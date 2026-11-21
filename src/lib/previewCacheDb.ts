import type { BurstMatchReason } from './burstGrouping';
import { waitForDeepIdle } from './interactionGate';
import type { ParsedExif, ResolvedPhotoMedia } from './rawParser';
import type { SimilaritySensitivity, VisualFingerprint } from './visualSimilarity';

const CACHE_DB_NAME = 'selectra_media_cache_v1';
const CACHE_DB_VERSION = 1;

const DETAIL_STORE = 'detail_previews';
const MICRO_THUMB_STORE = 'gallery_micro_thumbs';
const SERIES_MEMORY_STORE = 'folder_series_memory';

export const DETAIL_CULLED_TTL_MS = 24 * 60 * 60 * 1000; // 24 hodin po protřídění
export const GALLERY_AND_SERIES_CULLED_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dní po dotřídění

export interface CachedDetailPreviewRecord {
  cacheKey: string; // `${fileId}:${variant}`
  fileId: string;
  folderId: string;
  variant: 'auto' | 'full';
  blob: Blob;
  sizeBytes: number;
  source: ResolvedPhotoMedia['source'];
  exif?: ParsedExif;
  cachedAtMs: number;
  lastAccessedAtMs: number;
  culledAtMs: number | null;
}

export interface CachedMicroThumbRecord {
  fileId: string;
  folderId: string;
  blob: Blob;
  sizeBytes: number;
  createdAtMs: number;
  lastAccessedAtMs: number;
  folderCulledAtMs: number | null;
}

export interface RememberedAutoSeriesEntry {
  id: string;
  shotIds: string[];
  stems: string[];
  startTimeMs: number;
  endTimeMs: number;
  durationSec: number;
  timeLabel: string;
  matchReason: BurstMatchReason;
}

export interface SerializedVisualFingerprint {
  lumaGrid: Float32Array | number[];
  edgeGrid: Float32Array | number[];
  spatialColor: Float32Array | number[];
  colorHist: Float32Array | number[];
  meanLuma: number;
  aspectRatio: number;
}

export interface FolderSeriesMemoryRecord {
  folderId: string;
  folderName: string;
  autoSeries: RememberedAutoSeriesEntry[];
  fingerprints: Record<string, SerializedVisualFingerprint>;
  enrichedTimestamps: Record<string, { ms: number; label: string }>;
  sensitivity: SimilaritySensitivity;
  visualEnabled: boolean;
  isFolderCulled: boolean;
  folderCulledAtMs: number | null;
  totalShotsCount: number;
  seriesCount: number;
  sizeBytes: number;
  updatedAtMs: number;
}

export interface FolderCacheUsageSummary {
  folderId: string;
  folderName: string;
  detailBytes: number;
  detailCount: number;
  detailUnculledCount: number;
  microThumbBytes: number;
  microThumbCount: number;
  seriesMemoryBytes: number;
  seriesCount: number;
  isFolderCulled: boolean;
  folderCulledAtMs: number | null;
  updatedAtMs: number;
}

export interface CacheStorageStats {
  totalBytes: number;
  detailBytes: number;
  detailCount: number;
  detailUnculledCount: number;
  detailCulledPendingCount: number;
  microThumbBytes: number;
  microThumbCount: number;
  seriesMemoryBytes: number;
  seriesFolderCount: number;
  rememberedSeriesTotalCount: number;
  browserUsageBytes: number | null;
  browserQuotaBytes: number | null;
  folders: FolderCacheUsageSummary[];
  computedAtMs: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
const memoryMicroUrls = new Map<string, string>();
let lastSweepAtMs = 0;

function openCacheDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DETAIL_STORE)) {
        const store = db.createObjectStore(DETAIL_STORE, {
          keyPath: 'cacheKey',
        });
        store.createIndex('folderId', 'folderId', { unique: false });
        store.createIndex('fileId', 'fileId', { unique: false });
        store.createIndex('culledAtMs', 'culledAtMs', { unique: false });
      }
      if (!db.objectStoreNames.contains(MICRO_THUMB_STORE)) {
        const store = db.createObjectStore(MICRO_THUMB_STORE, {
          keyPath: 'fileId',
        });
        store.createIndex('folderId', 'folderId', { unique: false });
        store.createIndex('folderCulledAtMs', 'folderCulledAtMs', {
          unique: false,
        });
      }
      if (!db.objectStoreNames.contains(SERIES_MEMORY_STORE)) {
        const store = db.createObjectStore(SERIES_MEMORY_STORE, {
          keyPath: 'folderId',
        });
        store.createIndex('folderCulledAtMs', 'folderCulledAtMs', {
          unique: false,
        });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('Failed to open preview cache DB'));
    };
  });
  return dbPromise;
}

function toFloat32(val: Float32Array | number[] | undefined): Float32Array {
  if (val instanceof Float32Array) return val;
  if (Array.isArray(val)) return new Float32Array(val);
  return new Float32Array(0);
}

export function serializeVisualFingerprint(
  fp: VisualFingerprint
): SerializedVisualFingerprint {
  return {
    lumaGrid:
      fp.lumaGrid instanceof Float32Array
        ? fp.lumaGrid
        : new Float32Array(fp.lumaGrid),
    edgeGrid:
      fp.edgeGrid instanceof Float32Array
        ? fp.edgeGrid
        : new Float32Array(fp.edgeGrid),
    spatialColor:
      fp.spatialColor instanceof Float32Array
        ? fp.spatialColor
        : new Float32Array(fp.spatialColor),
    colorHist:
      fp.colorHist instanceof Float32Array
        ? fp.colorHist
        : new Float32Array(fp.colorHist),
    meanLuma: fp.meanLuma,
    aspectRatio: fp.aspectRatio,
  };
}

export function deserializeVisualFingerprint(
  raw: SerializedVisualFingerprint
): VisualFingerprint {
  return {
    lumaGrid: toFloat32(raw.lumaGrid),
    edgeGrid: toFloat32(raw.edgeGrid),
    spatialColor: toFloat32(raw.spatialColor),
    colorHist: toFloat32(raw.colorHist),
    meanLuma: Number(raw.meanLuma) || 0,
    aspectRatio: Number(raw.aspectRatio) || 1.5,
  };
}

const MAX_MEMORY_MICRO_URLS = 500;

export function getCachedMicroThumbMemoryUrl(fileId: string): string | null {
  const existing = memoryMicroUrls.get(fileId);
  if (!existing) return null;
  // Refresh LRU order
  memoryMicroUrls.delete(fileId);
  memoryMicroUrls.set(fileId, existing);
  return existing;
}

export function rememberMicroThumbMemoryUrl(
  fileId: string,
  url: string
): string {
  const prev = memoryMicroUrls.get(fileId);
  if (prev && prev !== url && prev.startsWith('blob:')) {
    URL.revokeObjectURL(prev);
  }
  if (memoryMicroUrls.has(fileId)) {
    memoryMicroUrls.delete(fileId);
  }
  memoryMicroUrls.set(fileId, url);
  while (memoryMicroUrls.size > MAX_MEMORY_MICRO_URLS) {
    const oldestKey = memoryMicroUrls.keys().next().value;
    if (!oldestKey) break;
    const oldestUrl = memoryMicroUrls.get(oldestKey);
    memoryMicroUrls.delete(oldestKey);
    if (oldestUrl && oldestUrl.startsWith('blob:')) {
      URL.revokeObjectURL(oldestUrl);
    }
  }
  return url;
}

export function clearMicroThumbMemoryUrls(): void {
  for (const url of memoryMicroUrls.values()) {
    if (url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  }
  memoryMicroUrls.clear();
}

export async function getCachedDetailPreview(
  cacheKey: string
): Promise<CachedDetailPreviewRecord | null> {
  try {
    const db = await openCacheDb();
    const record = await new Promise<CachedDetailPreviewRecord | null>(
      (resolve) => {
        const tx = db.transaction(DETAIL_STORE, 'readonly');
        const req = tx.objectStore(DETAIL_STORE).get(cacheKey);
        req.onsuccess = () =>
          resolve((req.result as CachedDetailPreviewRecord) || null);
        req.onerror = () => resolve(null);
      }
    );
    if (!record || !record.blob) return null;
    if (
      record.culledAtMs !== null &&
      Date.now() - record.culledAtMs >= DETAIL_CULLED_TTL_MS
    ) {
      void deleteDetailPreviewByKey(cacheKey);
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

async function deleteDetailPreviewByKey(cacheKey: string): Promise<void> {
  try {
    const db = await openCacheDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(DETAIL_STORE, 'readwrite');
      tx.objectStore(DETAIL_STORE).delete(cacheKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore IDB errors
  }
}

export async function deleteCachedDetailPreviewsForFile(
  fileId: string
): Promise<void> {
  if (!fileId) return;
  await Promise.all([
    deleteDetailPreviewByKey(`${fileId}:auto`),
    deleteDetailPreviewByKey(`${fileId}:full`),
  ]);
}

export async function saveDetailPreview(params: {
  cacheKey: string;
  fileId: string;
  folderId: string;
  variant: 'auto' | 'full';
  blob: Blob;
  source: ResolvedPhotoMedia['source'];
  exif?: ParsedExif;
  culledAtMs?: number | null;
}): Promise<void> {
  if (!params.folderId || !params.blob || params.blob.size === 0) return;
  try {
    const db = await openCacheDb();
    const now = Date.now();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(DETAIL_STORE, 'readwrite');
      const store = tx.objectStore(DETAIL_STORE);
      const getReq = store.get(params.cacheKey);
      getReq.onsuccess = () => {
        const existing = getReq.result as CachedDetailPreviewRecord | undefined;
        const resolvedCulledAt =
          params.culledAtMs !== undefined
            ? params.culledAtMs
            : existing?.culledAtMs ?? null;
        const record: CachedDetailPreviewRecord = {
          cacheKey: params.cacheKey,
          fileId: params.fileId,
          folderId: params.folderId,
          variant: params.variant,
          blob: params.blob,
          sizeBytes: params.blob.size,
          source: params.source,
          ...(params.exif ? { exif: params.exif } : {}),
          cachedAtMs: existing?.cachedAtMs || now,
          lastAccessedAtMs: now,
          culledAtMs: resolvedCulledAt,
        };
        store.put(record);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore IDB write quota/unavailable errors cleanly
  }
}

export async function getCachedMicroThumbBlob(
  fileId: string
): Promise<Blob | null> {
  try {
    const db = await openCacheDb();
    const rec = await new Promise<CachedMicroThumbRecord | null>((resolve) => {
      const tx = db.transaction(MICRO_THUMB_STORE, 'readonly');
      const req = tx.objectStore(MICRO_THUMB_STORE).get(fileId);
      req.onsuccess = () =>
        resolve((req.result as CachedMicroThumbRecord) || null);
      req.onerror = () => resolve(null);
    });
    if (!rec || !rec.blob) return null;
    if (
      rec.folderCulledAtMs !== null &&
      Date.now() - rec.folderCulledAtMs >= GALLERY_AND_SERIES_CULLED_TTL_MS
    ) {
      return null;
    }
    return rec.blob;
  } catch {
    return null;
  }
}

export async function loadMicroThumbUrlsForFolder(
  folderId: string,
  maxItems = 250
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!folderId || maxItems <= 0) return out;
  try {
    const db = await openCacheDb();
    const now = Date.now();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(MICRO_THUMB_STORE, 'readonly');
      const idx = tx.objectStore(MICRO_THUMB_STORE).index('folderId');
      const cursorReq = idx.openCursor(IDBKeyRange.only(folderId));
      let loaded = 0;
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || loaded >= maxItems) {
          resolve();
          return;
        }
        const rec = cursor.value as CachedMicroThumbRecord;
        if (
          rec &&
          rec.fileId &&
          rec.blob &&
          (rec.folderCulledAtMs === null ||
            now - rec.folderCulledAtMs < GALLERY_AND_SERIES_CULLED_TTL_MS)
        ) {
          const existingUrl = getCachedMicroThumbMemoryUrl(rec.fileId);
          if (existingUrl) {
            out[rec.fileId] = existingUrl;
          } else {
            const url = rememberMicroThumbMemoryUrl(
              rec.fileId,
              URL.createObjectURL(rec.blob)
            );
            out[rec.fileId] = url;
          }
          loaded++;
        }
        cursor.continue();
      };
      cursorReq.onerror = () => resolve();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore IDB errors
  }
  return out;
}

export async function saveMicroThumb(params: {
  fileId: string;
  folderId: string;
  blob: Blob;
  folderCulledAtMs?: number | null;
  skipMemoryUrl?: boolean;
}): Promise<string | null> {
  if (!params.folderId || !params.blob || params.blob.size === 0) return null;
  let url: string | null = getCachedMicroThumbMemoryUrl(params.fileId);
  if (!url && !params.skipMemoryUrl) {
    url = rememberMicroThumbMemoryUrl(
      params.fileId,
      URL.createObjectURL(params.blob)
    );
  }
  try {
    const db = await openCacheDb();
    const now = Date.now();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(MICRO_THUMB_STORE, 'readwrite');
      const store = tx.objectStore(MICRO_THUMB_STORE);
      const getReq = store.get(params.fileId);
      getReq.onsuccess = () => {
        const existing = getReq.result as CachedMicroThumbRecord | undefined;
        const resolvedFolderCulledAt =
          params.folderCulledAtMs !== undefined
            ? params.folderCulledAtMs
            : existing?.folderCulledAtMs ?? null;
        const record: CachedMicroThumbRecord = {
          fileId: params.fileId,
          folderId: params.folderId,
          blob: params.blob,
          sizeBytes: params.blob.size,
          createdAtMs: existing?.createdAtMs || now,
          lastAccessedAtMs: now,
          folderCulledAtMs: resolvedFolderCulledAt,
        };
        store.put(record);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore IDB errors
  }
  return url;
}

/**
 * Zero-blob fast index key scan returning file IDs that already have cached detail previews
 * or micro thumbnails in IndexedDB for the given folder.
 */
export async function getCachedFolderFileIds(folderId: string): Promise<{
  detailFileIds: Set<string>;
  microThumbFileIds: Set<string>;
}> {
  const detailFileIds = new Set<string>();
  const microThumbFileIds = new Set<string>();
  if (!folderId) return { detailFileIds, microThumbFileIds };

  try {
    const db = await openCacheDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(
        [DETAIL_STORE, MICRO_THUMB_STORE],
        'readonly'
      );

      const dIdx = tx.objectStore(DETAIL_STORE).index('folderId');
      const dCursor = dIdx.openKeyCursor(IDBKeyRange.only(folderId));
      dCursor.onsuccess = () => {
        const cursor = dCursor.result;
        if (!cursor) return;
        const keyStr = String(cursor.primaryKey || '');
        const fileId = keyStr.replace(/:(auto|full)$/, '');
        if (fileId) detailFileIds.add(fileId);
        cursor.continue();
      };

      const mIdx = tx.objectStore(MICRO_THUMB_STORE).index('folderId');
      const mCursor = mIdx.openKeyCursor(IDBKeyRange.only(folderId));
      mCursor.onsuccess = () => {
        const cursor = mCursor.result;
        if (!cursor) return;
        const fileId = String(cursor.primaryKey || '');
        if (fileId) microThumbFileIds.add(fileId);
        cursor.continue();
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore IDB errors
  }

  return { detailFileIds, microThumbFileIds };
}

function estimateSeriesMemoryBytes(
  autoSeries: RememberedAutoSeriesEntry[],
  fingerprints: Record<string, SerializedVisualFingerprint>,
  enrichedTimestamps: Record<string, { ms: number; label: string }>
): number {
  const fpCount = Object.keys(fingerprints).length;
  // Each VisualFingerprint stores 768 floats (~3.1 KB) + metadata overhead
  const fpBytes = fpCount * 3180;
  let seriesEstBytes = 0;
  for (let i = 0; i < autoSeries.length; i++) {
    seriesEstBytes += 160 + autoSeries[i].shotIds.length * 72;
  }
  const tsBytes = Object.keys(enrichedTimestamps).length * 64;
  return fpBytes + seriesEstBytes + tsBytes;
}

export async function loadFolderSeriesMemory(folderId: string): Promise<{
  autoSeries: RememberedAutoSeriesEntry[];
  fingerprints: Record<string, VisualFingerprint>;
  enrichedTimestamps: Record<string, { ms: number; label: string }>;
  isFolderCulled: boolean;
  folderCulledAtMs: number | null;
  updatedAtMs: number;
} | null> {
  if (!folderId) return null;
  try {
    const db = await openCacheDb();
    const rec = await new Promise<FolderSeriesMemoryRecord | null>((resolve) => {
      const tx = db.transaction(SERIES_MEMORY_STORE, 'readonly');
      const req = tx.objectStore(SERIES_MEMORY_STORE).get(folderId);
      req.onsuccess = () =>
        resolve((req.result as FolderSeriesMemoryRecord) || null);
      req.onerror = () => resolve(null);
    });
    if (!rec) return null;
    if (
      rec.folderCulledAtMs !== null &&
      Date.now() - rec.folderCulledAtMs >= GALLERY_AND_SERIES_CULLED_TTL_MS
    ) {
      return null;
    }
    const fps: Record<string, VisualFingerprint> = {};
    if (rec.fingerprints) {
      for (const [id, rawFp] of Object.entries(rec.fingerprints)) {
        if (!rawFp) continue;
        fps[id] = deserializeVisualFingerprint(rawFp);
      }
    }
    return {
      autoSeries: Array.isArray(rec.autoSeries) ? rec.autoSeries : [],
      fingerprints: fps,
      enrichedTimestamps: rec.enrichedTimestamps || {},
      isFolderCulled: Boolean(rec.isFolderCulled),
      folderCulledAtMs: rec.folderCulledAtMs ?? null,
      updatedAtMs: rec.updatedAtMs || 0,
    };
  } catch {
    return null;
  }
}

export async function saveFolderSeriesMemory(params: {
  folderId: string;
  folderName: string;
  autoSeries: RememberedAutoSeriesEntry[];
  fingerprints: Record<string, VisualFingerprint>;
  enrichedTimestamps: Record<string, { ms: number; label: string }>;
  sensitivity: SimilaritySensitivity;
  visualEnabled: boolean;
  isFolderCulled: boolean;
  totalShotsCount: number;
}): Promise<void> {
  if (!params.folderId) return;
  try {
    const db = await openCacheDb();
    const now = Date.now();
    const serializedFps: Record<string, SerializedVisualFingerprint> = {};
    for (const [id, fp] of Object.entries(params.fingerprints)) {
      serializedFps[id] = serializeVisualFingerprint(fp);
    }

    await new Promise<void>((resolve) => {
      const tx = db.transaction(SERIES_MEMORY_STORE, 'readwrite');
      const store = tx.objectStore(SERIES_MEMORY_STORE);
      const getReq = store.get(params.folderId);
      getReq.onsuccess = () => {
        const existing = getReq.result as FolderSeriesMemoryRecord | undefined;
        // Merge existing fingerprints & timestamps so partial scans never discard prior computed entries
        const mergedFps: Record<string, SerializedVisualFingerprint> = {
          ...(existing?.fingerprints || {}),
          ...serializedFps,
        };
        const mergedTs: Record<string, { ms: number; label: string }> = {
          ...(existing?.enrichedTimestamps || {}),
          ...params.enrichedTimestamps,
        };
        const folderCulledAtMs = params.isFolderCulled
          ? existing?.folderCulledAtMs ?? now
          : null;
        const sizeBytes = estimateSeriesMemoryBytes(
          params.autoSeries,
          mergedFps,
          mergedTs
        );
        const record: FolderSeriesMemoryRecord = {
          folderId: params.folderId,
          folderName: params.folderName || existing?.folderName || 'Složka',
          autoSeries: params.autoSeries,
          fingerprints: mergedFps,
          enrichedTimestamps: mergedTs,
          sensitivity: params.sensitivity,
          visualEnabled: params.visualEnabled,
          isFolderCulled: params.isFolderCulled,
          folderCulledAtMs,
          totalShotsCount: params.totalShotsCount,
          seriesCount: params.autoSeries.length,
          sizeBytes,
          updatedAtMs: now,
        };
        store.put(record);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore IDB write errors
  }
}

/**
 * Updates `culledAtMs` across cached detail previews for a folder:
 * - Newly culled files get `culledAtMs = now` (triggering 24h expiry countdown)
 * - Un-culled files (e.g. Undo) reset `culledAtMs = null` so they stay pinned
 */
export async function updatePhotosCulledStateIncremental(
  newlyCulledFileIds: string[],
  newlyUnculledFileIds: string[],
  nowMs = Date.now()
): Promise<void> {
  if (newlyCulledFileIds.length === 0 && newlyUnculledFileIds.length === 0) {
    return;
  }
  try {
    const db = await openCacheDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(DETAIL_STORE, 'readwrite');
      const store = tx.objectStore(DETAIL_STORE);
      const updateKey = (cacheKey: string, culled: boolean) => {
        const req = store.get(cacheKey);
        req.onsuccess = () => {
          const rec = req.result as CachedDetailPreviewRecord | undefined;
          if (!rec) return;
          if (culled && rec.culledAtMs === null) {
            store.put({ ...rec, culledAtMs: nowMs });
          } else if (!culled && rec.culledAtMs !== null) {
            store.put({ ...rec, culledAtMs: null });
          }
        };
      };
      for (const id of newlyCulledFileIds) {
        updateKey(`${id}:auto`, true);
        updateKey(`${id}:full`, true);
      }
      for (const id of newlyUnculledFileIds) {
        updateKey(`${id}:auto`, false);
        updateKey(`${id}:full`, false);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore IDB errors
  }
}

export async function syncPhotosCulledState(
  folderId: string,
  culledFileIds: Set<string>,
  nowMs = Date.now()
): Promise<void> {
  if (!folderId) return;
  try {
    const db = await openCacheDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(DETAIL_STORE, 'readwrite');
      const store = tx.objectStore(DETAIL_STORE);
      const idx = store.index('folderId');
      const cursorReq = idx.openCursor(IDBKeyRange.only(folderId));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const rec = cursor.value as CachedDetailPreviewRecord;
        const isCulled = culledFileIds.has(rec.fileId);
        if (isCulled && rec.culledAtMs === null) {
          cursor.update({ ...rec, culledAtMs: nowMs });
        } else if (!isCulled && rec.culledAtMs !== null) {
          cursor.update({ ...rec, culledAtMs: null });
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore IDB errors
  }
}

/**
 * Stamps or clears `folderCulledAtMs` on gallery micro-thumbnails and folder series memory
 * so finished folders retain gallery thumbs & series for 7 days after culling.
 */
export async function syncFolderCulledStatus(
  folderId: string,
  isFolderCulled: boolean,
  nowMs = Date.now()
): Promise<void> {
  if (!folderId) return;
  try {
    const db = await openCacheDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(
        [MICRO_THUMB_STORE, SERIES_MEMORY_STORE],
        'readwrite'
      );

      const microStore = tx.objectStore(MICRO_THUMB_STORE);
      const microIdx = microStore.index('folderId');
      const microCursor = microIdx.openCursor(IDBKeyRange.only(folderId));
      microCursor.onsuccess = () => {
        const cursor = microCursor.result;
        if (!cursor) return;
        const rec = cursor.value as CachedMicroThumbRecord;
        if (isFolderCulled && rec.folderCulledAtMs === null) {
          cursor.update({ ...rec, folderCulledAtMs: nowMs });
        } else if (!isFolderCulled && rec.folderCulledAtMs !== null) {
          cursor.update({ ...rec, folderCulledAtMs: null });
        }
        cursor.continue();
      };

      const seriesStore = tx.objectStore(SERIES_MEMORY_STORE);
      const sReq = seriesStore.get(folderId);
      sReq.onsuccess = () => {
        const sRec = sReq.result as FolderSeriesMemoryRecord | undefined;
        if (!sRec) return;
        const nextCulledAt = isFolderCulled
          ? sRec.folderCulledAtMs ?? nowMs
          : null;
        if (
          sRec.isFolderCulled !== isFolderCulled ||
          sRec.folderCulledAtMs !== nextCulledAt
        ) {
          seriesStore.put({
            ...sRec,
            isFolderCulled,
            folderCulledAtMs: nextCulledAt,
          });
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore IDB errors
  }
}

/**
 * Sweeps expired records:
 * - Culled detail previews older than 24h
 * - Culled folder micro-thumbnails and series memory older than 7 days
 */
export async function runCacheExpirySweep(force = false): Promise<{
  deletedDetailCount: number;
  deletedMicroCount: number;
  deletedSeriesFolderCount: number;
}> {
  const nowCheck = Date.now();
  if (!force && nowCheck - lastSweepAtMs < 10 * 60_000) {
    return {
      deletedDetailCount: 0,
      deletedMicroCount: 0,
      deletedSeriesFolderCount: 0,
    };
  }

  // Wait for true UI idle on background sweeps so we never touch IndexedDB mid-gesture
  if (!force) {
    await waitForDeepIdle(1400);
  }

  const now = Date.now();
  if (!force && now - lastSweepAtMs < 10 * 60_000) {
    return {
      deletedDetailCount: 0,
      deletedMicroCount: 0,
      deletedSeriesFolderCount: 0,
    };
  }
  lastSweepAtMs = now;

  let deletedDetailCount = 0;
  let deletedMicroCount = 0;
  let deletedSeriesFolderCount = 0;

  const detailCutoff = now - DETAIL_CULLED_TTL_MS;
  const folderCutoff = now - GALLERY_AND_SERIES_CULLED_TTL_MS;

  try {
    const db = await openCacheDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(
        [DETAIL_STORE, MICRO_THUMB_STORE, SERIES_MEMORY_STORE],
        'readwrite'
      );

      // Zero-blob indexed key cursors: ONLY visit records whose numeric culled timestamp <= cutoff!
      if (detailCutoff > 0) {
        const detailStore = tx.objectStore(DETAIL_STORE);
        const detailIdx = detailStore.index('culledAtMs');
        const detailRange = IDBKeyRange.bound(1, detailCutoff);
        const detailCursor = detailIdx.openKeyCursor(detailRange);
        detailCursor.onsuccess = () => {
          const cursor = detailCursor.result;
          if (!cursor) return;
          detailStore.delete(cursor.primaryKey);
          deletedDetailCount++;
          cursor.continue();
        };
      }

      if (folderCutoff > 0) {
        const microStore = tx.objectStore(MICRO_THUMB_STORE);
        const microIdx = microStore.index('folderCulledAtMs');
        const microRange = IDBKeyRange.bound(1, folderCutoff);
        const microCursor = microIdx.openKeyCursor(microRange);
        microCursor.onsuccess = () => {
          const cursor = microCursor.result;
          if (!cursor) return;
          const fileId = String(cursor.primaryKey || '');
          const memUrl = memoryMicroUrls.get(fileId);
          if (memUrl?.startsWith('blob:')) {
            URL.revokeObjectURL(memUrl);
          }
          memoryMicroUrls.delete(fileId);
          microStore.delete(cursor.primaryKey);
          deletedMicroCount++;
          cursor.continue();
        };

        const seriesStore = tx.objectStore(SERIES_MEMORY_STORE);
        const seriesIdx = seriesStore.index('folderCulledAtMs');
        const seriesRange = IDBKeyRange.bound(1, folderCutoff);
        const seriesCursor = seriesIdx.openKeyCursor(seriesRange);
        seriesCursor.onsuccess = () => {
          const cursor = seriesCursor.result;
          if (!cursor) return;
          seriesStore.delete(cursor.primaryKey);
          deletedSeriesFolderCount++;
          cursor.continue();
        };
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore IDB errors
  }

  return {
    deletedDetailCount,
    deletedMicroCount,
    deletedSeriesFolderCount,
  };
}

export async function getCacheStorageStats(): Promise<CacheStorageStats> {
  await runCacheExpirySweep(true);

  const folderMap = new Map<string, FolderCacheUsageSummary>();
  const ensureFolder = (folderId: string): FolderCacheUsageSummary => {
    let entry = folderMap.get(folderId);
    if (!entry) {
      entry = {
        folderId,
        folderName: 'Složka',
        detailBytes: 0,
        detailCount: 0,
        detailUnculledCount: 0,
        microThumbBytes: 0,
        microThumbCount: 0,
        seriesMemoryBytes: 0,
        seriesCount: 0,
        isFolderCulled: false,
        folderCulledAtMs: null,
        updatedAtMs: 0,
      };
      folderMap.set(folderId, entry);
    }
    return entry;
  };

  let detailBytes = 0;
  let detailCount = 0;
  let detailUnculledCount = 0;
  let detailCulledPendingCount = 0;
  let microThumbBytes = 0;
  let microThumbCount = 0;
  let seriesMemoryBytes = 0;
  let seriesFolderCount = 0;
  let rememberedSeriesTotalCount = 0;

  try {
    const db = await openCacheDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(
        [DETAIL_STORE, MICRO_THUMB_STORE, SERIES_MEMORY_STORE],
        'readonly'
      );

      const dReq = tx.objectStore(DETAIL_STORE).getAll();
      dReq.onsuccess = () => {
        const rows = (dReq.result as CachedDetailPreviewRecord[]) || [];
        for (const r of rows) {
          const bytes = Number(r.sizeBytes) || r.blob?.size || 0;
          detailBytes += bytes;
          detailCount++;
          if (r.culledAtMs === null) {
            detailUnculledCount++;
          } else {
            detailCulledPendingCount++;
          }
          const f = ensureFolder(r.folderId);
          f.detailBytes += bytes;
          f.detailCount++;
          if (r.culledAtMs === null) f.detailUnculledCount++;
          if ((r.lastAccessedAtMs || 0) > f.updatedAtMs) {
            f.updatedAtMs = r.lastAccessedAtMs || 0;
          }
        }
      };

      const mReq = tx.objectStore(MICRO_THUMB_STORE).getAll();
      mReq.onsuccess = () => {
        const rows = (mReq.result as CachedMicroThumbRecord[]) || [];
        for (const r of rows) {
          const bytes = Number(r.sizeBytes) || r.blob?.size || 0;
          microThumbBytes += bytes;
          microThumbCount++;
          const f = ensureFolder(r.folderId);
          f.microThumbBytes += bytes;
          f.microThumbCount++;
          if ((r.lastAccessedAtMs || 0) > f.updatedAtMs) {
            f.updatedAtMs = r.lastAccessedAtMs || 0;
          }
        }
      };

      const sReq = tx.objectStore(SERIES_MEMORY_STORE).getAll();
      sReq.onsuccess = () => {
        const rows = (sReq.result as FolderSeriesMemoryRecord[]) || [];
        for (const r of rows) {
          const bytes = Number(r.sizeBytes) || 0;
          seriesMemoryBytes += bytes;
          seriesFolderCount++;
          rememberedSeriesTotalCount += r.seriesCount || 0;
          const f = ensureFolder(r.folderId);
          f.folderName = r.folderName || f.folderName;
          f.seriesMemoryBytes += bytes;
          f.seriesCount = r.seriesCount || 0;
          f.isFolderCulled = Boolean(r.isFolderCulled);
          f.folderCulledAtMs = r.folderCulledAtMs ?? null;
          if ((r.updatedAtMs || 0) > f.updatedAtMs) {
            f.updatedAtMs = r.updatedAtMs || 0;
          }
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore IDB errors
  }

  let browserUsageBytes: number | null = null;
  let browserQuotaBytes: number | null = null;
  if (
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.estimate === 'function'
  ) {
    try {
      const est = await navigator.storage.estimate();
      if (typeof est.usage === 'number') browserUsageBytes = est.usage;
      if (typeof est.quota === 'number') browserQuotaBytes = est.quota;
    } catch {
      // Ignore storage estimate restrictions
    }
  }

  const folders = Array.from(folderMap.values()).sort(
    (a, b) => b.updatedAtMs - a.updatedAtMs
  );

  return {
    totalBytes: detailBytes + microThumbBytes + seriesMemoryBytes,
    detailBytes,
    detailCount,
    detailUnculledCount,
    detailCulledPendingCount,
    microThumbBytes,
    microThumbCount,
    seriesMemoryBytes,
    seriesFolderCount,
    rememberedSeriesTotalCount,
    browserUsageBytes,
    browserQuotaBytes,
    folders,
    computedAtMs: Date.now(),
  };
}

/**
 * Deletes only detail previews that belong to already-culled photos
 * while preserving unculled series and 7-day gallery/series memory.
 */
export async function purgeCulledDetailPreviewsNow(): Promise<number> {
  let deleted = 0;
  try {
    const db = await openCacheDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(DETAIL_STORE, 'readwrite');
      const cursorReq = tx.objectStore(DETAIL_STORE).openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const rec = cursor.value as CachedDetailPreviewRecord;
        if (rec.culledAtMs !== null) {
          cursor.delete();
          deleted++;
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore IDB errors
  }
  return deleted;
}

/**
 * Clears all cached detail previews, micro-thumbnails, and remembered folder series
 * without touching saved culling decisions (`folder_sessions`) or folder handles.
 */
export async function clearAllMediaAndSeriesCache(): Promise<void> {
  clearMicroThumbMemoryUrls();
  try {
    const db = await openCacheDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(
        [DETAIL_STORE, MICRO_THUMB_STORE, SERIES_MEMORY_STORE],
        'readwrite'
      );
      tx.objectStore(DETAIL_STORE).clear();
      tx.objectStore(MICRO_THUMB_STORE).clear();
      tx.objectStore(SERIES_MEMORY_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore IDB errors
  }
}

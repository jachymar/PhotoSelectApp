import exifr from 'exifr';
import { DrivePhotoFile, fetchDriveFileBytes } from './driveApi';
import { readLocalFileBytes } from './localMedia';
import {
  getCachedDetailPreview,
  getCachedMicroThumbBlob,
  getCachedMicroThumbMemoryUrl,
  rememberMicroThumbMemoryUrl,
  saveDetailPreview,
  saveMicroThumb,
} from './previewCacheDb';
import { waitForBackgroundSlot, withTimeout } from './interactionGate';
import {
  binaryMetaToParsedExif,
  ensureJpegExifOrientation,
  extractLargestEmbeddedJpeg,
  findCanonPrvwOrExifInCr3,
  parseExifDateStringToTimestamp,
  parseTiffIfdMetadata,
  type Cr3BoxParseResult,
  type ParsedExif,
} from './rawBinaryUtils';

export {
  ensureJpegExifOrientation,
  extractLargestEmbeddedJpeg,
  type ParsedExif,
};

export interface ResolvedPhotoMedia {
  url: string;
  source: 'raw-embedded' | 'drive-media' | 'drive-thumbnail' | 'local-media';
  exif?: ParsedExif;
  isObjectUrl: boolean;
}

export async function fetchPhotoBytes(
  token: string | null | undefined,
  file: DrivePhotoFile,
  range?: { start: number; end: number },
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const timeoutMs = range ? 14_000 : 22_000;
  if (file.sourceKind && file.sourceKind !== 'drive') {
    return await withTimeout(
      readLocalFileBytes(file, range, signal),
      timeoutMs,
      `Čtení ${file.name}`
    );
  }
  if (!token) {
    throw new Error('Chybí přístupový token ke Google Drive.');
  }
  return await withTimeout(
    fetchDriveFileBytes(token, file.id, range, signal),
    timeoutMs,
    `Stažení ${file.name}`
  );
}

/**
 * Safely computes a byte range `{ start: 0, end }` even when an Android SAF / OTG provider
 * reports `sizeBytes === 0` during directory enumeration.
 */
function getHeaderRange(
  file: DrivePhotoFile,
  maxBytes: number
): { start: number; end: number } | undefined {
  if (file.sizeBytes > 0 && file.sizeBytes <= maxBytes) {
    return undefined;
  }
  const effectiveEnd =
    file.sizeBytes > 0
      ? Math.min(file.sizeBytes - 1, maxBytes - 1)
      : maxBytes - 1;
  return { start: 0, end: Math.max(0, effectiveEnd) };
}

/**
 * Walks top-level ISOBMFF 16-byte box headers of a large Canon CR3 file using tiny 32-byte reads
 * to locate the exact `{ start, end }` of Canon's `uuid(eaf42b5e...)` preview container without ever reading `mdat`.
 */
async function locateCanonCr3PrvwBoxRange(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<{ start: number; end: number } | null> {
  let offset = 0;
  for (let step = 0; step < 12; step++) {
    if (signal?.aborted) return null;
    if (file.sizeBytes > 0 && offset + 16 >= file.sizeBytes) break;

    const headerBuf = await fetchPhotoBytes(
      token,
      file,
      { start: offset, end: offset + 31 },
      signal
    ).catch(() => null);
    if (!headerBuf || headerBuf.byteLength < 8) break;

    const dv = new DataView(headerBuf);
    const bytes = new Uint8Array(headerBuf);
    let boxSize = dv.getUint32(0, false);
    const boxType = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    let headerSize = 8;

    if (boxSize === 1) {
      if (headerBuf.byteLength < 16) break;
      boxSize = dv.getUint32(8, false) * 4294967296 + dv.getUint32(12, false);
      headerSize = 16;
    }
    if (boxSize < headerSize) break;

    if (
      boxType === 'uuid' &&
      headerBuf.byteLength >= headerSize + 4 &&
      bytes[headerSize] === 0xea &&
      bytes[headerSize + 1] === 0xf4 &&
      bytes[headerSize + 2] === 0x2b &&
      bytes[headerSize + 3] === 0x5e
    ) {
      return { start: offset, end: offset + boxSize };
    }

    offset += boxSize;
  }
  return null;
}

const orientationHintCache = new Map<string, number>();

function rememberOrientationHint(fileId: string, orientation?: number) {
  if (orientation && orientation >= 1 && orientation <= 8) {
    orientationHintCache.set(fileId, orientation);
    if (orientationHintCache.size > 2000) {
      const oldest = orientationHintCache.keys().next().value;
      if (oldest) orientationHintCache.delete(oldest);
    }
  }
}

export async function parseExifSafe(
  input: ArrayBuffer | Uint8Array
): Promise<ParsedExif | undefined> {
  const bytes =
    input instanceof Uint8Array
      ? input
      : new Uint8Array(input, 0, input.byteLength);

  // Fast binary TIFF/JPEG reader (< 0.05 ms, zero heap churn)
  const fastMeta = parseTiffIfdMetadata(bytes, 0);
  const fastParsed = binaryMetaToParsedExif(fastMeta);
  if (
    fastParsed &&
    (fastParsed.orientation !== undefined ||
      fastParsed.iso !== undefined ||
      fastParsed.exposureTime !== undefined ||
      fastParsed.dateTaken !== undefined ||
      fastParsed.model !== undefined)
  ) {
    return fastParsed;
  }

  try {
    const data = await exifr.parse(input, {
      tiff: true,
      exif: true,
    });
    if (!data) return fastParsed;
    return {
      make: data.Make ? String(data.Make).trim() : fastParsed?.make,
      model: data.Model ? String(data.Model).trim() : fastParsed?.model,
      lens: data.LensModel ? String(data.LensModel).trim() : fastParsed?.lens,
      iso: typeof data.ISO === 'number' ? data.ISO : fastParsed?.iso,
      aperture:
        typeof data.FNumber === 'number' ? data.FNumber : fastParsed?.aperture,
      exposureTime:
        typeof data.ExposureTime === 'number'
          ? data.ExposureTime
          : fastParsed?.exposureTime,
      focalLength:
        typeof data.FocalLength === 'number'
          ? data.FocalLength
          : fastParsed?.focalLength,
      dateTaken:
        data.DateTimeOriginal instanceof Date
          ? data.DateTimeOriginal.toLocaleDateString('cs-CZ', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })
          : fastParsed?.dateTaken,
      orientation:
        typeof data.Orientation === 'number'
          ? data.Orientation
          : fastParsed?.orientation,
    };
  } catch {
    return fastParsed;
  }
}

export async function extractExifTimestampFromHeader(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<{ ms: number; label: string } | null> {
  try {
    // 256 KB easily covers Canon CR3 ftyp + moov -> uuid -> CMT1 + CMT2 as well as all JPG/RAW TIFF headers
    const buffer = await fetchPhotoBytes(
      token,
      file,
      getHeaderRange(file, 262144),
      signal
    );
    const bytes = new Uint8Array(buffer);

    if (file.fileExtension === 'cr3') {
      const cr3 = findCanonPrvwOrExifInCr3(buffer);
      const meta1 = cr3.cmt1 ? parseTiffIfdMetadata(cr3.cmt1, 0) : undefined;
      const meta2 = cr3.cmt2 ? parseTiffIfdMetadata(cr3.cmt2, 0) : undefined;
      rememberOrientationHint(file.id, meta1?.orientation);

      const dateStr =
        meta2?.dateTimeOriginal ||
        meta2?.createDate ||
        meta1?.dateTimeOriginal ||
        meta1?.modifyDate;
      const subSecStr = meta2?.subSecTimeOriginal || meta2?.subSecTime;
      const ts = parseExifDateStringToTimestamp(dateStr, subSecStr);
      if (ts) {
        return { ms: ts.ms, label: ts.label };
      }
    } else {
      const fastMeta = parseTiffIfdMetadata(bytes, 0);
      rememberOrientationHint(file.id, fastMeta?.orientation);
      const dateStr =
        fastMeta?.dateTimeOriginal ||
        fastMeta?.createDate ||
        fastMeta?.modifyDate;
      const subSecStr = fastMeta?.subSecTimeOriginal || fastMeta?.subSecTime;
      const ts = parseExifDateStringToTimestamp(dateStr, subSecStr);
      if (ts) {
        return { ms: ts.ms, label: ts.label };
      }
    }

    // Fallback to exifr for uncommon container layouts (HEIC/AVIF/XMP)
    const parsed = await exifr.parse(buffer, { tiff: true, exif: true });
    if (typeof parsed?.Orientation === 'number') {
      rememberOrientationHint(file.id, parsed.Orientation);
    }
    let rawDate: Date | undefined;
    let subSecStr: string | undefined;
    if (parsed?.DateTimeOriginal instanceof Date) {
      rawDate = parsed.DateTimeOriginal;
      subSecStr = parsed.SubSecTimeOriginal
        ? String(parsed.SubSecTimeOriginal)
        : undefined;
    } else if (parsed?.CreateDate instanceof Date) {
      rawDate = parsed.CreateDate;
    }
    if (!rawDate || Number.isNaN(rawDate.getTime())) return null;

    const subMs = subSecStr
      ? Number(subSecStr.replace(/\D/g, '').slice(0, 3).padEnd(3, '0')) || 0
      : 0;
    const ms = rawDate.getTime() + subMs;
    const label = rawDate.toLocaleString('cs-CZ', {
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    return { ms, label };
  } catch {
    return null;
  }
}

function mergeExifWithDrive(
  file: DrivePhotoFile,
  parsed?: ParsedExif
): ParsedExif | undefined {
  const merged: ParsedExif = {
    make: parsed?.make || file.cameraMake,
    model: parsed?.model || file.cameraModel,
    lens: parsed?.lens,
    iso: parsed?.iso ?? file.isoSpeed,
    aperture: parsed?.aperture ?? file.aperture,
    exposureTime: parsed?.exposureTime ?? file.exposureTime,
    focalLength: parsed?.focalLength ?? file.focalLength,
    dateTaken: parsed?.dateTaken,
    orientation: parsed?.orientation ?? orientationHintCache.get(file.id),
  };
  const hasAny = Object.values(merged).some((v) => v !== undefined);
  return hasAny ? merged : undefined;
}

interface MediaCacheEntry {
  media: ResolvedPhotoMedia;
  pinned: boolean;
}

const mediaCache = new Map<string, MediaCacheEntry>();
const workerDecodedBitmapPool = new Map<string, ImageBitmap>();
const retainedMediaFileIds = new Set<string>();
const mediaEvictionListeners = new Set<(fileId: string, evictedUrl: string) => void>();
const BASE_MAX_MEDIA_CACHE_SIZE = 22;
const BASE_WORKER_BITMAP_POOL_SIZE = 8;
let activeSeriesCacheBudget = 0;

function getEffectiveWorkerBitmapPoolLimit(): number {
  if (activeSeriesCacheBudget > 0) {
    return Math.min(20, Math.max(BASE_WORKER_BITMAP_POOL_SIZE, activeSeriesCacheBudget + 2));
  }
  return BASE_WORKER_BITMAP_POOL_SIZE;
}

function closeAndDeleteWorkerBitmap(fileId: string): void {
  const bmp = workerDecodedBitmapPool.get(fileId);
  if (bmp) {
    try {
      bmp.close();
    } catch {
      // Ignore already-closed bitmap
    }
    workerDecodedBitmapPool.delete(fileId);
  }
}

function retainWorkerDecodedBitmap(fileId: string, bitmap: ImageBitmap): void {
  const prev = workerDecodedBitmapPool.get(fileId);
  if (prev && prev !== bitmap) {
    try {
      prev.close();
    } catch {
      // Ignore already-closed bitmap
    }
  }
  workerDecodedBitmapPool.delete(fileId);
  workerDecodedBitmapPool.set(fileId, bitmap);

  const limit = getEffectiveWorkerBitmapPoolLimit();
  while (workerDecodedBitmapPool.size > limit) {
    let evictId: string | undefined;
    for (const id of workerDecodedBitmapPool.keys()) {
      if (!retainedMediaFileIds.has(id) && id !== fileId) {
        evictId = id;
        break;
      }
    }
    if (!evictId) {
      for (const id of workerDecodedBitmapPool.keys()) {
        if (id !== fileId) {
          evictId = id;
          break;
        }
      }
    }
    if (!evictId) break;
    closeAndDeleteWorkerBitmap(evictId);
  }
}

function trimWorkerBitmapPool(): void {
  const limit = getEffectiveWorkerBitmapPoolLimit();
  for (const id of Array.from(workerDecodedBitmapPool.keys())) {
    if (!retainedMediaFileIds.has(id) && workerDecodedBitmapPool.size > Math.min(limit, retainedMediaFileIds.size + 1)) {
      closeAndDeleteWorkerBitmap(id);
    }
  }
  while (workerDecodedBitmapPool.size > limit) {
    const oldestId = workerDecodedBitmapPool.keys().next().value;
    if (!oldestId) break;
    closeAndDeleteWorkerBitmap(oldestId);
  }
}

export function getWorkerDecodedBitmap(fileId: string): ImageBitmap | null {
  const existing = workerDecodedBitmapPool.get(fileId);
  if (!existing) return null;
  workerDecodedBitmapPool.delete(fileId);
  workerDecodedBitmapPool.set(fileId, existing);
  return existing;
}

export function getCachedPhotoMedia(
  fileId: string,
  variant: 'auto' | 'full' = 'auto'
): ResolvedPhotoMedia | null {
  const exact = mediaCache.get(`${fileId}:${variant}`);
  if (exact) return exact.media;
  if (variant === 'auto') {
    const full = mediaCache.get(`${fileId}:full`);
    if (full) return full.media;
  }
  return null;
}

export function registerWorkerDecodedMedia(params: {
  file: DrivePhotoFile;
  blob?: Blob;
  bitmap?: ImageBitmap;
  fallbackUrl?: string;
  source: ResolvedPhotoMedia['source'];
  exif?: ParsedExif;
  folderId?: string;
  variant?: 'auto' | 'full';
  isCulled?: boolean;
  skipIdbPersist?: boolean;
}): ResolvedPhotoMedia | null {
  const {
    file,
    blob,
    bitmap,
    fallbackUrl,
    source,
    exif,
    folderId,
    variant = 'auto',
    isCulled,
    skipIdbPersist = false,
  } = params;

  if (exif?.orientation) {
    rememberOrientationHint(file.id, exif.orientation);
  }

  const cacheKey = `${file.id}:${variant}`;
  const pinInMemory = retainedMediaFileIds.has(file.id);
  const effectiveFolderId = folderId || file.parents?.[0];

  if (blob && blob.size > 0) {
    const url = URL.createObjectURL(blob);
    const resolved: ResolvedPhotoMedia = {
      url,
      source,
      exif: mergeExifWithDrive(file, exif),
      isObjectUrl: true,
    };
    setCacheEntry(cacheKey, resolved, pinInMemory);
    if (bitmap) {
      retainWorkerDecodedBitmap(file.id, bitmap);
    }
    if (!skipIdbPersist) {
      schedulePersistDetailPreview({
        cacheKey,
        file,
        folderId: effectiveFolderId,
        variant,
        sourceBlob: blob,
        source,
        exif: resolved.exif,
        isCulled,
      });
    } else if (effectiveFolderId) {
      schedulePersistMicroThumb(file, blob, effectiveFolderId);
    }
    return resolved;
  }

  if (fallbackUrl) {
    if (bitmap) {
      retainWorkerDecodedBitmap(file.id, bitmap);
    }
    const resolved: ResolvedPhotoMedia = {
      url: fallbackUrl,
      source,
      exif: mergeExifWithDrive(file, exif),
      isObjectUrl: false,
    };
    setCacheEntry(cacheKey, resolved, pinInMemory);
    return resolved;
  }

  if (bitmap) {
    try {
      bitmap.close();
    } catch {
      // Ignore close error
    }
  }
  return null;
}

function getEffectiveMediaCacheLimit(): number {
  if (activeSeriesCacheBudget > 0) {
    return Math.min(80, Math.max(BASE_MAX_MEDIA_CACHE_SIZE, activeSeriesCacheBudget + 8));
  }
  return BASE_MAX_MEDIA_CACHE_SIZE;
}

export function setSeriesCacheBudget(seriesSize: number): void {
  activeSeriesCacheBudget = seriesSize > 0 ? Math.max(0, Math.round(seriesSize)) : 0;
}

function extractFileIdFromCacheKey(key: string): string {
  return key.replace(/:(auto|full|temp-raw|raw-sharp|upgrade)$/, '');
}

export function setRetainedMediaFileIds(ids: Iterable<string>): void {
  retainedMediaFileIds.clear();
  for (const id of ids) {
    if (id) retainedMediaFileIds.add(id);
  }
}

export function subscribeMediaCacheEviction(
  listener: (fileId: string, evictedUrl: string) => void
): () => void {
  mediaEvictionListeners.add(listener);
  return () => {
    mediaEvictionListeners.delete(listener);
  };
}

function isUrlStillReferencedInMediaCache(url: string, ignoreKey: string): boolean {
  for (const [k, entry] of mediaCache.entries()) {
    if (k !== ignoreKey && entry.media.url === url) {
      return true;
    }
  }
  return false;
}

function evictMediaCacheKey(evictKey: string): void {
  const oldest = mediaCache.get(evictKey);
  const evictedFileId = extractFileIdFromCacheKey(evictKey);
  mediaCache.delete(evictKey);
  if (!oldest) return;

  if (!retainedMediaFileIds.has(evictedFileId)) {
    closeAndDeleteWorkerBitmap(evictedFileId);
  }

  for (const listener of mediaEvictionListeners) {
    try {
      listener(evictedFileId, oldest.media.url);
    } catch {
      // Ignore listener error
    }
  }
  if (
    oldest.media.isObjectUrl &&
    !isUrlStillReferencedInMediaCache(oldest.media.url, evictKey)
  ) {
    URL.revokeObjectURL(oldest.media.url);
  }
}

/**
 * Aggressively trims non-retained entries from RAM cache and GPU decoded pool,
 * especially when entering open-series mode or stepping forward through large folders.
 */
export function trimMediaMemoryCache(keepIds?: Iterable<string>): void {
  if (keepIds) {
    setRetainedMediaFileIds(keepIds);
  }
  const limit = getEffectiveMediaCacheLimit();
  const targetSize = activeSeriesCacheBudget > 0 ? Math.max(limit, retainedMediaFileIds.size + 2) : limit;

  // First pass: drop any non-retained entries when above a minimal non-retained cushion
  const maxAllowed = activeSeriesCacheBudget > 0 ? retainedMediaFileIds.size + 2 : targetSize;
  if (mediaCache.size > maxAllowed) {
    for (const k of Array.from(mediaCache.keys())) {
      if (mediaCache.size <= maxAllowed) break;
      const fId = extractFileIdFromCacheKey(k);
      if (!retainedMediaFileIds.has(fId)) {
        evictMediaCacheKey(k);
      }
    }
  }

  // Keep decoded GPU textures strictly aligned with retained URLs
  const retainedUrls = new Set<string>();
  for (const [k, entry] of mediaCache.entries()) {
    if (retainedMediaFileIds.has(extractFileIdFromCacheKey(k))) {
      retainedUrls.add(entry.media.url);
    }
  }
  trimDecodedImagePool(retainedUrls);
  trimWorkerBitmapPool();
}

function setCacheEntry(key: string, value: ResolvedPhotoMedia, pinned = false) {
  if (mediaCache.has(key)) {
    const prev = mediaCache.get(key)!;
    if (
      prev.media.isObjectUrl &&
      prev.media.url !== value.url &&
      !isUrlStillReferencedInMediaCache(prev.media.url, key)
    ) {
      URL.revokeObjectURL(prev.media.url);
    }
    mediaCache.delete(key);
  }
  const fIdSelf = extractFileIdFromCacheKey(key);
  const effectivePinned = pinned || retainedMediaFileIds.has(fIdSelf);
  mediaCache.set(key, { media: value, pinned: effectivePinned });

  const limit = getEffectiveMediaCacheLimit();
  while (mediaCache.size > limit) {
    let evictKey: string | undefined;
    for (const [k] of mediaCache.entries()) {
      const fId = extractFileIdFromCacheKey(k);
      if (!retainedMediaFileIds.has(fId)) {
        evictKey = k;
        break;
      }
    }
    if (!evictKey) {
      break;
    }
    evictMediaCacheKey(evictKey);
  }
}

export function setMediaCachePinned(fileId: string, pinned: boolean) {
  const shouldPin = pinned && retainedMediaFileIds.has(fileId);
  for (const key of [`${fileId}:auto`, `${fileId}:full`, `${fileId}:temp-raw`]) {
    const entry = mediaCache.get(key);
    if (entry) {
      entry.pinned = shouldPin;
    }
  }
}

export function getCachedMediaSnapshot(): Record<string, ResolvedPhotoMedia> {
  const out: Record<string, ResolvedPhotoMedia> = {};
  for (const [key, entry] of mediaCache.entries()) {
    if (key.endsWith(':auto') || key.endsWith(':full')) {
      const fileId = key.replace(/:(auto|full)$/, '');
      if (!out[fileId] || key.endsWith(':full')) {
        out[fileId] = entry.media;
      }
    }
  }
  return out;
}

interface FilmstripCacheEntry {
  url: string;
  isObjectUrl: boolean;
}

const filmstripCache = new Map<string, FilmstripCacheEntry>();
const MAX_FILMSTRIP_CACHE_SIZE = 450;

function setFilmstripCacheEntry(key: string, value: FilmstripCacheEntry) {
  if (filmstripCache.has(key)) {
    const prev = filmstripCache.get(key)!;
    if (prev.isObjectUrl && prev.url !== value.url) {
      URL.revokeObjectURL(prev.url);
    }
    filmstripCache.delete(key);
  }
  filmstripCache.set(key, value);
  if (filmstripCache.size > MAX_FILMSTRIP_CACHE_SIZE) {
    const oldestKey = filmstripCache.keys().next().value;
    if (oldestKey) {
      const oldest = filmstripCache.get(oldestKey);
      if (oldest?.isObjectUrl) {
        URL.revokeObjectURL(oldest.url);
      }
      filmstripCache.delete(oldestKey);
    }
  }
}

export function invalidateThumbnailCache(fileId: string) {
  const fsEntry = filmstripCache.get(fileId);
  if (fsEntry) {
    if (fsEntry.isObjectUrl) {
      URL.revokeObjectURL(fsEntry.url);
    }
    filmstripCache.delete(fileId);
  }
  const suffixKeys = [
    fileId,
    `${fileId}:auto`,
    `${fileId}:full`,
    `${fileId}:temp-raw`,
    `${fileId}:raw-sharp`,
    `${fileId}:upgrade`,
  ];
  for (const k of suffixKeys) {
    const mEntry = mediaCache.get(k);
    if (mEntry) {
      if (mEntry.media.isObjectUrl) {
        URL.revokeObjectURL(mEntry.media.url);
      }
      mediaCache.delete(k);
    }
  }
  closeAndDeleteWorkerBitmap(fileId);
}

export function clearFilmstripCache() {
  for (const entry of filmstripCache.values()) {
    if (entry.isObjectUrl) {
      URL.revokeObjectURL(entry.url);
    }
  }
  filmstripCache.clear();
}

export function clearMediaCache() {
  for (const entry of mediaCache.values()) {
    if (entry.media.isObjectUrl) {
      URL.revokeObjectURL(entry.media.url);
    }
  }
  mediaCache.clear();
  for (const fileId of Array.from(workerDecodedBitmapPool.keys())) {
    closeAndDeleteWorkerBitmap(fileId);
  }
  clearFilmstripCache();
}

export function getCachedFilmstripThumbnailUrl(fileId: string): string | null {
  return (
    filmstripCache.get(fileId)?.url ||
    getCachedMicroThumbMemoryUrl(fileId) ||
    null
  );
}

export function getFilmstripThumbnailUrl(thumbnailLink?: string): string | null {
  if (!thumbnailLink) return null;
  if (/=s\d+$/.test(thumbnailLink)) {
    return thumbnailLink.replace(/=s\d+$/, '=s160');
  }
  return thumbnailLink;
}

export function getGalleryThumbnailUrl(
  thumbnailLink?: string,
  highDetail = false
): string | null {
  if (!thumbnailLink) return null;
  if (/=s\d+$/.test(thumbnailLink)) {
    return thumbnailLink.replace(/=s\d+$/, highDetail ? '=s360' : '=s220');
  }
  return thumbnailLink;
}

export function getFastPreviewThumbnailUrl(thumbnailLink?: string): string | null {
  if (!thumbnailLink) return null;
  if (/=s\d+$/.test(thumbnailLink)) {
    return thumbnailLink.replace(/=s\d+$/, '=s360');
  }
  return thumbnailLink;
}

export function getUpgradeThumbnailUrl(thumbnailLink?: string): string | null {
  if (!thumbnailLink) return null;
  if (/=s\d+$/.test(thumbnailLink)) {
    return thumbnailLink.replace(/=s\d+$/, '=s1600');
  }
  return thumbnailLink;
}

export function getSeriesHighQualityThumbnailUrl(
  thumbnailLink?: string
): string | null {
  if (!thumbnailLink) return null;
  if (/=s\d+$/.test(thumbnailLink)) {
    return thumbnailLink.replace(/=s\d+$/, '=s2400');
  }
  return thumbnailLink;
}

const inFlightMicroSaveIds = new Set<string>();
const backgroundEncodeQueue: Array<() => Promise<void>> = [];
let backgroundEncodeRunning = false;

function enqueueBackgroundEncode(task: () => Promise<void>): void {
  backgroundEncodeQueue.push(task);
  if (backgroundEncodeRunning) return;
  backgroundEncodeRunning = true;
  void (async () => {
    try {
      while (backgroundEncodeQueue.length > 0) {
        await waitForBackgroundSlot();
        const next = backgroundEncodeQueue.shift();
        if (next) {
          await next().catch(() => {});
        }
        await new Promise<void>((r) => window.setTimeout(r, 24));
      }
    } finally {
      backgroundEncodeRunning = false;
    }
  })();
}

let fullBlobThumbLock: Promise<void> = Promise.resolve();

export function runSerializedFullBlobDownscale<T>(
  fn: () => Promise<T>
): Promise<T> {
  const next = fullBlobThumbLock.then(fn, fn);
  fullBlobThumbLock = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

let sharedDownscaleCanvas: HTMLCanvasElement | null = null;

export async function downscaleBlobToJpegBlob(
  blob: Blob,
  targetMaxDim: number,
  quality: number
): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') {
    return null;
  }
  let bitmap: ImageBitmap | null = null;
  try {
    // Decode without resizeWidth options first so all mobile WebViews honor EXIF Orientation (from-image)
    bitmap = await createImageBitmap(blob);
    const maxSide = Math.max(bitmap.width, bitmap.height);
    if (maxSide <= targetMaxDim && blob.size <= 75_000 && blob.type === 'image/jpeg') {
      return blob;
    }
    const ratio = maxSide > 0 ? Math.min(1, targetMaxDim / maxSide) : 1;
    const w = Math.max(1, Math.round(bitmap.width * ratio));
    const h = Math.max(1, Math.round(bitmap.height * ratio));
    if (!sharedDownscaleCanvas) {
      sharedDownscaleCanvas = document.createElement('canvas');
    }
    const canvas = sharedDownscaleCanvas;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality)
    );
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

async function downscaleBlobToFilmstripResult(
  blob: Blob,
  targetMaxDim = 200
): Promise<{ url: string; blob: Blob }> {
  // Fast zero-reencode path: if embedded EXIF/THMB JPEG is already compact (<= 65 KB),
  // create ObjectURL directly in 0.01ms without blocking the main thread on canvas.toBlob!
  if (blob.size > 0 && blob.size <= 65_536 && blob.type === 'image/jpeg') {
    return { url: URL.createObjectURL(blob), blob };
  }
  const scaled = await downscaleBlobToJpegBlob(blob, targetMaxDim, 0.75);
  const outBlob = scaled || blob;
  return { url: URL.createObjectURL(outBlob), blob: outBlob };
}

function schedulePersistMicroThumb(
  file: DrivePhotoFile,
  sourceBlob: Blob,
  folderId?: string,
  folderCulledAtMs?: number | null
): void {
  const effectiveFolderId = folderId || file.parents?.[0];
  if (!effectiveFolderId || inFlightMicroSaveIds.has(file.id)) return;
  if (getCachedMicroThumbMemoryUrl(file.id)) return;
  inFlightMicroSaveIds.add(file.id);
  enqueueBackgroundEncode(async () => {
    try {
      const existing = await getCachedMicroThumbBlob(file.id);
      if (existing) {
        rememberMicroThumbMemoryUrl(file.id, URL.createObjectURL(existing));
        return;
      }
      await waitForBackgroundSlot();
      const microBlob =
        sourceBlob.size <= 22_000 && sourceBlob.type === 'image/jpeg'
          ? sourceBlob
          : await downscaleBlobToJpegBlob(sourceBlob, 112, 0.45);
      if (microBlob && microBlob.size > 0) {
        await saveMicroThumb({
          fileId: file.id,
          folderId: effectiveFolderId,
          blob: microBlob,
          folderCulledAtMs,
        });
      }
    } finally {
      inFlightMicroSaveIds.delete(file.id);
    }
  });
}

function schedulePersistDetailPreview(params: {
  cacheKey: string;
  file: DrivePhotoFile;
  folderId?: string;
  variant: 'auto' | 'full';
  sourceBlob: Blob;
  source: ResolvedPhotoMedia['source'];
  exif?: ParsedExif;
  isCulled?: boolean;
}): void {
  const effectiveFolderId = params.folderId || params.file.parents?.[0];
  if (!effectiveFolderId || !params.sourceBlob || params.sourceBlob.size === 0) {
    return;
  }
  const culledAtMs = params.isCulled ? Date.now() : null;
  schedulePersistMicroThumb(params.file, params.sourceBlob, effectiveFolderId);

  enqueueBackgroundEncode(async () => {
    await waitForBackgroundSlot();
    let storeBlob = params.sourceBlob;
    const targetDim = params.variant === 'full' ? 2048 : 1920;
    const targetQuality = params.variant === 'full' ? 0.87 : 0.85;
    if (storeBlob.size > 1_200_000) {
      const compact = await downscaleBlobToJpegBlob(
        storeBlob,
        targetDim,
        targetQuality
      );
      if (compact && compact.size > 0 && compact.size < storeBlob.size) {
        storeBlob = compact;
      }
    }
    await waitForBackgroundSlot();
    await saveDetailPreview({
      cacheKey: params.cacheKey,
      fileId: params.file.id,
      folderId: effectiveFolderId,
      variant: params.variant,
      blob: storeBlob,
      source: params.source,
      exif: params.exif,
      culledAtMs,
    });
  });
}

export async function resolveFilmstripThumbnailUrl(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal,
  options?: { folderId?: string; preferMicroOnly?: boolean }
): Promise<string | null> {
  if (signal?.aborted) return null;
  const cached = filmstripCache.get(file.id);
  if (cached) {
    filmstripCache.delete(file.id);
    filmstripCache.set(file.id, cached);
    return cached.url;
  }

  const folderId = options?.folderId || file.parents?.[0];
  const cachedMicroMem = getCachedMicroThumbMemoryUrl(file.id);
  if (cachedMicroMem) {
    setFilmstripCacheEntry(file.id, { url: cachedMicroMem, isObjectUrl: false });
    return cachedMicroMem;
  }
  if (options?.preferMicroOnly) {
    const microBlob = await getCachedMicroThumbBlob(file.id);
    if (signal?.aborted) return null;
    if (microBlob) {
      const url = rememberMicroThumbMemoryUrl(
        file.id,
        URL.createObjectURL(microBlob)
      );
      return url;
    }
  }

  const isLocal = Boolean(file.sourceKind && file.sourceKind !== 'drive');

  if (!isLocal && file.thumbnailLink) {
    const url = getFilmstripThumbnailUrl(file.thumbnailLink);
    if (url) {
      setFilmstripCacheEntry(file.id, { url, isObjectUrl: false });
      return url;
    }
  }

  // Native Android RAW/CR3 mini-thumbnailer writes physically rotated disk cache JPEGs
  // on a dedicated lightweight queue without Base64 bridge overhead or revocable blob URLs.
  if (
    file.isRaw &&
    file.sourceKind === 'android-saf' &&
    file.nativeUri &&
    window.FrameCullNative?.extractRawThumbnailUrl
  ) {
    try {
      const nativeRawThumb = await window.FrameCullNative.extractRawThumbnailUrl(
        file.nativeUri
      );
      if (signal?.aborted) return null;
      if (nativeRawThumb?.url) {
        if (nativeRawThumb.orientation) {
          rememberOrientationHint(file.id, nativeRawThumb.orientation);
        }
        setFilmstripCacheEntry(file.id, {
          url: nativeRawThumb.url,
          isObjectUrl: false,
        });
        if (folderId) {
          void fetch(nativeRawThumb.url)
            .then((r) => (r.ok ? r.blob() : null))
            .then((b) => {
              if (b) schedulePersistMicroThumb(file, b, folderId);
            })
            .catch(() => {});
        }
        return nativeRawThumb.url;
      }
    } catch {
      // Fall through to header/slice extraction
    }
  }

  // Only use Android SAF's OS getDocumentThumbnail for standard non-RAW images,
  // because Android ExternalStorageProvider returns sideways unrotated thumbnails for RAW/CR3 files.
  if (
    !file.isRaw &&
    file.sourceKind === 'android-saf' &&
    file.nativeUri &&
    window.FrameCullNative?.getThumbnailUrl
  ) {
    try {
      const nativeThumb = await window.FrameCullNative.getThumbnailUrl(
        file.nativeUri
      );
      if (signal?.aborted) return null;
      if (nativeThumb) {
        setFilmstripCacheEntry(file.id, {
          url: nativeThumb,
          isObjectUrl: nativeThumb.startsWith('blob:'),
        });
        if (folderId) {
          void fetch(nativeThumb)
            .then((r) => (r.ok ? r.blob() : null))
            .then((b) => {
              if (b) schedulePersistMicroThumb(file, b, folderId);
            })
            .catch(() => {});
        }
        return nativeThumb;
      }
    } catch {
      // Fall through to header/slice extraction
    }
  }

  // Fast IDB micro-thumb check before reading disk slices
  const idbMicroBeforeSlice = await getCachedMicroThumbBlob(file.id);
  if (signal?.aborted) return null;
  if (idbMicroBeforeSlice) {
    const microUrl = rememberMicroThumbMemoryUrl(
      file.id,
      URL.createObjectURL(idbMicroBeforeSlice)
    );
    setFilmstripCacheEntry(file.id, { url: microUrl, isObjectUrl: false });
    return microUrl;
  }

  if (isLocal && !file.isRaw) {
    const blobFile = file.localFile;
    if (blobFile) {
      if (signal?.aborted) return null;
      const headerThumb = await extractFastHeaderThumbnailBlob(
        token,
        file,
        signal
      ).catch(() => null);
      if (signal?.aborted) return null;
      if (headerThumb) {
        const { url, blob: outBlob } = await downscaleBlobToFilmstripResult(
          headerThumb,
          200
        );
        if (signal?.aborted) {
          URL.revokeObjectURL(url);
          return null;
        }
        setFilmstripCacheEntry(file.id, { url, isObjectUrl: true });
        schedulePersistMicroThumb(file, outBlob, folderId);
        return url;
      }
      await waitForBackgroundSlot(signal);
      if (signal?.aborted) return null;
      const { url, blob: outBlob } = await runSerializedFullBlobDownscale(() =>
        downscaleBlobToFilmstripResult(blobFile, 200)
      );
      if (signal?.aborted) {
        URL.revokeObjectURL(url);
        return null;
      }
      setFilmstripCacheEntry(file.id, { url, isObjectUrl: true });
      schedulePersistMicroThumb(file, outBlob, folderId);
      return url;
    }
  }

  const thumbBlob = await extractFastHeaderThumbnailBlob(
    token,
    file,
    signal
  ).catch(() => null);
  if (signal?.aborted) return null;
  if (!thumbBlob) {
    if (
      file.sourceKind === 'android-saf' &&
      !file.isRaw &&
      file.nativeUri &&
      window.FrameCullNative?.getFullMediaUrl
    ) {
      const fullUrl = await window.FrameCullNative
        .getFullMediaUrl(file.nativeUri)
        .catch(() => null);
      if (fullUrl && !signal?.aborted) {
        setFilmstripCacheEntry(file.id, {
          url: fullUrl,
          isObjectUrl: fullUrl.startsWith('blob:'),
        });
        return fullUrl;
      }
    }
    return null;
  }

  const { url, blob: outBlob } = await downscaleBlobToFilmstripResult(
    thumbBlob,
    200
  );
  if (signal?.aborted) {
    URL.revokeObjectURL(url);
    return null;
  }
  setFilmstripCacheEntry(file.id, { url, isObjectUrl: true });
  schedulePersistMicroThumb(file, outBlob, folderId);
  return url;
}

/**
 * Bounded LRU pool of decoded HTMLImageElement instances.
 * Keeping an HTMLImageElement alive after `img.decode()` locks its decoded bitmap texture
 * in the browser's GPU/compositor cache so switching photos in a series or swiping neighbors
 * paints in 0ms without re-decoding the JPEG on swap!
 */
const decodedImageLockPool = new Map<string, HTMLImageElement>();
const inFlightImageDecodes = new Map<string, Promise<void>>();
const BASE_DECODED_IMAGE_POOL_SIZE = 6;

function getEffectiveDecodedPoolLimit(): number {
  if (activeSeriesCacheBudget > 0) {
    return Math.min(28, Math.max(BASE_DECODED_IMAGE_POOL_SIZE, activeSeriesCacheBudget + 2));
  }
  return BASE_DECODED_IMAGE_POOL_SIZE;
}

export function trimDecodedImagePool(keepUrls?: Set<string>): void {
  const limit = getEffectiveDecodedPoolLimit();
  if (keepUrls && keepUrls.size > 0) {
    for (const url of Array.from(decodedImageLockPool.keys())) {
      if (!keepUrls.has(url) && decodedImageLockPool.size > Math.min(limit, keepUrls.size + 1)) {
        decodedImageLockPool.delete(url);
      }
    }
  }
  while (decodedImageLockPool.size > limit) {
    let evicted = false;
    if (keepUrls && keepUrls.size > 0) {
      for (const url of decodedImageLockPool.keys()) {
        if (!keepUrls.has(url)) {
          decodedImageLockPool.delete(url);
          evicted = true;
          break;
        }
      }
    }
    if (!evicted) {
      const oldestKey = decodedImageLockPool.keys().next().value;
      if (!oldestKey) break;
      decodedImageLockPool.delete(oldestKey);
    }
  }
}

export function predecodeAndRetainImage(
  url: string | null | undefined,
  timeoutMs = 10_000,
  retainInPool = true
): Promise<void> {
  if (!url) return Promise.resolve();
  const existing = decodedImageLockPool.get(url);
  if (existing) {
    decodedImageLockPool.delete(url);
    decodedImageLockPool.set(url, existing);
    return Promise.resolve();
  }
  const inFlight = inFlightImageDecodes.get(url);
  if (inFlight) return inFlight;

  const task = new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    let settled = false;

    const finishOk = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      inFlightImageDecodes.delete(url);
      if (retainInPool) {
        decodedImageLockPool.set(url, img);
        trimDecodedImagePool();
      }
      resolve();
    };

    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      inFlightImageDecodes.delete(url);
      reject(err);
    };

    const timer = window.setTimeout(() => {
      img.onload = null;
      img.onerror = null;
      finishErr(new Error('Image load timed out'));
    }, timeoutMs);

    img.onload = () => {
      if (typeof img.decode === 'function') {
        img.decode().then(finishOk, finishOk);
      } else {
        finishOk();
      }
    };
    img.onerror = () => {
      finishErr(new Error('Image load failed'));
    };
    img.src = url;
  });

  inFlightImageDecodes.set(url, task);
  return task;
}

export function preloadImageUrl(url: string, timeoutMs = 12_000): Promise<void> {
  return predecodeAndRetainImage(url, timeoutMs, true);
}

function resolveRawHeaderOrientation(
  file: DrivePhotoFile,
  buffer: ArrayBuffer,
  cr3Cmt1?: Uint8Array
): number | undefined {
  if (cr3Cmt1) {
    const o = parseTiffIfdMetadata(cr3Cmt1, 0)?.orientation;
    if (o !== undefined) {
      rememberOrientationHint(file.id, o);
      return o;
    }
  }
  if (file.fileExtension !== 'cr3') {
    const o = parseTiffIfdMetadata(new Uint8Array(buffer), 0)?.orientation;
    if (o !== undefined) {
      rememberOrientationHint(file.id, o);
      return o;
    }
  }
  return orientationHintCache.get(file.id);
}

/**
 * Extracts a quick temporary low-res upright JPEG from the first 512 KB of a RAW/CR3 file.
 */
export async function resolveFastTempRawPreview(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<string | null> {
  if (!file.isRaw) return null;
  const cacheKey = `${file.id}:temp-raw`;
  const cached = mediaCache.get(cacheKey);
  if (cached) return cached.media.url;

  try {
    const buffer = await fetchPhotoBytes(
      token,
      file,
      getHeaderRange(file, 524288), // 512 KB
      signal
    );
    const cr3 =
      file.fileExtension === 'cr3' ? findCanonPrvwOrExifInCr3(buffer) : {};
    const outerOrientation = resolveRawHeaderOrientation(
      file,
      buffer,
      cr3.cmt1
    );
    const jpegBytes =
      cr3.prvwJpeg ||
      cr3.thmbJpeg ||
      extractLargestEmbeddedJpeg(buffer, { minBytes: 1024 });
    if (!jpegBytes) return null;

    const normalized = ensureJpegExifOrientation(jpegBytes, outerOrientation);
    const blob = new Blob([normalized], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    setCacheEntry(cacheKey, {
      url,
      source: 'raw-embedded',
      isObjectUrl: true,
    });
    return url;
  } catch {
    return null;
  }
}

/**
 * Extracts a lightweight upright thumbnail Blob (EXIF APP1 thumbnail inside JPGs, or THMB/PRVW inside RAW/CR3)
 * via tiny Range/Slice requests so both Filmstrip thumbnails and visual similarity fingerprinting
 * receive properly oriented upright frames.
 */
export async function extractFastHeaderThumbnailBlob(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<Blob | null> {
  try {
    let jpegBytes: Uint8Array | null = null;
    let outerOrientation: number | undefined = orientationHintCache.get(file.id);

    if (file.isRaw) {
      // Stage 1: First 512 KB covers Canon CR3 CMT1 + THMB box and most RAW embedded thumbnails
      const buf512 = await fetchPhotoBytes(
        token,
        file,
        getHeaderRange(file, 524288),
        signal
      );
      const cr3Info =
        file.fileExtension === 'cr3' ? findCanonPrvwOrExifInCr3(buf512) : {};
      outerOrientation =
        resolveRawHeaderOrientation(file, buf512, cr3Info.cmt1) ??
        outerOrientation;
      jpegBytes =
        cr3Info.prvwJpeg ||
        cr3Info.thmbJpeg ||
        extractLargestEmbeddedJpeg(buf512, { minBytes: 1024 });

      // Stage 2: Escalate to 2 MB when Sony/Nikon/CR3 places embedded thumbnail deeper
      if (
        !jpegBytes &&
        (file.sizeBytes === 0 || file.sizeBytes > 524288) &&
        !signal?.aborted
      ) {
        const buf2m = await fetchPhotoBytes(
          token,
          file,
          getHeaderRange(file, 2097152),
          signal
        );
        const cr3Info2 =
          file.fileExtension === 'cr3' ? findCanonPrvwOrExifInCr3(buf2m) : {};
        outerOrientation =
          resolveRawHeaderOrientation(file, buf2m, cr3Info2.cmt1) ??
          outerOrientation;
        jpegBytes =
          cr3Info2.prvwJpeg ||
          cr3Info2.thmbJpeg ||
          extractLargestEmbeddedJpeg(buf2m, { minBytes: 1024 });
      }
    } else {
      // Standard JPG: read outer EXIF Orientation first, then extract embedded APP1 thumbnail
      const buf128 = await fetchPhotoBytes(
        token,
        file,
        getHeaderRange(file, 131072),
        signal
      );
      outerOrientation =
        parseTiffIfdMetadata(new Uint8Array(buf128), 0)?.orientation ??
        outerOrientation;
      rememberOrientationHint(file.id, outerOrientation);
      jpegBytes = extractLargestEmbeddedJpeg(buf128, {
        minBytes: 1024,
        startOffset: 12,
      });
    }

    if (!jpegBytes) return null;

    const normalized = ensureJpegExifOrientation(jpegBytes, outerOrientation);
    return new Blob([normalized], { type: 'image/jpeg' });
  } catch {
    return null;
  }
}

export async function resolveFastHeaderThumbnailUrl(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<string | null> {
  const blob = await extractFastHeaderThumbnailBlob(token, file, signal);
  if (!blob) return null;
  return URL.createObjectURL(blob);
}

/**
 * Extracts a high-resolution upright embedded JPEG + EXIF from any RAW file
 * (Canon CR3 PRVW/THMB, Sony ARW, Nikon NEF, CR2, DNG, SAF native extractor).
 * Does not touch mediaCache or decodedImageLockPool — safe for batch folder preloading.
 */
export async function extractRawEmbeddedPreviewBlob(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<{ blob: Blob; exif?: ParsedExif } | null> {
  if (!file.isRaw) return null;

  // Fast Zero-Base64 Android SAF native extractor when available
  if (
    file.sourceKind === 'android-saf' &&
    file.nativeUri &&
    window.FrameCullNative?.extractRawPreviewUrl
  ) {
    try {
      const [nativeExtracted, headerBuf] = await Promise.all([
        window.FrameCullNative.extractRawPreviewUrl(file.nativeUri),
        fetchPhotoBytes(
          token,
          file,
          getHeaderRange(file, 262144),
          signal
        ).catch(() => null),
      ]);
      if (signal?.aborted) return null;
      if (nativeExtracted?.url) {
        let exif: ParsedExif | undefined;
        if (headerBuf) {
          if (file.fileExtension === 'cr3') {
            const cr3Hdr = findCanonPrvwOrExifInCr3(headerBuf);
            const m1 = cr3Hdr.cmt1
              ? parseTiffIfdMetadata(cr3Hdr.cmt1, 0)
              : undefined;
            const m2 = cr3Hdr.cmt2
              ? parseTiffIfdMetadata(cr3Hdr.cmt2, 0)
              : undefined;
            exif = binaryMetaToParsedExif(m1, m2);
          } else {
            exif = await parseExifSafe(headerBuf);
          }
        }
        if (nativeExtracted.orientation) {
          rememberOrientationHint(file.id, nativeExtracted.orientation);
        }
        const resp = await fetch(nativeExtracted.url, { signal });
        if (resp.ok) {
          const nativeBlob = await resp.blob();
          if (nativeBlob.size > 0) {
            return { blob: nativeBlob, exif: mergeExifWithDrive(file, exif) };
          }
        }
      }
    } catch {
      // Fall through to JS Range/Slice extraction
    }
  }

  // Stage 1: Read first 4 MB (covers metadata + embedded preview in most RAWs & CR3s)
  let buffer = await fetchPhotoBytes(
    token,
    file,
    getHeaderRange(file, 4194304),
    signal
  );

  let cr3Info: Cr3BoxParseResult =
    file.fileExtension === 'cr3' ? findCanonPrvwOrExifInCr3(buffer) : {};
  let outerOrientation = resolveRawHeaderOrientation(
    file,
    buffer,
    cr3Info.cmt1
  );

  let jpegBytes: Uint8Array | null =
    cr3Info.prvwJpeg ||
    extractLargestEmbeddedJpeg(buffer) ||
    cr3Info.thmbJpeg ||
    null;

  // Stage 2 for Canon CR3: if PRVW JPEG exceeded the initial 4 MB slice, fetch ONLY the exact PRVW UUID box!
  if (
    file.fileExtension === 'cr3' &&
    (!jpegBytes || jpegBytes.byteLength < 45000) &&
    (file.sizeBytes === 0 || file.sizeBytes > 4194304)
  ) {
    const targetBox =
      cr3Info.prvwBoxRange ||
      (await locateCanonCr3PrvwBoxRange(token, file, signal));

    if (
      targetBox &&
      targetBox.end > targetBox.start &&
      targetBox.end - targetBox.start <= 20 * 1024 * 1024
    ) {
      const prvwBuf = await fetchPhotoBytes(
        token,
        file,
        { start: targetBox.start, end: targetBox.end - 1 },
        signal
      ).catch(() => null);
      if (prvwBuf) {
        const parsedPrvw = findCanonPrvwOrExifInCr3(prvwBuf);
        const candidate =
          parsedPrvw.prvwJpeg ||
          extractLargestEmbeddedJpeg(prvwBuf, { minBytes: 2048 });
        if (
          candidate &&
          (!jpegBytes || candidate.byteLength > jpegBytes.byteLength)
        ) {
          jpegBytes = candidate;
        }
      }
    }
  }

  // Stage 3 for large RAWs (Sony ARW, Nikon NEF, Canon CR2, high-MP CR3): try 12 MB header slice before full file
  if (
    (!jpegBytes || jpegBytes.byteLength < 35000) &&
    (file.sizeBytes === 0 || file.sizeBytes > 4194304)
  ) {
    const buf12m = await fetchPhotoBytes(
      token,
      file,
      getHeaderRange(file, 12 * 1024 * 1024),
      signal
    ).catch(() => null);

    if (buf12m) {
      if (file.fileExtension === 'cr3') {
        const cr312 = findCanonPrvwOrExifInCr3(buf12m);
        if (!cr3Info.cmt1 && cr312.cmt1) cr3Info.cmt1 = cr312.cmt1;
        if (!cr3Info.cmt2 && cr312.cmt2) cr3Info.cmt2 = cr312.cmt2;
        outerOrientation =
          resolveRawHeaderOrientation(file, buf12m, cr3Info.cmt1) ??
          outerOrientation;
        const cand =
          cr312.prvwJpeg || extractLargestEmbeddedJpeg(buf12m) || cr312.thmbJpeg;
        if (cand && (!jpegBytes || cand.byteLength > jpegBytes.byteLength)) {
          jpegBytes = cand;
        }
      } else {
        outerOrientation =
          resolveRawHeaderOrientation(file, buf12m) ?? outerOrientation;
        const cand = extractLargestEmbeddedJpeg(buf12m);
        if (cand && (!jpegBytes || cand.byteLength > jpegBytes.byteLength)) {
          jpegBytes = cand;
        }
      }
      buffer = buf12m;
    }
  }

  // Final Stage 4 fallback for desktop/Drive RAWs where preview is stored at end of file (e.g. certain DNG/PEF)
  if (
    (!jpegBytes || jpegBytes.byteLength < 35000) &&
    file.sourceKind !== 'android-saf' &&
    file.sizeBytes > 12 * 1024 * 1024
  ) {
    const fullBuf = await fetchPhotoBytes(
      token,
      file,
      undefined,
      signal
    ).catch(() => null);
    if (fullBuf) {
      outerOrientation =
        resolveRawHeaderOrientation(file, fullBuf, cr3Info.cmt1) ??
        outerOrientation;
      const fullJpeg = extractLargestEmbeddedJpeg(fullBuf);
      if (
        fullJpeg &&
        (!jpegBytes || fullJpeg.byteLength > jpegBytes.byteLength)
      ) {
        jpegBytes = fullJpeg;
      }
      buffer = fullBuf;
    }
  }

  let exif: ParsedExif | undefined;
  if (cr3Info.cmt1 || cr3Info.cmt2) {
    const m1 = cr3Info.cmt1
      ? parseTiffIfdMetadata(cr3Info.cmt1, 0)
      : undefined;
    const m2 = cr3Info.cmt2
      ? parseTiffIfdMetadata(cr3Info.cmt2, 0)
      : undefined;
    exif = binaryMetaToParsedExif(m1, m2);
  }
  if (!exif) {
    exif = await parseExifSafe(buffer);
  }
  if (!exif && jpegBytes) {
    exif = await parseExifSafe(jpegBytes);
  }
  if (!outerOrientation && exif?.orientation) {
    outerOrientation = exif.orientation;
    rememberOrientationHint(file.id, outerOrientation);
  }

  if (!jpegBytes) return null;

  const normalized = ensureJpegExifOrientation(jpegBytes, outerOrientation);
  const blob = new Blob([normalized], { type: 'image/jpeg' });
  return { blob, exif: mergeExifWithDrive(file, exif) };
}

/**
 * Resolves a displayable high-resolution upright preview URL + EXIF for any Google Drive or Local/SD photo or RAW file (including Canon CR3).
 */
export async function resolvePhotoMedia(
  token: string | null | undefined,
  file: DrivePhotoFile,
  options: {
    preferFullRawDecode?: boolean;
    highQualitySeries?: boolean;
    isBackground?: boolean;
    signal?: AbortSignal;
    folderId?: string;
    isCulled?: boolean;
  } = {}
): Promise<ResolvedPhotoMedia> {
  const isLocal = Boolean(file.sourceKind && file.sourceKind !== 'drive');
  const variant: 'auto' | 'full' = options.preferFullRawDecode ? 'full' : 'auto';
  const cacheKey = `${file.id}:${variant}`;
  const pinInMemory = retainedMediaFileIds.has(file.id);
  const folderId = options.folderId || file.parents?.[0];

  const cached = mediaCache.get(cacheKey);
  if (cached) {
    if (pinInMemory) cached.pinned = true;
    return cached.media;
  }

  // Hydrate persistent IndexedDB detail preview before touching disk/RAW/Drive
  const idbCached =
    (await getCachedDetailPreview(cacheKey)) ||
    (!options.preferFullRawDecode
      ? await getCachedDetailPreview(`${file.id}:full`)
      : null);
  if (idbCached && !options.signal?.aborted) {
    const url = URL.createObjectURL(idbCached.blob);
    const resolved: ResolvedPhotoMedia = {
      url,
      source: idbCached.source,
      exif: mergeExifWithDrive(file, idbCached.exif),
      isObjectUrl: true,
    };
    setCacheEntry(cacheKey, resolved, pinInMemory);
    schedulePersistMicroThumb(file, idbCached.blob, folderId);
    return resolved;
  }

  // Fast path for standard local images (with automatic downscale for multi-MP background preloads so RAM stays flat)
  if (isLocal && !file.isRaw) {
    if (
      file.sourceKind === 'android-saf' &&
      file.nativeUri &&
      window.FrameCullNative?.getFullMediaUrl
    ) {
      const nativeUrl = await window.FrameCullNative.getFullMediaUrl(
        file.nativeUri
      );
      if (nativeUrl) {
        const headerSlice = await fetchPhotoBytes(
          token,
          file,
          getHeaderRange(file, 131072),
          options.signal
        ).catch(() => null);
        const exif = headerSlice ? await parseExifSafe(headerSlice) : undefined;
        const resolved: ResolvedPhotoMedia = {
          url: nativeUrl,
          source: 'local-media',
          exif: mergeExifWithDrive(file, exif),
          isObjectUrl: nativeUrl.startsWith('blob:'),
        };
        setCacheEntry(cacheKey, resolved, pinInMemory);
        if (folderId) {
          void fetch(nativeUrl)
            .then((r) => (r.ok ? r.blob() : null))
            .then((b) => {
              if (b) {
                schedulePersistDetailPreview({
                  cacheKey,
                  file,
                  folderId,
                  variant,
                  sourceBlob: b,
                  source: 'local-media',
                  exif: resolved.exif,
                  isCulled: options.isCulled,
                });
              }
            })
            .catch(() => {});
        }
        return resolved;
      }
    }

    const blobFile = file.localFile;
    if (blobFile) {
      const headerSlice = await blobFile
        .slice(0, Math.min(blobFile.size, 131072))
        .arrayBuffer()
        .catch(() => null);
      const exif = headerSlice ? await parseExifSafe(headerSlice) : undefined;

      // For huge local JPEGs (> 2.4 MB) preloaded in background or series, convert to crisp 2048px JPEG
      // so the browser does not retain 50MP uncompressed RGBA bitmaps (~150 MB each) in RAM/VRAM.
      let displayBlob: Blob = blobFile;
      if (
        !options.preferFullRawDecode &&
        blobFile.size > 2_400_000 &&
        (options.isBackground || options.highQualitySeries)
      ) {
        const compact = await runSerializedFullBlobDownscale(() =>
          downscaleBlobToJpegBlob(blobFile, 2048, 0.86)
        );
        if (options.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        if (compact && compact.size > 0 && compact.size < blobFile.size) {
          displayBlob = compact;
        }
      }

      const url = URL.createObjectURL(displayBlob);
      const resolved: ResolvedPhotoMedia = {
        url,
        source: 'local-media',
        exif: mergeExifWithDrive(file, exif),
        isObjectUrl: true,
      };
      setCacheEntry(cacheKey, resolved, pinInMemory);
      schedulePersistDetailPreview({
        cacheKey,
        file,
        folderId,
        variant,
        sourceBlob: displayBlob,
        source: 'local-media',
        exif: resolved.exif,
        isCulled: options.isCulled,
      });
      return resolved;
    }

    const buffer = await fetchPhotoBytes(token, file, undefined, options.signal);
    const exif = await parseExifSafe(buffer);
    const blob = new Blob([buffer], { type: file.mimeType || 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const resolved: ResolvedPhotoMedia = {
      url,
      source: 'local-media',
      exif: mergeExifWithDrive(file, exif),
      isObjectUrl: true,
    };
    setCacheEntry(cacheKey, resolved, pinInMemory);
    schedulePersistDetailPreview({
      cacheKey,
      file,
      folderId,
      variant,
      sourceBlob: blob,
      source: 'local-media',
      exif: resolved.exif,
      isCulled: options.isCulled,
    });
    return resolved;
  }

  // Fast path when Drive provides a thumbnailLink (works in ~100ms; series mode upgrades to =s2400 or full RAW preview)
  const thumbUrl = !isLocal
    ? options.highQualitySeries
      ? getSeriesHighQualityThumbnailUrl(file.thumbnailLink)
      : getUpgradeThumbnailUrl(file.thumbnailLink)
    : null;
  if (!options.preferFullRawDecode && thumbUrl) {
    const resolved: ResolvedPhotoMedia = {
      url: thumbUrl,
      source: 'drive-thumbnail',
      exif: mergeExifWithDrive(file),
      isObjectUrl: false,
    };
    setCacheEntry(cacheKey, resolved, pinInMemory);
    if (folderId && !inFlightMicroSaveIds.has(file.id)) {
      void extractFastHeaderThumbnailBlob(token, file, options.signal)
        .then((hdrBlob) => {
          if (hdrBlob) schedulePersistMicroThumb(file, hdrBlob, folderId);
        })
        .catch(() => {});
    }
    return resolved;
  }

  // For RAW files (CR3, CR2, NEF, ARW, DNG, ORF, RW2, RAF, PEF...):
  if (file.isRaw) {
    if (
      file.sourceKind === 'android-saf' &&
      file.nativeUri &&
      window.FrameCullNative?.extractRawPreviewUrl
    ) {
      const [nativeExtracted, headerBuf] = await Promise.all([
        window.FrameCullNative.extractRawPreviewUrl(file.nativeUri),
        fetchPhotoBytes(
          token,
          file,
          getHeaderRange(file, 262144),
          options.signal
        ).catch(() => null),
      ]);

      if (nativeExtracted?.url) {
        let exif: ParsedExif | undefined;
        if (headerBuf) {
          if (file.fileExtension === 'cr3') {
            const cr3Hdr = findCanonPrvwOrExifInCr3(headerBuf);
            const m1 = cr3Hdr.cmt1
              ? parseTiffIfdMetadata(cr3Hdr.cmt1, 0)
              : undefined;
            const m2 = cr3Hdr.cmt2
              ? parseTiffIfdMetadata(cr3Hdr.cmt2, 0)
              : undefined;
            exif = binaryMetaToParsedExif(m1, m2);
          } else {
            exif = await parseExifSafe(headerBuf);
          }
        }
        if (nativeExtracted.orientation) {
          rememberOrientationHint(file.id, nativeExtracted.orientation);
        }
        const resolved: ResolvedPhotoMedia = {
          url: nativeExtracted.url,
          source: 'raw-embedded',
          exif: mergeExifWithDrive(file, exif),
          isObjectUrl: nativeExtracted.url.startsWith('blob:'),
        };
        setCacheEntry(cacheKey, resolved, pinInMemory);
        if (folderId) {
          void fetch(nativeExtracted.url)
            .then((r) => (r.ok ? r.blob() : null))
            .then((b) => {
              if (b) {
                schedulePersistDetailPreview({
                  cacheKey,
                  file,
                  folderId,
                  variant,
                  sourceBlob: b,
                  source: 'raw-embedded',
                  exif: resolved.exif,
                  isCulled: options.isCulled,
                });
              }
            })
            .catch(() => {});
        }
        return resolved;
      }
    }

    const extracted = await extractRawEmbeddedPreviewBlob(
      token,
      file,
      options.signal
    );
    if (extracted) {
      const url = URL.createObjectURL(extracted.blob);
      const resolved: ResolvedPhotoMedia = {
        url,
        source: 'raw-embedded',
        exif: extracted.exif,
        isObjectUrl: true,
      };
      setCacheEntry(cacheKey, resolved, pinInMemory);
      schedulePersistDetailPreview({
        cacheKey,
        file,
        folderId,
        variant,
        sourceBlob: extracted.blob,
        source: 'raw-embedded',
        exif: resolved.exif,
        isCulled: options.isCulled,
      });
      return resolved;
    }

    // Fallback to Drive thumbnail if RAW had no embedded JPEG
    if (thumbUrl) {
      const resolved: ResolvedPhotoMedia = {
        url: thumbUrl,
        source: 'drive-thumbnail',
        exif: mergeExifWithDrive(file),
        isObjectUrl: false,
      };
      setCacheEntry(cacheKey, resolved, pinInMemory);
      return resolved;
    }

    throw new Error(`Soubor ${file.name} neobsahuje čitelný náhled JPEG.`);
  }

  // Standard Drive image full media fetch (when thumbnailLink is absent or full quality requested)
  const buffer = await fetchPhotoBytes(token, file, undefined, options.signal);
  const exif = await parseExifSafe(buffer);
  const mime = file.mimeType || 'image/jpeg';
  const rawBlob = new Blob([buffer], { type: mime });
  let displayBlob: Blob = rawBlob;
  if (rawBlob.size > 2_400_000 && !options.preferFullRawDecode) {
    const compact = await runSerializedFullBlobDownscale(() =>
      downscaleBlobToJpegBlob(rawBlob, 2048, 0.86)
    );
    if (compact && compact.size > 0 && compact.size < rawBlob.size) {
      displayBlob = compact;
    }
  }
  const url = URL.createObjectURL(displayBlob);
  const resolved: ResolvedPhotoMedia = {
    url,
    source: 'drive-media',
    exif: mergeExifWithDrive(file, exif),
    isObjectUrl: true,
  };
  setCacheEntry(cacheKey, resolved, pinInMemory);
  schedulePersistDetailPreview({
    cacheKey,
    file,
    folderId,
    variant,
    sourceBlob: displayBlob,
    source: 'drive-media',
    exif: resolved.exif,
    isCulled: options.isCulled,
  });
  return resolved;
}

export function formatShutterSpeed(exposureTime?: number): string | null {
  if (!exposureTime || exposureTime <= 0) return null;
  if (exposureTime >= 1) {
    return `${exposureTime.toFixed(1).replace(/\.0$/, '')}s`;
  }
  const denom = Math.round(1 / exposureTime);
  return `1/${denom}s`;
}

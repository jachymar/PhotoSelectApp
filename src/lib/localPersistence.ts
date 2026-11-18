import { ManualLockedSeries } from './burstGrouping';
import {
  FolderResumeTarget,
  PartialResetScope,
  PersistedDecisionEntry,
  PersistedFolderSummary,
  applyPartialResetToEntries,
  resolveEntryStates,
} from './cullPersistence';

const DB_NAME = 'framecull_local_db';
const DB_VERSION = 2;
const STORE_NAME = 'folder_sessions';
const LS_FALLBACK_PREFIX = 'framecull_local_session_';
const LS_RESUME_POS_PREFIX = 'selectra_resume_pos_v1:';
const LS_MANUAL_SERIES_PREFIX = 'selectra_manual_series_v1:';

export interface LocalFolderSessionRecord {
  folderId: string;
  folderName: string;
  keepCount: number;
  trashCount: number;
  lastShotId?: string;
  lastShotName?: string;
  updatedAtMs: number;
  entries: Record<string, PersistedDecisionEntry>;
  manualSeries?: ManualLockedSeries[];
}

export function readLocalResumePosition(
  folderId: string
): FolderResumeTarget | null {
  try {
    const raw = window.localStorage.getItem(`${LS_RESUME_POS_PREFIX}${folderId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FolderResumeTarget;
    if (!parsed || (!parsed.shotId && !parsed.fileName && !parsed.stem)) {
      return null;
    }
    return {
      shotId: typeof parsed.shotId === 'string' ? parsed.shotId : undefined,
      fileName: typeof parsed.fileName === 'string' ? parsed.fileName : undefined,
      stem: typeof parsed.stem === 'string' ? parsed.stem : undefined,
      updatedAtMs: Number(parsed.updatedAtMs) || 0,
    };
  } catch {
    return null;
  }
}

export function writeLocalResumePosition(
  folderId: string,
  pos: FolderResumeTarget
): void {
  try {
    window.localStorage.setItem(
      `${LS_RESUME_POS_PREFIX}${folderId}`,
      JSON.stringify({
        shotId: pos.shotId,
        fileName: pos.fileName,
        stem: pos.stem,
        updatedAtMs: pos.updatedAtMs || Date.now(),
      })
    );
  } catch {
    // Ignore storage quota errors
  }
}

export function clearLocalResumePosition(folderId: string): void {
  try {
    window.localStorage.removeItem(`${LS_RESUME_POS_PREFIX}${folderId}`);
  } catch {
    // Ignore storage errors
  }
}

export function pickNewerResumeTarget(
  a: FolderResumeTarget | null | undefined,
  b: FolderResumeTarget | null | undefined
): FolderResumeTarget | null {
  const validA = a && (a.shotId || a.fileName || a.stem) ? a : null;
  const validB = b && (b.shotId || b.fileName || b.stem) ? b : null;
  if (!validA) return validB;
  if (!validB) return validA;
  return (validA.updatedAtMs || 0) >= (validB.updatedAtMs || 0)
    ? validA
    : validB;
}

function openLocalDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'folderId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open DB'));
  });
}

function normalizeEntriesMap(
  raw?: Record<string, PersistedDecisionEntry>
): Record<string, PersistedDecisionEntry> {
  if (!raw) return {};
  const normalized: Record<string, PersistedDecisionEntry> = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const states = resolveEntryStates(entry);
    if (states.selectState === 'unrated' && states.deleteState === 'unrated') {
      continue;
    }
    normalized[id] = {
      ...entry,
      decision: states.selectState === 'selected' ? 'pick' : 'reject',
      ...(states.selectState !== 'unrated'
        ? { selectState: states.selectState }
        : { selectState: undefined }),
      ...(states.deleteState !== 'unrated'
        ? { deleteState: states.deleteState }
        : { deleteState: undefined }),
    };
  }
  return normalized;
}

export async function loadAllLocalFolderSummaries(): Promise<
  Record<string, PersistedFolderSummary>
> {
  const map: Record<string, PersistedFolderSummary> = {};
  try {
    const db = await openLocalDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const list = (req.result as LocalFolderSessionRecord[]) || [];
        for (const rec of list) {
          if (!rec || !rec.folderId) continue;
          map[rec.folderId] = {
            folderId: rec.folderId,
            folderName: rec.folderName || 'Lokální složka',
            keepCount: Number(rec.keepCount) || 0,
            trashCount: Number(rec.trashCount) || 0,
            lastShotId: rec.lastShotId,
            lastShotName: rec.lastShotName,
            updatedAtMs: Number(rec.updatedAtMs) || 0,
          };
        }
        resolve();
      };
      req.onerror = () => resolve();
    });
  } catch {
    // Fallback to localStorage scan
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (!key || !key.startsWith(LS_FALLBACK_PREFIX)) continue;
        const raw = window.localStorage.getItem(key);
        if (!raw) continue;
        const rec = JSON.parse(raw) as LocalFolderSessionRecord;
        if (!rec || !rec.folderId) continue;
        map[rec.folderId] = {
          folderId: rec.folderId,
          folderName: rec.folderName || 'Lokální složka',
          keepCount: Number(rec.keepCount) || 0,
          trashCount: Number(rec.trashCount) || 0,
          lastShotId: rec.lastShotId,
          lastShotName: rec.lastShotName,
          updatedAtMs: Number(rec.updatedAtMs) || 0,
        };
      }
    } catch {
      // Ignore storage errors
    }
  }
  return map;
}

export async function removeSavedLocalFolderEntry(
  folderId: string
): Promise<void> {
  await resetLocalFolderDecisions(folderId);
}

function normalizeManualSeriesList(raw: unknown): ManualLockedSeries[] {
  if (!Array.isArray(raw)) return [];
  const out: ManualLockedSeries[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const ms = item as Partial<ManualLockedSeries>;
    if (
      typeof ms.id !== 'string' ||
      !ms.id ||
      !Array.isArray(ms.shotIds) ||
      ms.shotIds.length < 2
    ) {
      continue;
    }
    const shotIds = ms.shotIds
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .slice(0, 200);
    const stems = Array.isArray(ms.stems)
      ? ms.stems
          .filter((s): s is string => typeof s === 'string' && s.length > 0)
          .slice(0, 200)
      : [];
    if (shotIds.length < 2) continue;
    out.push({
      id: ms.id.slice(0, 128),
      shotIds,
      stems: stems.length >= 2 ? stems : shotIds,
      updatedAtMs: Number(ms.updatedAtMs) || Date.now(),
    });
  }
  return out;
}

export async function loadLocalManualSeries(
  folderId: string
): Promise<ManualLockedSeries[]> {
  try {
    const rawLs = window.localStorage.getItem(
      `${LS_MANUAL_SERIES_PREFIX}${folderId}`
    );
    if (rawLs) {
      const parsed = normalizeManualSeriesList(JSON.parse(rawLs));
      if (parsed.length > 0) return parsed;
    }
  } catch {
    // Ignore storage read error
  }
  const session = await loadLocalFolderSession(folderId);
  return session.manualSeries || [];
}

export async function saveLocalManualSeries(params: {
  folderId: string;
  folderName: string;
  manualSeries: ManualLockedSeries[];
}): Promise<void> {
  const { folderId, folderName, manualSeries } = params;
  const clean = normalizeManualSeriesList(manualSeries);
  try {
    if (clean.length === 0) {
      window.localStorage.removeItem(`${LS_MANUAL_SERIES_PREFIX}${folderId}`);
    } else {
      window.localStorage.setItem(
        `${LS_MANUAL_SERIES_PREFIX}${folderId}`,
        JSON.stringify(clean)
      );
    }
  } catch {
    // Ignore storage quota error
  }

  try {
    const existing = await loadLocalFolderSession(folderId);
    const db = await openLocalDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const record: LocalFolderSessionRecord = {
        folderId,
        folderName: folderName || 'Složka',
        keepCount: 0,
        trashCount: 0,
        ...(existing.lastShotId ? { lastShotId: existing.lastShotId } : {}),
        ...(existing.lastShotName
          ? { lastShotName: existing.lastShotName }
          : {}),
        updatedAtMs: existing.updatedAtMs || Date.now(),
        entries: existing.entries,
        ...(clean.length > 0 ? { manualSeries: clean } : {}),
      };
      for (const e of Object.values(existing.entries)) {
        const st = resolveEntryStates(e);
        if (st.selectState === 'selected') record.keepCount++;
        if (st.deleteState === 'trash') record.trashCount++;
      }
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // LocalStorage already synced above
  }
}

export async function loadLocalFolderSession(folderId: string): Promise<{
  entries: Record<string, PersistedDecisionEntry>;
  manualSeries?: ManualLockedSeries[];
  lastShotId?: string;
  lastShotName?: string;
  updatedAtMs: number;
}> {
  let lsManual: ManualLockedSeries[] = [];
  try {
    const rawMs = window.localStorage.getItem(
      `${LS_MANUAL_SERIES_PREFIX}${folderId}`
    );
    if (rawMs) lsManual = normalizeManualSeriesList(JSON.parse(rawMs));
  } catch {
    // Ignore
  }
  try {
    const db = await openLocalDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(folderId);
      req.onsuccess = () => {
        const record = req.result as LocalFolderSessionRecord | undefined;
        const dbManual = normalizeManualSeriesList(record?.manualSeries);
        const manualSeries = dbManual.length > 0 ? dbManual : lsManual;
        resolve({
          entries: normalizeEntriesMap(record?.entries),
          ...(manualSeries.length > 0 ? { manualSeries } : {}),
          lastShotId: record?.lastShotId,
          lastShotName: record?.lastShotName,
          updatedAtMs: Number(record?.updatedAtMs) || 0,
        });
      };
      req.onerror = () =>
        resolve({
          entries: {},
          ...(lsManual.length > 0 ? { manualSeries: lsManual } : {}),
          updatedAtMs: 0,
        });
    });
  } catch {
    try {
      const raw = window.localStorage.getItem(`${LS_FALLBACK_PREFIX}${folderId}`);
      if (!raw) {
        return {
          entries: {},
          ...(lsManual.length > 0 ? { manualSeries: lsManual } : {}),
          updatedAtMs: 0,
        };
      }
      const parsed = JSON.parse(raw) as LocalFolderSessionRecord;
      const parsedManual = normalizeManualSeriesList(parsed.manualSeries);
      const manualSeries = parsedManual.length > 0 ? parsedManual : lsManual;
      return {
        entries: normalizeEntriesMap(parsed.entries),
        ...(manualSeries.length > 0 ? { manualSeries } : {}),
        lastShotId: parsed.lastShotId,
        lastShotName: parsed.lastShotName,
        updatedAtMs: Number(parsed.updatedAtMs) || 0,
      };
    } catch {
      return {
        entries: {},
        ...(lsManual.length > 0 ? { manualSeries: lsManual } : {}),
        updatedAtMs: 0,
      };
    }
  }
}

export async function loadLocalFolderDecisions(
  folderId: string
): Promise<Record<string, PersistedDecisionEntry>> {
  const session = await loadLocalFolderSession(folderId);
  return session.entries;
}

export async function saveLocalFolderDecisions(params: {
  folderId: string;
  folderName: string;
  entries: Record<string, PersistedDecisionEntry>;
  lastShotId?: string;
  lastShotName?: string;
}): Promise<PersistedFolderSummary | null> {
  const { folderId, folderName, entries, lastShotId, lastShotName } = params;
  let keepCount = 0;
  let trashCount = 0;
  for (const e of Object.values(entries)) {
    const states = resolveEntryStates(e);
    if (states.selectState === 'selected') keepCount++;
    if (states.deleteState === 'trash') trashCount++;
  }

  const cleanLastShotId =
    typeof lastShotId === 'string' && lastShotId.trim()
      ? lastShotId.trim().slice(0, 256)
      : undefined;
  const cleanLastShotName =
    typeof lastShotName === 'string' && lastShotName.trim()
      ? lastShotName.trim().slice(0, 256)
      : undefined;

  const existingManualSeries = await loadLocalManualSeries(folderId).catch(
    () => []
  );

  if (
    Object.keys(entries).length === 0 &&
    !cleanLastShotId &&
    existingManualSeries.length === 0
  ) {
    await resetLocalFolderDecisions(folderId);
    return null;
  }

  const record: LocalFolderSessionRecord = {
    folderId,
    folderName,
    keepCount,
    trashCount,
    ...(cleanLastShotId ? { lastShotId: cleanLastShotId } : {}),
    ...(cleanLastShotName ? { lastShotName: cleanLastShotName } : {}),
    updatedAtMs: Date.now(),
    entries,
    ...(existingManualSeries.length > 0
      ? { manualSeries: existingManualSeries }
      : {}),
  };

  try {
    const db = await openLocalDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    try {
      window.localStorage.setItem(
        `${LS_FALLBACK_PREFIX}${folderId}`,
        JSON.stringify(record)
      );
    } catch {
      // Ignore quota exceeded
    }
  }

  return {
    folderId,
    folderName,
    keepCount,
    trashCount,
    ...(cleanLastShotId ? { lastShotId: cleanLastShotId } : {}),
    ...(cleanLastShotName ? { lastShotName: cleanLastShotName } : {}),
    updatedAtMs: record.updatedAtMs,
  };
}

export async function resetLocalFolderDecisions(folderId: string): Promise<void> {
  clearLocalResumePosition(folderId);
  try {
    window.localStorage.removeItem(`${LS_MANUAL_SERIES_PREFIX}${folderId}`);
  } catch {
    // Ignore storage errors
  }
  try {
    const db = await openLocalDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(folderId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Fallback below
  }

  try {
    window.localStorage.removeItem(`${LS_FALLBACK_PREFIX}${folderId}`);
  } catch {
    // Ignore storage errors
  }
}

export async function resetLocalFolderByScope(params: {
  folderId: string;
  folderName: string;
  scope: PartialResetScope;
}): Promise<PersistedFolderSummary | null> {
  const { folderId, folderName, scope } = params;
  if (scope === 'everything') {
    await resetLocalFolderDecisions(folderId);
    return null;
  }

  const session = await loadLocalFolderSession(folderId);

  if (scope === 'manual-series') {
    await saveLocalManualSeries({
      folderId,
      folderName: folderName || 'Lokální složka',
      manualSeries: [],
    });
    return await saveLocalFolderDecisions({
      folderId,
      folderName: folderName || 'Lokální složka',
      entries: session.entries,
      lastShotId: session.lastShotId,
      lastShotName: session.lastShotName,
    });
  }

  const { nextEntries } = applyPartialResetToEntries(session.entries, scope);
  return await saveLocalFolderDecisions({
    folderId,
    folderName: folderName || 'Lokální složka',
    entries: nextEntries,
    lastShotId: session.lastShotId,
    lastShotName: session.lastShotName,
  });
}


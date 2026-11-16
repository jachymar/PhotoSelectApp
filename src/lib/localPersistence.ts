import {
  FolderResumeTarget,
  PersistedDecisionEntry,
  PersistedFolderSummary,
  resolveEntryStates,
} from './cullPersistence';

const DB_NAME = 'framecull_local_db';
const DB_VERSION = 2;
const STORE_NAME = 'folder_sessions';
const HANDLES_STORE_NAME = 'saved_dir_handles';
const LS_FALLBACK_PREFIX = 'framecull_local_session_';
const LS_RESUME_POS_PREFIX = 'selectra_resume_pos_v1:';

export interface LocalFolderSessionRecord {
  folderId: string;
  folderName: string;
  keepCount: number;
  trashCount: number;
  lastShotId?: string;
  lastShotName?: string;
  updatedAtMs: number;
  entries: Record<string, PersistedDecisionEntry>;
}

export interface SavedLocalDirHandleRecord {
  folderId: string;
  folderName: string;
  dirHandle: FileSystemDirectoryHandle;
  canWrite: boolean;
  updatedAtMs: number;
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
      if (!db.objectStoreNames.contains(HANDLES_STORE_NAME)) {
        db.createObjectStore(HANDLES_STORE_NAME, { keyPath: 'folderId' });
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

export async function saveLocalDirHandle(params: {
  folderId: string;
  folderName: string;
  dirHandle: FileSystemDirectoryHandle;
  canWrite: boolean;
}): Promise<void> {
  try {
    const db = await openLocalDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(HANDLES_STORE_NAME, 'readwrite');
      const store = tx.objectStore(HANDLES_STORE_NAME);
      const record: SavedLocalDirHandleRecord = {
        folderId: params.folderId,
        folderName: params.folderName,
        dirHandle: params.dirHandle,
        canWrite: params.canWrite,
        updatedAtMs: Date.now(),
      };
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore browsers where FileSystemDirectoryHandle cannot be structured-cloned
  }
}

export async function loadSavedLocalDirHandles(): Promise<
  Record<string, SavedLocalDirHandleRecord>
> {
  const out: Record<string, SavedLocalDirHandleRecord> = {};
  try {
    const db = await openLocalDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(HANDLES_STORE_NAME, 'readonly');
      const store = tx.objectStore(HANDLES_STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const list = (req.result as SavedLocalDirHandleRecord[]) || [];
        for (const item of list) {
          if (item && item.folderId && item.dirHandle) {
            out[item.folderId] = item;
          }
        }
        resolve();
      };
      req.onerror = () => resolve();
    });
  } catch {
    // Ignore IndexedDB unavailability
  }
  return out;
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
  try {
    const db = await openLocalDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(HANDLES_STORE_NAME, 'readwrite');
      const store = tx.objectStore(HANDLES_STORE_NAME);
      store.delete(folderId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore errors
  }
}

export async function loadLocalFolderSession(folderId: string): Promise<{
  entries: Record<string, PersistedDecisionEntry>;
  lastShotId?: string;
  lastShotName?: string;
  updatedAtMs: number;
}> {
  try {
    const db = await openLocalDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(folderId);
      req.onsuccess = () => {
        const record = req.result as LocalFolderSessionRecord | undefined;
        resolve({
          entries: normalizeEntriesMap(record?.entries),
          lastShotId: record?.lastShotId,
          lastShotName: record?.lastShotName,
          updatedAtMs: Number(record?.updatedAtMs) || 0,
        });
      };
      req.onerror = () =>
        resolve({ entries: {}, updatedAtMs: 0 });
    });
  } catch {
    try {
      const raw = window.localStorage.getItem(`${LS_FALLBACK_PREFIX}${folderId}`);
      if (!raw) return { entries: {}, updatedAtMs: 0 };
      const parsed = JSON.parse(raw) as LocalFolderSessionRecord;
      return {
        entries: normalizeEntriesMap(parsed.entries),
        lastShotId: parsed.lastShotId,
        lastShotName: parsed.lastShotName,
        updatedAtMs: Number(parsed.updatedAtMs) || 0,
      };
    } catch {
      return { entries: {}, updatedAtMs: 0 };
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

  if (Object.keys(entries).length === 0 && !cleanLastShotId) {
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


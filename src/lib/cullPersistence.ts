import {
  GlobalCalibrationState,
  normalizeBaseSensitivity,
  sanitizeCalibrationExamples,
  sanitizeCustomCalibration,
} from './appSettings';
import type { ManualLockedSeries } from './burstGrouping';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
const auth = getAuth(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

let connectionTested = false;
let isPageUnloading = false;

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    isPageUnloading = true;
  });
}

export async function testFirestoreConnection(): Promise<void> {
  if (connectionTested || isPageUnloading) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (typeof window !== 'undefined') {
      window.addEventListener(
        'online',
        () => {
          void testFirestoreConnection();
        },
        { once: true }
      );
    }
    return;
  }

  // Brief settle delay avoids colliding with immediate Service Worker controllerchange reloads
  await new Promise<void>((resolve) => {
    if (typeof window !== 'undefined') {
      window.setTimeout(resolve, 800);
    } else {
      resolve();
    }
  });

  if (
    connectionTested ||
    isPageUnloading ||
    (typeof navigator !== 'undefined' && navigator.onLine === false)
  ) {
    return;
  }

  connectionTested = true;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('the client is offline')
    ) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

export type WorkflowMode = 'select' | 'delete';
export type SelectionRating = 'unrated' | 'pick' | 'reject';
export type PersistedRating = 'pick' | 'reject';
export type SelectModeState = 'unrated' | 'selected' | 'dimmed';
export type DeleteModeState = 'unrated' | 'trash' | 'spared';

export interface PersistedDecisionEntry {
  decision: PersistedRating;
  selectState?: 'selected' | 'dimmed';
  deleteState?: 'trash' | 'spared';
  name: string;
  ext: string;
  sizeBytes: number;
  batchId: string;
  pairedWith?: string;
  updatedAtMs: number;
}

export interface PersistedFolderSummary {
  folderId: string;
  folderName: string;
  keepCount: number;
  trashCount: number;
  lastShotId?: string;
  lastShotName?: string;
  updatedAtMs: number;
}

export interface FolderResumeTarget {
  shotId?: string;
  fileName?: string;
  stem?: string;
  updatedAtMs: number;
}

export type ShardEntriesMap = Record<string, Record<string, PersistedDecisionEntry>>;

const SHARD_COUNT = 32;

export function getShardId(fileId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < fileId.length; i++) {
    hash ^= fileId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const idx = (hash >>> 0) % SHARD_COUNT;
  return `shard_${idx.toString().padStart(2, '0')}`;
}

export function normalizePersistedRating(raw: unknown): PersistedRating {
  if (raw === 'reject' || raw === 'trash') return 'reject';
  return 'pick';
}

export function resolveEntryStates(
  entry?: PersistedDecisionEntry | null
): { selectState: SelectModeState; deleteState: DeleteModeState } {
  if (!entry) {
    return { selectState: 'unrated', deleteState: 'unrated' };
  }
  if (entry.selectState === undefined && entry.deleteState === undefined) {
    if (normalizePersistedRating(entry.decision) === 'pick') {
      return { selectState: 'selected', deleteState: 'unrated' };
    }
    return { selectState: 'unrated', deleteState: 'trash' };
  }
  const selectState: SelectModeState =
    entry.selectState === 'selected' || entry.selectState === 'dimmed'
      ? entry.selectState
      : 'unrated';
  const deleteState: DeleteModeState =
    entry.deleteState === 'trash' || entry.deleteState === 'spared'
      ? entry.deleteState
      : 'unrated';
  return { selectState, deleteState };
}

function sanitizeEntry(entry: PersistedDecisionEntry): PersistedDecisionEntry {
  const resolved = resolveEntryStates(entry);
  const clean: PersistedDecisionEntry = {
    decision: resolved.selectState === 'selected' ? 'pick' : 'reject',
    name: (entry.name || 'file').slice(0, 240),
    ext: (entry.ext || '').slice(0, 16),
    sizeBytes: Math.max(0, Math.round(Number(entry.sizeBytes) || 0)),
    batchId: (entry.batchId || 'batch').slice(0, 64),
    updatedAtMs: Number(entry.updatedAtMs) || Date.now(),
  };
  if (resolved.selectState !== 'unrated') {
    clean.selectState = resolved.selectState;
  }
  if (resolved.deleteState !== 'unrated') {
    clean.deleteState = resolved.deleteState;
  }
  if (entry.pairedWith) {
    clean.pairedWith = entry.pairedWith.slice(0, 120);
  }
  return clean;
}

/**
 * Loads summary progress for all folders the user has previously culled.
 */
export async function loadAllFolderSummaries(
  userId: string
): Promise<Record<string, PersistedFolderSummary>> {
  const path = `users/${userId}/folders`;
  try {
    const q = query(
      collection(db, path),
      where('ownerId', '==', userId)
    );
    const snap = await getDocs(q);
    const summaries: Record<string, PersistedFolderSummary> = {};
    snap.forEach((d) => {
      const data = d.data();
      const updatedAtRaw = data.updatedAt as
        | { toMillis?: () => number }
        | undefined;
      const lastShotId =
        typeof data.lastShotId === 'string' && data.lastShotId.trim()
          ? data.lastShotId.trim()
          : undefined;
      const lastShotName =
        typeof data.lastShotName === 'string' && data.lastShotName.trim()
          ? data.lastShotName.trim()
          : undefined;
      summaries[d.id] = {
        folderId: String(data.folderId || d.id),
        folderName: String(data.folderName || d.id),
        keepCount: Number(data.keepCount || 0),
        trashCount: Number(data.trashCount || 0),
        ...(lastShotId ? { lastShotId } : {}),
        ...(lastShotName ? { lastShotName } : {}),
        updatedAtMs:
          updatedAtRaw && typeof updatedAtRaw.toMillis === 'function'
            ? updatedAtRaw.toMillis()
            : 0,
      };
    });
    return summaries;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

/**
 * Loads all decision shards and saved resume cursor for a specific Google Drive folder.
 */
export async function loadFolderDecisions(
  userId: string,
  folderId: string
): Promise<{
  entries: Record<string, PersistedDecisionEntry>;
  shardMap: ShardEntriesMap;
  lastShotId?: string;
  lastShotName?: string;
  folderUpdatedAtMs: number;
}> {
  const chunksPath = `users/${userId}/folders/${folderId}/chunks`;
  const folderPath = `users/${userId}/folders/${folderId}`;
  try {
    const q = query(
      collection(db, chunksPath),
      where('ownerId', '==', userId)
    );
    const [snap, folderSnap] = await Promise.all([
      getDocs(q),
      getDoc(doc(db, folderPath)).catch(() => null),
    ]);
    const entries: Record<string, PersistedDecisionEntry> = {};
    const shardMap: ShardEntriesMap = {};

    snap.forEach((docSnap) => {
      const data = docSnap.data();
      const chunkEntries = (data.entries || {}) as Record<
        string,
        PersistedDecisionEntry
      >;
      const cleanShard: Record<string, PersistedDecisionEntry> = {};
      for (const [fileId, rawEntry] of Object.entries(chunkEntries)) {
        if (!rawEntry || typeof rawEntry !== 'object') continue;
        const sanitized = sanitizeEntry(rawEntry);
        cleanShard[fileId] = sanitized;
        entries[fileId] = sanitized;
      }
      if (Object.keys(cleanShard).length > 0) {
        shardMap[docSnap.id] = cleanShard;
      }
    });

    let lastShotId: string | undefined;
    let lastShotName: string | undefined;
    let folderUpdatedAtMs = 0;

    if (folderSnap && folderSnap.exists()) {
      const data = folderSnap.data();
      if (typeof data.lastShotId === 'string' && data.lastShotId.trim()) {
        lastShotId = data.lastShotId.trim();
      }
      if (typeof data.lastShotName === 'string' && data.lastShotName.trim()) {
        lastShotName = data.lastShotName.trim();
      }
      const updatedAtRaw = data.updatedAt as
        | { toMillis?: () => number }
        | undefined;
      if (updatedAtRaw && typeof updatedAtRaw.toMillis === 'function') {
        folderUpdatedAtMs = updatedAtRaw.toMillis();
      }
    }

    return { entries, shardMap, lastShotId, lastShotName, folderUpdatedAtMs };
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, chunksPath);
  }
}

/**
 * Applies incremental upserts & deletions to touched shards and updates the folder summary doc atomically.
 */
export async function saveFolderDecisionDeltas(params: {
  userId: string;
  folderId: string;
  folderName: string;
  shardMap: ShardEntriesMap;
  upserts: Record<string, PersistedDecisionEntry>;
  removals: string[];
  lastShotId?: string;
  lastShotName?: string;
  forceFolderSummaryWrite?: boolean;
}): Promise<ShardEntriesMap> {
  const {
    userId,
    folderId,
    folderName,
    shardMap,
    upserts,
    removals,
    lastShotId,
    lastShotName,
    forceFolderSummaryWrite = false,
  } = params;
  const touchedShards = new Set<string>();

  // Clone only touched shards cleanly
  const nextShardMap: ShardEntriesMap = { ...shardMap };

  for (const fileId of removals) {
    const shardId = getShardId(fileId);
    if (nextShardMap[shardId] && fileId in nextShardMap[shardId]) {
      nextShardMap[shardId] = { ...nextShardMap[shardId] };
      delete nextShardMap[shardId][fileId];
      touchedShards.add(shardId);
    }
  }

  for (const [fileId, rawEntry] of Object.entries(upserts)) {
    const shardId = getShardId(fileId);
    nextShardMap[shardId] = {
      ...(nextShardMap[shardId] || {}),
      [fileId]: sanitizeEntry(rawEntry),
    };
    touchedShards.add(shardId);
  }

  if (touchedShards.size === 0 && !forceFolderSummaryWrite) {
    return nextShardMap;
  }

  let keepCount = 0;
  let trashCount = 0;
  for (const shard of Object.values(nextShardMap)) {
    for (const item of Object.values(shard)) {
      const states = resolveEntryStates(item);
      if (states.selectState === 'selected') keepCount++;
      if (states.deleteState === 'trash') trashCount++;
    }
  }

  const folderPath = `users/${userId}/folders/${folderId}`;
  const folderRef = doc(db, folderPath);
  const batch = writeBatch(db);

  const cleanLastShotId =
    typeof lastShotId === 'string' ? lastShotId.trim().slice(0, 256) : '';
  const cleanLastShotName =
    typeof lastShotName === 'string' ? lastShotName.trim().slice(0, 256) : '';

  const folderPayload: Record<string, unknown> = {
    ownerId: userId,
    folderId,
    folderName: (folderName || 'Složka').slice(0, 256),
    keepCount,
    trashCount,
    updatedAt: serverTimestamp(),
  };
  if (cleanLastShotId) {
    folderPayload.lastShotId = cleanLastShotId;
  }
  if (cleanLastShotName) {
    folderPayload.lastShotName = cleanLastShotName;
  }

  batch.set(folderRef, folderPayload);

  for (const shardId of touchedShards) {
    const chunkRef = doc(db, `${folderPath}/chunks/${shardId}`);
    const entries = nextShardMap[shardId] || {};
    if (Object.keys(entries).length === 0) {
      batch.delete(chunkRef);
      delete nextShardMap[shardId];
    } else {
      batch.set(chunkRef, {
        ownerId: userId,
        folderId,
        entries,
        updatedAt: serverTimestamp(),
      });
    }
  }

  try {
    await batch.commit();
    return nextShardMap;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, folderPath);
  }
}

/**
 * Removes saved culling progress for a specific folder (when user explicitly resets a folder).
 */
export async function resetFolderDecisions(
  userId: string,
  folderId: string,
  shardMap: ShardEntriesMap
): Promise<void> {
  const folderPath = `users/${userId}/folders/${folderId}`;
  const batch = writeBatch(db);

  for (const shardId of Object.keys(shardMap)) {
    batch.delete(doc(db, `${folderPath}/chunks/${shardId}`));
  }
  batch.delete(doc(db, folderPath));

  try {
    await batch.commit();
  } catch (error) {
    // Fallback delete if batch fails on missing summary doc
    try {
      await deleteDoc(doc(db, folderPath));
    } catch {
      // Ignore fallback error and throw structured Firestore error below
    }
    handleFirestoreError(error, OperationType.DELETE, folderPath);
  }
}

export async function loadGlobalCalibrationPreference(
  userId: string
): Promise<GlobalCalibrationState | null> {
  const prefPath = `users/${userId}/preferences/seriesCalibration`;
  try {
    const snap = await getDoc(doc(db, prefPath));
    if (!snap.exists()) return null;
    const data = snap.data() as Record<string, unknown>;
    const baseSensitivity = normalizeBaseSensitivity(data.baseSensitivity);
    const calibration = sanitizeCustomCalibration(data.calibration);
    const examples = sanitizeCalibrationExamples(data.examples);
    const tsMs =
      data.updatedAt &&
      typeof (data.updatedAt as { toMillis?: () => number }).toMillis ===
        'function'
        ? (data.updatedAt as { toMillis: () => number }).toMillis()
        : calibration?.updatedAt || Date.now();
    return {
      baseSensitivity,
      calibration,
      examples,
      updatedAtMs: tsMs,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, prefPath);
  }
}

export async function saveGlobalCalibrationPreference(
  userId: string,
  state: GlobalCalibrationState
): Promise<void> {
  const prefPath = `users/${userId}/preferences/seriesCalibration`;
  const cleanCal = sanitizeCustomCalibration(state.calibration);
  const cleanExamples = sanitizeCalibrationExamples(state.examples).map(
    (ex) => ({
      pairKey: ex.pairKey,
      idA: ex.idA,
      idB: ex.idB,
      label: ex.label,
      metrics: {
        score: Number(ex.metrics.score.toFixed(4)),
        structSim: Number(ex.metrics.structSim.toFixed(4)),
        centerSim: Number(ex.metrics.centerSim.toFixed(4)),
        edgeSim: Number(ex.metrics.edgeSim.toFixed(4)),
        spatialColorSim: Number(ex.metrics.spatialColorSim.toFixed(4)),
        centerColorSim: Number(ex.metrics.centerColorSim.toFixed(4)),
        histSim: Number(ex.metrics.histSim.toFixed(4)),
        meanLumaDiff: Number(ex.metrics.meanLumaDiff.toFixed(4)),
        incompatible: Boolean(ex.metrics.incompatible),
      },
    })
  );

  const payload: Record<string, unknown> = {
    ownerId: userId,
    prefId: 'seriesCalibration',
    baseSensitivity: normalizeBaseSensitivity(state.baseSensitivity),
    examples: cleanExamples,
    updatedAt: serverTimestamp(),
  };

  if (cleanCal) {
    payload.calibration = {
      minScore: Math.max(0, Math.min(1, Number(cleanCal.minScore.toFixed(4)))),
      minStruct: Math.max(
        0,
        Math.min(1, Number(cleanCal.minStruct.toFixed(4)))
      ),
      minCenter: Math.max(
        0,
        Math.min(1, Number(cleanCal.minCenter.toFixed(4)))
      ),
      minEdge: Math.max(0, Math.min(1, Number(cleanCal.minEdge.toFixed(4)))),
      minSpatialColor: Math.max(
        0,
        Math.min(1, Number(cleanCal.minSpatialColor.toFixed(4)))
      ),
      minCenterColor: Math.max(
        0,
        Math.min(1, Number(cleanCal.minCenterColor.toFixed(4)))
      ),
      maxMeanLumaDiff: Math.max(
        0,
        Math.min(1, Number(cleanCal.maxMeanLumaDiff.toFixed(4)))
      ),
      sameCount: Math.max(0, Math.min(10000, Math.round(cleanCal.sameCount))),
      differentCount: Math.max(
        0,
        Math.min(10000, Math.round(cleanCal.differentCount))
      ),
      accuracyPct: Math.max(0, Math.min(100, Math.round(cleanCal.accuracyPct))),
      updatedAt: Math.max(0, Math.round(cleanCal.updatedAt || Date.now())),
    };
  }

  try {
    await setDoc(doc(db, prefPath), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, prefPath);
  }
}

export async function loadFolderManualSeries(
  userId: string,
  folderId: string
): Promise<ManualLockedSeries[]> {
  const colPath = `users/${userId}/folders/${folderId}/manualSeries`;
  try {
    const q = query(
      collection(db, colPath),
      where('ownerId', '==', userId)
    );
    const snap = await getDocs(q);
    const out: ManualLockedSeries[] = [];
    snap.forEach((d) => {
      const data = d.data() as Record<string, unknown>;
      const shotIds = Array.isArray(data.shotIds)
        ? data.shotIds.filter(
            (x): x is string => typeof x === 'string' && x.length > 0
          )
        : [];
      const stems = Array.isArray(data.stems)
        ? data.stems.filter(
            (x): x is string => typeof x === 'string' && x.length > 0
          )
        : [];
      if (shotIds.length >= 2) {
        out.push({
          id: typeof data.seriesId === 'string' ? data.seriesId : d.id,
          shotIds,
          stems: stems.length >= 2 ? stems : shotIds,
          updatedAtMs: Math.max(0, Math.round(Number(data.updatedAtMs) || 0)),
        });
      }
    });
    return out;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, colPath);
  }
}

export async function saveFolderManualSeries(params: {
  userId: string;
  folderId: string;
  folderName: string;
  manualSeries: ManualLockedSeries[];
}): Promise<void> {
  const { userId, folderId, folderName, manualSeries } = params;
  const folderPath = `users/${userId}/folders/${folderId}`;
  const colPath = `${folderPath}/manualSeries`;
  try {
    const folderRef = doc(db, folderPath);
    const existingSnap = await getDoc(folderRef);
    const existingSnapList = await getDocs(
      query(collection(db, colPath), where('ownerId', '==', userId))
    );

    const batch = writeBatch(db);
    if (!existingSnap.exists()) {
      batch.set(folderRef, {
        ownerId: userId,
        folderId,
        folderName: (folderName || 'Složka').slice(0, 256),
        keepCount: 0,
        trashCount: 0,
        updatedAt: serverTimestamp(),
      });
    }

    const desiredIds = new Set<string>();
    for (const ms of manualSeries) {
      if (!ms || ms.shotIds.length < 2) continue;
      const safeId = ms.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
      if (!safeId) continue;
      desiredIds.add(safeId);
      const cleanShotIds = ms.shotIds.slice(0, 200);
      const cleanStems = (ms.stems.length >= 2 ? ms.stems : cleanShotIds).slice(
        0,
        200
      );
      batch.set(doc(db, `${colPath}/${safeId}`), {
        ownerId: userId,
        folderId,
        seriesId: safeId,
        shotIds: cleanShotIds,
        stems: cleanStems,
        updatedAtMs: Math.max(0, Math.round(ms.updatedAtMs || Date.now())),
        updatedAt: serverTimestamp(),
      });
    }

    existingSnapList.forEach((d) => {
      if (!desiredIds.has(d.id)) {
        batch.delete(d.ref);
      }
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, colPath);
  }
}


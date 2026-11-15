import {
  DriveFolder,
  DrivePhotoFile,
  SourceCapabilities,
  getFileStem,
  isSupportedPhoto,
} from './driveApi';

export interface NativePhotoDescriptor {
  id: string;
  uri: string;
  name: string;
  relativePath?: string;
  mimeType?: string;
  sizeBytes: number;
  lastModifiedMs?: number;
}

export interface NativePickResult {
  folderId: string;
  folderName: string;
  files: NativePhotoDescriptor[];
}

export interface NativeBatchOpResult {
  succeeded: string[];
  failed: { uri: string; error: string }[];
}

export interface NativePersistedFolderInfo {
  folderId: string;
  folderName: string;
  treeUri: string;
  updatedAtMs: number;
}

export interface NativeGoogleAuthResult {
  idToken: string;
  accessToken: string;
  email: string | null;
}

/**
 * Contract for a Capacitor / Android WebView SAF bridge (`window.FrameCullNative`)
 * enabling direct folder tree access and real file deletion on internal storage
 * and USB OTG SD cards via Android Storage Access Framework (ACTION_OPEN_DOCUMENT_TREE),
 * plus permanent native Google Drive authentication.
 */
export interface FrameCullNativeBridge {
  isAvailable(): boolean;
  pickDirectoryTree(): Promise<NativePickResult | null>;
  listPersistedFolders?(): Promise<NativePersistedFolderInfo[]>;
  openPersistedDirectoryTree?(folderId: string): Promise<NativePickResult | null>;
  forgetPersistedFolder?(folderId: string): Promise<void>;
  listSubfolderFileNames?(
    folderId: string,
    subfolderName: string
  ): Promise<string[]>;
  readFileSlice(
    uri: string,
    start: number,
    end: number
  ): Promise<ArrayBuffer | string>;
  getThumbnailUrl?(uri: string): Promise<string | null>;
  getFullMediaUrl?(uri: string): Promise<string | null>;
  moveToSubfolderTrash(
    folderId: string,
    fileUris: string[]
  ): Promise<NativeBatchOpResult>;
  copyToSubfolder?(
    folderId: string,
    subfolderName: string,
    fileUris: string[]
  ): Promise<NativeBatchOpResult>;
  moveToSubfolder?(
    folderId: string,
    subfolderName: string,
    fileUris: string[]
  ): Promise<NativeBatchOpResult>;
  deleteFilesPermanently(fileUris: string[]): Promise<NativeBatchOpResult>;
  triggerHaptic?(
    intensity: 'light' | 'medium' | 'heavy',
    kind: string
  ): Promise<void> | void;
  googleSignInNative?(options: {
    webClientId: string;
    forceAccountSelect?: boolean;
    loginHint?: string | null;
  }): Promise<NativeGoogleAuthResult | null>;
  silentRefreshDriveToken?(options: {
    webClientId: string;
    invalidateToken?: string | null;
  }): Promise<NativeGoogleAuthResult | null>;
  googleSignOutNative?(): Promise<void>;
}

declare global {
  interface Window {
    FrameCullNative?: FrameCullNativeBridge;
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: 'read' | 'readwrite';
      startIn?: string;
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

export interface LocalSessionBundle {
  folder: DriveFolder;
  photos: DrivePhotoFile[];
}

export interface LocalStreamMeta {
  pageNumber: number;
  hasMore: boolean;
  totalDiscovered: number;
}

export type LocalStreamBatchCallback = (
  folder: DriveFolder,
  batch: DrivePhotoFile[],
  meta: LocalStreamMeta
) => void;

export interface LocalStreamStarter {
  folderName: string;
  launch: (
    onBatch: LocalStreamBatchCallback,
    signal: AbortSignal
  ) => Promise<void>;
}

export const LOCAL_INITIAL_BATCH_SIZE = 20;
export const LOCAL_BACKGROUND_BATCH_SIZE = 50;

export const TRASH_SUBFOLDER_NAME = '_Vyrazene';
export const LIKED_SUBFOLDER_NAME = 'Liked';

const IGNORED_SUBFOLDERS = new Set([
  'liked',
  '_vyrazene',
  '_trash',
  '.trash',
  '.trashed',
  'lost.dir',
  'system volume information',
  '.android_secure',
]);

function hashString(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

export function buildLocalFolderId(
  folderName: string,
  descriptors: { name: string; sizeBytes: number }[]
): string {
  const sample = descriptors
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 40)
    .map((d) => `${d.name}:${d.sizeBytes}`)
    .join('|');
  return `local-${hashString(`${folderName}#${descriptors.length}#${sample}`)}`;
}

export function buildStableStreamFolderId(
  prefix: 'local-fs-dir' | 'local-file-dir' | 'local-file-sel',
  key: string
): string {
  return `${prefix}-${hashString(key)}`;
}

export function hasAndroidNativeBridge(): boolean {
  try {
    return Boolean(window.FrameCullNative?.isAvailable?.());
  } catch {
    return false;
  }
}

export function hasDesktopDirectoryPicker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.showDirectoryPicker === 'function'
  );
}

function isTopLevelOrNestedIgnored(relPath: string): boolean {
  const parts = relPath.split('/').map((p) => p.trim().toLowerCase());
  return parts.some((part, idx) => {
    if (idx === parts.length - 1) return false;
    return IGNORED_SUBFOLDERS.has(part) || part.startsWith('.');
  });
}

function sortPhotosNaturally(list: DrivePhotoFile[]): DrivePhotoFile[] {
  return list.sort((a, b) => {
    const pa = a.relativePath || a.name;
    const pb = b.relativePath || b.name;
    return pa.localeCompare(pb, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

function decodeBase64ToArrayBuffer(b64: string): ArrayBuffer {
  const clean = b64.includes(',') ? b64.split(',').pop() || '' : b64;
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes.buffer;
}

function buildPhotoFromLocalFile(
  file: File,
  relativePath: string,
  sourceKind: 'local-fs' | 'local-file',
  fsHandle?: FileSystemFileHandle,
  parentDirHandle?: FileSystemDirectoryHandle
): DrivePhotoFile | null {
  const check = isSupportedPhoto({
    name: file.name,
    mimeType: file.type,
  });
  if (!check.supported) return null;

  return {
    id:
      sourceKind === 'local-fs'
        ? `local-fs:${hashString(relativePath)}:${file.size}`
        : `local-file:${hashString(relativePath)}:${file.size}:${file.lastModified}`,
    name: file.name,
    stem: getFileStem(file.name),
    mimeType: file.type || '',
    sizeBytes: file.size,
    modifiedTime: file.lastModified
      ? new Date(file.lastModified).toISOString()
      : undefined,
    fileExtension: check.ext,
    isRaw: check.isRaw,
    takenAtMs: null,
    sourceKind,
    localFile: file,
    fsHandle,
    parentDirHandle,
    relativePath,
  };
}

/**
 * Opens the native OS directory picker without scanning files yet.
 * Throws `'FALLBACK_REQUIRED'` if blocked by SecurityError/unsupported browser,
 * or returns `null` if cancelled by the user.
 */
export async function pickDesktopDirectoryHandle(): Promise<{
  dirHandle: FileSystemDirectoryHandle;
  canWrite: boolean;
} | null> {
  if (!hasDesktopDirectoryPicker() || !window.showDirectoryPicker) {
    throw new Error('FALLBACK_REQUIRED');
  }

  try {
    const dirHandle = await window.showDirectoryPicker({
      mode: 'readwrite',
    });
    return { dirHandle, canWrite: true };
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return null;
    }
    if (err instanceof DOMException && err.name === 'SecurityError') {
      throw new Error('FALLBACK_REQUIRED');
    }
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
      return { dirHandle, canWrite: false };
    } catch (innerErr: unknown) {
      if (innerErr instanceof DOMException && innerErr.name === 'AbortError') {
        return null;
      }
      throw new Error('FALLBACK_REQUIRED');
    }
  }
}

/**
 * Progressively streams a picked FileSystemDirectoryHandle in batches:
 * emits the first ~20 photos as soon as available so SwipeStudio opens immediately,
 * then continues walking & calling `getFile()` in background chunks without blocking UI.
 */
export async function streamDesktopDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
  canWrite: boolean,
  onBatch: LocalStreamBatchCallback,
  signal: AbortSignal
): Promise<void> {
  const folderId = buildStableStreamFolderId('local-fs-dir', dirHandle.name);
  const capabilities: SourceCapabilities = {
    sourceKind: 'local-fs',
    canTrashSubfolder: canWrite,
    canPermanentDelete: canWrite,
    isReadOnlyFallback: !canWrite,
    supportsDirectoryPicker: true,
  };
  const folder: DriveFolder = {
    id: folderId,
    name: dirHandle.name,
    sourceKind: 'local-fs',
    capabilities,
    dirHandle,
  };

  interface PendingFileEntry {
    handle: FileSystemFileHandle;
    parentDirHandle: FileSystemDirectoryHandle;
    relativePath: string;
    stem: string;
  }

  interface DirFrame {
    dir: FileSystemDirectoryHandle;
    prefix: string;
    depth: number;
    iterator?: AsyncIterator<FileSystemHandle>;
    queuedSubdirs: { dir: FileSystemDirectoryHandle; prefix: string; depth: number }[];
    enumerationDone: boolean;
  }

  const stack: DirFrame[] = [
    {
      dir: dirHandle,
      prefix: '',
      depth: 0,
      queuedSubdirs: [],
      enumerationDone: false,
    },
  ];
  const pendingFiles: PendingFileEntry[] = [];
  let pageNumber = 0;
  let totalDiscovered = 0;

  const getIterable = (dir: FileSystemDirectoryHandle) =>
    (
      dir as unknown as {
        values: () => AsyncIterable<FileSystemHandle>;
      }
    )
      .values()
      [Symbol.asyncIterator]();

  const fillPendingUpTo = async (minCount: number, timeBudgetMs: number) => {
    const startMs = performance.now();

    while (pendingFiles.length < minCount && stack.length > 0) {
      if (signal.aborted) return;

      const frame = stack[stack.length - 1];
      if (!frame.enumerationDone) {
        if (!frame.iterator) {
          frame.iterator = getIterable(frame.dir);
        }

        const localBatchFiles: PendingFileEntry[] = [];
        const localBatchDirs: {
          dir: FileSystemDirectoryHandle;
          prefix: string;
          depth: number;
        }[] = [];

        let enumeratedCount = 0;
        while (true) {
          if (signal.aborted) return;
          const next = await frame.iterator.next();
          if (next.done) {
            frame.enumerationDone = true;
            break;
          }

          const handle = next.value;
          if (handle.kind === 'directory') {
            if (frame.depth < 2) {
              const lower = handle.name.toLowerCase();
              if (!IGNORED_SUBFOLDERS.has(lower) && !lower.startsWith('.')) {
                localBatchDirs.push({
                  dir: handle as FileSystemDirectoryHandle,
                  prefix: frame.prefix
                    ? `${frame.prefix}/${handle.name}`
                    : handle.name,
                  depth: frame.depth + 1,
                });
              }
            }
          } else if (handle.kind === 'file') {
            const check = isSupportedPhoto({ name: handle.name });
            if (check.supported) {
              const relativePath = frame.prefix
                ? `${frame.prefix}/${handle.name}`
                : handle.name;
              localBatchFiles.push({
                handle: handle as FileSystemFileHandle,
                parentDirHandle: frame.dir,
                relativePath,
                stem: getFileStem(handle.name),
              });
            }
          }

          enumeratedCount++;
          if (enumeratedCount % 900 === 0) {
            await yieldToMainThread();
          }
          // Safety cap only for massive folders if initial quick-open exceeds 450ms and already holds 3k+ handles
          if (
            localBatchFiles.length >= 3000 &&
            performance.now() - startMs > Math.max(timeBudgetMs, 450)
          ) {
            break;
          }
        }

        localBatchFiles.sort((a, b) =>
          a.relativePath.localeCompare(b.relativePath, undefined, {
            numeric: true,
            sensitivity: 'base',
          })
        );
        for (const f of localBatchFiles) {
          pendingFiles.push(f);
        }

        if (localBatchDirs.length > 0) {
          localBatchDirs.sort((a, b) =>
            a.prefix.localeCompare(b.prefix, undefined, {
              numeric: true,
              sensitivity: 'base',
            })
          );
          frame.queuedSubdirs.push(...localBatchDirs);
        }

        if (pendingFiles.length >= minCount) {
          break;
        }
      }

      if (frame.enumerationDone) {
        if (frame.queuedSubdirs.length > 0) {
          // Push subdirs in reverse so first alphabetical subdir pops first
          const subdirs = frame.queuedSubdirs.splice(0);
          for (let i = subdirs.length - 1; i >= 0; i--) {
            stack.push({
              dir: subdirs[i].dir,
              prefix: subdirs[i].prefix,
              depth: subdirs[i].depth,
              queuedSubdirs: [],
              enumerationDone: false,
            });
          }
        } else {
          stack.pop();
        }
      }
    }
  };

  while (!signal.aborted) {
    const targetBatchSize =
      pageNumber === 0 ? LOCAL_INITIAL_BATCH_SIZE : LOCAL_BACKGROUND_BATCH_SIZE;
    await fillPendingUpTo(targetBatchSize + 4, 300);
    if (signal.aborted) return;

    if (pendingFiles.length === 0 && stack.length === 0) {
      break;
    }

    let takeCount = Math.min(targetBatchSize, pendingFiles.length);
    // Keep JPG + RAW stem pairs together across batch boundaries
    if (takeCount > 0 && takeCount < pendingFiles.length) {
      const lastStem = pendingFiles[takeCount - 1].stem;
      while (
        takeCount < pendingFiles.length &&
        takeCount < targetBatchSize + 3 &&
        pendingFiles[takeCount].stem === lastStem
      ) {
        takeCount++;
      }
    }

    const sliceEntries = pendingFiles.splice(0, takeCount);
    if (sliceEntries.length === 0) {
      if (stack.length === 0) break;
      continue;
    }

    const batchPhotos: DrivePhotoFile[] = [];
    // Resolve File objects in small concurrent chunks (4) for fast tablet/USB throughput
    for (let i = 0; i < sliceEntries.length; i += 4) {
      if (signal.aborted) return;
      const chunk = sliceEntries.slice(i, i + 4);
      const resolved = await Promise.all(
        chunk.map(async (entry) => {
          try {
            const file = await entry.handle.getFile();
            return buildPhotoFromLocalFile(
              file,
              entry.relativePath,
              'local-fs',
              entry.handle,
              entry.parentDirHandle
            );
          } catch {
            return null;
          }
        })
      );
      for (const p of resolved) {
        if (p) batchPhotos.push(p);
      }
    }

    if (signal.aborted) return;

    const hasMore = pendingFiles.length > 0 || stack.length > 0;
    if (batchPhotos.length > 0 || !hasMore) {
      pageNumber++;
      totalDiscovered += batchPhotos.length;
      onBatch(folder, batchPhotos, {
        pageNumber,
        hasMore,
        totalDiscovered,
      });
    }

    if (!hasMore) break;
    await yieldToMainThread();
  }
}

/**
 * Legacy helper (full upfront load) kept for compatibility if needed.
 */
export async function openDesktopDirectorySession(): Promise<LocalSessionBundle | null> {
  const picked = await pickDesktopDirectoryHandle();
  if (!picked) return null;
  const controller = new AbortController();
  let capturedFolder: DriveFolder | null = null;
  const allPhotos: DrivePhotoFile[] = [];
  await streamDesktopDirectoryHandle(
    picked.dirHandle,
    picked.canWrite,
    (folder, batch) => {
      capturedFolder = folder;
      allPhotos.push(...batch);
    },
    controller.signal
  );
  if (!capturedFolder) {
    capturedFolder = {
      id: buildStableStreamFolderId('local-fs-dir', picked.dirHandle.name),
      name: picked.dirHandle.name,
      sourceKind: 'local-fs',
      capabilities: {
        sourceKind: 'local-fs',
        canTrashSubfolder: picked.canWrite,
        canPermanentDelete: picked.canWrite,
        isReadOnlyFallback: !picked.canWrite,
        supportsDirectoryPicker: true,
      },
      dirHandle: picked.dirHandle,
    };
  }
  return { folder: capturedFolder, photos: allPhotos };
}

/**
 * Progressively streams a native Android SAF directory pick result in chunks
 * so large SD card folders open SwipeStudio after the first ~20 files.
 */
export async function streamAndroidNativePickResult(
  res: NativePickResult,
  onBatch: LocalStreamBatchCallback,
  signal: AbortSignal
): Promise<void> {
  const capabilities: SourceCapabilities = {
    sourceKind: 'android-saf',
    canTrashSubfolder: true,
    canPermanentDelete: true,
    isReadOnlyFallback: false,
    supportsDirectoryPicker: true,
  };

  const folder: DriveFolder = {
    id: res.folderId,
    name: res.folderName || 'SD karta / Složka',
    sourceKind: 'android-saf',
    capabilities,
  };

  // Sort oldest-first using lastModifiedMs (grouping close camera bursts by natural path/name)
  const rawItems = [...res.files].sort((a, b) => {
    const ta = a.lastModifiedMs ?? 0;
    const tb = b.lastModifiedMs ?? 0;
    if (ta > 0 && tb > 0 && Math.abs(ta - tb) > 4000) {
      return ta - tb;
    }
    const pa = a.relativePath || a.name;
    const pb = b.relativePath || b.name;
    return pa.localeCompare(pb, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
  let cursor = 0;
  let pageNumber = 0;
  let totalDiscovered = 0;

  while (cursor < rawItems.length && !signal.aborted) {
    const targetSize =
      pageNumber === 0 ? LOCAL_INITIAL_BATCH_SIZE : LOCAL_BACKGROUND_BATCH_SIZE;
    const batch: DrivePhotoFile[] = [];

    while (cursor < rawItems.length && batch.length < targetSize) {
      const item = rawItems[cursor++];
      const check = isSupportedPhoto({
        name: item.name,
        mimeType: item.mimeType,
      });
      if (!check.supported) continue;
      const rel = item.relativePath || item.name;
      if (isTopLevelOrNestedIgnored(rel)) continue;

      batch.push({
        id: item.id || `saf:${hashString(item.uri)}`,
        name: item.name,
        stem: getFileStem(item.name),
        mimeType: item.mimeType || '',
        sizeBytes: item.sizeBytes || 0,
        modifiedTime: item.lastModifiedMs
          ? new Date(item.lastModifiedMs).toISOString()
          : undefined,
        fileExtension: check.ext,
        isRaw: check.isRaw,
        takenAtMs: null,
        sourceKind: 'android-saf',
        nativeUri: item.uri,
        relativePath: rel,
      });
    }

    // Align stem pairs across batch boundary
    if (batch.length > 0) {
      const lastStem = batch[batch.length - 1].stem;
      while (cursor < rawItems.length && batch.length < targetSize + 3) {
        const peek = rawItems[cursor];
        if (getFileStem(peek.name) !== lastStem) break;
        cursor++;
        const check = isSupportedPhoto({
          name: peek.name,
          mimeType: peek.mimeType,
        });
        if (!check.supported) continue;
        const rel = peek.relativePath || peek.name;
        if (isTopLevelOrNestedIgnored(rel)) continue;
        batch.push({
          id: peek.id || `saf:${hashString(peek.uri)}`,
          name: peek.name,
          stem: getFileStem(peek.name),
          mimeType: peek.mimeType || '',
          sizeBytes: peek.sizeBytes || 0,
          modifiedTime: peek.lastModifiedMs
            ? new Date(peek.lastModifiedMs).toISOString()
            : undefined,
          fileExtension: check.ext,
          isRaw: check.isRaw,
          takenAtMs: null,
          sourceKind: 'android-saf',
          nativeUri: peek.uri,
          relativePath: rel,
        });
      }
    }

    const hasMore = cursor < rawItems.length;
    if (batch.length > 0 || !hasMore) {
      pageNumber++;
      totalDiscovered += batch.length;
      onBatch(folder, batch, {
        pageNumber,
        hasMore,
        totalDiscovered,
      });
    }

    if (hasMore) {
      await yieldToMainThread();
    }
  }
}

/**
 * Opens a folder via the Capacitor / Android Native SAF Bridge when available.
 */
export async function openAndroidNativeDirectorySession(): Promise<LocalSessionBundle | null> {
  if (!hasAndroidNativeBridge() || !window.FrameCullNative) {
    return null;
  }
  const res = await window.FrameCullNative.pickDirectoryTree();
  if (!res) return null;

  const controller = new AbortController();
  let capturedFolder: DriveFolder | null = null;
  const photos: DrivePhotoFile[] = [];
  await streamAndroidNativePickResult(
    res,
    (folder, batch) => {
      capturedFolder = folder;
      photos.push(...batch);
    },
    controller.signal
  );

  sortPhotosNaturally(photos);
  return {
    folder: capturedFolder || {
      id: res.folderId,
      name: res.folderName || 'SD karta / Složka',
      sourceKind: 'android-saf',
      capabilities: {
        sourceKind: 'android-saf',
        canTrashSubfolder: true,
        canPermanentDelete: true,
        isReadOnlyFallback: false,
        supportsDirectoryPicker: true,
      },
    },
    photos,
  };
}

/**
 * Progressively streams a copied File[] from `<input type="file" webkitdirectory>`
 * or `<input type="file" multiple>` so tablets/phones open SwipeStudio immediately
 * after the first ~20 photos without freezing on 1,000+ file selections.
 */
export async function streamFileListSession(
  files: File[],
  fallbackName: string,
  onBatch: LocalStreamBatchCallback,
  signal: AbortSignal
): Promise<void> {
  if (files.length === 0) return;

  const firstRel =
    (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath ||
    '';
  const hasDirStructure = firstRel.includes('/');
  const derivedFolderName = hasDirStructure
    ? firstRel.split('/')[0]
    : fallbackName;

  const folderId = hasDirStructure
    ? buildStableStreamFolderId('local-file-dir', derivedFolderName)
    : buildStableStreamFolderId(
        'local-file-sel',
        `${fallbackName}#${files.length}#${files[0]?.name || ''}`
      );

  const capabilities: SourceCapabilities = {
    sourceKind: 'local-file',
    canTrashSubfolder: false,
    canPermanentDelete: false,
    isReadOnlyFallback: true,
    supportsDirectoryPicker: false,
  };

  const folder: DriveFolder = {
    id: folderId,
    name: derivedFolderName,
    sourceKind: 'local-file',
    capabilities,
  };

  // Sort lightweight File objects oldest-first (grouping close JPG+RAW timestamps by natural path)
  const orderedFiles: { file: File; rel: string }[] = files.map((file) => ({
    file,
    rel:
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name,
  }));
  if (orderedFiles.length <= 15000) {
    orderedFiles.sort((a, b) => {
      const ta = a.file.lastModified || 0;
      const tb = b.file.lastModified || 0;
      if (ta > 0 && tb > 0 && Math.abs(ta - tb) > 4000) {
        return ta - tb;
      }
      return a.rel.localeCompare(b.rel, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
  }

  let cursor = 0;
  let pageNumber = 0;
  let totalDiscovered = 0;

  while (cursor < orderedFiles.length && !signal.aborted) {
    const targetSize =
      pageNumber === 0 ? LOCAL_INITIAL_BATCH_SIZE : LOCAL_BACKGROUND_BATCH_SIZE;
    const batch: DrivePhotoFile[] = [];
    let inspectedInChunk = 0;

    while (cursor < orderedFiles.length && batch.length < targetSize) {
      const entry = orderedFiles[cursor++];
      inspectedInChunk++;

      if (!isTopLevelOrNestedIgnored(entry.rel)) {
        const photo = buildPhotoFromLocalFile(
          entry.file,
          entry.rel,
          'local-file'
        );
        if (photo) {
          batch.push(photo);
        }
      }

      // Avoid blocking if thousands of non-image files precede images
      if (inspectedInChunk >= 400 && batch.length === 0) {
        await yieldToMainThread();
        if (signal.aborted) return;
        inspectedInChunk = 0;
      }
    }

    // Keep JPG + RAW stem pairs together across batch boundaries
    if (batch.length > 0) {
      const lastStem = batch[batch.length - 1].stem;
      while (cursor < orderedFiles.length && batch.length < targetSize + 3) {
        const nextEntry = orderedFiles[cursor];
        if (getFileStem(nextEntry.file.name) !== lastStem) break;
        cursor++;
        if (!isTopLevelOrNestedIgnored(nextEntry.rel)) {
          const photo = buildPhotoFromLocalFile(
            nextEntry.file,
            nextEntry.rel,
            'local-file'
          );
          if (photo) batch.push(photo);
        }
      }
    }

    const hasMore = cursor < orderedFiles.length;
    if (batch.length > 0 || !hasMore) {
      pageNumber++;
      totalDiscovered += batch.length;
      onBatch(folder, batch, {
        pageNumber,
        hasMore,
        totalDiscovered,
      });
    }

    if (hasMore) {
      await yieldToMainThread();
    }
  }
}

/**
 * Synchronous helper preserved for compatibility.
 */
export function buildLocalSessionFromFileList(
  fileList: FileList | File[],
  fallbackName = 'Vybrané soubory / SD karta'
): LocalSessionBundle {
  const files = Array.from(fileList);
  const firstRel = (files[0] as File & { webkitRelativePath?: string })
    ?.webkitRelativePath;
  const derivedFolderName =
    firstRel && firstRel.includes('/')
      ? firstRel.split('/')[0]
      : fallbackName;

  const photos: DrivePhotoFile[] = [];

  for (const file of files) {
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name;
    if (isTopLevelOrNestedIgnored(rel)) continue;

    const photo = buildPhotoFromLocalFile(file, rel, 'local-file');
    if (photo) photos.push(photo);
  }

  sortPhotosNaturally(photos);

  const hasDirStructure = Boolean(firstRel && firstRel.includes('/'));
  const folderId = hasDirStructure
    ? buildStableStreamFolderId('local-file-dir', derivedFolderName)
    : buildLocalFolderId(
        derivedFolderName,
        photos.map((p) => ({
          name: p.relativePath || p.name,
          sizeBytes: p.sizeBytes,
        }))
      );

  const capabilities: SourceCapabilities = {
    sourceKind: 'local-file',
    canTrashSubfolder: false,
    canPermanentDelete: false,
    isReadOnlyFallback: true,
    supportsDirectoryPicker: false,
  };

  const folder: DriveFolder = {
    id: folderId,
    name: derivedFolderName,
    sourceKind: 'local-file',
    capabilities,
  };

  return { folder, photos };
}

/**
 * Reads byte range from a local File / FileSystemFileHandle / Android SAF URI without loading the full RAW into memory.
 */
export async function readLocalFileBytes(
  file: DrivePhotoFile,
  range?: { start: number; end: number },
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  if (file.sourceKind === 'android-saf' && file.nativeUri && window.FrameCullNative) {
    const start = range ? Math.max(0, range.start) : 0;
    const end = range
      ? Math.max(start, range.end)
      : Math.max(0, (file.sizeBytes || 1) - 1);
    const res = await window.FrameCullNative.readFileSlice(
      file.nativeUri,
      start,
      end
    );
    if (typeof res === 'string') {
      return decodeBase64ToArrayBuffer(res);
    }
    return res;
  }

  const blobFile =
    file.localFile || (file.fsHandle ? await file.fsHandle.getFile() : null);
  if (!blobFile) {
    throw new Error(`Lokální soubor ${file.name} již není dostupný.`);
  }

  const slice = range
    ? blobFile.slice(
        Math.max(0, range.start),
        Math.min(blobFile.size, range.end + 1)
      )
    : blobFile;

  const buffer = await slice.arrayBuffer();
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  return buffer;
}

/**
 * Moves a local FileSystemFileHandle into `_Vyrazene` inside its parent directory (or rootDirHandle).
 */
export async function moveLocalFileToTrashSubfolder(
  rootDirHandle: FileSystemDirectoryHandle,
  file: DrivePhotoFile
): Promise<void> {
  const parentDir = file.parentDirHandle || rootDirHandle;
  const trashDir = await parentDir.getDirectoryHandle(TRASH_SUBFOLDER_NAME, {
    create: true,
  });

  const fsHandleWithMove = file.fsHandle as
    | (FileSystemFileHandle & {
        move?: (
          destination: FileSystemDirectoryHandle,
          newName?: string
        ) => Promise<void>;
      })
    | undefined;

  if (fsHandleWithMove && typeof fsHandleWithMove.move === 'function') {
    await fsHandleWithMove.move(trashDir, file.name);
    return;
  }

  // Fallback for browsers without FileSystemFileHandle.move(): copy stream + removeEntry
  const sourceFile =
    file.localFile || (file.fsHandle ? await file.fsHandle.getFile() : null);
  if (!sourceFile) {
    throw new Error(`Soubor ${file.name} nelze přesunout.`);
  }

  const destHandle = await trashDir.getFileHandle(file.name, { create: true });
  const writable = await destHandle.createWritable();
  try {
    await sourceFile.stream().pipeTo(writable);
  } catch (err) {
    try {
      await writable.abort();
    } catch {
      // Ignore abort failure
    }
    throw err;
  }

  await parentDir.removeEntry(file.name);
}

/**
 * Permanently removes a local file from its directory via File System Access API.
 */
export async function deleteLocalFilePermanently(
  rootDirHandle: FileSystemDirectoryHandle,
  file: DrivePhotoFile
): Promise<void> {
  const parentDir = file.parentDirHandle || rootDirHandle;
  await parentDir.removeEntry(file.name);
}

export async function ensureLocalDirWritePermission(
  dirHandle: FileSystemDirectoryHandle
): Promise<boolean> {
  const handleWithPerm = dirHandle as FileSystemDirectoryHandle & {
    queryPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
    requestPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  };

  if (typeof handleWithPerm.queryPermission === 'function') {
    const current = await handleWithPerm.queryPermission({ mode: 'readwrite' });
    if (current === 'granted') return true;
  }
  if (typeof handleWithPerm.requestPermission === 'function') {
    const requested = await handleWithPerm.requestPermission({ mode: 'readwrite' });
    return requested === 'granted';
  }
  return true;
}

/**
 * Lists lowercase filenames of all files currently inside the local `Liked` subfolder.
 */
export async function listLocalLikedFileNames(
  rootDirHandle: FileSystemDirectoryHandle
): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const likedDir = await rootDirHandle.getDirectoryHandle(
      LIKED_SUBFOLDER_NAME,
      { create: false }
    );
    const iterableDir = likedDir as unknown as {
      values: () => AsyncIterable<FileSystemHandle>;
    };
    for await (const handle of iterableDir.values()) {
      if (handle.kind === 'file' && handle.name.trim()) {
        names.add(handle.name.trim().toLowerCase());
      }
    }
  } catch {
    // Subfolder does not exist yet
  }
  return names;
}

async function doesLocalFileExist(
  destDir: FileSystemDirectoryHandle,
  desiredName: string
): Promise<boolean> {
  try {
    await destDir.getFileHandle(desiredName, { create: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies a local FileSystemFileHandle into the `Liked` subfolder of `rootDirHandle`.
 * Never creates duplicate `_1` copies — skips if a file with the same name is already there.
 */
export async function copyLocalFileToLikedSubfolder(
  rootDirHandle: FileSystemDirectoryHandle,
  file: DrivePhotoFile
): Promise<'copied' | 'skipped'> {
  const likedDir = await rootDirHandle.getDirectoryHandle(LIKED_SUBFOLDER_NAME, {
    create: true,
  });

  if (await doesLocalFileExist(likedDir, file.name)) {
    return 'skipped';
  }

  const sourceFile =
    file.localFile || (file.fsHandle ? await file.fsHandle.getFile() : null);
  if (!sourceFile) {
    throw new Error(`Soubor ${file.name} nelze zkopírovat.`);
  }

  const destHandle = await likedDir.getFileHandle(file.name, { create: true });
  const writable = await destHandle.createWritable();
  try {
    await sourceFile.stream().pipeTo(writable);
  } catch (err) {
    try {
      await writable.abort();
    } catch {
      // Ignore abort failure
    }
    throw err;
  }
  return 'copied';
}

/**
 * Moves a local FileSystemFileHandle into the `Liked` subfolder of `rootDirHandle`.
 * Skips instead of creating duplicates if a file with the same name already exists in `Liked`.
 */
export async function moveLocalFileToLikedSubfolder(
  rootDirHandle: FileSystemDirectoryHandle,
  file: DrivePhotoFile
): Promise<'moved' | 'skipped'> {
  const parentDir = file.parentDirHandle || rootDirHandle;
  const likedDir = await rootDirHandle.getDirectoryHandle(LIKED_SUBFOLDER_NAME, {
    create: true,
  });

  if (await doesLocalFileExist(likedDir, file.name)) {
    return 'skipped';
  }

  const fsHandleWithMove = file.fsHandle as
    | (FileSystemFileHandle & {
        move?: (
          destination: FileSystemDirectoryHandle,
          newName?: string
        ) => Promise<void>;
      })
    | undefined;

  if (fsHandleWithMove && typeof fsHandleWithMove.move === 'function') {
    await fsHandleWithMove.move(likedDir, file.name);
    return 'moved';
  }

  const sourceFile =
    file.localFile || (file.fsHandle ? await file.fsHandle.getFile() : null);
  if (!sourceFile) {
    throw new Error(`Soubor ${file.name} nelze přesunout.`);
  }

  const destHandle = await likedDir.getFileHandle(file.name, { create: true });
  const writable = await destHandle.createWritable();
  try {
    await sourceFile.stream().pipeTo(writable);
  } catch (err) {
    try {
      await writable.abort();
    } catch {
      // Ignore abort failure
    }
    throw err;
  }

  await parentDir.removeEntry(file.name);
  return 'moved';
}

export function buildLikedListText(files: DrivePhotoFile[]): string {
  return files.map((f) => f.relativePath || f.name).join('\n') + '\n';
}

export function buildLikedShellScript(
  files: DrivePhotoFile[],
  mode: 'copy' | 'move' = 'copy'
): string {
  const cmd = mode === 'move' ? 'mv -nv' : 'cp -nv';
  const lines = [
    '#!/usr/bin/env bash',
    `# Selectra — Export vybranych fotek do podslozky ${LIKED_SUBFOLDER_NAME}`,
    '# Spustte tento skript uvnitr vybrane slozky na disku nebo SD karte.',
    'set -e',
    '',
    `mkdir -p "./${LIKED_SUBFOLDER_NAME}"`,
    '',
  ];
  for (const f of files) {
    const rel = (f.relativePath || f.name).replace(/"/g, '\\"');
    lines.push(`${cmd} -- "./${rel}" "./${LIKED_SUBFOLDER_NAME}/"`);
  }
  lines.push(
    '',
    `echo "Hotovo: vybrane soubory byly ulozeny do slozky ${LIKED_SUBFOLDER_NAME}."`
  );
  return lines.join('\n') + '\n';
}

export function buildLikedBatchScript(
  files: DrivePhotoFile[],
  mode: 'copy' | 'move' = 'copy'
): string {
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    `REM Selectra - Export vybranych fotek do podslozky ${LIKED_SUBFOLDER_NAME}`,
    'REM Zkopirujte tento soubor do slozky s fotkami nebo na SD kartu a spustte jej.',
    '',
    `if not exist "${LIKED_SUBFOLDER_NAME}" mkdir "${LIKED_SUBFOLDER_NAME}"`,
    '',
  ];
  for (const f of files) {
    const rel = (f.relativePath || f.name).replace(/\//g, '\\').replace(/"/g, '');
    const fileNameOnly = f.name.replace(/"/g, '');
    if (mode === 'move') {
      lines.push(
        `if exist "${rel}" if not exist "${LIKED_SUBFOLDER_NAME}\\${fileNameOnly}" move "${rel}" "${LIKED_SUBFOLDER_NAME}\\"`
      );
    } else {
      lines.push(
        `if exist "${rel}" if not exist "${LIKED_SUBFOLDER_NAME}\\${fileNameOnly}" copy "${rel}" "${LIKED_SUBFOLDER_NAME}\\"`
      );
    }
  }
  lines.push('', 'echo Hotovo.', 'pause');
  return lines.join('\r\n') + '\r\n';
}

export function buildTrashShellScript(
  files: DrivePhotoFile[],
  mode: 'trash' | 'permanent' = 'trash'
): string {
  const lines = [
    '#!/usr/bin/env bash',
    `# FrameCull — ${
      mode === 'permanent'
        ? 'Trvale smazani vyrazenych fotek'
        : `Presun vyrazenych fotek do podslozky ${TRASH_SUBFOLDER_NAME}`
    }`,
    '# Spustte tento skript uvnitr vybrane slozky na disku nebo SD karte.',
    'set -e',
    '',
  ];
  if (mode === 'trash') {
    lines.push(`mkdir -p "./${TRASH_SUBFOLDER_NAME}"`, '');
  }
  for (const f of files) {
    const rel = (f.relativePath || f.name).replace(/"/g, '\\"');
    if (mode === 'permanent') {
      lines.push(`rm -fv -- "./${rel}"`);
    } else {
      lines.push(`mv -nv -- "./${rel}" "./${TRASH_SUBFOLDER_NAME}/"`);
    }
  }
  lines.push(
    '',
    mode === 'permanent'
      ? 'echo "Hotovo: vybrane soubory byly smazany."'
      : `echo "Hotovo: vybrane soubory byly presunuty do slozky ${TRASH_SUBFOLDER_NAME}."`
  );
  return lines.join('\n') + '\n';
}

export function buildTrashBatchScript(
  files: DrivePhotoFile[],
  mode: 'trash' | 'permanent' = 'trash'
): string {
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    `REM FrameCull - ${
      mode === 'permanent'
        ? 'Trvale smazani vyrazenych fotek'
        : `Presun vyrazenych fotek do podslozky ${TRASH_SUBFOLDER_NAME}`
    }`,
    'REM Zkopirujte tento soubor do slozky s fotkami nebo na SD kartu a spustte jej.',
    '',
  ];
  if (mode === 'trash') {
    lines.push(`if not exist "${TRASH_SUBFOLDER_NAME}" mkdir "${TRASH_SUBFOLDER_NAME}"`, '');
  }
  for (const f of files) {
    const rel = (f.relativePath || f.name).replace(/\//g, '\\').replace(/"/g, '');
    if (mode === 'permanent') {
      lines.push(`if exist "${rel}" del /F /Q "${rel}"`);
    } else {
      lines.push(`if exist "${rel}" move /Y "${rel}" "${TRASH_SUBFOLDER_NAME}\\"`);
    }
  }
  lines.push('', 'echo Hotovo.', 'pause');
  return lines.join('\r\n') + '\r\n';
}

export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = 'text/plain;charset=utf-8'
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function exportPickedLocalPhotos(
  pickedFiles: DrivePhotoFile[],
  onProgress?: (done: number, total: number) => void
): Promise<{ method: 'share' | 'download'; count: number }> {
  const actualFiles: File[] = [];
  for (const item of pickedFiles) {
    if (item.localFile) {
      actualFiles.push(item.localFile);
    } else if (item.fsHandle) {
      actualFiles.push(await item.fsHandle.getFile());
    }
  }

  if (actualFiles.length === 0) {
    return { method: 'download', count: 0 };
  }

  const navWithShare = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
  };
  if (
    typeof navigator.share === 'function' &&
    typeof navWithShare.canShare === 'function' &&
    actualFiles.length <= 30 &&
    navWithShare.canShare({ files: actualFiles })
  ) {
    try {
      await navigator.share({
        title: `Selectra — Vybrané snímky (${actualFiles.length})`,
        files: actualFiles,
      });
      onProgress?.(actualFiles.length, actualFiles.length);
      return { method: 'share', count: actualFiles.length };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { method: 'share', count: 0 };
      }
    }
  }

  for (let i = 0; i < actualFiles.length; i++) {
    const file = actualFiles[i];
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 2500);
    onProgress?.(i + 1, actualFiles.length);
    await new Promise((r) => setTimeout(r, 120));
  }

  return { method: 'download', count: actualFiles.length };
}

export const exportKeptLocalPhotos = exportPickedLocalPhotos;


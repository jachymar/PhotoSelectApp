import {
  DriveFolder,
  DrivePhotoFile,
  SourceCapabilities,
  getFileStem,
  isSupportedPhoto,
} from './driveApi';
import { waitForBackgroundSlot, withTimeout } from './interactionGate';

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

export interface NativeAppBuildInfo {
  versionName: string;
  versionCode: number;
  packageName: string;
  canInstallPackages: boolean;
  hasPendingApk: boolean;
  sha1Fingerprint?: string | null;
}

export interface NativeExtractedRawPreview {
  url: string;
  orientation?: number;
}

export interface NativeApkDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
}

export interface NativeApkInstallResult {
  status: 'installer_launched' | 'needs_install_permission';
}

/**
 * Contract for a Capacitor / Android WebView SAF bridge (`window.FrameCullNative`)
 * enabling direct folder tree access and real file deletion on internal storage
 * and USB OTG SD cards via Android Storage Access Framework (ACTION_OPEN_DOCUMENT_TREE),
 * permanent native Google Drive authentication, and in-app GitHub Release APK updates.
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
  extractRawThumbnailUrl?(uri: string): Promise<NativeExtractedRawPreview | null>;
  extractRawPreviewUrl?(uri: string): Promise<NativeExtractedRawPreview | null>;
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
  getAppBuildInfo?(): Promise<NativeAppBuildInfo | null>;
  downloadAndInstallApk?(options: {
    apkUrl: string;
    githubToken?: string | null;
    versionTag?: string | null;
  }): Promise<NativeApkInstallResult>;
  installPendingApk?(): Promise<NativeApkInstallResult>;
  openExternalUrl?(url: string): Promise<void>;
  onApkDownloadProgress?(
    listener: (progress: NativeApkDownloadProgress) => void
  ): Promise<() => void>;
}

declare global {
  interface Window {
    FrameCullNative?: FrameCullNativeBridge;
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

export const LOCAL_INITIAL_BATCH_SIZE = 24;
export const LOCAL_BACKGROUND_BATCH_SIZE = 200;

export const TRASH_SUBFOLDER_NAME = '_Vyrazene';
export const LIKED_SUBFOLDER_NAME = 'Liked';
const EXPORT_FOLDER_NAME_LS_KEY = 'selectra_export_folder_name_v1';

export function sanitizeExportFolderName(raw: string): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .trim()
    .slice(0, 80);
  return cleaned || LIKED_SUBFOLDER_NAME;
}

export function readPreferredExportFolderName(): string {
  try {
    const raw = window.localStorage.getItem(EXPORT_FOLDER_NAME_LS_KEY);
    if (raw && raw.trim()) {
      return sanitizeExportFolderName(raw);
    }
  } catch {
    // Ignore storage read errors
  }
  return LIKED_SUBFOLDER_NAME;
}

export function writePreferredExportFolderName(folderName: string): string {
  const clean = sanitizeExportFolderName(folderName);
  try {
    window.localStorage.setItem(EXPORT_FOLDER_NAME_LS_KEY, clean);
  } catch {
    // Ignore storage write errors
  }
  return clean;
}

export function supportsWebDirectoryPicker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown })
      .showDirectoryPicker === 'function'
  );
}

export interface WebDirectoryHandleLike {
  name: string;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<WebDirectoryHandleLike>;
  getFileHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<{
    createWritable(): Promise<{
      write(data: Blob | BufferSource): Promise<void>;
      close(): Promise<void>;
    }>;
  }>;
  values?(): AsyncIterable<{ kind: 'file' | 'directory'; name: string }>;
}

export async function pickWebDirectoryHandle(): Promise<WebDirectoryHandleLike | null> {
  if (!supportsWebDirectoryPicker()) return null;
  try {
    const picker = (
      window as unknown as {
        showDirectoryPicker: (opts?: {
          mode?: 'read' | 'readwrite';
        }) => Promise<WebDirectoryHandleLike>;
      }
    ).showDirectoryPicker;
    return await picker({ mode: 'readwrite' });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return null;
    }
    throw err;
  }
}

export async function listSubfolderNamesInWebDirectory(
  dirHandle: WebDirectoryHandleLike
): Promise<string[]> {
  const names: string[] = [];
  if (typeof dirHandle.values !== 'function') return names;
  try {
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'directory' && entry.name && !entry.name.startsWith('.')) {
        names.push(entry.name);
      }
    }
  } catch {
    // Ignore iteration errors
  }
  return names.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );
}

export async function listFileNamesInWebDirectory(
  dirHandle: WebDirectoryHandleLike,
  subfolderName?: string
): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const targetDir =
      subfolderName && subfolderName.trim()
        ? await dirHandle.getDirectoryHandle(
            sanitizeExportFolderName(subfolderName),
            { create: false }
          )
        : dirHandle;
    if (typeof targetDir.values === 'function') {
      for await (const entry of targetDir.values()) {
        if (entry.kind === 'file' && entry.name) {
          names.add(entry.name.trim().toLowerCase());
        }
      }
    }
  } catch {
    // Subfolder may not exist yet
  }
  return names;
}

export async function exportPhotosToWebDirectoryHandle(
  rootDirHandle: WebDirectoryHandleLike,
  subfolderName: string | null,
  pickedFiles: DrivePhotoFile[],
  onProgress?: (done: number, total: number, currentName: string) => void
): Promise<{
  succeededCount: number;
  failed: { name: string; error: string }[];
  targetFolderLabel: string;
}> {
  const cleanSub =
    subfolderName && subfolderName.trim()
      ? sanitizeExportFolderName(subfolderName)
      : null;
  const targetDir = cleanSub
    ? await rootDirHandle.getDirectoryHandle(cleanSub, { create: true })
    : rootDirHandle;
  const targetFolderLabel = cleanSub
    ? `${rootDirHandle.name}/${cleanSub}`
    : rootDirHandle.name;

  let succeededCount = 0;
  const failed: { name: string; error: string }[] = [];

  for (let i = 0; i < pickedFiles.length; i++) {
    const item = pickedFiles[i];
    onProgress?.(i, pickedFiles.length, item.name);
    try {
      let blobData: Blob | ArrayBuffer;
      if (item.localFile) {
        blobData = item.localFile;
      } else {
        blobData = await readLocalFileBytes(item);
      }
      const fileHandle = await targetDir.getFileHandle(item.name, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(blobData);
      await writable.close();
      succeededCount++;
    } catch (err: unknown) {
      failed.push({
        name: item.name,
        error: err instanceof Error ? err.message : 'Chyba zápisu souboru',
      });
    }
    onProgress?.(i + 1, pickedFiles.length, item.name);
  }

  return { succeededCount, failed, targetFolderLabel };
}

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

function yieldToMainThread(delayMs = 12): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
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
  prefix: 'local-file-dir' | 'local-file-sel',
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
  sourceKind: 'local-file'
): DrivePhotoFile | null {
  const check = isSupportedPhoto({
    name: file.name,
    mimeType: file.type,
  });
  if (!check.supported) return null;

  return {
    id: `local-file:${hashString(relativePath)}:${file.size}:${file.lastModified}`,
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
    relativePath,
  };
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
      await waitForBackgroundSlot(signal);
      await yieldToMainThread(16);
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
      await waitForBackgroundSlot(signal);
      await yieldToMainThread(16);
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
    const fallbackFullEnd =
      file.sizeBytes && file.sizeBytes > 0
        ? file.sizeBytes - 1
        : 24 * 1024 * 1024 - 1;
    const end = range
      ? Math.max(start, range.end)
      : Math.max(start, fallbackFullEnd);
    const res = await withTimeout(
      window.FrameCullNative.readFileSlice(file.nativeUri, start, end),
      14_000,
      `Čtení souboru ${file.name}`
    );
    if (typeof res === 'string') {
      return decodeBase64ToArrayBuffer(res);
    }
    return res;
  }

  const blobFile = file.localFile;
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

export function buildLikedListText(files: DrivePhotoFile[]): string {
  return files.map((f) => f.relativePath || f.name).join('\n') + '\n';
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


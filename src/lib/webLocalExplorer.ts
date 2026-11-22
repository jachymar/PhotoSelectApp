import { isSupportedPhoto } from './driveApi';
import {
  LocalDirectoryListing,
  LocalPreviewPhotoItem,
  LocalStorageRoot,
  LocalStreamStarter,
  LocalSubfolderEntry,
  buildStableStreamFolderId,
  streamFileListSession,
  supportsWebDirectoryPicker,
} from './localMedia';
import { tr } from './i18n';

const WEB_ROOTS_DB_NAME = 'selectra_web_roots_db_v1';
const WEB_ROOTS_STORE = 'roots';

const IGNORED_DIRS = new Set([
  'liked',
  '_vyrazene',
  '_trash',
  '.trash',
  '.trashed',
  'lost.dir',
  'system volume information',
  '.android_secure',
]);

interface FileSystemEntryLike {
  kind: 'file' | 'directory';
  name: string;
}

interface FileSystemFileHandleLike extends FileSystemEntryLike {
  kind: 'file';
  getFile(): Promise<File>;
}

interface FileSystemDirectoryHandleFull extends FileSystemEntryLike {
  kind: 'directory';
  values(): AsyncIterable<FileSystemEntryLike>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<FileSystemDirectoryHandleFull>;
  queryPermission?(desc?: {
    mode?: 'read' | 'readwrite';
  }): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?(desc?: {
    mode?: 'read' | 'readwrite';
  }): Promise<'granted' | 'denied' | 'prompt'>;
}

interface PersistedWebRootRecord {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandleFull;
  addedAtMs: number;
}

interface VirtualFolderNode {
  name: string;
  relPathParts: string[];
  subfolders: Map<string, VirtualFolderNode>;
  files: File[];
}

interface VirtualRootRecord {
  id: string;
  name: string;
  rootNode: VirtualFolderNode;
}

const virtualRoots = new Map<string, VirtualRootRecord>();

function hashKey(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function openRootsDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(WEB_ROOTS_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WEB_ROOTS_STORE)) {
        db.createObjectStore(WEB_ROOTS_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB error'));
  });
}

async function readAllPersistedWebRoots(): Promise<PersistedWebRootRecord[]> {
  try {
    const db = await openRootsDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(WEB_ROOTS_STORE, 'readonly');
      const store = tx.objectStore(WEB_ROOTS_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const list = (req.result as PersistedWebRootRecord[]) || [];
        resolve(list.sort((a, b) => (b.addedAtMs || 0) - (a.addedAtMs || 0)));
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

async function readPersistedWebRoot(
  id: string
): Promise<PersistedWebRootRecord | null> {
  try {
    const db = await openRootsDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(WEB_ROOTS_STORE, 'readonly');
      const store = tx.objectStore(WEB_ROOTS_STORE);
      const req = store.get(id);
      req.onsuccess = () =>
        resolve((req.result as PersistedWebRootRecord) || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function savePersistedWebRoot(
  rec: PersistedWebRootRecord
): Promise<void> {
  try {
    const db = await openRootsDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(WEB_ROOTS_STORE, 'readwrite');
      tx.objectStore(WEB_ROOTS_STORE).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore IDB persistence failures (private browsing, etc.)
  }
}

export async function removeWebStorageRoot(rootId: string): Promise<void> {
  virtualRoots.delete(rootId);
  try {
    const db = await openRootsDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(WEB_ROOTS_STORE, 'readwrite');
      tx.objectStore(WEB_ROOTS_STORE).delete(rootId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore cleanup errors
  }
}

export async function listWebStorageRoots(): Promise<LocalStorageRoot[]> {
  const out: LocalStorageRoot[] = [];
  const persisted = await readAllPersistedWebRoots();
  for (const rec of persisted) {
    if (!rec?.id || !rec.handle) continue;
    out.push({
      id: rec.id,
      kind: 'web-handle',
      name: rec.name || rec.handle.name || tr('Lokální složka', 'Local folder'),
      path: '',
      volumeType: 'web',
    });
  }
  for (const v of virtualRoots.values()) {
    out.push({
      id: v.id,
      kind: 'web-virtual',
      name: v.name,
      path: '',
      volumeType: 'web',
    });
  }
  return out;
}

export async function attachWebDirectoryRoot(): Promise<LocalStorageRoot | null> {
  if (!supportsWebDirectoryPicker()) return null;
  try {
    const winWithPicker = window as unknown as {
      showDirectoryPicker: (opts?: {
        mode?: 'read' | 'readwrite';
      }) => Promise<FileSystemDirectoryHandleFull>;
    };
    const handle = await winWithPicker.showDirectoryPicker({ mode: 'read' });
    const name = handle.name || tr('Lokální složka', 'Local folder');
    const id = `web-root-${hashKey(`${name}#${Date.now()}`)}`;
    await savePersistedWebRoot({
      id,
      name,
      handle,
      addedAtMs: Date.now(),
    });
    return {
      id,
      kind: 'web-handle',
      name,
      path: '',
      volumeType: 'web',
    };
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return null;
    }
    throw err;
  }
}

export function attachWebVirtualRootFromFileList(
  files: File[]
): LocalStorageRoot | null {
  if (!files || files.length === 0) return null;
  const firstWithRel = files.find((f) => {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    return Boolean(rel && rel.includes('/'));
  });
  const firstRel = firstWithRel
    ? (firstWithRel as File & { webkitRelativePath?: string })
        .webkitRelativePath || ''
    : '';
  const rootName = firstRel.includes('/')
    ? firstRel.split('/')[0]
    : tr('Vybrané lokální soubory', 'Selected local files');

  const rootNode: VirtualFolderNode = {
    name: rootName,
    relPathParts: [],
    subfolders: new Map(),
    files: [],
  };

  for (const file of files) {
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name;
    const segments = rel.split('/').filter(Boolean);
    const dirSegments =
      segments.length > 1 && segments[0] === rootName
        ? segments.slice(1, -1)
        : segments.slice(0, -1);

    let cursor = rootNode;
    let ignored = false;
    const accPath: string[] = [];
    for (const seg of dirSegments) {
      const lower = seg.trim().toLowerCase();
      if (seg.startsWith('.') || IGNORED_DIRS.has(lower)) {
        ignored = true;
        break;
      }
      accPath.push(seg);
      let next = cursor.subfolders.get(seg);
      if (!next) {
        next = {
          name: seg,
          relPathParts: [...accPath],
          subfolders: new Map(),
          files: [],
        };
        cursor.subfolders.set(seg, next);
      }
      cursor = next;
    }
    if (ignored) continue;
    if (file.name.startsWith('.')) continue;
    const check = isSupportedPhoto({ name: file.name, mimeType: file.type });
    if (!check.supported) continue;
    cursor.files.push(file);
  }

  const id = `web-virt-${hashKey(`${rootName}#${files.length}#${Date.now()}`)}`;
  virtualRoots.set(id, { id, name: rootName, rootNode });

  return {
    id,
    kind: 'web-virtual',
    name: rootName,
    path: '',
    volumeType: 'web',
  };
}

async function ensureHandleReadPermission(
  handle: FileSystemDirectoryHandleFull
): Promise<boolean> {
  if (typeof handle.queryPermission === 'function') {
    const current = await handle.queryPermission({ mode: 'read' });
    if (current === 'granted') return true;
  }
  if (typeof handle.requestPermission === 'function') {
    const requested = await handle.requestPermission({ mode: 'read' });
    return requested === 'granted';
  }
  return true;
}

async function resolveWebHandleAtPath(
  rootHandle: FileSystemDirectoryHandleFull,
  relPathParts: string[]
): Promise<FileSystemDirectoryHandleFull> {
  let cursor = rootHandle;
  for (const seg of relPathParts) {
    cursor = await cursor.getDirectoryHandle(seg, { create: false });
  }
  return cursor;
}

function resolveVirtualNodeAtPath(
  rootNode: VirtualFolderNode,
  relPathParts: string[]
): VirtualFolderNode | null {
  let cursor: VirtualFolderNode | undefined = rootNode;
  for (const seg of relPathParts) {
    cursor = cursor.subfolders.get(seg);
    if (!cursor) return null;
  }
  return cursor;
}

export async function listWebDirectory(
  root: LocalStorageRoot,
  relPathParts: string[]
): Promise<LocalDirectoryListing> {
  const pathStr = relPathParts.join('/');
  const folderKey = `${root.name}${pathStr ? '/' + pathStr : ''}`;
  const folderId = buildStableStreamFolderId('local-file-dir', folderKey);

  if (root.kind === 'web-virtual') {
    const rec = virtualRoots.get(root.id);
    if (!rec) {
      throw new Error(
        tr(
          'Připojená složka již není v paměti prohlížeče dostupná.',
          'The attached folder is no longer available in browser memory.'
        )
      );
    }
    const node = resolveVirtualNodeAtPath(rec.rootNode, relPathParts);
    if (!node) {
      throw new Error(tr('Složka nebyla nalezena.', 'Folder not found.'));
    }

    const subfolders: LocalSubfolderEntry[] = Array.from(node.subfolders.values())
      .map((sub) => {
        const subKey = `${root.name}/${sub.relPathParts.join('/')}`;
        return {
          id: buildStableStreamFolderId('local-file-dir', subKey),
          name: sub.name,
          path: sub.relPathParts.join('/'),
          relPathParts: sub.relPathParts,
          photoCount: sub.files.length,
          subfolderCount: sub.subfolders.size,
        };
      })
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: 'base',
        })
      );

    const photos: LocalPreviewPhotoItem[] = node.files
      .map((file) => {
        const check = isSupportedPhoto({ name: file.name, mimeType: file.type });
        return {
          id: `web-file:${hashKey(`${folderKey}/${file.name}:${file.size}`)}`,
          uri: '',
          name: file.name,
          relativePath: file.name,
          mimeType: file.type || '',
          sizeBytes: file.size,
          lastModifiedMs: file.lastModified,
          isRaw: check.isRaw,
          fileExtension: check.ext,
          localFile: file,
        };
      })
      .sort((a, b) => {
        const ta = a.lastModifiedMs || 0;
        const tb = b.lastModifiedMs || 0;
        if (ta > 0 && tb > 0 && Math.abs(ta - tb) > 4000) return tb - ta;
        return a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      });

    return {
      folderId,
      name: node.name,
      kind: 'web-virtual',
      path: pathStr,
      parentPath:
        relPathParts.length > 0 ? relPathParts.slice(0, -1).join('/') : undefined,
      canGoUp: relPathParts.length > 0,
      subfolders,
      photos,
    };
  }

  const persisted = await readPersistedWebRoot(root.id);
  if (!persisted?.handle) {
    throw new Error(
      tr(
        'Připojená složka nebyla nalezena. Připojte ji prosím znovu.',
        'Connected folder was not found. Please attach it again.'
      )
    );
  }
  const granted = await ensureHandleReadPermission(persisted.handle);
  if (!granted) {
    throw new Error(
      tr(
        'Prohlížeč zamítl přístup ke čtení této složky.',
        'Browser denied read access to this folder.'
      )
    );
  }

  const targetDir = await resolveWebHandleAtPath(persisted.handle, relPathParts);
  const subfolders: LocalSubfolderEntry[] = [];
  const photos: LocalPreviewPhotoItem[] = [];

  for await (const entry of targetDir.values()) {
    if (!entry?.name || entry.name.startsWith('.')) continue;
    if (entry.kind === 'directory') {
      const lower = entry.name.trim().toLowerCase();
      if (IGNORED_DIRS.has(lower)) continue;
      const nextParts = [...relPathParts, entry.name];
      const subKey = `${root.name}/${nextParts.join('/')}`;
      subfolders.push({
        id: buildStableStreamFolderId('local-file-dir', subKey),
        name: entry.name,
        path: nextParts.join('/'),
        relPathParts: nextParts,
      });
    } else if (entry.kind === 'file') {
      const check = isSupportedPhoto({ name: entry.name, mimeType: '' });
      if (!check.supported) continue;
      try {
        const file = await (entry as FileSystemFileHandleLike).getFile();
        photos.push({
          id: `web-file:${hashKey(`${folderKey}/${file.name}:${file.size}`)}`,
          uri: '',
          name: file.name,
          relativePath: file.name,
          mimeType: file.type || '',
          sizeBytes: file.size,
          lastModifiedMs: file.lastModified,
          isRaw: check.isRaw,
          fileExtension: check.ext,
          localFile: file,
        });
      } catch {
        // Skip unreadable entries
      }
    }
  }

  subfolders.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  );
  photos.sort((a, b) => {
    const ta = a.lastModifiedMs || 0;
    const tb = b.lastModifiedMs || 0;
    if (ta > 0 && tb > 0 && Math.abs(ta - tb) > 4000) return tb - ta;
    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });

  return {
    folderId,
    name:
      relPathParts.length > 0
        ? relPathParts[relPathParts.length - 1]
        : root.name,
    kind: 'web-handle',
    path: pathStr,
    parentPath:
      relPathParts.length > 0 ? relPathParts.slice(0, -1).join('/') : undefined,
    canGoUp: relPathParts.length > 0,
    subfolders,
    photos,
  };
}

async function collectHandleFilesRecursive(
  dir: FileSystemDirectoryHandleFull,
  folderName: string,
  relPrefix: string,
  depth: number,
  out: File[]
): Promise<void> {
  for await (const entry of dir.values()) {
    if (!entry?.name || entry.name.startsWith('.')) continue;
    if (entry.kind === 'directory') {
      if (depth < 2) {
        const lower = entry.name.trim().toLowerCase();
        if (IGNORED_DIRS.has(lower)) continue;
        const subHandle = await dir.getDirectoryHandle(entry.name, {
          create: false,
        });
        const nextPrefix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        await collectHandleFilesRecursive(
          subHandle,
          folderName,
          nextPrefix,
          depth + 1,
          out
        );
      }
    } else if (entry.kind === 'file') {
      const check = isSupportedPhoto({ name: entry.name, mimeType: '' });
      if (!check.supported) continue;
      try {
        const file = await (entry as FileSystemFileHandleLike).getFile();
        const syntheticRel = relPrefix
          ? `${folderName}/${relPrefix}/${file.name}`
          : `${folderName}/${file.name}`;
        Object.defineProperty(file, 'webkitRelativePath', {
          value: syntheticRel,
          configurable: true,
        });
        out.push(file);
      } catch {
        // Skip unreadable entries
      }
    }
  }
}

function collectVirtualFilesRecursive(
  node: VirtualFolderNode,
  folderName: string,
  relPrefix: string,
  depth: number,
  out: File[]
): void {
  for (const file of node.files) {
    const syntheticRel = relPrefix
      ? `${folderName}/${relPrefix}/${file.name}`
      : `${folderName}/${file.name}`;
    try {
      Object.defineProperty(file, 'webkitRelativePath', {
        value: syntheticRel,
        configurable: true,
      });
    } catch {
      // Ignore if non-configurable
    }
    out.push(file);
  }
  if (depth < 2) {
    for (const sub of node.subfolders.values()) {
      const nextPrefix = relPrefix ? `${relPrefix}/${sub.name}` : sub.name;
      collectVirtualFilesRecursive(sub, folderName, nextPrefix, depth + 1, out);
    }
  }
}

export async function createWebDirectoryStreamStarter(
  root: LocalStorageRoot,
  relPathParts: string[],
  folderDisplayName?: string
): Promise<LocalStreamStarter> {
  const folderName =
    folderDisplayName ||
    (relPathParts.length > 0
      ? relPathParts[relPathParts.length - 1]
      : root.name);

  if (root.kind === 'web-virtual') {
    const rec = virtualRoots.get(root.id);
    if (!rec) {
      throw new Error(tr('Složka již není dostupná.', 'Folder is no longer available.'));
    }
    const node = resolveVirtualNodeAtPath(rec.rootNode, relPathParts);
    if (!node) {
      throw new Error(tr('Složka nebyla nalezena.', 'Folder not found.'));
    }
    const collected: File[] = [];
    collectVirtualFilesRecursive(node, folderName, '', 0, collected);
    return {
      folderName,
      launch: (onBatch, signal) =>
        streamFileListSession(collected, folderName, onBatch, signal),
    };
  }

  const persisted = await readPersistedWebRoot(root.id);
  if (!persisted?.handle) {
    throw new Error(
      tr(
        'Připojená složka nebyla nalezena.',
        'Connected folder was not found.'
      )
    );
  }
  const granted = await ensureHandleReadPermission(persisted.handle);
  if (!granted) {
    throw new Error(
      tr(
        'Prohlížeč nepovolil přístup ke složce.',
        'Browser did not allow access to this folder.'
      )
    );
  }
  const targetDir = await resolveWebHandleAtPath(persisted.handle, relPathParts);
  const collected: File[] = [];
  await collectHandleFilesRecursive(targetDir, folderName, '', 0, collected);

  return {
    folderName,
    launch: (onBatch, signal) =>
      streamFileListSession(collected, folderName, onBatch, signal),
  };
}

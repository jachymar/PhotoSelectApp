import { getIntlLocale, tr } from './i18n';

export type MediaSourceKind =
  | 'drive'
  | 'local-file'
  | 'android-saf';

export interface SourceCapabilities {
  sourceKind: MediaSourceKind;
  canTrashSubfolder: boolean;
  canPermanentDelete: boolean;
  isReadOnlyFallback: boolean;
  supportsDirectoryPicker: boolean;
}

export interface DriveFolder {
  id: string;
  name: string;
  modifiedTime?: string;
  shared?: boolean;
  sourceKind?: MediaSourceKind;
  capabilities?: SourceCapabilities;
}

export interface DrivePhotoFile {
  id: string;
  name: string;
  stem: string;
  mimeType: string;
  sizeBytes: number;
  modifiedTime?: string;
  thumbnailLink?: string;
  fileExtension: string;
  isRaw: boolean;
  width?: number;
  height?: number;
  cameraMake?: string;
  cameraModel?: string;
  isoSpeed?: number;
  aperture?: number;
  exposureTime?: number;
  focalLength?: number;
  takenAtMs: number | null;
  takenAtLabel?: string;
  sourceKind?: MediaSourceKind;
  localFile?: File;
  relativePath?: string;
  nativeUri?: string;
  parents?: string[];
}

export class AuthExpiredError extends Error {
  constructor(
    message = tr(
      'Platnost přihlášení k Google Drive vypršela.',
      'Your Google Drive sign-in has expired.'
    )
  ) {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

const RAW_EXTENSIONS = new Set([
  'cr3',
  'cr2',
  'crw',
  'nef',
  'nrw',
  'arw',
  'sr2',
  'srf',
  'dng',
  'raf',
  'orf',
  'rw2',
  'pef',
  'raw',
  'rwl',
  'iiq',
  '3fr',
]);

const STANDARD_IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'heic',
  'heif',
  'avif',
  'tif',
  'tiff',
]);

const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'mov',
  'avi',
  'mkv',
  'mts',
  'm2ts',
  'webm',
  'wmv',
  'm4v',
  '3gp',
]);

export function getExtension(filename: string, explicitExt?: string): string {
  if (explicitExt) return explicitExt.toLowerCase().replace(/^\./, '');
  const idx = filename.lastIndexOf('.');
  if (idx === -1) return '';
  return filename.slice(idx + 1).toLowerCase();
}

export function getFileStem(filename: string): string {
  const idx = filename.lastIndexOf('.');
  const base = idx === -1 ? filename : filename.slice(0, idx);
  return base.trim().toLowerCase();
}

export function isSupportedPhoto(file: {
  name: string;
  mimeType?: string;
  fileExtension?: string;
}): { supported: boolean; isRaw: boolean; ext: string } {
  const mime = (file.mimeType || '').toLowerCase();
  const ext = getExtension(file.name, file.fileExtension);

  // Explicitly skip videos and folders
  if (
    mime.startsWith('video/') ||
    mime === 'application/vnd.google-apps.folder' ||
    VIDEO_EXTENSIONS.has(ext)
  ) {
    return { supported: false, isRaw: false, ext };
  }

  if (
    RAW_EXTENSIONS.has(ext) ||
    mime.includes('raw') ||
    mime === 'image/x-canon-cr3' ||
    mime === 'image/x-canon-cr2'
  ) {
    return { supported: true, isRaw: true, ext };
  }

  if (STANDARD_IMAGE_EXTENSIONS.has(ext) || mime.startsWith('image/')) {
    return { supported: true, isRaw: false, ext };
  }

  return { supported: false, isRaw: false, ext };
}

async function driveFetch(
  url: string,
  token: string,
  init: RequestInit = {},
  retries = 2,
  timeoutMs = 16_000
): Promise<Response> {
  let attempt = 0;
  while (true) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);

    const timeoutController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);

    const onCallerAbort = () => timeoutController.abort();
    if (init.signal) {
      if (init.signal.aborted) {
        clearTimeout(timer);
        throw new DOMException('Aborted', 'AbortError');
      }
      init.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        signal: timeoutController.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', onCallerAbort);
      if (init.signal?.aborted) {
        throw err;
      }
      if (attempt < retries) {
        attempt++;
        const delayMs = 450 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      if (timedOut) {
        throw new Error(
          tr(
            'Spojení s Google Drive vypršelo. Zkuste to prosím znovu.',
            'Connection to Google Drive timed out. Please try again.'
          )
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', onCallerAbort);
    }

    if (response.status === 401) {
      throw new AuthExpiredError();
    }

    // Retry transient rate limits or 5xx Drive errors
    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < retries &&
      !init.signal?.aborted
    ) {
      attempt++;
      const delayMs = 450 * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    return response;
  }
}

export async function listDriveFolders(
  token: string,
  options: {
    parentId?: string;
    sharedWithMe?: boolean;
    searchQuery?: string;
  } = {}
): Promise<DriveFolder[]> {
  const { parentId = 'root', sharedWithMe = false, searchQuery = '' } = options;

  const conditions: string[] = [
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
  ];

  const trimmedSearch = searchQuery.trim();
  if (trimmedSearch) {
    const escaped = trimmedSearch.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    conditions.push(`name contains '${escaped}'`);
  } else if (sharedWithMe) {
    conditions.push('sharedWithMe = true');
  } else {
    conditions.push(`'${parentId}' in parents`);
  }

  const params = new URLSearchParams({
    q: conditions.join(' and '),
    fields: 'files(id,name,modifiedTime,shared)',
    orderBy: 'folder,name_natural',
    pageSize: '100',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });

  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    token
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      tr(
        `Chyba při načítání složek z Google Drive (${res.status}): ${errText}`,
        `Error loading Google Drive folders (${res.status}): ${errText}`
      )
    );
  }

  const data = await res.json();
  return (data.files || []) as DriveFolder[];
}

function parseExifTimeString(raw?: string): { ms: number; label: string } | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  // Google Drive imageMediaMetadata.time format: "YYYY:MM:DD HH:MM:SS"
  const m = trimmed.match(
    /^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/
  );
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const min = Number(m[5]);
    const sec = Number(m[6]);
    const subMs = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
    const ms = Date.UTC(year, month, day, hour, min, sec, subMs);
    if (!Number.isNaN(ms)) {
      const hh = String(hour).padStart(2, '0');
      const mm = String(min).padStart(2, '0');
      const ss = String(sec).padStart(2, '0');
      return { ms, label: `${day}. ${month + 1}. ${year} ${hh}:${mm}:${ss}` };
    }
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    return {
      ms: parsed,
      label: d.toLocaleString(getIntlLocale(), {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    };
  }
  return null;
}

function mapDriveFileToPhoto(f: any): DrivePhotoFile | null {
  const check = isSupportedPhoto(f);
  if (!check.supported) return null;

  const meta = f.imageMediaMetadata || {};
  const parsedTime = parseExifTimeString(meta.time);
  return {
    id: f.id,
    name: f.name,
    stem: getFileStem(f.name),
    mimeType: f.mimeType || '',
    sizeBytes: Number(f.size || 0),
    modifiedTime: f.modifiedTime,
    thumbnailLink: f.thumbnailLink,
    fileExtension: check.ext,
    isRaw: check.isRaw,
    width: meta.width,
    height: meta.height,
    cameraMake: meta.cameraMake,
    cameraModel: meta.cameraModel,
    isoSpeed: meta.isoSpeed,
    aperture: meta.aperture,
    exposureTime: meta.exposureTime,
    focalLength: meta.focalLength,
    takenAtMs: parsedTime ? parsedTime.ms : null,
    takenAtLabel: parsedTime?.label,
    parents: Array.isArray(f.parents) ? f.parents : undefined,
  };
}

/**
 * Streams photos page-by-page so huge folders (10,000+ photos) open immediately after the first batch
 * and continue loading remaining pages cleanly in the background.
 * Note: Intentionally omits slow Drive-side `orderBy=name_natural` which times out on 10k+ folders.
 */
export async function streamPhotosInFolder(
  token: string,
  folderId: string,
  onPage: (
    batch: DrivePhotoFile[],
    meta: { pageNumber: number; hasMore: boolean; nextPageToken?: string }
  ) => void,
  options: { signal?: AbortSignal; startPageToken?: string; startPageNumber?: number } = {}
): Promise<void> {
  let pageToken: string | undefined = options.startPageToken;
  let pageNumber = options.startPageNumber ?? 0;
  let useOldestFirstOrder = true;

  do {
    if (options.signal?.aborted) return;

    const buildParams = (ordered: boolean) => {
      const p = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
        fields:
          'nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink,fileExtension,imageMediaMetadata,parents)',
        pageSize: '400',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (ordered) {
        p.set('orderBy', 'createdTime,name');
      }
      if (pageToken) {
        p.set('pageToken', pageToken);
      }
      return p;
    };

    let res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files?${buildParams(useOldestFirstOrder).toString()}`,
      token,
      { signal: options.signal },
      2
    );

    if (
      !res.ok &&
      useOldestFirstOrder &&
      !pageToken &&
      pageNumber === 0 &&
      res.status >= 500
    ) {
      useOldestFirstOrder = false;
      res = await driveFetch(
        `https://www.googleapis.com/drive/v3/files?${buildParams(false).toString()}`,
        token,
        { signal: options.signal },
        2
      );
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        tr(
          `Chyba při načítání fotek ze složky (${res.status}): ${errText}`,
          `Error loading photos from folder (${res.status}): ${errText}`
        )
      );
    }

    const data = await res.json();
    if (options.signal?.aborted) return;

    const files = data.files || [];
    const batch: DrivePhotoFile[] = [];

    for (const f of files) {
      const mapped = mapDriveFileToPhoto(f);
      if (mapped) batch.push(mapped);
    }

    pageNumber++;
    pageToken = data.nextPageToken;
    onPage(batch, {
      pageNumber,
      hasMore: Boolean(pageToken),
      nextPageToken: pageToken,
    });
  } while (pageToken);
}

export async function fetchDriveFileBytes(
  token: string,
  fileId: string,
  range?: { start: number; end: number },
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const headers: Record<string, string> = {};
  if (range) {
    headers['Range'] = `bytes=${range.start}-${range.end}`;
  }

  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    token,
    { headers, signal }
  );

  if (!res.ok && res.status !== 206) {
    throw new Error(
      tr(
        `Nepodařilo se stáhnout náhled souboru (${res.status}).`,
        `Failed to download file preview (${res.status}).`
      )
    );
  }

  return await res.arrayBuffer();
}

export const LIKED_SUBFOLDER_NAME = 'Liked';

/**
 * Finds an existing subfolder by exact name inside `parentFolderId` without creating it.
 */
export async function findDriveSubfolder(
  token: string,
  parentFolderId: string,
  folderName = LIKED_SUBFOLDER_NAME
): Promise<DriveFolder | null> {
  const escapedName = folderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `'${parentFolderId}' in parents and name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)',
    pageSize: '5',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });

  const searchRes = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    token,
    {},
    3
  );
  if (searchRes.ok) {
    const searchData = await searchRes.json();
    const existing = (searchData.files || [])[0];
    if (existing?.id) {
      return { id: existing.id, name: existing.name || folderName };
    }
  }
  return null;
}

/**
 * Lists lowercase filenames of all non-trashed files already inside `folderId`
 * so repeated exports never duplicate existing photos.
 */
export async function listDriveFolderFileNames(
  token: string,
  folderId: string
): Promise<Set<string>> {
  const names = new Set<string>();
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken,files(name)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      token,
      {},
      2
    );
    if (!res.ok) {
      break;
    }

    const data = await res.json();
    for (const f of data.files || []) {
      if (typeof f?.name === 'string' && f.name.trim()) {
        names.add(f.name.trim().toLowerCase());
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return names;
}

/**
 * Explicitly creates a new folder inside `parentFolderId` on Google Drive (or returns existing if exact match).
 */
export async function createDriveFolder(
  token: string,
  parentFolderId: string,
  folderName: string
): Promise<DriveFolder> {
  const cleanName = folderName.trim() || LIKED_SUBFOLDER_NAME;
  return findOrCreateDriveSubfolder(token, parentFolderId, cleanName);
}

/**
 * Finds an existing subfolder by exact name inside `parentFolderId`, or creates it on Google Drive.
 */
export async function findOrCreateDriveSubfolder(
  token: string,
  parentFolderId: string,
  folderName = LIKED_SUBFOLDER_NAME
): Promise<DriveFolder> {
  const cleanName = folderName.trim() || LIKED_SUBFOLDER_NAME;
  const existing = await findDriveSubfolder(token, parentFolderId, cleanName);
  if (existing) {
    return existing;
  }

  const createRes = await driveFetch(
    'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name',
    token,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: cleanName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId],
      }),
    },
    3
  );

  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(
      tr(
        `Nepodařilo se vytvořit složku „${cleanName}“ na Google Drive (${createRes.status}): ${text}`,
        `Could not create folder "${cleanName}" on Google Drive (${createRes.status}): ${text}`
      )
    );
  }

  const created = await createRes.json();
  return { id: created.id, name: created.name || cleanName };
}

/**
 * Server-side copies a file on Google Drive directly into `destFolderId` without downloading media.
 */
export async function copyDriveFileToFolder(
  token: string,
  fileId: string,
  destFolderId: string,
  fileName?: string,
  destFolderName = LIKED_SUBFOLDER_NAME
): Promise<void> {
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/copy?supportsAllDrives=true&fields=id`,
    token,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parents: [destFolderId],
        ...(fileName ? { name: fileName } : {}),
      }),
    },
    3
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      tr(
        `Nepodařilo se zkopírovat soubor do „${destFolderName}“ (${res.status}): ${text}`,
        `Could not copy file to "${destFolderName}" (${res.status}): ${text}`
      )
    );
  }
}

/**
 * Instant zero-download move on Google Drive using addParents & removeParents.
 */
export async function moveDriveFileToFolder(
  token: string,
  fileId: string,
  sourceParentId: string,
  destFolderId: string,
  destFolderName = LIKED_SUBFOLDER_NAME
): Promise<void> {
  const params = new URLSearchParams({
    addParents: destFolderId,
    supportsAllDrives: 'true',
    fields: 'id,parents',
  });
  if (sourceParentId) {
    params.set('removeParents', sourceParentId);
  }

  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`,
    token,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    },
    3
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      tr(
        `Nepodařilo se přesunout soubor do „${destFolderName}“ (${res.status}): ${text}`,
        `Could not move file to "${destFolderName}" (${res.status}): ${text}`
      )
    );
  }
}

export async function trashDriveFile(token: string, fileId: string): Promise<void> {
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    token,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ trashed: true }),
    },
    3
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      tr(
        `Nepodařilo se přesunout soubor do koše (${res.status}): ${text}`,
        `Could not move file to Trash (${res.status}): ${text}`
      )
    );
  }
}

export async function deleteDriveFilePermanently(
  token: string,
  fileId: string
): Promise<void> {
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    token,
    {
      method: 'DELETE',
    },
    3
  );

  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(
      tr(
        `Nepodařilo se trvale smazat soubor (${res.status}): ${text}`,
        `Could not permanently delete file (${res.status}): ${text}`
      )
    );
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

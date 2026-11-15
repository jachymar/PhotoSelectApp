import exifr from 'exifr';
import { DrivePhotoFile, fetchDriveFileBytes } from './driveApi';
import { readLocalFileBytes } from './localMedia';

export interface ParsedExif {
  make?: string;
  model?: string;
  lens?: string;
  iso?: number;
  aperture?: number;
  exposureTime?: number;
  focalLength?: number;
  dateTaken?: string;
  orientation?: number;
}

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
  if (file.sourceKind && file.sourceKind !== 'drive') {
    return await readLocalFileBytes(file, range, signal);
  }
  if (!token) {
    throw new Error('Chybí přístupový token ke Google Drive.');
  }
  return await fetchDriveFileBytes(token, file.id, range, signal);
}

/**
 * Finds the largest complete embedded JPEG inside a binary RAW buffer (CR3, CR2, NEF, ARW, DNG, ORF, RW2, RAF).
 * Walks JPEG segments accurately up to SOS (0xFFDA) so nested EXIF APP1 thumbnails' FFD9 markers
 * never cause premature truncation.
 */
export function extractLargestEmbeddedJpeg(
  buffer: ArrayBuffer,
  options: { minBytes?: number; startOffset?: number } = {}
): Uint8Array | null {
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;
  const minBytes = options.minBytes ?? 4096;
  let bestStart = -1;
  let bestEnd = -1;
  let bestSize = 0;

  let i = Math.max(0, options.startOffset ?? 0);
  while (i < len - 10) {
    // JPEG SOI marker: FF D8 followed by FF and a valid JPEG segment/frame marker
    const m3 = bytes[i + 3];
    if (
      bytes[i] === 0xff &&
      bytes[i + 1] === 0xd8 &&
      bytes[i + 2] === 0xff &&
      ((m3 >= 0xc0 && m3 <= 0xfe) || m3 === 0xdd)
    ) {
      const start = i;
      let pos = i + 2;
      let reachedSos = false;
      let foundEnd = -1;

      // Walk JPEG marker segments cleanly until Start Of Scan (0xFF 0xDA)
      while (pos + 3 < len) {
        if (bytes[pos] !== 0xff) {
          break;
        }
        // Skip fill 0xFF bytes
        while (pos < len && bytes[pos] === 0xff) {
          pos++;
        }
        if (pos >= len) break;

        const marker = bytes[pos];
        pos++;

        // Standalone markers (RST0..RST7, TEM, SOI)
        if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
          continue;
        }
        // EOI before SOS (invalid / tiny stub)
        if (marker === 0xd9) {
          foundEnd = pos;
          break;
        }
        // Start of Scan
        if (marker === 0xda) {
          if (pos + 1 >= len) break;
          const sosLen = (bytes[pos] << 8) | bytes[pos + 1];
          pos += sosLen;
          reachedSos = true;
          break;
        }

        if (pos + 1 >= len) break;
        const segLen = (bytes[pos] << 8) | bytes[pos + 1];
        if (segLen < 2 || pos + segLen > len) {
          break;
        }
        pos += segLen;
      }

      if (reachedSos) {
        // Scan entropy-coded data for EOI (0xFF 0xD9)
        while (pos + 1 < len) {
          if (bytes[pos] === 0xff) {
            const next = bytes[pos + 1];
            if (next === 0xd9) {
              foundEnd = pos + 2;
              break;
            }
            // Byte stuffing (FF 00) or RST markers (FF D0..D7)
            if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
              pos += 2;
              continue;
            }
            // Another marker inside entropy stream (rare DNL etc.)
            if (next === 0xff) {
              pos++;
              continue;
            }
          }
          pos++;
        }
      }

      if (foundEnd > start) {
        const size = foundEnd - start;
        if (size > bestSize) {
          bestSize = size;
          bestStart = start;
          bestEnd = foundEnd;
        }
        i = foundEnd;
        continue;
      }
    }
    i++;
  }

  if (bestStart !== -1 && bestSize > minBytes) {
    return bytes.subarray(bestStart, bestEnd);
  }
  return null;
}

/**
 * Searches Canon CR3 ISOBMFF boxes specifically for Canon PRVW / THMB / CMT1 / CMT2 boxes.
 * Falls back to full embedded JPEG extraction if PRVW box isn't directly exposed.
 */
function findCanonPrvwOrExifInCr3(buffer: ArrayBuffer): {
  jpeg?: Uint8Array;
  cmt1?: Uint8Array;
  cmt2?: Uint8Array;
} {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;
  let cmt1: Uint8Array | undefined;
  let cmt2: Uint8Array | undefined;
  let prvwJpeg: Uint8Array | undefined;

  const readType = (offset: number) =>
    String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );

  const walkBoxes = (start: number, end: number, depth = 0) => {
    if (depth > 6) return;
    let offset = start;
    while (offset + 8 <= end) {
      let boxSize = view.getUint32(offset, false);
      const boxType = readType(offset + 4);
      let headerSize = 8;

      if (boxSize === 1 && offset + 16 <= end) {
        const hi = view.getUint32(offset + 8, false);
        const lo = view.getUint32(offset + 12, false);
        boxSize = hi * 4294967296 + lo;
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = end - offset;
      }

      if (boxSize < headerSize || offset + boxSize > end) {
        break;
      }

      const contentStart = offset + headerSize;
      const contentEnd = offset + boxSize;

      if (boxType === 'moov' || boxType === 'trak' || boxType === 'mdia') {
        walkBoxes(contentStart, contentEnd, depth + 1);
      } else if (boxType === 'uuid' && contentStart + 16 <= contentEnd) {
        // Canon CR3 metadata UUID: 85c0b687820f11e08111f4ce462b6a48
        // or Canon PRVW UUID: eaf42b5e1c984b88b9fbb7dc406e4d16
        walkBoxes(contentStart + 16, contentEnd, depth + 1);
      } else if (boxType === 'CMT1') {
        cmt1 = bytes.subarray(contentStart, contentEnd);
      } else if (boxType === 'CMT2') {
        cmt2 = bytes.subarray(contentStart, contentEnd);
      } else if (boxType === 'PRVW' && contentStart + 16 < contentEnd) {
        // Canon PRVW box has 16 bytes header (version/flags + unknown + width + height + jpegSize)
        const jpegCandidate = extractLargestEmbeddedJpeg(
          buffer.slice(contentStart, contentEnd)
        );
        if (jpegCandidate && (!prvwJpeg || jpegCandidate.byteLength > prvwJpeg.byteLength)) {
          prvwJpeg = jpegCandidate;
        }
      }

      offset += boxSize;
    }
  };

  if (len >= 12 && readType(4) === 'ftyp') {
    walkBoxes(0, len, 0);
  }

  return { jpeg: prvwJpeg, cmt1, cmt2 };
}

async function parseExifSafe(
  input: ArrayBuffer | Uint8Array
): Promise<ParsedExif | undefined> {
  try {
    const data = await exifr.parse(input, {
      tiff: true,
      exif: true,
    });
    if (!data) return undefined;
    return {
      make: data.Make ? String(data.Make).trim() : undefined,
      model: data.Model ? String(data.Model).trim() : undefined,
      lens: data.LensModel ? String(data.LensModel).trim() : undefined,
      iso: typeof data.ISO === 'number' ? data.ISO : undefined,
      aperture: typeof data.FNumber === 'number' ? data.FNumber : undefined,
      exposureTime:
        typeof data.ExposureTime === 'number' ? data.ExposureTime : undefined,
      focalLength:
        typeof data.FocalLength === 'number' ? data.FocalLength : undefined,
      dateTaken:
        data.DateTimeOriginal instanceof Date
          ? data.DateTimeOriginal.toLocaleDateString('cs-CZ', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })
          : undefined,
      orientation:
        typeof data.Orientation === 'number' ? data.Orientation : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function extractExifTimestampFromHeader(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<{ ms: number; label: string } | null> {
  try {
    const endByte = Math.min(Math.max(file.sizeBytes - 1, 0), 163839); // 160 KB
    const buffer = await fetchPhotoBytes(
      token,
      file,
      file.sizeBytes > 163840 ? { start: 0, end: endByte } : undefined,
      signal
    );

    const candidates: (ArrayBuffer | Uint8Array)[] = [];
    if (file.fileExtension === 'cr3') {
      const cr3 = findCanonPrvwOrExifInCr3(buffer);
      if (cr3.cmt2) candidates.push(cr3.cmt2);
      if (cr3.cmt1) candidates.push(cr3.cmt1);
    }

    let rawDate: Date | undefined;
    let subSecStr: string | undefined;

    for (const c of candidates) {
      try {
        const parsed = await exifr.parse(c, { tiff: true, exif: true });
        if (parsed?.DateTimeOriginal instanceof Date) {
          rawDate = parsed.DateTimeOriginal;
          subSecStr = parsed.SubSecTimeOriginal
            ? String(parsed.SubSecTimeOriginal)
            : undefined;
          break;
        }
        if (parsed?.CreateDate instanceof Date) {
          rawDate = parsed.CreateDate;
          break;
        }
      } catch {
        // try next candidate
      }
    }

    if (!rawDate) {
      const parsed = await exifr.parse(buffer, { tiff: true, exif: true });
      if (parsed?.DateTimeOriginal instanceof Date) {
        rawDate = parsed.DateTimeOriginal;
        subSecStr = parsed.SubSecTimeOriginal
          ? String(parsed.SubSecTimeOriginal)
          : undefined;
      } else if (parsed?.CreateDate instanceof Date) {
        rawDate = parsed.CreateDate;
      }
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
    orientation: parsed?.orientation,
  };
  const hasAny = Object.values(merged).some((v) => v !== undefined);
  return hasAny ? merged : undefined;
}

const mediaCache = new Map<string, ResolvedPhotoMedia>();
const MAX_CACHE_SIZE = 28;

function setCacheEntry(key: string, value: ResolvedPhotoMedia) {
  if (mediaCache.has(key)) {
    const prev = mediaCache.get(key)!;
    if (prev.isObjectUrl && prev.url !== value.url) {
      URL.revokeObjectURL(prev.url);
    }
    mediaCache.delete(key);
  }
  mediaCache.set(key, value);
  if (mediaCache.size > MAX_CACHE_SIZE) {
    const oldestKey = mediaCache.keys().next().value;
    if (oldestKey) {
      const oldest = mediaCache.get(oldestKey);
      if (oldest?.isObjectUrl) {
        URL.revokeObjectURL(oldest.url);
      }
      mediaCache.delete(oldestKey);
    }
  }
}

interface FilmstripCacheEntry {
  url: string;
  isObjectUrl: boolean;
}

const filmstripCache = new Map<string, FilmstripCacheEntry>();
const MAX_FILMSTRIP_CACHE_SIZE = 520;

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
    if (entry.isObjectUrl) {
      URL.revokeObjectURL(entry.url);
    }
  }
  mediaCache.clear();
  clearFilmstripCache();
}

export function getCachedFilmstripThumbnailUrl(fileId: string): string | null {
  return filmstripCache.get(fileId)?.url || null;
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

async function downscaleBlobToFilmstripUrl(
  blob: Blob,
  targetWidth = 180
): Promise<string> {
  if (typeof createImageBitmap !== 'function') {
    return URL.createObjectURL(blob);
  }
  let bitmap: ImageBitmap | null = null;
  try {
    try {
      bitmap = await createImageBitmap(blob, {
        resizeWidth: targetWidth,
        resizeQuality: 'low',
      });
    } catch {
      bitmap = await createImageBitmap(blob);
    }
    const ratio = bitmap.width > 0 ? Math.min(1, targetWidth / bitmap.width) : 1;
    const w = Math.max(1, Math.round(bitmap.width * ratio));
    const h = Math.max(1, Math.round(bitmap.height * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return URL.createObjectURL(blob);
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    const outBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.72)
    );
    if (!outBlob) {
      return URL.createObjectURL(blob);
    }
    return URL.createObjectURL(outBlob);
  } catch {
    return URL.createObjectURL(blob);
  } finally {
    bitmap?.close();
  }
}

export async function resolveFilmstripThumbnailUrl(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<string | null> {
  if (signal?.aborted) return null;
  const cached = filmstripCache.get(file.id);
  if (cached) {
    // Refresh LRU position
    filmstripCache.delete(file.id);
    filmstripCache.set(file.id, cached);
    return cached.url;
  }

  const isLocal = Boolean(file.sourceKind && file.sourceKind !== 'drive');

  if (!isLocal && file.thumbnailLink) {
    const url = getFilmstripThumbnailUrl(file.thumbnailLink);
    if (url) {
      setFilmstripCacheEntry(file.id, { url, isObjectUrl: false });
      return url;
    }
  }

  if (
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
        return nativeThumb;
      }
    } catch {
      // Fall through to header/slice extraction
    }
  }

  if (isLocal && !file.isRaw) {
    const blobFile =
      file.localFile || (file.fsHandle ? await file.fsHandle.getFile().catch(() => null) : null);
    if (blobFile) {
      if (signal?.aborted) return null;
      // Try tiny EXIF thumbnail first (instant <1ms slice on large JPGs)
      const headerThumb = await extractFastHeaderThumbnailBlob(
        token,
        file,
        signal
      ).catch(() => null);
      if (signal?.aborted) return null;
      const sourceBlob = headerThumb || blobFile;
      const url = await downscaleBlobToFilmstripUrl(sourceBlob, 180);
      if (signal?.aborted) {
        URL.revokeObjectURL(url);
        return null;
      }
      setFilmstripCacheEntry(file.id, { url, isObjectUrl: true });
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

  const url = await downscaleBlobToFilmstripUrl(thumbBlob, 180);
  if (signal?.aborted) {
    URL.revokeObjectURL(url);
    return null;
  }
  setFilmstripCacheEntry(file.id, { url, isObjectUrl: true });
  return url;
}

export function preloadImageUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = url;
  });
}

/**
 * Extracts a quick temporary low-res JPEG from the first 384 KB of a RAW/CR3 file
 * when Google Drive hasn't generated a thumbnailLink at all.
 */
export async function resolveFastTempRawPreview(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<string | null> {
  if (!file.isRaw) return null;
  const cacheKey = `${file.id}:temp-raw`;
  const cached = mediaCache.get(cacheKey);
  if (cached) return cached.url;

  try {
    const endByte = Math.min(Math.max(file.sizeBytes - 1, 0), 393215); // 384 KB
    const buffer = await fetchPhotoBytes(
      token,
      file,
      file.sizeBytes > 393216 ? { start: 0, end: endByte } : undefined,
      signal
    );
    const jpegBytes = extractLargestEmbeddedJpeg(buffer);
    if (!jpegBytes) return null;

    const copy = new Uint8Array(jpegBytes.byteLength);
    copy.set(jpegBytes);
    const blob = new Blob([copy], { type: 'image/jpeg' });
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
 * Extracts a lightweight thumbnail Blob (EXIF APP1 thumbnail inside JPGs, or THMB/PRVW inside RAW/CR3)
 * via tiny Range/Slice requests so visual similarity fingerprinting works reliably without CORS issues
 * and without evicting actively displayed previews from mediaCache.
 */
export async function extractFastHeaderThumbnailBlob(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal?: AbortSignal
): Promise<Blob | null> {
  try {
    let jpegBytes: Uint8Array | null = null;

    if (file.isRaw) {
      // Stage 1: First 512 KB covers Canon CR3 THMB box + many RAW embedded thumbs
      const endByte512 = Math.min(Math.max(file.sizeBytes - 1, 0), 524287);
      const buf512 = await fetchPhotoBytes(
        token,
        file,
        file.sizeBytes > 524288 ? { start: 0, end: endByte512 } : undefined,
        signal
      );
      const cr3Info =
        file.fileExtension === 'cr3' ? findCanonPrvwOrExifInCr3(buf512) : {};
      jpegBytes =
        cr3Info.jpeg || extractLargestEmbeddedJpeg(buf512, { minBytes: 1024 });

      // Stage 2: Escalate to 1.5 MB when Sony/Nikon/CR3 places embedded preview slightly deeper
      if (!jpegBytes && file.sizeBytes > 524288 && !signal?.aborted) {
        const endByte15m = Math.min(Math.max(file.sizeBytes - 1, 0), 1572863);
        const buf15m = await fetchPhotoBytes(
          token,
          file,
          file.sizeBytes > 1572864 ? { start: 0, end: endByte15m } : undefined,
          signal
        );
        const cr3Info2 =
          file.fileExtension === 'cr3' ? findCanonPrvwOrExifInCr3(buf15m) : {};
        jpegBytes =
          cr3Info2.jpeg ||
          extractLargestEmbeddedJpeg(buf15m, { minBytes: 1024 });
      }
    } else {
      // Standard JPG: look inside first 128 KB starting past outer JPEG SOI for embedded EXIF thumbnail
      const endByte128 = Math.min(Math.max(file.sizeBytes - 1, 0), 131071);
      const buf128 = await fetchPhotoBytes(
        token,
        file,
        file.sizeBytes > 131072 ? { start: 0, end: endByte128 } : undefined,
        signal
      );
      jpegBytes = extractLargestEmbeddedJpeg(buf128, {
        minBytes: 1024,
        startOffset: 12,
      });
    }

    if (!jpegBytes) return null;

    const copy = new Uint8Array(jpegBytes.byteLength);
    copy.set(jpegBytes);
    return new Blob([copy], { type: 'image/jpeg' });
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
 * Resolves a displayable high-resolution preview URL + EXIF for any Google Drive or Local/SD photo or RAW file (including Canon CR3).
 */
export async function resolvePhotoMedia(
  token: string | null | undefined,
  file: DrivePhotoFile,
  options: { preferFullRawDecode?: boolean; signal?: AbortSignal } = {}
): Promise<ResolvedPhotoMedia> {
  const isLocal = Boolean(file.sourceKind && file.sourceKind !== 'drive');
  const cacheKey = `${file.id}:${options.preferFullRawDecode ? 'full' : 'auto'}`;
  const cached = mediaCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Fast path for standard local images (zero copy ObjectURL + header slice EXIF)
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
          file.sizeBytes > 131072 ? { start: 0, end: 131071 } : undefined,
          options.signal
        ).catch(() => null);
        const exif = headerSlice ? await parseExifSafe(headerSlice) : undefined;
        const resolved: ResolvedPhotoMedia = {
          url: nativeUrl,
          source: 'local-media',
          exif: mergeExifWithDrive(file, exif),
          isObjectUrl: nativeUrl.startsWith('blob:'),
        };
        setCacheEntry(cacheKey, resolved);
        return resolved;
      }
    }

    const blobFile =
      file.localFile || (file.fsHandle ? await file.fsHandle.getFile() : null);
    if (blobFile) {
      const headerSlice = await blobFile
        .slice(0, Math.min(blobFile.size, 131072))
        .arrayBuffer()
        .catch(() => null);
      const exif = headerSlice ? await parseExifSafe(headerSlice) : undefined;
      const url = URL.createObjectURL(blobFile);
      const resolved: ResolvedPhotoMedia = {
        url,
        source: 'local-media',
        exif: mergeExifWithDrive(file, exif),
        isObjectUrl: true,
      };
      setCacheEntry(cacheKey, resolved);
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
    setCacheEntry(cacheKey, resolved);
    return resolved;
  }

  // Fast path when Drive provides a thumbnailLink (works in ~100ms; UI seamlessly falls back to preferFullRawDecode on img error or zoom)
  const thumbUrl = !isLocal ? getUpgradeThumbnailUrl(file.thumbnailLink) : null;
  if (!options.preferFullRawDecode && thumbUrl) {
    const resolved: ResolvedPhotoMedia = {
      url: thumbUrl,
      source: 'drive-thumbnail',
      exif: mergeExifWithDrive(file),
      isObjectUrl: false,
    };
    setCacheEntry(cacheKey, resolved);
    return resolved;
  }

  // For RAW files (CR3, CR2, NEF, ARW, DNG...) or full media decode:
  if (file.isRaw) {
    // Stage 1: Try reading the first 4 MB (Canon CR3 stores PRVW & CMT1/CMT2 near start of file, before mdat)
    const rangeEnd = Math.min(Math.max(file.sizeBytes - 1, 4194303), 4194303);
    let buffer = await fetchPhotoBytes(
      token,
      file,
      file.sizeBytes > 4194304 ? { start: 0, end: rangeEnd } : undefined,
      options.signal
    );

    let cr3Info =
      file.fileExtension === 'cr3' ? findCanonPrvwOrExifInCr3(buffer) : {};
    let jpegBytes = cr3Info.jpeg || extractLargestEmbeddedJpeg(buffer);

    // If embedded high-res JPEG wasn't in the first 4 MB (or looks like only a tiny < 35 KB thumbnail),
    // read the full RAW file and extract the full-res preview!
    if (
      file.sizeBytes > 4194304 &&
      (!jpegBytes || jpegBytes.byteLength < 35000)
    ) {
      buffer = await fetchPhotoBytes(token, file, undefined, options.signal);
      if (file.fileExtension === 'cr3') {
        cr3Info = findCanonPrvwOrExifInCr3(buffer);
      }
      const fullJpeg = cr3Info.jpeg || extractLargestEmbeddedJpeg(buffer);
      if (fullJpeg && (!jpegBytes || fullJpeg.byteLength > jpegBytes.byteLength)) {
        jpegBytes = fullJpeg;
      }
    }

    let exif: ParsedExif | undefined;
    if (cr3Info.cmt1) {
      exif = await parseExifSafe(cr3Info.cmt1);
    }
    if (!exif && jpegBytes) {
      exif = await parseExifSafe(jpegBytes);
    }
    if (!exif) {
      exif = await parseExifSafe(buffer);
    }

    if (jpegBytes) {
      const copy = new Uint8Array(jpegBytes.byteLength);
      copy.set(jpegBytes);
      const blob = new Blob([copy], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      const resolved: ResolvedPhotoMedia = {
        url,
        source: 'raw-embedded',
        exif: mergeExifWithDrive(file, exif),
        isObjectUrl: true,
      };
      setCacheEntry(cacheKey, resolved);
      return resolved;
    }

    // Fallback to Drive thumbnail if RAW had no embedded JPEG
    if (thumbUrl) {
      const resolved: ResolvedPhotoMedia = {
        url: thumbUrl,
        source: 'drive-thumbnail',
        exif: mergeExifWithDrive(file, exif),
        isObjectUrl: false,
      };
      setCacheEntry(cacheKey, resolved);
      return resolved;
    }

    throw new Error(`Soubor ${file.name} neobsahuje čitelný náhled JPEG.`);
  }

  // Standard Drive image full media fetch (when thumbnailLink is absent or full quality requested)
  const buffer = await fetchPhotoBytes(token, file, undefined, options.signal);
  const exif = await parseExifSafe(buffer);
  const mime = file.mimeType || 'image/jpeg';
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const resolved: ResolvedPhotoMedia = {
    url,
    source: 'drive-media',
    exif: mergeExifWithDrive(file, exif),
    isObjectUrl: true,
  };
  setCacheEntry(cacheKey, resolved);
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

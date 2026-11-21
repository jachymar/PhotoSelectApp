import {
  binaryMetaToParsedExif,
  ensureJpegExifOrientation,
  extractLargestEmbeddedJpeg,
  findCanonPrvwOrExifInCr3,
  parseTiffIfdMetadata,
  type Cr3BoxParseResult,
  type ParsedExif,
} from './rawBinaryUtils';

export type WorkerMediaSource =
  | 'raw-embedded'
  | 'drive-media'
  | 'drive-thumbnail'
  | 'local-media';

export interface WorkerDecodePayload {
  fileId: string;
  name: string;
  fileExtension: string;
  mimeType: string;
  sizeBytes: number;
  isRaw: boolean;
  sourceKind: 'drive' | 'local-file' | 'android-saf';
  thumbnailLink?: string;
  accessToken?: string | null;
  localFile?: File;
  cachedBlob?: Blob;
  cachedSource?: WorkerMediaSource;
  cachedExif?: ParsedExif;
  preFetchedUrl?: string;
  preFetchedHeaderBuffer?: ArrayBuffer;
  preFetchedBuffer?: ArrayBuffer;
  orientationHint?: number;
  preferFullRawDecode?: boolean;
  highQualitySeries?: boolean;
  maxDim?: number;
  jpegQuality?: number;
}

export type WorkerInboundMessage =
  | { type: 'decode'; jobId: string; payload: WorkerDecodePayload }
  | { type: 'cancel'; jobId: string };

export type WorkerOutboundMessage =
  | {
      type: 'decoded';
      jobId: string;
      fileId: string;
      blob?: Blob;
      bitmap?: ImageBitmap;
      fallbackUrl?: string;
      width?: number;
      height?: number;
      exif?: ParsedExif;
      source: WorkerMediaSource;
      fromIdbCache?: boolean;
    }
  | {
      type: 'error';
      jobId: string;
      fileId: string;
      error: string;
      authExpired?: boolean;
      aborted?: boolean;
    };

interface WorkerGlobalScopeLike {
  onmessage: ((event: MessageEvent<WorkerInboundMessage>) => void) | null;
  postMessage: (
    message: WorkerOutboundMessage,
    transfer?: Transferable[]
  ) => void;
}

const workerScope = globalThis as unknown as WorkerGlobalScopeLike;

class WorkerAuthExpiredError extends Error {
  constructor() {
    super('Platnost přihlášení k Google Drive vypršela.');
    this.name = 'WorkerAuthExpiredError';
  }
}

const activeJobs = new Map<string, AbortController>();
let driveThumbCorsFailures = 0;

function getDrivePreviewThumbUrl(
  thumbnailLink: string | undefined,
  highQualitySeries: boolean
): string | null {
  if (!thumbnailLink) return null;
  if (/=s\d+$/.test(thumbnailLink)) {
    return thumbnailLink.replace(/=s\d+$/, highQualitySeries ? '=s2400' : '=s1600');
  }
  return thumbnailLink;
}

function getHeaderRange(
  sizeBytes: number,
  maxBytes: number
): { start: number; end: number } | undefined {
  if (sizeBytes > 0 && sizeBytes <= maxBytes) {
    return undefined;
  }
  const effectiveEnd =
    sizeBytes > 0 ? Math.min(sizeBytes - 1, maxBytes - 1) : maxBytes - 1;
  return { start: 0, end: Math.max(0, effectiveEnd) };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const timeoutController = new AbortController();
  const callerSignal = init.signal;
  const onAbort = () => timeoutController.abort();

  if (callerSignal) {
    if (callerSignal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    callerSignal.addEventListener('abort', onAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timeoutController.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: timeoutController.signal,
    });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onAbort);
  }
}

async function fetchDriveBytesInWorker(
  token: string,
  fileId: string,
  range: { start: number; end: number } | undefined,
  signal: AbortSignal
): Promise<ArrayBuffer> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (range) {
    headers['Range'] = `bytes=${range.start}-${range.end}`;
  }
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId
  )}?alt=media&supportsAllDrives=true`;

  const timeoutMs = range ? 14_000 : 22_000;
  const res = await fetchWithTimeout(url, { headers, signal }, timeoutMs);
  if (res.status === 401) {
    throw new WorkerAuthExpiredError();
  }
  if (!res.ok && res.status !== 206) {
    throw new Error(`Nepodařilo se stáhnout náhled souboru (${res.status}).`);
  }
  return await res.arrayBuffer();
}

async function readSliceInWorker(
  payload: WorkerDecodePayload,
  range: { start: number; end: number } | undefined,
  signal: AbortSignal
): Promise<ArrayBuffer> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  if (payload.localFile) {
    const slice = range
      ? payload.localFile.slice(
          Math.max(0, range.start),
          Math.min(payload.localFile.size, range.end + 1)
        )
      : payload.localFile;
    const buf = await slice.arrayBuffer();
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    return buf;
  }
  if (payload.sourceKind === 'drive') {
    if (!payload.accessToken) {
      throw new Error('Chybí přístupový token ke Google Drive.');
    }
    return await fetchDriveBytesInWorker(
      payload.accessToken,
      payload.fileId,
      range,
      signal
    );
  }
  throw new Error('Zdroj souboru není dostupný ve workeru.');
}

async function locateCanonCr3PrvwBoxRangeInWorker(
  payload: WorkerDecodePayload,
  signal: AbortSignal
): Promise<{ start: number; end: number } | null> {
  let offset = 0;
  for (let step = 0; step < 12; step++) {
    if (signal.aborted) return null;
    if (payload.sizeBytes > 0 && offset + 16 >= payload.sizeBytes) break;

    const headerBuf = await readSliceInWorker(
      payload,
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

function parseExifFast(
  buffer: ArrayBuffer | Uint8Array,
  isCr3: boolean
): ParsedExif | undefined {
  if (isCr3 && buffer instanceof ArrayBuffer) {
    const cr3 = findCanonPrvwOrExifInCr3(buffer);
    if (cr3.cmt1 || cr3.cmt2) {
      const m1 = cr3.cmt1 ? parseTiffIfdMetadata(cr3.cmt1, 0) : undefined;
      const m2 = cr3.cmt2 ? parseTiffIfdMetadata(cr3.cmt2, 0) : undefined;
      const parsed = binaryMetaToParsedExif(m1, m2);
      if (parsed) return parsed;
    }
  }
  const bytes =
    buffer instanceof Uint8Array
      ? buffer
      : new Uint8Array(buffer, 0, buffer.byteLength);
  return binaryMetaToParsedExif(parseTiffIfdMetadata(bytes, 0));
}

function resolveRawOrientation(
  fileExtension: string,
  buffer: ArrayBuffer,
  cr3Cmt1: Uint8Array | undefined,
  fallback?: number
): number | undefined {
  if (cr3Cmt1) {
    const o = parseTiffIfdMetadata(cr3Cmt1, 0)?.orientation;
    if (o !== undefined) return o;
  }
  if (fileExtension !== 'cr3') {
    const o = parseTiffIfdMetadata(new Uint8Array(buffer), 0)?.orientation;
    if (o !== undefined) return o;
  }
  return fallback;
}

async function extractRawPreviewBlobInWorker(
  payload: WorkerDecodePayload,
  signal: AbortSignal
): Promise<{ blob: Blob; exif?: ParsedExif } | null> {
  const isCr3 = payload.fileExtension === 'cr3';
  const sizeBytes = payload.localFile?.size ?? payload.sizeBytes;

  // Stage 1: First 4 MB slice
  let buffer = await readSliceInWorker(
    payload,
    getHeaderRange(sizeBytes, 4 * 1024 * 1024),
    signal
  );

  const cr3Info: Cr3BoxParseResult = isCr3
    ? findCanonPrvwOrExifInCr3(buffer)
    : {};
  let outerOrientation = resolveRawOrientation(
    payload.fileExtension,
    buffer,
    cr3Info.cmt1,
    payload.orientationHint
  );

  let jpegBytes: Uint8Array | null =
    cr3Info.prvwJpeg ||
    extractLargestEmbeddedJpeg(buffer) ||
    cr3Info.thmbJpeg ||
    null;

  // Stage 2 (Canon CR3): fetch exact PRVW box if truncated in initial 4 MB
  if (
    isCr3 &&
    (!jpegBytes || jpegBytes.byteLength < 45_000) &&
    (sizeBytes === 0 || sizeBytes > 4 * 1024 * 1024)
  ) {
    const targetBox =
      cr3Info.prvwBoxRange ||
      (await locateCanonCr3PrvwBoxRangeInWorker(payload, signal));

    if (
      targetBox &&
      targetBox.end > targetBox.start &&
      targetBox.end - targetBox.start <= 20 * 1024 * 1024
    ) {
      const prvwBuf = await readSliceInWorker(
        payload,
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

  // Stage 3: 12 MB header slice for deeper embedded previews (ARW/NEF/CR2)
  if (
    (!jpegBytes || jpegBytes.byteLength < 35_000) &&
    (sizeBytes === 0 || sizeBytes > 4 * 1024 * 1024)
  ) {
    const buf12m = await readSliceInWorker(
      payload,
      getHeaderRange(sizeBytes, 12 * 1024 * 1024),
      signal
    ).catch(() => null);

    if (buf12m) {
      if (isCr3) {
        const cr312 = findCanonPrvwOrExifInCr3(buf12m);
        if (!cr3Info.cmt1 && cr312.cmt1) cr3Info.cmt1 = cr312.cmt1;
        if (!cr3Info.cmt2 && cr312.cmt2) cr3Info.cmt2 = cr312.cmt2;
        outerOrientation =
          resolveRawOrientation(
            payload.fileExtension,
            buf12m,
            cr3Info.cmt1,
            outerOrientation
          ) ?? outerOrientation;
        const cand =
          cr312.prvwJpeg || extractLargestEmbeddedJpeg(buf12m) || cr312.thmbJpeg;
        if (cand && (!jpegBytes || cand.byteLength > jpegBytes.byteLength)) {
          jpegBytes = cand;
        }
      } else {
        outerOrientation =
          resolveRawOrientation(
            payload.fileExtension,
            buf12m,
            undefined,
            outerOrientation
          ) ?? outerOrientation;
        const cand = extractLargestEmbeddedJpeg(buf12m);
        if (cand && (!jpegBytes || cand.byteLength > jpegBytes.byteLength)) {
          jpegBytes = cand;
        }
      }
      buffer = buf12m;
    }
  }

  // Stage 4: Full file fallback when embedded preview sits near EOF (non-SAF)
  if (
    (!jpegBytes || jpegBytes.byteLength < 35_000) &&
    payload.sourceKind !== 'android-saf' &&
    sizeBytes > 12 * 1024 * 1024
  ) {
    const fullBuf = await readSliceInWorker(payload, undefined, signal).catch(
      () => null
    );
    if (fullBuf) {
      outerOrientation =
        resolveRawOrientation(
          payload.fileExtension,
          fullBuf,
          cr3Info.cmt1,
          outerOrientation
        ) ?? outerOrientation;
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
    const m1 = cr3Info.cmt1 ? parseTiffIfdMetadata(cr3Info.cmt1, 0) : undefined;
    const m2 = cr3Info.cmt2 ? parseTiffIfdMetadata(cr3Info.cmt2, 0) : undefined;
    exif = binaryMetaToParsedExif(m1, m2);
  }
  if (!exif) {
    exif = parseExifFast(buffer, isCr3);
  }
  if (!exif && jpegBytes) {
    exif = parseExifFast(jpegBytes, false);
  }
  if (!outerOrientation && exif?.orientation) {
    outerOrientation = exif.orientation;
  }

  if (!jpegBytes) return null;

  const normalized = ensureJpegExifOrientation(jpegBytes, outerOrientation);
  const blob = new Blob([normalized], { type: 'image/jpeg' });
  return { blob, exif };
}

async function fetchDriveThumbCorsInWorker(
  url: string,
  signal: AbortSignal
): Promise<Blob | null> {
  if (driveThumbCorsFailures >= 3) return null;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal,
      },
      12_000
    );
    if (!res.ok) {
      driveThumbCorsFailures += 1;
      return null;
    }
    const blob = await res.blob();
    if (blob && blob.size > 4096) {
      driveThumbCorsFailures = 0;
      return blob;
    }
    return null;
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError' || signal.aborted) {
      throw err;
    }
    driveThumbCorsFailures += 1;
    return null;
  }
}

/**
 * Decodes the image blob off the main thread using `createImageBitmap`, and if the
 * source exceeds the high-res preview ceiling (`maxDim` or 2.4 MB), smoothly resizes it
 * on an `OffscreenCanvas` so the main thread never pays decode or canvas re-encode cost.
 */
async function decodeAndOptimizeBlobInWorker(
  sourceBlob: Blob,
  options: {
    allowDownscale: boolean;
    maxDim: number;
    jpegQuality: number;
    signal: AbortSignal;
  }
): Promise<{
  blob: Blob;
  bitmap?: ImageBitmap;
  width?: number;
  height?: number;
}> {
  if (options.signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  if (typeof createImageBitmap !== 'function') {
    return { blob: sourceBlob };
  }

  let bitmap: ImageBitmap | null = null;
  try {
    // Decode without resizeWidth options first so EXIF orientation is faithfully honored
    bitmap = await createImageBitmap(sourceBlob);
    if (options.signal.aborted) {
      bitmap.close();
      bitmap = null;
      throw new DOMException('Aborted', 'AbortError');
    }

    const origW = bitmap.width;
    const origH = bitmap.height;
    const maxSide = Math.max(origW, origH);

    const shouldDownscale =
      options.allowDownscale &&
      typeof OffscreenCanvas !== 'undefined' &&
      (sourceBlob.size > 2_400_000 || maxSide > options.maxDim);

    if (shouldDownscale) {
      const ratio = maxSide > 0 ? Math.min(1, options.maxDim / maxSide) : 1;
      const targetW = Math.max(1, Math.round(origW * ratio));
      const targetH = Math.max(1, Math.round(origH * ratio));

      const canvas = new OffscreenCanvas(targetW, targetH);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, targetW, targetH);
        const resizedBlob = await canvas
          .convertToBlob({
            type: 'image/jpeg',
            quality: options.jpegQuality,
          })
          .catch(() => null);

        if (options.signal.aborted) {
          bitmap.close();
          bitmap = null;
          throw new DOMException('Aborted', 'AbortError');
        }

        if (resizedBlob && resizedBlob.size > 0 && resizedBlob.size < sourceBlob.size) {
          // Close oversized source bitmap and hand back compact GPU-ready bitmap
          bitmap.close();
          bitmap = null;
          let compactBitmap: ImageBitmap | undefined;
          try {
            if (typeof canvas.transferToImageBitmap === 'function') {
              compactBitmap = canvas.transferToImageBitmap();
            } else {
              compactBitmap = await createImageBitmap(resizedBlob);
            }
          } catch {
            compactBitmap = undefined;
          }
          if (options.signal.aborted) {
            compactBitmap?.close();
            throw new DOMException('Aborted', 'AbortError');
          }
          return {
            blob: resizedBlob,
            bitmap: compactBitmap,
            width: targetW,
            height: targetH,
          };
        }
      }
    }

    const readyBitmap = bitmap;
    bitmap = null;
    return {
      blob: sourceBlob,
      bitmap: readyBitmap,
      width: origW,
      height: origH,
    };
  } catch (err) {
    if (bitmap) {
      bitmap.close();
      bitmap = null;
    }
    if ((err as { name?: string })?.name === 'AbortError' || options.signal.aborted) {
      throw err;
    }
    // If createImageBitmap fails on an exotic codec, still return the raw blob so <img> can attempt decode
    return { blob: sourceBlob };
  }
}

async function handleDecodeJob(
  jobId: string,
  payload: WorkerDecodePayload,
  signal: AbortSignal
): Promise<void> {
  const maxDim = payload.maxDim ?? 2048;
  const jpegQuality = payload.jpegQuality ?? 0.86;
  const isCr3 = payload.fileExtension === 'cr3';

  // Fast path 0: Already cached in IndexedDB — decode off-thread via createImageBitmap!
  if (payload.cachedBlob && payload.cachedBlob.size > 0) {
    const decoded = await decodeAndOptimizeBlobInWorker(payload.cachedBlob, {
      allowDownscale: false,
      maxDim,
      jpegQuality,
      signal,
    });
    if (signal.aborted) {
      decoded.bitmap?.close();
      return;
    }
    const transfers: Transferable[] = decoded.bitmap ? [decoded.bitmap] : [];
    workerScope.postMessage(
      {
        type: 'decoded',
        jobId,
        fileId: payload.fileId,
        blob: decoded.blob,
        bitmap: decoded.bitmap,
        width: decoded.width,
        height: decoded.height,
        exif: payload.cachedExif,
        source: payload.cachedSource || 'local-media',
        fromIdbCache: true,
      },
      transfers
    );
    return;
  }

  let resolvedBlob: Blob | null = null;
  let resolvedExif: ParsedExif | undefined;
  let resolvedSource: WorkerMediaSource = 'local-media';
  let allowDownscale = !payload.preferFullRawDecode;

  // Path 1: Pre-fetched URL or buffer (e.g., Android SAF native bridge)
  if (payload.preFetchedUrl) {
    if (payload.preFetchedHeaderBuffer) {
      resolvedExif = parseExifFast(payload.preFetchedHeaderBuffer, isCr3);
    }
    const resp = await fetchWithTimeout(
      payload.preFetchedUrl,
      { signal },
      16_000
    );
    if (!resp.ok) {
      throw new Error(`Nepodařilo se načíst lokální náhled (${resp.status}).`);
    }
    resolvedBlob = await resp.blob();
    resolvedSource = payload.isRaw ? 'raw-embedded' : 'local-media';
    if (!resolvedExif && payload.orientationHint) {
      resolvedExif = { orientation: payload.orientationHint };
    }
  } else if (payload.preFetchedBuffer) {
    if (payload.isRaw) {
      const cr3 = isCr3
        ? findCanonPrvwOrExifInCr3(payload.preFetchedBuffer)
        : {};
      const orient = resolveRawOrientation(
        payload.fileExtension,
        payload.preFetchedBuffer,
        cr3.cmt1,
        payload.orientationHint
      );
      const jpegBytes =
        cr3.prvwJpeg ||
        extractLargestEmbeddedJpeg(payload.preFetchedBuffer) ||
        cr3.thmbJpeg;
      resolvedExif = parseExifFast(payload.preFetchedBuffer, isCr3);
      if (jpegBytes) {
        const normalized = ensureJpegExifOrientation(
          jpegBytes,
          orient ?? resolvedExif?.orientation
        );
        resolvedBlob = new Blob([normalized], { type: 'image/jpeg' });
        resolvedSource = 'raw-embedded';
      }
    } else {
      resolvedExif = parseExifFast(payload.preFetchedBuffer, false);
      resolvedBlob = new Blob([payload.preFetchedBuffer], {
        type: payload.mimeType || 'image/jpeg',
      });
      resolvedSource = 'local-media';
    }
  } else if (payload.sourceKind === 'local-file' && payload.localFile) {
    // Path 2: Direct local File inside Worker
    if (payload.isRaw) {
      const extracted = await extractRawPreviewBlobInWorker(payload, signal);
      if (!extracted) {
        throw new Error(
          `Soubor ${payload.name} neobsahuje čitelný náhled JPEG.`
        );
      }
      resolvedBlob = extracted.blob;
      resolvedExif = extracted.exif;
      resolvedSource = 'raw-embedded';
      allowDownscale = false; // RAW embedded previews are already compact high-res JPEGs
    } else {
      const hdrSlice = await payload.localFile
        .slice(0, Math.min(payload.localFile.size, 131_072))
        .arrayBuffer()
        .catch(() => null);
      resolvedExif = hdrSlice ? parseExifFast(hdrSlice, false) : undefined;
      resolvedBlob = payload.localFile;
      resolvedSource = 'local-media';
    }
  } else if (payload.sourceKind === 'drive') {
    // Path 3: Google Drive file
    const driveThumbUrl = getDrivePreviewThumbUrl(
      payload.thumbnailLink,
      Boolean(payload.highQualitySeries)
    );

    // Try high-res Drive CDN thumbnail via CORS inside Worker when full RAW decode is not forced
    if (!payload.preferFullRawDecode && driveThumbUrl) {
      const cdnBlob = await fetchDriveThumbCorsInWorker(driveThumbUrl, signal);
      if (cdnBlob && cdnBlob.size > 4096) {
        resolvedBlob = cdnBlob;
        resolvedSource = 'drive-thumbnail';
        allowDownscale = false;
      } else {
        // CDN blocked CORS (opaque): return fallbackUrl so main thread can pre-decode via <img> without wasting bandwidth on full RAW
        if (signal.aborted) return;
        workerScope.postMessage({
          type: 'decoded',
          jobId,
          fileId: payload.fileId,
          fallbackUrl: driveThumbUrl,
          source: 'drive-thumbnail',
        });
        return;
      }
    } else if (payload.isRaw) {
      const extracted = await extractRawPreviewBlobInWorker(payload, signal);
      if (extracted) {
        resolvedBlob = extracted.blob;
        resolvedExif = extracted.exif;
        resolvedSource = 'raw-embedded';
        allowDownscale = false;
      } else if (driveThumbUrl) {
        if (signal.aborted) return;
        workerScope.postMessage({
          type: 'decoded',
          jobId,
          fileId: payload.fileId,
          fallbackUrl: driveThumbUrl,
          source: 'drive-thumbnail',
        });
        return;
      } else {
        throw new Error(
          `Soubor ${payload.name} neobsahuje čitelný náhled JPEG.`
        );
      }
    } else {
      const buf = await readSliceInWorker(payload, undefined, signal);
      resolvedExif = parseExifFast(buf, false);
      resolvedBlob = new Blob([buf], {
        type: payload.mimeType || 'image/jpeg',
      });
      resolvedSource = 'drive-media';
    }
  }

  if (!resolvedBlob || resolvedBlob.size === 0) {
    throw new Error(`Nepodařilo se připravit náhled pro ${payload.name}.`);
  }

  const decoded = await decodeAndOptimizeBlobInWorker(resolvedBlob, {
    allowDownscale,
    maxDim,
    jpegQuality,
    signal,
  });

  if (signal.aborted) {
    decoded.bitmap?.close();
    return;
  }

  const transfers: Transferable[] = decoded.bitmap ? [decoded.bitmap] : [];
  workerScope.postMessage(
    {
      type: 'decoded',
      jobId,
      fileId: payload.fileId,
      blob: decoded.blob,
      bitmap: decoded.bitmap,
      width: decoded.width,
      height: decoded.height,
      exif: resolvedExif,
      source: resolvedSource,
      fromIdbCache: false,
    },
    transfers
  );
}

workerScope.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'cancel') {
    const controller = activeJobs.get(msg.jobId);
    if (controller) {
      controller.abort();
      activeJobs.delete(msg.jobId);
    }
    return;
  }

  if (msg.type === 'decode') {
    const controller = new AbortController();
    activeJobs.set(msg.jobId, controller);

    void handleDecodeJob(msg.jobId, msg.payload, controller.signal)
      .catch((err: unknown) => {
        const isAbort =
          controller.signal.aborted ||
          (err as { name?: string })?.name === 'AbortError';
        const authExpired = err instanceof WorkerAuthExpiredError;
        workerScope.postMessage({
          type: 'error',
          jobId: msg.jobId,
          fileId: msg.payload.fileId,
          error:
            err instanceof Error
              ? err.message
              : 'Nepodařilo se dekódovat náhled ve workeru.',
          authExpired,
          aborted: isAbort,
        });
      })
      .finally(() => {
        activeJobs.delete(msg.jobId);
      });
  }
};

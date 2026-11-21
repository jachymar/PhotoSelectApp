import {
  computeFingerprintFromRgba32x32,
  type VisualFingerprint,
} from './fingerprintMath';
import {
  ensureJpegExifOrientation,
  extractLargestEmbeddedJpeg,
  findCanonPrvwOrExifInCr3,
  parseTiffIfdMetadata,
} from './rawBinaryUtils';

export interface FingerprintWorkerPayload {
  fileId: string;
  fileExtension: string;
  mimeType: string;
  sizeBytes: number;
  isRaw: boolean;
  sourceKind: 'drive' | 'local-file' | 'android-saf';
  thumbnailLink?: string;
  accessToken?: string | null;
  blob?: Blob;
  localFile?: File;
  preFetchedUrl?: string;
}

export type FingerprintWorkerInbound =
  | { type: 'compute'; jobId: string; payload: FingerprintWorkerPayload }
  | { type: 'cancel'; jobId: string }
  | { type: 'cancelAll' };

export type FingerprintWorkerOutbound =
  | {
      type: 'result';
      jobId: string;
      fileId: string;
      fingerprint: VisualFingerprint | null;
      unsupported?: boolean;
    }
  | {
      type: 'error';
      jobId: string;
      fileId: string;
      aborted?: boolean;
    };

interface WorkerScopeLike {
  onmessage: ((event: MessageEvent<FingerprintWorkerInbound>) => void) | null;
  postMessage: (
    message: FingerprintWorkerOutbound,
    transfer?: Transferable[]
  ) => void;
}

const workerScope = globalThis as unknown as WorkerScopeLike;

const activeJobs = new Map<string, AbortController>();
let sharedCanvas: OffscreenCanvas | null = null;
let sharedCtx: OffscreenCanvasRenderingContext2D | null = null;
let consecutiveCdnCorsFailures = 0;

function getOffscreenContext(): OffscreenCanvasRenderingContext2D | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  if (!sharedCanvas) {
    sharedCanvas = new OffscreenCanvas(32, 32);
    sharedCtx = sharedCanvas.getContext('2d', {
      willReadFrequently: true,
    });
  }
  return sharedCtx;
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

async function fingerprintFromBlobInWorker(
  blob: Blob,
  signal: AbortSignal
): Promise<VisualFingerprint | null> {
  if (signal.aborted || typeof createImageBitmap !== 'function') return null;
  const ctx = getOffscreenContext();
  if (!ctx) return null;

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    if (signal.aborted) return null;
    const width = bitmap.width;
    const height = bitmap.height;
    if (width <= 0 || height <= 0) return null;

    ctx.clearRect(0, 0, 32, 32);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(bitmap, 0, 0, 32, 32);

    const pixels = ctx.getImageData(0, 0, 32, 32).data;
    return computeFingerprintFromRgba32x32(pixels, width, height);
  } catch {
    return null;
  } finally {
    try {
      bitmap?.close();
    } catch {
      // Ignore close error
    }
  }
}

function getCorsThumbnailUrl(thumbnailLink?: string): string | null {
  if (!thumbnailLink) return null;
  if (/=s\d+$/.test(thumbnailLink)) {
    return thumbnailLink.replace(/=s\d+$/, '=s220');
  }
  return thumbnailLink;
}

function getHeaderRange(
  sizeBytes: number,
  maxBytes: number
): { start: number; end: number } | undefined {
  if (sizeBytes > 0 && sizeBytes <= maxBytes) return undefined;
  const effectiveEnd =
    sizeBytes > 0 ? Math.min(sizeBytes - 1, maxBytes - 1) : maxBytes - 1;
  return { start: 0, end: Math.max(0, effectiveEnd) };
}

async function fetchDriveRangeInWorker(
  token: string,
  fileId: string,
  range: { start: number; end: number } | undefined,
  signal: AbortSignal
): Promise<ArrayBuffer | null> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (range) {
    headers['Range'] = `bytes=${range.start}-${range.end}`;
  }
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId
  )}?alt=media&supportsAllDrives=true`;

  const res = await fetchWithTimeout(
    url,
    { headers, signal },
    range ? 12_000 : 18_000
  );
  if (!res.ok && res.status !== 206) {
    return null;
  }
  return await res.arrayBuffer();
}

async function readSliceForFingerprint(
  payload: FingerprintWorkerPayload,
  maxBytes: number,
  signal: AbortSignal
): Promise<ArrayBuffer | null> {
  const sizeBytes = payload.localFile?.size ?? payload.sizeBytes;
  const range = getHeaderRange(sizeBytes, maxBytes);

  if (payload.localFile) {
    const slice = range
      ? payload.localFile.slice(
          Math.max(0, range.start),
          Math.min(payload.localFile.size, range.end + 1)
        )
      : payload.localFile;
    return await slice.arrayBuffer();
  }

  if (payload.sourceKind === 'drive' && payload.accessToken) {
    return await fetchDriveRangeInWorker(
      payload.accessToken,
      payload.fileId,
      range,
      signal
    );
  }

  return null;
}

async function extractHeaderThumbnailBlobInWorker(
  payload: FingerprintWorkerPayload,
  signal: AbortSignal
): Promise<Blob | null> {
  let jpegBytes: Uint8Array | null = null;
  let outerOrientation: number | undefined;
  const isCr3 = payload.fileExtension === 'cr3';

  if (payload.isRaw) {
    const buf512 = await readSliceForFingerprint(payload, 524_288, signal);
    if (!buf512 || signal.aborted) return null;
    const cr3Info = isCr3 ? findCanonPrvwOrExifInCr3(buf512) : {};
    if (cr3Info.cmt1) {
      outerOrientation = parseTiffIfdMetadata(cr3Info.cmt1, 0)?.orientation;
    } else if (!isCr3) {
      outerOrientation = parseTiffIfdMetadata(
        new Uint8Array(buf512),
        0
      )?.orientation;
    }
    jpegBytes =
      cr3Info.prvwJpeg ||
      cr3Info.thmbJpeg ||
      extractLargestEmbeddedJpeg(buf512, { minBytes: 1024 });

    if (
      !jpegBytes &&
      (payload.sizeBytes === 0 || payload.sizeBytes > 524_288) &&
      !signal.aborted
    ) {
      const buf2m = await readSliceForFingerprint(payload, 2_097_152, signal);
      if (buf2m && !signal.aborted) {
        const cr3Info2 = isCr3 ? findCanonPrvwOrExifInCr3(buf2m) : {};
        if (!outerOrientation && cr3Info2.cmt1) {
          outerOrientation = parseTiffIfdMetadata(
            cr3Info2.cmt1,
            0
          )?.orientation;
        } else if (!outerOrientation && !isCr3) {
          outerOrientation = parseTiffIfdMetadata(
            new Uint8Array(buf2m),
            0
          )?.orientation;
        }
        jpegBytes =
          cr3Info2.prvwJpeg ||
          cr3Info2.thmbJpeg ||
          extractLargestEmbeddedJpeg(buf2m, { minBytes: 1024 });
      }
    }
  } else {
    const buf128 = await readSliceForFingerprint(payload, 131_072, signal);
    if (!buf128 || signal.aborted) return null;
    outerOrientation = parseTiffIfdMetadata(
      new Uint8Array(buf128),
      0
    )?.orientation;
    jpegBytes = extractLargestEmbeddedJpeg(buf128, {
      minBytes: 1024,
      startOffset: 12,
    });
  }

  if (!jpegBytes) return null;
  const normalized = ensureJpegExifOrientation(jpegBytes, outerOrientation);
  return new Blob([normalized], { type: 'image/jpeg' });
}

async function computeJob(
  payload: FingerprintWorkerPayload,
  signal: AbortSignal
): Promise<VisualFingerprint | null> {
  // 1. Direct Blob provided (IDB micro-thumb or in-memory blob)
  if (payload.blob && payload.blob.size > 0) {
    const fp = await fingerprintFromBlobInWorker(payload.blob, signal);
    if (fp || signal.aborted) return fp;
  }

  // 2. Pre-fetched local/blob/Capacitor URL
  if (payload.preFetchedUrl) {
    try {
      const resp = await fetchWithTimeout(
        payload.preFetchedUrl,
        { signal },
        10_000
      );
      if (resp.ok) {
        const b = await resp.blob();
        if (!signal.aborted && b.size > 0) {
          const fp = await fingerprintFromBlobInWorker(b, signal);
          if (fp) return fp;
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' || signal.aborted) {
        throw err;
      }
    }
  }

  if (signal.aborted) return null;

  // 3. Fast Drive CDN thumbnail via anonymous CORS (with circuit breaker)
  if (
    payload.sourceKind === 'drive' &&
    payload.thumbnailLink &&
    consecutiveCdnCorsFailures < 2
  ) {
    const thumbUrl = getCorsThumbnailUrl(payload.thumbnailLink);
    if (thumbUrl) {
      try {
        const res = await fetchWithTimeout(
          thumbUrl,
          {
            mode: 'cors',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal,
          },
          8_000
        );
        if (res.ok) {
          const b = await res.blob();
          if (!signal.aborted && b.size > 512) {
            const fp = await fingerprintFromBlobInWorker(b, signal);
            if (fp) {
              consecutiveCdnCorsFailures = 0;
              return fp;
            }
          }
        }
        consecutiveCdnCorsFailures += 1;
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError' || signal.aborted) {
          throw err;
        }
        consecutiveCdnCorsFailures += 1;
      }
    }
  }

  if (signal.aborted) return null;

  // 4. Tiny authenticated Range/Slice embedded EXIF/RAW thumbnail extraction (entirely off main thread!)
  const headerThumb = await extractHeaderThumbnailBlobInWorker(payload, signal);
  if (signal.aborted) return null;
  if (headerThumb) {
    const headerFp = await fingerprintFromBlobInWorker(headerThumb, signal);
    if (headerFp) return headerFp;
  }

  if (signal.aborted) return null;

  // 5. Fallback for standard images lacking an embedded EXIF thumbnail (<= 25 MB)
  if (!payload.isRaw && payload.sizeBytes <= 25 * 1024 * 1024) {
    if (payload.localFile) {
      return await fingerprintFromBlobInWorker(payload.localFile, signal);
    }
    if (payload.sourceKind === 'drive' && payload.accessToken) {
      const fullBuf = await fetchDriveRangeInWorker(
        payload.accessToken,
        payload.fileId,
        undefined,
        signal
      );
      if (fullBuf && !signal.aborted) {
        const blob = new Blob([fullBuf], {
          type: payload.mimeType || 'image/jpeg',
        });
        return await fingerprintFromBlobInWorker(blob, signal);
      }
    }
  }

  return null;
}

workerScope.onmessage = (event: MessageEvent<FingerprintWorkerInbound>) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'cancel') {
    const ctrl = activeJobs.get(msg.jobId);
    if (ctrl) {
      ctrl.abort();
      activeJobs.delete(msg.jobId);
    }
    return;
  }

  if (msg.type === 'cancelAll') {
    for (const ctrl of activeJobs.values()) {
      ctrl.abort();
    }
    activeJobs.clear();
    return;
  }

  if (msg.type === 'compute') {
    if (
      typeof OffscreenCanvas === 'undefined' ||
      typeof createImageBitmap !== 'function'
    ) {
      workerScope.postMessage({
        type: 'result',
        jobId: msg.jobId,
        fileId: msg.payload.fileId,
        fingerprint: null,
        unsupported: true,
      });
      return;
    }

    const controller = new AbortController();
    activeJobs.set(msg.jobId, controller);

    void computeJob(msg.payload, controller.signal)
      .then((fp) => {
        if (controller.signal.aborted) {
          workerScope.postMessage({
            type: 'error',
            jobId: msg.jobId,
            fileId: msg.payload.fileId,
            aborted: true,
          });
          return;
        }
        const transfers: Transferable[] = fp
          ? [
              fp.lumaGrid.buffer,
              fp.edgeGrid.buffer,
              fp.spatialColor.buffer,
              fp.colorHist.buffer,
            ]
          : [];
        workerScope.postMessage(
          {
            type: 'result',
            jobId: msg.jobId,
            fileId: msg.payload.fileId,
            fingerprint: fp,
          },
          transfers
        );
      })
      .catch(() => {
        workerScope.postMessage({
          type: 'error',
          jobId: msg.jobId,
          fileId: msg.payload.fileId,
          aborted: controller.signal.aborted,
        });
      })
      .finally(() => {
        activeJobs.delete(msg.jobId);
      });
  }
};

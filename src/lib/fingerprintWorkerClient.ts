import { DrivePhotoFile } from './driveApi';
import type { VisualFingerprint } from './fingerprintMath';
import type {
  FingerprintWorkerInbound,
  FingerprintWorkerOutbound,
  FingerprintWorkerPayload,
} from './fingerprintWorker';
import { getCachedMicroThumbBlob } from './previewCacheDb';
import { getCachedFilmstripThumbnailUrl } from './rawParser';
import { computePhotoFingerprint } from './visualSimilarity';

interface PendingJob {
  jobId: string;
  fileId: string;
  resolve: (result: {
    fingerprint: VisualFingerprint | null;
    unsupported?: boolean;
  }) => void;
}

class FingerprintWorkerClient {
  private worker: Worker | null = null;
  private workerDisabled = false;
  private nextSeq = 1;
  private pendingJobs = new Map<string, PendingJob>();

  private ensureWorker(): Worker | null {
    if (
      this.workerDisabled ||
      typeof Worker === 'undefined' ||
      typeof OffscreenCanvas === 'undefined' ||
      typeof createImageBitmap !== 'function'
    ) {
      this.workerDisabled = true;
      return null;
    }
    if (this.worker) return this.worker;

    try {
      const w = new Worker(
        new URL('./fingerprintWorker.ts', import.meta.url),
        { type: 'module' }
      );
      w.onmessage = (event: MessageEvent<FingerprintWorkerOutbound>) => {
        const msg = event.data;
        if (!msg || !msg.jobId) return;
        const pending = this.pendingJobs.get(msg.jobId);
        if (!pending) return;
        this.pendingJobs.delete(msg.jobId);
        if (msg.type === 'result') {
          if (msg.unsupported) {
            this.workerDisabled = true;
          }
          pending.resolve({
            fingerprint: msg.fingerprint,
            unsupported: msg.unsupported,
          });
        } else {
          pending.resolve({ fingerprint: null });
        }
      };
      w.onerror = () => {
        this.handleCrash();
      };
      this.worker = w;
      return w;
    } catch {
      this.workerDisabled = true;
      return null;
    }
  }

  private handleCrash(): void {
    const stale = Array.from(this.pendingJobs.values());
    this.pendingJobs.clear();
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // Ignore terminate error
      }
      this.worker = null;
    }
    for (const p of stale) {
      p.resolve({ fingerprint: null });
    }
  }

  public cancelAll(): void {
    if (this.worker && this.pendingJobs.size > 0) {
      try {
        const msg: FingerprintWorkerInbound = { type: 'cancelAll' };
        this.worker.postMessage(msg);
      } catch {
        // Ignore postMessage errors
      }
    }
    const stale = Array.from(this.pendingJobs.values());
    this.pendingJobs.clear();
    for (const p of stale) {
      p.resolve({ fingerprint: null });
    }
  }

  public dispose(): void {
    this.cancelAll();
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // Ignore terminate error
      }
      this.worker = null;
    }
  }

  /**
   * Computes a VisualFingerprint completely off the main thread in the dedicated
   * Fingerprint Web Worker whenever supported, falling back to `computePhotoFingerprint`
   * on environments lacking Worker/OffscreenCanvas support.
   */
  public async computeOffThread(
    accessToken: string | null | undefined,
    file: DrivePhotoFile,
    options: { existingLocalUrl?: string; signal?: AbortSignal } = {}
  ): Promise<VisualFingerprint | null> {
    if (options.signal?.aborted) return null;

    const worker = this.ensureWorker();
    if (!worker) {
      return computePhotoFingerprint(accessToken, file, options);
    }

    const sourceKind = file.sourceKind || 'drive';

    // Check fast local sources (already-loaded blob URL, IDB micro-thumb, or Android native RAW thumb)
    let idbMicroBlob: Blob | undefined;
    let preFetchedUrl: string | undefined;

    const isLocalCachedUrl = (url?: string | null) =>
      Boolean(
        url &&
          (url.startsWith('blob:') ||
            url.includes('/_capacitor_file_/') ||
            url.startsWith('capacitor://'))
      );

    const candidateLocalUrl = isLocalCachedUrl(options.existingLocalUrl)
      ? options.existingLocalUrl
      : getCachedFilmstripThumbnailUrl(file.id);
    if (isLocalCachedUrl(candidateLocalUrl) && candidateLocalUrl) {
      preFetchedUrl = candidateLocalUrl;
    }

    if (!preFetchedUrl) {
      try {
        const micro = await getCachedMicroThumbBlob(file.id);
        if (options.signal?.aborted) return null;
        if (micro && micro.size > 0) {
          idbMicroBlob = micro;
        }
      } catch {
        // Ignore IDB lookup errors
      }
    }

    if (
      !preFetchedUrl &&
      !idbMicroBlob &&
      sourceKind === 'android-saf' &&
      file.nativeUri
    ) {
      try {
        if (file.isRaw && window.FrameCullNative?.extractRawThumbnailUrl) {
          const nativeThumb =
            await window.FrameCullNative.extractRawThumbnailUrl(file.nativeUri);
          if (options.signal?.aborted) return null;
          if (nativeThumb?.url) preFetchedUrl = nativeThumb.url;
        } else if (!file.isRaw && window.FrameCullNative?.getThumbnailUrl) {
          const nativeThumb = await window.FrameCullNative.getThumbnailUrl(
            file.nativeUri
          );
          if (options.signal?.aborted) return null;
          if (nativeThumb) preFetchedUrl = nativeThumb;
        }
      } catch {
        // Fall through
      }
    }

    if (options.signal?.aborted) return null;

    // Android SAF without preFetchedUrl/blob cannot read SAF URIs inside a Web Worker;
    // gracefully delegate only that edge case to main-thread fallback
    if (sourceKind === 'android-saf' && !preFetchedUrl && !idbMicroBlob) {
      return computePhotoFingerprint(accessToken, file, options);
    }

    const payload: FingerprintWorkerPayload = {
      fileId: file.id,
      fileExtension: file.fileExtension,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      isRaw: file.isRaw,
      sourceKind,
      thumbnailLink: file.thumbnailLink,
      accessToken,
      ...(idbMicroBlob ? { blob: idbMicroBlob } : {}),
      ...(file.localFile ? { localFile: file.localFile } : {}),
      ...(preFetchedUrl ? { preFetchedUrl } : {}),
    };

    const jobId = `fp-${this.nextSeq++}`;

    const res = await new Promise<{
      fingerprint: VisualFingerprint | null;
      unsupported?: boolean;
    }>((resolve) => {
      const onAbort = () => {
        if (this.pendingJobs.delete(jobId) && this.worker) {
          try {
            const cancelMsg: FingerprintWorkerInbound = {
              type: 'cancel',
              jobId,
            };
            this.worker.postMessage(cancelMsg);
          } catch {
            // Ignore cancel error
          }
        }
        resolve({ fingerprint: null });
      };

      if (options.signal) {
        if (options.signal.aborted) {
          resolve({ fingerprint: null });
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pendingJobs.set(jobId, {
        jobId,
        fileId: file.id,
        resolve: (out) => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve(out);
        },
      });

      try {
        const msg: FingerprintWorkerInbound = {
          type: 'compute',
          jobId,
          payload,
        };
        worker.postMessage(msg);
      } catch {
        options.signal?.removeEventListener('abort', onAbort);
        this.pendingJobs.delete(jobId);
        resolve({ fingerprint: null });
      }
    });

    if (res.unsupported && !options.signal?.aborted) {
      return computePhotoFingerprint(accessToken, file, options);
    }

    return res.fingerprint;
  }
}

export const fingerprintWorkerClient = new FingerprintWorkerClient();

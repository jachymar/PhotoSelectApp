import { DrivePhotoFile } from './driveApi';
import {
  waitForBackgroundSlot,
  waitForPreviewSlot,
} from './interactionGate';
import { readLocalFileBytes } from './localMedia';
import {
  getCachedDetailPreview,
  saveDetailPreview,
  saveMicroThumb,
} from './previewCacheDb';
import type {
  WorkerDecodePayload,
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from './previewDecodeWorker';
import {
  getCachedPhotoMedia,
  predecodeAndRetainImage,
  registerWorkerDecodedMedia,
  resolvePhotoMedia,
  type ResolvedPhotoMedia,
} from './rawParser';

export const NEXT_QUEUE_DECODE_COUNT = 5;
const MAX_CONCURRENT_WORKER_DECODES = 3;

export interface QueueDecodeOptions {
  accessToken?: string | null;
  folderId?: string;
  highQualitySeries?: boolean;
  preferFullRawDecode?: boolean;
  keepActiveFileId?: string;
  isCulled?: (fileId: string) => boolean;
  isAlreadyReady?: (file: DrivePhotoFile) => boolean;
  onDecoded: (fileId: string, resolved: ResolvedPhotoMedia) => void;
  onAuthExpired?: () => void;
}

interface PendingQueueItem {
  file: DrivePhotoFile;
  jobKey: string;
  variant: 'auto' | 'full';
  highQualitySeries: boolean;
  preferFullRawDecode: boolean;
  accessToken?: string | null;
  folderId?: string;
  isCulled: boolean;
  onDecoded: (fileId: string, resolved: ResolvedPhotoMedia) => void;
  onAuthExpired?: () => void;
}

interface ActiveJobHandle {
  jobId: string;
  fileId: string;
  jobKey: string;
  variant: 'auto' | 'full';
  controller: AbortController;
  resolveWorker?: (msg: WorkerOutboundMessage) => void;
  onDecoded: (fileId: string, resolved: ResolvedPhotoMedia) => void;
  onAuthExpired?: () => void;
}

function isResolvedMediaSufficient(
  file: DrivePhotoFile,
  media: ResolvedPhotoMedia | null | undefined,
  highQualitySeries: boolean,
  preferFullRawDecode: boolean
): boolean {
  if (!media || !media.url) return false;
  if (preferFullRawDecode && file.isRaw && media.source === 'drive-thumbnail') {
    return false;
  }
  if (highQualitySeries) {
    if (file.isRaw && media.source === 'drive-thumbnail') return false;
    if (
      !file.isRaw &&
      media.source === 'drive-thumbnail' &&
      !media.url.includes('=s2400')
    ) {
      return false;
    }
  }
  return true;
}

class PreviewDecodeWorkerManager {
  private worker: Worker | null = null;
  private workerDisabled = false;
  private nextJobSeq = 1;
  private pendingQueue: PendingQueueItem[] = [];
  private activeJobsByFileId = new Map<string, ActiveJobHandle>();
  private activeJobsByJobId = new Map<string, ActiveJobHandle>();
  private desiredFileIds = new Set<string>();
  private pumping = false;

  private ensureWorker(): Worker | null {
    if (this.workerDisabled || typeof Worker === 'undefined') {
      return null;
    }
    if (this.worker) return this.worker;

    try {
      const w = new Worker(
        new URL('./previewDecodeWorker.ts', import.meta.url),
        { type: 'module' }
      );
      w.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
        this.handleWorkerMessage(event.data);
      };
      w.onerror = () => {
        this.handleWorkerFailure();
      };
      this.worker = w;
      return w;
    } catch {
      this.workerDisabled = true;
      return null;
    }
  }

  private handleWorkerMessage(msg: WorkerOutboundMessage): void {
    if (!msg || !msg.jobId) return;
    const handle = this.activeJobsByJobId.get(msg.jobId);
    if (!handle) {
      // Stale job already cancelled — immediately release transferred ImageBitmap
      if (msg.type === 'decoded' && msg.bitmap) {
        try {
          msg.bitmap.close();
        } catch {
          // Ignore close error
        }
      }
      return;
    }
    const resolver = handle.resolveWorker;
    handle.resolveWorker = undefined;
    resolver?.(msg);
  }

  private handleWorkerFailure(): void {
    const failedHandles = Array.from(this.activeJobsByJobId.values());
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // Ignore terminate error
      }
      this.worker = null;
    }
    for (const handle of failedHandles) {
      const resolver = handle.resolveWorker;
      handle.resolveWorker = undefined;
      resolver?.({
        type: 'error',
        jobId: handle.jobId,
        fileId: handle.fileId,
        error: 'Worker thread restarted after unexpected error.',
      });
    }
  }

  private postToWorker(
    message: WorkerInboundMessage,
    transfer?: Transferable[]
  ): boolean {
    const w = this.ensureWorker();
    if (!w) return false;
    try {
      if (transfer && transfer.length > 0) {
        w.postMessage(message, transfer);
      } else {
        w.postMessage(message);
      }
      return true;
    } catch {
      return false;
    }
  }

  private cancelJobHandle(handle: ActiveJobHandle): void {
    if (!handle.controller.signal.aborted) {
      handle.controller.abort();
    }
    this.activeJobsByJobId.delete(handle.jobId);
    if (this.activeJobsByFileId.get(handle.fileId)?.jobId === handle.jobId) {
      this.activeJobsByFileId.delete(handle.fileId);
    }
    if (this.worker) {
      try {
        const cancelMsg: WorkerInboundMessage = {
          type: 'cancel',
          jobId: handle.jobId,
        };
        this.worker.postMessage(cancelMsg);
      } catch {
        // Ignore postMessage errors on closing worker
      }
    }
    const resolver = handle.resolveWorker;
    handle.resolveWorker = undefined;
    resolver?.({
      type: 'error',
      jobId: handle.jobId,
      fileId: handle.fileId,
      error: 'Aborted',
      aborted: true,
    });
  }

  /**
   * Schedules background high-resolution preview decoding on the Worker thread
   * for up to the next 3 images in the active queue.
   * Any stale jobs outside the new 3-image lookahead window are immediately cancelled.
   */
  public scheduleNextQueuePreviews(
    nextFiles: DrivePhotoFile[],
    options: QueueDecodeOptions
  ): void {
    const targetFiles = nextFiles.slice(0, NEXT_QUEUE_DECODE_COUNT);
    const nextDesired = new Set<string>();
    const dedupedTargets: DrivePhotoFile[] = [];

    for (const file of targetFiles) {
      if (!file?.id || nextDesired.has(file.id)) continue;
      nextDesired.add(file.id);
      dedupedTargets.push(file);
    }

    const keepActiveId = options.keepActiveFileId;
    if (keepActiveId && this.activeJobsByFileId.has(keepActiveId)) {
      nextDesired.add(keepActiveId);
      const activeForCurrent = this.activeJobsByFileId.get(keepActiveId);
      if (activeForCurrent) {
        activeForCurrent.onDecoded = options.onDecoded;
        activeForCurrent.onAuthExpired = options.onAuthExpired;
      }
    }

    this.desiredFileIds = nextDesired;

    // Cancel any active jobs that fell outside the new next-3 lookahead window
    for (const [fileId, handle] of Array.from(this.activeJobsByFileId.entries())) {
      if (!nextDesired.has(fileId)) {
        this.cancelJobHandle(handle);
      }
    }

    // Rebuild priority-ordered pending queue: [next+1, next+2, next+3]
    const nextPending: PendingQueueItem[] = [];
    const highQualitySeries = Boolean(options.highQualitySeries);

    for (const file of dedupedTargets) {
      const preferFullRawDecode = Boolean(
        options.preferFullRawDecode || (highQualitySeries && file.isRaw)
      );
      const variant: 'auto' | 'full' = preferFullRawDecode ? 'full' : 'auto';
      const jobKey = `${file.id}:${variant}:${highQualitySeries ? 'hq' : 'std'}`;

      // If caller already has a sufficient sharp preview in React state, skip
      if (options.isAlreadyReady?.(file)) {
        continue;
      }

      // Check RAM mediaCache for an instant 0ms hit
      const cachedRam = getCachedPhotoMedia(file.id, variant);
      if (
        isResolvedMediaSufficient(
          file,
          cachedRam,
          highQualitySeries,
          preferFullRawDecode
        )
      ) {
        options.onDecoded(file.id, cachedRam!);
        continue;
      }

      // If an equivalent job is already actively decoding in the Worker, keep it alive and refresh callbacks
      const existingActive = this.activeJobsByFileId.get(file.id);
      if (existingActive) {
        if (existingActive.jobKey === jobKey || existingActive.variant === 'full') {
          existingActive.onDecoded = options.onDecoded;
          existingActive.onAuthExpired = options.onAuthExpired;
          continue;
        }
        // Quality requirement upgraded (e.g. entered open-series HQ mode): cancel lower-res job
        this.cancelJobHandle(existingActive);
      }

      nextPending.push({
        file,
        jobKey,
        variant,
        highQualitySeries,
        preferFullRawDecode,
        accessToken: options.accessToken,
        folderId: options.folderId,
        isCulled: options.isCulled ? options.isCulled(file.id) : false,
        onDecoded: options.onDecoded,
        onAuthExpired: options.onAuthExpired,
      });
    }

    this.pendingQueue = nextPending;
    this.pumpQueue();
  }

  public isFileDecoding(fileId: string): boolean {
    return this.activeJobsByFileId.has(fileId);
  }

  public cancelAll(): void {
    this.desiredFileIds.clear();
    this.pendingQueue = [];
    for (const handle of Array.from(this.activeJobsByFileId.values())) {
      this.cancelJobHandle(handle);
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

  private pumpQueue(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (
        this.activeJobsByFileId.size < MAX_CONCURRENT_WORKER_DECODES &&
        this.pendingQueue.length > 0
      ) {
        const item = this.pendingQueue.shift();
        if (!item) break;
        if (!this.desiredFileIds.has(item.file.id)) continue;
        if (this.activeJobsByFileId.has(item.file.id)) continue;

        void this.runQueueItem(item);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runQueueItem(item: PendingQueueItem): Promise<void> {
    const jobId = `bg-decode-${this.nextJobSeq++}`;
    const controller = new AbortController();
    const handle: ActiveJobHandle = {
      jobId,
      fileId: item.file.id,
      jobKey: item.jobKey,
      variant: item.variant,
      controller,
      onDecoded: item.onDecoded,
      onAuthExpired: item.onAuthExpired,
    };

    this.activeJobsByFileId.set(item.file.id, handle);
    this.activeJobsByJobId.set(jobId, handle);

    try {
      // Pause lookahead decoding only while a finger is actively pressed (0ms post-release cooldown)
      if (!item.highQualitySeries) {
        await waitForPreviewSlot(controller.signal);
        if (controller.signal.aborted || !this.desiredFileIds.has(item.file.id)) {
          return;
        }
      }

      // Check RAM cache again in case foreground loaded it while we waited
      const cachedRam = getCachedPhotoMedia(item.file.id, item.variant);
      if (
        isResolvedMediaSufficient(
          item.file,
          cachedRam,
          item.highQualitySeries,
          item.preferFullRawDecode
        )
      ) {
        handle.onDecoded(item.file.id, cachedRam!);
        return;
      }

      const worker = this.ensureWorker();
      if (!worker) {
        // Graceful fallback if Web Workers are unavailable
        const resolved = await resolvePhotoMedia(item.accessToken, item.file, {
          preferFullRawDecode: item.preferFullRawDecode,
          highQualitySeries: item.highQualitySeries,
          isBackground: !item.highQualitySeries,
          signal: controller.signal,
          folderId: item.folderId,
          isCulled: item.isCulled,
        });
        if (!controller.signal.aborted) {
          handle.onDecoded(item.file.id, resolved);
          void predecodeAndRetainImage(resolved.url, 12_000, true).catch(() => {});
        }
        return;
      }

      // Prepare worker payload (check IndexedDB first so even cached blobs decode off-thread!)
      const cacheKey = `${item.file.id}:${item.variant}`;
      const idbCached =
        (await getCachedDetailPreview(cacheKey)) ||
        (!item.preferFullRawDecode
          ? await getCachedDetailPreview(`${item.file.id}:full`)
          : null);

      if (controller.signal.aborted || !this.desiredFileIds.has(item.file.id)) {
        return;
      }

      const sourceKind = item.file.sourceKind || 'drive';
      const transfers: Transferable[] = [];
      const payload: WorkerDecodePayload = {
        fileId: item.file.id,
        name: item.file.name,
        fileExtension: item.file.fileExtension,
        mimeType: item.file.mimeType,
        sizeBytes: item.file.sizeBytes,
        isRaw: item.file.isRaw,
        sourceKind,
        thumbnailLink: item.file.thumbnailLink,
        accessToken: item.accessToken,
        preferFullRawDecode: item.preferFullRawDecode,
        highQualitySeries: item.highQualitySeries,
        maxDim: item.highQualitySeries ? 2048 : 2048,
        jpegQuality: item.highQualitySeries ? 0.87 : 0.86,
      };

      if (idbCached?.blob && idbCached.blob.size > 0) {
        payload.cachedBlob = idbCached.blob;
        payload.cachedSource = idbCached.source;
        payload.cachedExif = idbCached.exif;
      } else if (sourceKind === 'local-file' && item.file.localFile) {
        payload.localFile = item.file.localFile;
      } else if (sourceKind === 'android-saf') {
        const prepared = await this.prepareAndroidSafPayload(
          item.file,
          controller.signal
        );
        if (controller.signal.aborted || !this.desiredFileIds.has(item.file.id)) {
          return;
        }
        if (prepared.preFetchedUrl) {
          payload.preFetchedUrl = prepared.preFetchedUrl;
        }
        if (prepared.orientationHint) {
          payload.orientationHint = prepared.orientationHint;
        }
        if (prepared.preFetchedHeaderBuffer) {
          payload.preFetchedHeaderBuffer = prepared.preFetchedHeaderBuffer;
          transfers.push(prepared.preFetchedHeaderBuffer);
        }
        if (prepared.preFetchedBuffer) {
          payload.preFetchedBuffer = prepared.preFetchedBuffer;
          transfers.push(prepared.preFetchedBuffer);
        }
      }

      const workerResponse = await new Promise<WorkerOutboundMessage>(
        (resolve) => {
          handle.resolveWorker = resolve;
          const sent = this.postToWorker(
            { type: 'decode', jobId, payload },
            transfers
          );
          if (!sent) {
            handle.resolveWorker = undefined;
            resolve({
              type: 'error',
              jobId,
              fileId: item.file.id,
              error: 'Worker unavailable',
            });
          }
        }
      );

      if (controller.signal.aborted || !this.desiredFileIds.has(item.file.id)) {
        if (workerResponse.type === 'decoded' && workerResponse.bitmap) {
          try {
            workerResponse.bitmap.close();
          } catch {
            // Ignore close error
          }
        }
        return;
      }

      if (workerResponse.type === 'error') {
        if (workerResponse.authExpired) {
          handle.onAuthExpired?.();
        }
        return;
      }

      const registered = registerWorkerDecodedMedia({
        file: item.file,
        blob: workerResponse.blob,
        bitmap: workerResponse.bitmap,
        fallbackUrl: workerResponse.fallbackUrl,
        source: workerResponse.source,
        exif: workerResponse.exif,
        folderId: item.folderId,
        variant: item.variant,
        isCulled: item.isCulled,
        skipIdbPersist: Boolean(workerResponse.fromIdbCache),
      });

      if (registered) {
        handle.onDecoded(item.file.id, registered);
        // Warm compositor image texture asynchronously when idle so <img> swaps in 0ms
        void predecodeAndRetainImage(registered.url, 12_000, true).catch(() => {});
      }
    } catch {
      // Background preload errors are non-fatal; foreground loader will retry on demand
    } finally {
      this.activeJobsByJobId.delete(jobId);
      if (this.activeJobsByFileId.get(item.file.id)?.jobId === jobId) {
        this.activeJobsByFileId.delete(item.file.id);
      }
      this.pumpQueue();
    }
  }

  private async prepareAndroidSafPayload(
    file: DrivePhotoFile,
    signal: AbortSignal
  ): Promise<{
    preFetchedUrl?: string;
    preFetchedHeaderBuffer?: ArrayBuffer;
    preFetchedBuffer?: ArrayBuffer;
    orientationHint?: number;
  }> {
    const nativeBridge =
      typeof window !== 'undefined' ? window.FrameCullNative : undefined;

    if (file.isRaw && file.nativeUri && nativeBridge?.extractRawPreviewUrl) {
      const [nativeExtracted, headerBuf] = await Promise.all([
        nativeBridge.extractRawPreviewUrl(file.nativeUri).catch(() => null),
        readLocalFileBytes(file, { start: 0, end: 262_143 }, signal).catch(
          () => null
        ),
      ]);
      if (nativeExtracted?.url) {
        return {
          preFetchedUrl: nativeExtracted.url,
          preFetchedHeaderBuffer: headerBuf || undefined,
          orientationHint: nativeExtracted.orientation,
        };
      }
    }

    if (!file.isRaw && file.nativeUri && nativeBridge?.getFullMediaUrl) {
      const [nativeUrl, headerBuf] = await Promise.all([
        nativeBridge.getFullMediaUrl(file.nativeUri).catch(() => null),
        readLocalFileBytes(file, { start: 0, end: 131_071 }, signal).catch(
          () => null
        ),
      ]);
      if (nativeUrl) {
        return {
          preFetchedUrl: nativeUrl,
          preFetchedHeaderBuffer: headerBuf || undefined,
        };
      }
    }

    // Fallback: read initial slice (for RAW) or full buffer (for standard image) and transfer to Worker
    const range = file.isRaw
      ? {
          start: 0,
          end:
            file.sizeBytes > 0
              ? Math.min(file.sizeBytes - 1, 4 * 1024 * 1024 - 1)
              : 4 * 1024 * 1024 - 1,
        }
      : undefined;
    const buf = await readLocalFileBytes(file, range, signal);
    return { preFetchedBuffer: buf };
  }

  /**
   * Silently downloads & decodes a single file off the main thread in the Web Worker
   * and persists its high-quality preview JPEG + micro-thumb directly into IndexedDB
   * without transferring ImageBitmaps or bloating main-thread RAM.
   */
  public async prewarmFileToIdbCache(
    file: DrivePhotoFile,
    options: {
      accessToken?: string | null;
      folderId: string;
      isCulled?: boolean;
      signal?: AbortSignal;
      onAuthExpired?: () => void;
    }
  ): Promise<boolean> {
    if (!file?.id || !options.folderId || options.signal?.aborted) {
      return false;
    }
    if (this.activeJobsByFileId.has(file.id)) {
      return false;
    }

    const cacheKey = `${file.id}:auto`;
    try {
      const existing = await getCachedDetailPreview(cacheKey);
      if (existing?.blob && existing.blob.size > 0) {
        return true;
      }
    } catch {
      // Proceed to decode
    }

    if (options.signal?.aborted) return false;
    await waitForBackgroundSlot(options.signal);
    if (options.signal?.aborted || this.activeJobsByFileId.has(file.id)) {
      return false;
    }

    const worker = this.ensureWorker();
    if (!worker) return false;

    const sourceKind = file.sourceKind || 'drive';
    const transfers: Transferable[] = [];
    const payload: WorkerDecodePayload = {
      fileId: file.id,
      name: file.name,
      fileExtension: file.fileExtension,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      isRaw: file.isRaw,
      sourceKind,
      thumbnailLink: file.thumbnailLink,
      accessToken: options.accessToken,
      preferFullRawDecode: false,
      highQualitySeries: false,
      cacheOnly: true,
      generateMicroThumb: true,
      maxDim: 1920,
      jpegQuality: 0.85,
    };

    if (sourceKind === 'local-file' && file.localFile) {
      payload.localFile = file.localFile;
    } else if (sourceKind === 'android-saf') {
      try {
        const prepared = await this.prepareAndroidSafPayload(
          file,
          options.signal || new AbortController().signal
        );
        if (options.signal?.aborted) return false;
        if (prepared.preFetchedUrl) {
          payload.preFetchedUrl = prepared.preFetchedUrl;
        }
        if (prepared.orientationHint) {
          payload.orientationHint = prepared.orientationHint;
        }
        if (prepared.preFetchedHeaderBuffer) {
          payload.preFetchedHeaderBuffer = prepared.preFetchedHeaderBuffer;
          transfers.push(prepared.preFetchedHeaderBuffer);
        }
        if (prepared.preFetchedBuffer) {
          payload.preFetchedBuffer = prepared.preFetchedBuffer;
          transfers.push(prepared.preFetchedBuffer);
        }
      } catch {
        return false;
      }
    }

    const jobId = `prewarm-${this.nextJobSeq++}`;
    const controller = new AbortController();
    const handle: ActiveJobHandle = {
      jobId,
      fileId: file.id,
      jobKey: `prewarm:${file.id}`,
      variant: 'auto',
      controller,
      onDecoded: () => {},
      onAuthExpired: options.onAuthExpired,
    };

    this.activeJobsByJobId.set(jobId, handle);

    const onExternalAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
      this.activeJobsByJobId.delete(jobId);
      if (this.worker) {
        try {
          this.worker.postMessage({ type: 'cancel', jobId } as WorkerInboundMessage);
        } catch {
          // Ignore cancel error
        }
      }
      const resolver = handle.resolveWorker;
      handle.resolveWorker = undefined;
      resolver?.({
        type: 'error',
        jobId,
        fileId: file.id,
        error: 'Aborted',
        aborted: true,
      });
    };

    if (options.signal) {
      if (options.signal.aborted) {
        this.activeJobsByJobId.delete(jobId);
        return false;
      }
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const workerResponse = await new Promise<WorkerOutboundMessage>(
        (resolve) => {
          handle.resolveWorker = resolve;
          const sent = this.postToWorker(
            { type: 'decode', jobId, payload },
            transfers
          );
          if (!sent) {
            handle.resolveWorker = undefined;
            resolve({
              type: 'error',
              jobId,
              fileId: file.id,
              error: 'Worker unavailable',
            });
          }
        }
      );

      if (workerResponse.type === 'decoded' && workerResponse.bitmap) {
        try {
          workerResponse.bitmap.close();
        } catch {
          // Ignore close error
        }
      }

      if (options.signal?.aborted || controller.signal.aborted) {
        return false;
      }

      if (workerResponse.type === 'error') {
        if (workerResponse.authExpired) {
          options.onAuthExpired?.();
        }
        return false;
      }

      if (workerResponse.blob && workerResponse.blob.size > 0) {
        const culledAtMs = options.isCulled ? Date.now() : null;
        await saveDetailPreview({
          cacheKey,
          fileId: file.id,
          folderId: options.folderId,
          variant: 'auto',
          blob: workerResponse.blob,
          source: workerResponse.source,
          exif: workerResponse.exif,
          culledAtMs,
        });
        if (
          workerResponse.microThumbBlob &&
          workerResponse.microThumbBlob.size > 0
        ) {
          await saveMicroThumb({
            fileId: file.id,
            folderId: options.folderId,
            blob: workerResponse.microThumbBlob,
            folderCulledAtMs: culledAtMs,
            skipMemoryUrl: true,
          });
        }
        return true;
      }

      return false;
    } catch {
      return false;
    } finally {
      options.signal?.removeEventListener('abort', onExternalAbort);
      this.activeJobsByJobId.delete(jobId);
    }
  }
}

export const previewDecodeWorkerClient = new PreviewDecodeWorkerManager();

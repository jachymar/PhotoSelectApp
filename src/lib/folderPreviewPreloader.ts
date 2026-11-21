import { AuthExpiredError, DrivePhotoFile } from './driveApi';
import {
  isOpenSeriesPriorityActive,
  waitForBackgroundSlot,
} from './interactionGate';
import {
  getCachedFolderFileIds,
  saveDetailPreview,
  saveMicroThumb,
} from './previewCacheDb';
import {
  downscaleBlobToJpegBlob,
  extractFastHeaderThumbnailBlob,
  extractRawEmbeddedPreviewBlob,
  fetchPhotoBytes,
  getSeriesHighQualityThumbnailUrl,
  parseExifSafe,
  runSerializedFullBlobDownscale,
  type ParsedExif,
  type ResolvedPhotoMedia,
} from './rawParser';
import type { PhotoShotItem } from './burstGrouping';

export type FolderPreloadStatus =
  | 'idle'
  | 'running'
  | 'paused-series'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface FolderPreloadProgress {
  status: FolderPreloadStatus;
  total: number;
  processed: number;
  converted: number;
  skipped: number;
  failed: number;
  bytesStored: number;
  currentFileName: string;
  errorMessage?: string;
}

export interface FolderCacheCoverage {
  total: number;
  detailCached: number;
  microCached: number;
}

const DETAIL_TARGET_MAX_DIM = 1920;
const DETAIL_JPEG_QUALITY = 0.85;
const MICRO_TARGET_MAX_DIM = 128;
const MICRO_JPEG_QUALITY = 0.55;

export async function checkFolderPreviewCoverage(
  folderId: string,
  shots: PhotoShotItem[]
): Promise<FolderCacheCoverage> {
  if (!folderId || shots.length === 0) {
    return { total: shots.length, detailCached: 0, microCached: 0 };
  }
  const { detailFileIds, microThumbFileIds } =
    await getCachedFolderFileIds(folderId);
  let detailCached = 0;
  let microCached = 0;
  for (const s of shots) {
    const id = s.primary.id;
    if (detailFileIds.has(id)) detailCached++;
    if (microThumbFileIds.has(id)) microCached++;
  }
  return {
    total: shots.length,
    detailCached,
    microCached,
  };
}

let driveThumbCorsBlocked = 0;

async function fetchDriveThumbnailCorsBlob(
  url: string,
  signal?: AbortSignal
): Promise<Blob | null> {
  if (driveThumbCorsBlocked >= 3) return null;
  try {
    const res = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    });
    if (!res.ok) {
      driveThumbCorsBlocked += 1;
      return null;
    }
    const blob = await res.blob();
    if (blob && blob.size > 2048) {
      driveThumbCorsBlocked = 0;
      return blob;
    }
    return null;
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    driveThumbCorsBlocked += 1;
    return null;
  }
}

async function resolveSourcePreviewBlobForPreload(
  token: string | null | undefined,
  file: DrivePhotoFile,
  signal: AbortSignal
): Promise<{
  blob: Blob;
  source: ResolvedPhotoMedia['source'];
  exif?: ParsedExif;
} | null> {
  const isLocal = Boolean(file.sourceKind && file.sourceKind !== 'drive');

  // 1. Local/SD standard image
  if (isLocal && !file.isRaw) {
    if (file.localFile) {
      const hdr = await file.localFile
        .slice(0, Math.min(file.localFile.size, 131072))
        .arrayBuffer()
        .catch(() => null);
      const exif = hdr ? await parseExifSafe(hdr) : undefined;
      return { blob: file.localFile, source: 'local-media', exif };
    }

    if (
      file.sourceKind === 'android-saf' &&
      file.nativeUri &&
      window.FrameCullNative?.getFullMediaUrl
    ) {
      const nativeUrl = await window.FrameCullNative.getFullMediaUrl(
        file.nativeUri
      );
      if (signal.aborted) return null;
      if (nativeUrl) {
        const [resp, hdr] = await Promise.all([
          fetch(nativeUrl, { signal }),
          fetchPhotoBytes(
            token,
            file,
            { start: 0, end: 131071 },
            signal
          ).catch(() => null),
        ]);
        if (resp.ok) {
          const blob = await resp.blob();
          const exif = hdr ? await parseExifSafe(hdr) : undefined;
          if (blob.size > 0) {
            return { blob, source: 'local-media', exif };
          }
        }
      }
    }

    const buf = await fetchPhotoBytes(token, file, undefined, signal);
    const exif = await parseExifSafe(buf);
    const blob = new Blob([buf], { type: file.mimeType || 'image/jpeg' });
    return { blob, source: 'local-media', exif };
  }

  // 2. Local or Drive RAW file
  if (file.isRaw) {
    // On Drive, try high-res Drive CDN preview first if available & CORS-accessible to avoid downloading gigabytes
    if (!isLocal && file.thumbnailLink) {
      const driveHiResUrl = getSeriesHighQualityThumbnailUrl(file.thumbnailLink);
      if (driveHiResUrl) {
        const cdnBlob = await fetchDriveThumbnailCorsBlob(driveHiResUrl, signal);
        if (cdnBlob && cdnBlob.size > 24_000) {
          return { blob: cdnBlob, source: 'drive-thumbnail' };
        }
      }
    }

    const extracted = await extractRawEmbeddedPreviewBlob(token, file, signal);
    if (extracted && extracted.blob.size > 0) {
      return {
        blob: extracted.blob,
        source: 'raw-embedded',
        exif: extracted.exif,
      };
    }
    return null;
  }

  // 3. Google Drive standard image: try crisp =s2400 thumbnail first, fall back to Drive media download
  if (file.thumbnailLink) {
    const driveHiResUrl = getSeriesHighQualityThumbnailUrl(file.thumbnailLink);
    if (driveHiResUrl) {
      const cdnBlob = await fetchDriveThumbnailCorsBlob(driveHiResUrl, signal);
      if (cdnBlob && cdnBlob.size > 12_000) {
        return { blob: cdnBlob, source: 'drive-thumbnail' };
      }
    }
  }

  const buffer = await fetchPhotoBytes(token, file, undefined, signal);
  const exif = await parseExifSafe(buffer);
  const blob = new Blob([buffer], { type: file.mimeType || 'image/jpeg' });
  return { blob, source: 'drive-media', exif };
}

/**
 * Batch-downloads and converts previews for an entire folder into IndexedDB
 * (both display-ready upright detail previews up to 1920px and micro-thumbnails)
 * without polluting RAM mediaCache, ObjectURL maps, or GPU decode pools.
 */
export async function preloadAndConvertFolderPreviews(params: {
  folderId: string;
  shots: PhotoShotItem[];
  accessToken?: string | null;
  culledFileIds?: Set<string>;
  isFolderFullyCulled?: boolean;
  signal: AbortSignal;
  onProgress: (progress: FolderPreloadProgress) => void;
}): Promise<FolderPreloadProgress> {
  const { folderId, shots, accessToken, culledFileIds, signal, onProgress } =
    params;

  const progress: FolderPreloadProgress = {
    status: 'running',
    total: shots.length,
    processed: 0,
    converted: 0,
    skipped: 0,
    failed: 0,
    bytesStored: 0,
    currentFileName: '',
  };

  if (!folderId || shots.length === 0) {
    progress.status = 'completed';
    onProgress({ ...progress });
    return progress;
  }

  let lastEmitAt = 0;
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmitAt < 110) return;
    lastEmitAt = now;
    onProgress({ ...progress });
  };

  emit(true);

  const { detailFileIds, microThumbFileIds } =
    await getCachedFolderFileIds(folderId);
  if (signal.aborted) {
    progress.status = 'cancelled';
    emit(true);
    return progress;
  }

  const pendingShots: PhotoShotItem[] = [];
  for (const shot of shots) {
    const id = shot.primary.id;
    if (detailFileIds.has(id) && microThumbFileIds.has(id)) {
      progress.skipped += 1;
      progress.processed += 1;
    } else {
      pendingShots.push(shot);
    }
  }

  emit(true);

  if (pendingShots.length === 0) {
    progress.status = 'completed';
    emit(true);
    return progress;
  }

  let cursor = 0;
  let fatalAuthErrorMessage: string | null = null;

  const waitWhilePaused = async () => {
    while (!signal.aborted) {
      if (isOpenSeriesPriorityActive()) {
        if (progress.status !== 'paused-series') {
          progress.status = 'paused-series';
          emit(true);
        }
        await waitForBackgroundSlot(signal);
        continue;
      }
      if (progress.status === 'paused-series') {
        progress.status = 'running';
        emit(true);
      }
      await waitForBackgroundSlot(signal);
      return;
    }
  };

  const worker = async () => {
    while (!signal.aborted && !fatalAuthErrorMessage) {
      await waitWhilePaused();
      if (signal.aborted || fatalAuthErrorMessage) return;

      const idx = cursor++;
      if (idx >= pendingShots.length) return;

      const shot = pendingShots[idx];
      const file = shot.primary;
      const needsDetail = !detailFileIds.has(file.id);
      const needsMicro = !microThumbFileIds.has(file.id);

      progress.currentFileName = file.name;
      emit();

      try {
        let convertedDetailBlob: Blob | null = null;
        let detailSource: ResolvedPhotoMedia['source'] = 'local-media';
        let detailExif: ParsedExif | undefined;

        if (needsDetail) {
          const resolved = await resolveSourcePreviewBlobForPreload(
            accessToken,
            file,
            signal
          );
          if (signal.aborted) return;

          if (resolved && resolved.blob.size > 0) {
            detailSource = resolved.source;
            detailExif = resolved.exif;
            // Convert / normalize orientation to crisp upright display JPEG
            const converted = await runSerializedFullBlobDownscale(() =>
              downscaleBlobToJpegBlob(
                resolved.blob,
                DETAIL_TARGET_MAX_DIM,
                DETAIL_JPEG_QUALITY
              )
            );
            if (signal.aborted) return;

            convertedDetailBlob =
              converted && converted.size > 0 ? converted : resolved.blob;

            const isCulled = culledFileIds ? culledFileIds.has(file.id) : false;
            await saveDetailPreview({
              cacheKey: `${file.id}:auto`,
              fileId: file.id,
              folderId,
              variant: 'auto',
              blob: convertedDetailBlob,
              source: detailSource,
              exif: detailExif,
              culledAtMs: isCulled ? Date.now() : null,
            });
            progress.bytesStored += convertedDetailBlob.size;
            detailFileIds.add(file.id);
          }
        }

        if (needsMicro && !signal.aborted) {
          let microSourceBlob: Blob | null = convertedDetailBlob;
          if (!microSourceBlob) {
            microSourceBlob = await extractFastHeaderThumbnailBlob(
              accessToken,
              file,
              signal
            ).catch(() => null);
          }
          if (!microSourceBlob && !file.isRaw && file.localFile) {
            microSourceBlob = file.localFile;
          }
          if (microSourceBlob && microSourceBlob.size > 0) {
            const microBlob =
              microSourceBlob.size <= 22_000 &&
              microSourceBlob.type === 'image/jpeg'
                ? microSourceBlob
                : await runSerializedFullBlobDownscale(() =>
                    downscaleBlobToJpegBlob(
                      microSourceBlob!,
                      MICRO_TARGET_MAX_DIM,
                      MICRO_JPEG_QUALITY
                    )
                  );
            if (microBlob && microBlob.size > 0 && !signal.aborted) {
              await saveMicroThumb({
                fileId: file.id,
                folderId,
                blob: microBlob,
                folderCulledAtMs: params.isFolderFullyCulled ? Date.now() : null,
                skipMemoryUrl: true,
              });
              progress.bytesStored += microBlob.size;
              microThumbFileIds.add(file.id);
            }
          }
        }

        if (convertedDetailBlob || !needsDetail) {
          progress.converted += 1;
        } else {
          progress.failed += 1;
        }
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          fatalAuthErrorMessage = err.message;
          throw err;
        }
        if ((err as { name?: string })?.name === 'AbortError' || signal.aborted) {
          return;
        }
        progress.failed += 1;
      } finally {
        if (!signal.aborted) {
          progress.processed += 1;
          emit();
        }
      }

      // Yield briefly to keep UI & GC smooth during sustained conversion
      await new Promise<void>((r) => window.setTimeout(r, 12));
    }
  };

  try {
    // Bounded concurrency of 2 keeps RAM flat while converting swiftly
    const concurrency = Math.min(2, pendingShots.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } catch (err) {
    if (err instanceof AuthExpiredError) {
      progress.status = 'error';
      progress.errorMessage = err.message;
      emit(true);
      throw err;
    }
  }

  if (signal.aborted) {
    progress.status = 'cancelled';
  } else if (fatalAuthErrorMessage) {
    progress.status = 'error';
    progress.errorMessage = fatalAuthErrorMessage;
  } else {
    progress.status = 'completed';
    progress.currentFileName = '';
  }

  emit(true);
  return progress;
}

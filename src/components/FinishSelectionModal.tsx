import React, { useEffect, useMemo, useState } from 'react';
import {
  Star,
  X,
  AlertTriangle,
  CheckCircle2,
  Image as ImageIcon,
  FileText,
  Share2,
  FolderPlus,
  Copy,
  FolderInput,
  Check,
  Loader2,
} from 'lucide-react';
import {
  AuthExpiredError,
  DriveFolder,
  DrivePhotoFile,
  LIKED_SUBFOLDER_NAME,
  copyDriveFileToFolder,
  findDriveSubfolder,
  findOrCreateDriveSubfolder,
  formatBytes,
  listDriveFolderFileNames,
  moveDriveFileToFolder,
} from '../lib/driveApi';
import {
  buildLikedListText,
  downloadTextFile,
  exportPickedLocalPhotos,
} from '../lib/localMedia';
import { getFastPreviewThumbnailUrl } from '../lib/rawParser';
import { triggerHaptic } from '../lib/haptics';

export type LikedTransferMode = 'copy' | 'move';
export type ExportFormatFilter = 'all' | 'jpg' | 'raw';

const LOCAL_EXPORTED_HISTORY_PREFIX = 'selectra_liked_exported_v1:';

function normalizeFileNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function loadExportedNamesHistory(folderId?: string): Set<string> {
  if (!folderId || typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(
      `${LOCAL_EXPORTED_HISTORY_PREFIX}${folderId}`
    );
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => normalizeFileNameKey(x))
    );
  } catch {
    return new Set();
  }
}

function saveExportedNamesHistory(
  folderId: string | undefined,
  names: Iterable<string>
): void {
  if (!folderId || typeof window === 'undefined') return;
  try {
    const existing = loadExportedNamesHistory(folderId);
    for (const n of names) {
      const key = normalizeFileNameKey(n);
      if (key) existing.add(key);
    }
    // Keep bounded so localStorage stays lean
    const arr = Array.from(existing).slice(-5000);
    window.localStorage.setItem(
      `${LOCAL_EXPORTED_HISTORY_PREFIX}${folderId}`,
      JSON.stringify(arr)
    );
  } catch {
    // Ignore storage quota errors
  }
}

interface FinishSelectionModalProps {
  isOpen: boolean;
  folder?: DriveFolder | null;
  pickedFiles: DrivePhotoFile[];
  pickedShotCount: number;
  thumbnails: Record<string, string>;
  accessToken?: string | null;
  isStillLoadingFolder?: boolean;
  onCancel: () => void;
  onAuthExpired: () => void;
  onComplete: (
    processedIds: string[],
    mode: LikedTransferMode,
    failedItems: { file: DrivePhotoFile; error: string }[],
    customMessage?: string
  ) => void;
}

export const FinishSelectionModal: React.FC<FinishSelectionModalProps> = ({
  isOpen,
  folder,
  pickedFiles,
  pickedShotCount,
  thumbnails,
  accessToken,
  isStillLoadingFolder = false,
  onCancel,
  onAuthExpired,
  onComplete,
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exportFormat, setExportFormat] = useState<ExportFormatFilter>('all');
  const [transferMode, setTransferMode] = useState<LikedTransferMode>('copy');
  const [visibleLimit, setVisibleLimit] = useState(100);
  const [isCheckingExisting, setIsCheckingExisting] = useState(false);
  const [existingInLikedNames, setExistingInLikedNames] = useState<Set<string>>(
    () => new Set()
  );
  const [cachedLikedFolderId, setCachedLikedFolderId] = useState<string | null>(
    null
  );
  const [isProcessing, setIsProcessing] = useState(false);
  const [isExportingReadOnly, setIsExportingReadOnly] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<{
    processedCount: number;
    skippedCount: number;
    failed: { file: DrivePhotoFile; error: string }[];
  } | null>(null);

  const sourceKind =
    folder?.sourceKind || pickedFiles[0]?.sourceKind || 'drive';
  const capabilities = folder?.capabilities;
  const isDrive = sourceKind === 'drive';
  const isReadOnlyLocal =
    !isDrive &&
    (sourceKind === 'local-file' || Boolean(capabilities?.isReadOnlyFallback));
  const isAndroidSaf = sourceKind === 'android-saf';

  // Format counts & smart labels across all picked files
  const { standardFiles, rawFiles, jpgLabel, rawLabel } = useMemo(() => {
    const std: DrivePhotoFile[] = [];
    const raw: DrivePhotoFile[] = [];
    for (const f of pickedFiles) {
      if (f.isRaw) raw.push(f);
      else std.push(f);
    }
    const allStdAreJpg =
      std.length === 0 ||
      std.every(
        (f) => f.fileExtension === 'jpg' || f.fileExtension === 'jpeg'
      );
    const hasCr3 = raw.some((f) => f.fileExtension === 'cr3');
    const allRawAreCr3 =
      raw.length > 0 && raw.every((f) => f.fileExtension === 'cr3');

    return {
      standardFiles: std,
      rawFiles: raw,
      jpgLabel: allStdAreJpg ? 'Jen JPG' : 'Jen JPG / foto',
      rawLabel: allRawAreCr3
        ? 'Jen CR3'
        : hasCr3
          ? 'Jen CR3 / RAW'
          : 'Jen RAW',
    };
  }, [pickedFiles]);

  // Reset modal & immediately scan real `Liked` subfolder for existing files
  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    setExportFormat('all');
    setTransferMode('copy');
    setVisibleLimit(100);
    setIsProcessing(false);
    setIsExportingReadOnly(false);
    setExportNote(null);
    setPermissionError(null);
    setProgress({ done: 0, total: 0 });
    setSummary(null);
    setCachedLikedFolderId(null);

    const checkExisting = async () => {
      setIsCheckingExisting(true);
      let existingNames = new Set<string>();
      let likedId: string | null = null;

      try {
        if (isDrive && accessToken && folder?.id) {
          const likedSub = await findDriveSubfolder(
            accessToken,
            folder.id,
            LIKED_SUBFOLDER_NAME
          );
          if (likedSub?.id) {
            likedId = likedSub.id;
            existingNames = await listDriveFolderFileNames(
              accessToken,
              likedSub.id
            );
          }
        } else if (
          isAndroidSaf &&
          folder?.id &&
          window.FrameCullNative?.listSubfolderFileNames
        ) {
          const nativeNames =
            await window.FrameCullNative.listSubfolderFileNames(
              folder.id,
              LIKED_SUBFOLDER_NAME
            );
          existingNames = new Set(
            nativeNames
              .filter((n) => typeof n === 'string' && n.trim().length > 0)
              .map((n) => normalizeFileNameKey(n))
          );
          for (const hist of loadExportedNamesHistory(folder.id)) {
            existingNames.add(hist);
          }
        } else {
          existingNames = loadExportedNamesHistory(folder?.id);
        }
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          if (!cancelled) onAuthExpired();
          return;
        }
      }

      if (cancelled) return;

      // Also detect duplicate filenames within pickedFiles themselves (e.g. from two subfolders)
      const seenInPicked = new Set<string>(existingNames);
      const initialSelected = new Set<string>();
      for (const f of pickedFiles) {
        const key = normalizeFileNameKey(f.name);
        if (!existingNames.has(key) && !seenInPicked.has(key)) {
          initialSelected.add(f.id);
          seenInPicked.add(key);
        }
      }

      setCachedLikedFolderId(likedId);
      setExistingInLikedNames(existingNames);
      setSelectedIds(initialSelected);
      setIsCheckingExisting(false);
    };

    void checkExisting();

    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    pickedFiles,
    isDrive,
    isAndroidSaf,
    accessToken,
    folder?.id,
    onAuthExpired,
  ]);

  // Apply chosen format filter (`Vše` / `Jen JPG` / `Jen CR3`)
  const filteredFiles = useMemo(() => {
    if (exportFormat === 'jpg') return standardFiles;
    if (exportFormat === 'raw') return rawFiles;
    return pickedFiles;
  }, [exportFormat, pickedFiles, standardFiles, rawFiles]);

  // Detect files already in `Liked` (or repeated filename earlier in the same export batch)
  const { exportableFilteredFiles, alreadyInLikedFilteredIds, duplicateNameFilteredIds } =
    useMemo(() => {
      const exportable: DrivePhotoFile[] = [];
      const inLikedIds = new Set<string>();
      const dupNameIds = new Set<string>();
      const seenNames = new Set<string>();

      for (const f of filteredFiles) {
        const key = normalizeFileNameKey(f.name);
        if (existingInLikedNames.has(key)) {
          inLikedIds.add(f.id);
        } else if (seenNames.has(key)) {
          dupNameIds.add(f.id);
        } else {
          seenNames.add(key);
          exportable.push(f);
        }
      }
      return {
        exportableFilteredFiles: exportable,
        alreadyInLikedFilteredIds: inLikedIds,
        duplicateNameFilteredIds: dupNameIds,
      };
    }, [filteredFiles, existingInLikedNames]);

  if (!isOpen) return null;

  const selectedFiles = exportableFilteredFiles.filter((f) =>
    selectedIds.has(f.id)
  );
  const rawSelectedCount = selectedFiles.filter((f) => f.isRaw).length;
  const totalBytes = selectedFiles.reduce(
    (acc, f) => acc + (f.sizeBytes || 0),
    0
  );
  const visibleFiles = filteredFiles.slice(0, visibleLimit);
  const remainingHidden = Math.max(0, filteredFiles.length - visibleLimit);
  const skippedExistingCount = alreadyInLikedFilteredIds.size;

  const toggleFile = (id: string) => {
    if (isProcessing || isCheckingExisting) return;
    if (alreadyInLikedFilteredIds.has(id) || duplicateNameFilteredIds.has(id)) {
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allExportableSelected =
    exportableFilteredFiles.length > 0 &&
    exportableFilteredFiles.every((f) => selectedIds.has(f.id));

  const handleToggleSelectAllInView = () => {
    if (isProcessing || isCheckingExisting) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allExportableSelected) {
        for (const f of exportableFilteredFiles) {
          next.delete(f.id);
        }
      } else {
        for (const f of exportableFilteredFiles) {
          next.add(f.id);
        }
      }
      return next;
    });
  };

  const handleConfirmExportToLiked = async () => {
    if (selectedFiles.length === 0 || isProcessing || isCheckingExisting) return;

    triggerHaptic('selection');
    setPermissionError(null);

    if (isReadOnlyLocal) {
      await handleExportReadOnlyFiles();
      return;
    }

    setIsProcessing(true);
    setProgress({ done: 0, total: selectedFiles.length });

    const processedIds: string[] = [];
    const newlyExportedNames: string[] = [];
    const failedItems: { file: DrivePhotoFile; error: string }[] = [];
    let skippedRuntimeCount = 0;

    if (isAndroidSaf && window.FrameCullNative) {
      try {
        const uriToFile = new Map<string, DrivePhotoFile>();
        const uris: string[] = [];
        for (const f of selectedFiles) {
          if (f.nativeUri) {
            uriToFile.set(f.nativeUri, f);
            uris.push(f.nativeUri);
          } else {
            failedItems.push({ file: f, error: 'Chybí Android SAF URI.' });
          }
        }

        const nativeOp =
          transferMode === 'move'
            ? window.FrameCullNative.moveToSubfolder
            : window.FrameCullNative.copyToSubfolder;

        if (!nativeOp) {
          throw new Error(
            'Nativní Android obal v této verzi nepodporuje zápis do podsložky Liked.'
          );
        }

        const result = await nativeOp(
          folder?.id || '',
          LIKED_SUBFOLDER_NAME,
          uris
        );
        for (const uri of result.succeeded) {
          const matched = uriToFile.get(uri);
          if (matched) {
            processedIds.push(matched.id);
            newlyExportedNames.push(matched.name);
          }
        }
        for (const fail of result.failed) {
          const matched = uriToFile.get(fail.uri);
          if (matched) {
            failedItems.push({ file: matched, error: fail.error });
          }
        }
        if (newlyExportedNames.length > 0) {
          saveExportedNamesHistory(folder?.id, newlyExportedNames);
        }
        setProgress({ done: selectedFiles.length, total: selectedFiles.length });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Chyba při zápisu do podsložky Liked na zařízení.';
        for (const f of selectedFiles) {
          if (!processedIds.includes(f.id)) {
            failedItems.push({ file: f, error: msg });
          }
        }
      }
    } else {
      // Google Drive API
      if (!accessToken || !folder) {
        onAuthExpired();
        setIsProcessing(false);
        return;
      }

      try {
        const likedFolder = cachedLikedFolderId
          ? { id: cachedLikedFolderId, name: LIKED_SUBFOLDER_NAME }
          : await findOrCreateDriveSubfolder(
              accessToken,
              folder.id,
              LIKED_SUBFOLDER_NAME
            );

        // Refresh live existing names from Drive if Liked already existed and wasn't scanned yet
        const liveExistingNames = new Set(existingInLikedNames);
        if (!cachedLikedFolderId && likedFolder.id) {
          const freshNames = await listDriveFolderFileNames(
            accessToken,
            likedFolder.id
          );
          for (const n of freshNames) liveExistingNames.add(n);
        }

        const batchSize = 4;
        for (let i = 0; i < selectedFiles.length; i += batchSize) {
          const batch = selectedFiles.slice(i, i + batchSize);
          await Promise.all(
            batch.map(async (file) => {
              const nameKey = normalizeFileNameKey(file.name);
              if (liveExistingNames.has(nameKey)) {
                skippedRuntimeCount++;
                setProgress((p) => ({ ...p, done: p.done + 1 }));
                return;
              }
              liveExistingNames.add(nameKey);

              try {
                if (transferMode === 'move') {
                  const sourceParentId = file.parents?.[0] || folder.id;
                  await moveDriveFileToFolder(
                    accessToken,
                    file.id,
                    sourceParentId,
                    likedFolder.id
                  );
                } else {
                  await copyDriveFileToFolder(
                    accessToken,
                    file.id,
                    likedFolder.id,
                    file.name
                  );
                }
                processedIds.push(file.id);
                newlyExportedNames.push(file.name);
              } catch (err: unknown) {
                liveExistingNames.delete(nameKey);
                if (err instanceof AuthExpiredError) {
                  onAuthExpired();
                  return;
                }
                failedItems.push({
                  file,
                  error: err instanceof Error ? err.message : 'Neznámá chyba',
                });
              } finally {
                setProgress((p) => ({ ...p, done: p.done + 1 }));
              }
            })
          );
        }
      } catch (err: unknown) {
        if (err instanceof AuthExpiredError) {
          onAuthExpired();
          setIsProcessing(false);
          return;
        }
        const msg =
          err instanceof Error
            ? err.message
            : 'Nepodařilo se vytvořit složku Liked na Google Drive.';
        for (const f of selectedFiles) {
          if (!processedIds.includes(f.id)) {
            failedItems.push({ file: f, error: msg });
          }
        }
      }
    }

    if (newlyExportedNames.length > 0) {
      setExistingInLikedNames((prev) => {
        const next = new Set(prev);
        for (const n of newlyExportedNames) {
          next.add(normalizeFileNameKey(n));
        }
        return next;
      });
    }

    setIsProcessing(false);
    triggerHaptic('confirm');

    const count = processedIds.length;
    const totalSkipped = skippedExistingCount + skippedRuntimeCount;
    const noun = count === 1 ? 'soubor' : count < 5 ? 'soubory' : 'souborů';
    const actionWord =
      transferMode === 'move' ? 'Přesunuto' : 'Zkopírováno';
    const whereWord = isDrive ? 'na Google Drive ' : '';
    const formatNote =
      exportFormat === 'jpg'
        ? ` (${jpgLabel.toLowerCase()})`
        : exportFormat === 'raw'
          ? ` (${rawLabel.toLowerCase()})`
          : '';
    const skipNote =
      totalSkipped > 0
        ? ` · ${totalSkipped.toLocaleString('cs-CZ')} již v „${LIKED_SUBFOLDER_NAME}“ přeskočeno`
        : '';

    const customMsg =
      count > 0
        ? `${actionWord} do podsložky „${LIKED_SUBFOLDER_NAME}“ ${whereWord}${formatNote}: ${count.toLocaleString('cs-CZ')} ${noun}${skipNote}.`
        : totalSkipped > 0
          ? `Všechny vybrané soubory (${totalSkipped.toLocaleString('cs-CZ')}) už ve složce „${LIKED_SUBFOLDER_NAME}“ jsou — nic nebylo duplikováno.`
          : undefined;

    if (failedItems.length === 0) {
      onComplete(processedIds, transferMode, [], customMsg);
    } else {
      setSummary({
        processedCount: count,
        skippedCount: totalSkipped,
        failed: failedItems,
      });
      onComplete(processedIds, transferMode, failedItems, customMsg);
    }
  };

  const handleDownloadList = () => {
    const safeName = (folder?.name || 'selectra').replace(
      /[^a-zA-Z0-9_-]+/g,
      '_'
    );
    downloadTextFile(
      `${safeName}_liked.txt`,
      buildLikedListText(selectedFiles)
    );
    setExportNote('Seznam vybraných souborů (.txt) byl stažen.');
  };

  const handleExportReadOnlyFiles = async () => {
    if (selectedFiles.length === 0 || isExportingReadOnly) return;
    setIsExportingReadOnly(true);
    setExportNote(null);
    try {
      const res = await exportPickedLocalPhotos(selectedFiles);
      if (res.count > 0) {
        saveExportedNamesHistory(
          folder?.id,
          selectedFiles.map((f) => f.name)
        );
        const msg =
          res.method === 'share'
            ? `Sdíleno ${res.count.toLocaleString('cs-CZ')} vybraných souborů.`
            : `Staženo ${res.count.toLocaleString('cs-CZ')} vybraných souborů.`;
        setExportNote(msg);
        onComplete(
          selectedFiles.map((f) => f.id),
          'copy',
          [],
          msg
        );
      }
    } catch (err: unknown) {
      setExportNote(
        err instanceof Error
          ? err.message
          : 'Export vybraných snímků se nezdařil.'
      );
    } finally {
      setIsExportingReadOnly(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-2.5 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="finish-modal-title"
    >
      <div className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-[#141417] shadow-2xl overflow-hidden flex flex-col max-h-[92dvh]">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3.5 sm:py-5 border-b border-zinc-800">
          <div className="flex items-start gap-3 min-w-0">
            <div className="flex h-9 w-9 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
              <Star className="w-4 h-4 sm:w-5 sm:h-5 fill-amber-400" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2
                id="finish-modal-title"
                className="font-display text-base sm:text-lg font-semibold text-zinc-100 truncate"
              >
                Dokončit výběr — „{LIKED_SUBFOLDER_NAME}“
              </h2>
              <p className="mt-0.5 text-xs sm:text-sm text-zinc-400 tabular-nums">
                Vybráno {pickedShotCount.toLocaleString('cs-CZ')}{' '}
                {pickedShotCount === 1
                  ? 'snímek'
                  : pickedShotCount < 5
                    ? 'snímky'
                    : 'snímků'}{' '}
                · ke zkopírování{' '}
                <strong className="text-zinc-200 font-semibold">
                  {selectedFiles.length.toLocaleString('cs-CZ')}
                </strong>{' '}
                {selectedFiles.length === 1
                  ? 'soubor'
                  : selectedFiles.length < 5
                    ? 'soubory'
                    : 'souborů'}
                {rawSelectedCount > 0 && exportFormat === 'all'
                  ? ' (vč. RAW)'
                  : ''}{' '}
                · {formatBytes(totalBytes)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isProcessing}
            className="min-h-[38px] min-w-[38px] sm:min-h-[40px] sm:min-w-[40px] inline-flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-40 shrink-0"
            aria-label="Zavřít dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-4 flex-1">
          {isStillLoadingFolder && (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
              <span>
                Složka se stále načítá na pozadí. Tento export obsahuje zatím
                vybrané snímky.
              </span>
            </div>
          )}

          {permissionError && (
            <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <span>{permissionError}</span>
            </div>
          )}

          {/* Export Format Filter: Vše (JPG + RAW) / Jen JPG / Jen CR3 (RAW) */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-zinc-400">
              Formát pro export do „{LIKED_SUBFOLDER_NAME}“
            </p>
            <div
              className="grid grid-cols-3 gap-1.5 p-1 rounded-xl border border-zinc-800 bg-[#09090B]"
              role="group"
              aria-label="Vyberte formát souborů pro export"
            >
              <button
                type="button"
                disabled={isProcessing || pickedFiles.length === 0}
                onClick={() => setExportFormat('all')}
                aria-pressed={exportFormat === 'all'}
                className={`min-h-[38px] px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap tabular-nums disabled:opacity-40 disabled:cursor-not-allowed ${
                  exportFormat === 'all'
                    ? 'bg-amber-500 text-zinc-950'
                    : 'text-zinc-300 hover:text-white hover:bg-zinc-900'
                }`}
              >
                Vše ({pickedFiles.length})
              </button>

              <button
                type="button"
                disabled={isProcessing || standardFiles.length === 0}
                onClick={() => setExportFormat('jpg')}
                aria-pressed={exportFormat === 'jpg'}
                className={`min-h-[38px] px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap tabular-nums disabled:opacity-40 disabled:cursor-not-allowed ${
                  exportFormat === 'jpg'
                    ? 'bg-amber-500 text-zinc-950'
                    : 'text-zinc-300 hover:text-white hover:bg-zinc-900'
                }`}
              >
                {jpgLabel} ({standardFiles.length})
              </button>

              <button
                type="button"
                disabled={isProcessing || rawFiles.length === 0}
                onClick={() => setExportFormat('raw')}
                aria-pressed={exportFormat === 'raw'}
                className={`min-h-[38px] px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap tabular-nums disabled:opacity-40 disabled:cursor-not-allowed ${
                  exportFormat === 'raw'
                    ? 'bg-amber-500 text-zinc-950'
                    : 'text-zinc-300 hover:text-white hover:bg-zinc-900'
                }`}
              >
                {rawLabel} ({rawFiles.length})
              </button>
            </div>
          </div>

          {/* Transfer Mode Selector (Copy vs Move) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3">
            <button
              type="button"
              disabled={isProcessing}
              onClick={() => setTransferMode('copy')}
              className={`text-left p-3 sm:p-3.5 rounded-xl border transition-colors cursor-pointer ${
                transferMode === 'copy'
                  ? 'border-amber-500/70 bg-amber-500/10'
                  : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
              }`}
            >
              <p className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Copy className="w-4 h-4 text-amber-400 shrink-0" />
                <span>Zkopírovat do „{LIKED_SUBFOLDER_NAME}“</span>
              </p>
              <p className="mt-1 text-xs text-zinc-400">
                Přidá jen soubory, které v „{LIKED_SUBFOLDER_NAME}“ ještě nejsou.
                Původní složka zůstane kompletní.
              </p>
            </button>

            <button
              type="button"
              disabled={isProcessing}
              onClick={() => setTransferMode('move')}
              className={`text-left p-3 sm:p-3.5 rounded-xl border transition-colors cursor-pointer ${
                transferMode === 'move'
                  ? 'border-amber-500/70 bg-amber-500/10'
                  : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
              }`}
            >
              <p className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <FolderInput className="w-4 h-4 text-amber-400 shrink-0" />
                <span>Přesunout do „{LIKED_SUBFOLDER_NAME}“</span>
              </p>
              <p className="mt-1 text-xs text-zinc-400">
                {isDrive
                  ? `Bleskový přesun na Google Drive (bez duplikátů) do podsložky „${LIKED_SUBFOLDER_NAME}“.`
                  : `Přesune vybrané soubory přímo do „${LIKED_SUBFOLDER_NAME}“ bez duplikování místa.`}
              </p>
            </button>
          </div>

          {/* Duplicate Check Status Banner */}
          {isCheckingExisting ? (
            <div className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-[#09090B] px-3.5 py-2.5 text-xs text-zinc-300">
              <Loader2 className="w-4 h-4 text-amber-400 animate-spin shrink-0" />
              <span>
                Kontroluji složku „{LIKED_SUBFOLDER_NAME}“, abych přeskočil už
                zkopírované fotky…
              </span>
            </div>
          ) : (
            skippedExistingCount > 0 && (
              <div className="flex items-start gap-2.5 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-200 tabular-nums">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>
                  {exportableFilteredFiles.length === 0
                    ? `Všech ${skippedExistingCount.toLocaleString('cs-CZ')} souborů v tomto filtru už ve složce „${LIKED_SUBFOLDER_NAME}“ je — nic se nebude duplikovat.`
                    : `${skippedExistingCount.toLocaleString('cs-CZ')} ${
                        skippedExistingCount === 1
                          ? 'soubor už ve složce „Liked“ je'
                          : skippedExistingCount < 5
                            ? 'soubory už ve složce „Liked“ jsou'
                            : 'souborů už ve složce „Liked“ je'
                      } — byly automaticky odznačeny, aby nevznikly duplicity.`}
                </span>
              </div>
            )
          )}

          {isReadOnlyLocal && (
            <div className="space-y-3">
              <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200 leading-relaxed">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                <span>
                  U jednotlivě vybraných fotografií bez přístupu ke složce nelze
                  podsložku „{LIKED_SUBFOLDER_NAME}“ vytvořit přímo. Vybrané
                  fotky můžete rovnou exportovat / sdílet, nebo stáhnout jejich
                  seznam (.txt).
                </span>
              </div>

              <div className="flex">
                <button
                  type="button"
                  onClick={handleDownloadList}
                  disabled={selectedFiles.length === 0}
                  className="w-full min-h-[42px] flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-xs font-medium text-zinc-100 hover:border-amber-500/60 transition-colors cursor-pointer disabled:opacity-40"
                >
                  <FileText className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>Stáhnout seznam (.txt)</span>
                </button>
              </div>

              {exportNote && (
                <p className="text-xs text-emerald-300">{exportNote}</p>
              )}
            </div>
          )}

          {/* File checklist */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-zinc-400 tabular-nums">
                Soubory pro „{LIKED_SUBFOLDER_NAME}“ ({selectedFiles.length}/
                {exportableFilteredFiles.length} nových)
              </p>
              {exportableFilteredFiles.length > 0 && (
                <button
                  type="button"
                  disabled={isProcessing || isCheckingExisting}
                  onClick={handleToggleSelectAllInView}
                  className="text-xs text-amber-400 hover:text-amber-300 cursor-pointer disabled:opacity-40"
                >
                  {allExportableSelected
                    ? 'Odznačit nové'
                    : `Vybrat vše (${exportableFilteredFiles.length})`}
                </button>
              )}
            </div>

            <div className="rounded-xl border border-zinc-800 bg-[#09090B] max-h-60 overflow-y-auto">
              <ul className="divide-y divide-zinc-800/80">
                {visibleFiles.map((file) => {
                  const alreadyInLiked = alreadyInLikedFilteredIds.has(file.id);
                  const isDupName = duplicateNameFilteredIds.has(file.id);
                  const blocked = alreadyInLiked || isDupName;
                  const checked = !blocked && selectedIds.has(file.id);
                  const thumb =
                    thumbnails[file.id] ||
                    getFastPreviewThumbnailUrl(file.thumbnailLink);

                  return (
                    <li key={file.id}>
                      <label
                        className={`flex items-center gap-3 px-3 sm:px-3.5 py-2.5 transition-colors ${
                          blocked
                            ? 'opacity-55 cursor-not-allowed bg-zinc-950/60'
                            : 'cursor-pointer hover:bg-zinc-900/70'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={isProcessing || isCheckingExisting || blocked}
                          onChange={() => toggleFile(file.id)}
                          className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 accent-amber-500 cursor-pointer disabled:cursor-not-allowed"
                        />
                        <div className="h-10 w-12 shrink-0 overflow-hidden rounded-md bg-zinc-900 border border-zinc-800 flex items-center justify-center">
                          {thumb ? (
                            <img
                              src={thumb}
                              alt={file.name}
                              referrerPolicy="no-referrer"
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <ImageIcon className="w-4 h-4 text-zinc-600" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-zinc-200 truncate">
                            {file.relativePath || file.name}
                          </p>
                          <p className="font-mono text-[11px] text-zinc-500 tabular-nums flex flex-wrap items-center gap-x-1.5">
                            <span>
                              {file.fileExtension.toUpperCase()} ·{' '}
                              {formatBytes(file.sizeBytes)}
                            </span>
                            {alreadyInLiked && (
                              <span className="inline-flex items-center gap-1 font-sans text-emerald-400 font-medium">
                                <Check className="w-3 h-3" aria-hidden="true" />
                                Už v „{LIKED_SUBFOLDER_NAME}“ · přeskočí se
                              </span>
                            )}
                            {!alreadyInLiked && isDupName && (
                              <span className="font-sans text-amber-400 font-medium">
                                · Stejný název už v exportu · přeskočí se
                              </span>
                            )}
                          </p>
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {remainingHidden > 0 && (
                <div className="p-3 border-t border-zinc-800/80 text-center">
                  <button
                    type="button"
                    onClick={() => setVisibleLimit((v) => v + 150)}
                    className="text-xs font-medium text-amber-400 hover:text-amber-300 cursor-pointer tabular-nums"
                  >
                    Zobrazit dalších {Math.min(150, remainingHidden)} (zbývá{' '}
                    {remainingHidden.toLocaleString('cs-CZ')})
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Progress or Error Summary */}
          {isProcessing && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-zinc-300 tabular-nums">
                <span>
                  {transferMode === 'move'
                    ? `Přesouvám soubory do „${LIKED_SUBFOLDER_NAME}“…`
                    : `Kopíruji soubory do „${LIKED_SUBFOLDER_NAME}“…`}
                </span>
                <span>
                  {progress.done.toLocaleString('cs-CZ')} /{' '}
                  {progress.total.toLocaleString('cs-CZ')}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full bg-amber-500 transition-all duration-200"
                  style={{
                    width: `${
                      progress.total > 0
                        ? Math.round((progress.done / progress.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
          )}

          {summary && summary.failed.length > 0 && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3.5 text-xs text-rose-200 space-y-1">
              <p className="font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                Uloženo {summary.processedCount} souborů
                {summary.skippedCount > 0
                  ? ` (${summary.skippedCount} přeskočeno)`
                  : ''}
                , u {summary.failed.length} nastala chyba:
              </p>
              <ul className="list-disc pl-5 text-rose-300 max-h-28 overflow-y-auto">
                {summary.failed.slice(0, 20).map((item) => (
                  <li key={item.file.id}>
                    {item.file.name}: {item.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 sm:gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t border-zinc-800 bg-[#0D0D10]">
          <button
            type="button"
            onClick={onCancel}
            disabled={isProcessing || isExportingReadOnly}
            className="min-h-[42px] px-4 py-2 text-sm font-medium rounded-lg border border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-40"
          >
            Zavřít
          </button>
          <button
            type="button"
            onClick={() => void handleConfirmExportToLiked()}
            disabled={
              isCheckingExisting ||
              selectedFiles.length === 0 ||
              isProcessing ||
              isExportingReadOnly
            }
            className="min-h-[42px] inline-flex items-center gap-2 px-4 sm:px-5 py-2 text-xs sm:text-sm font-semibold rounded-lg bg-amber-500 text-zinc-950 hover:bg-amber-400 transition-colors cursor-pointer disabled:opacity-40 tabular-nums"
          >
            {isReadOnlyLocal ? (
              <>
                <Share2 className="w-4 h-4 shrink-0" />
                <span>
                  {isExportingReadOnly
                    ? 'Exportuji…'
                    : `Exportovat / sdílet (${selectedFiles.length.toLocaleString('cs-CZ')})`}
                </span>
              </>
            ) : isProcessing ? (
              <>
                <FolderPlus className="w-4 h-4 shrink-0" />
                <span>
                  Zpracovávám ({progress.done}/{progress.total})…
                </span>
              </>
            ) : transferMode === 'move' ? (
              <>
                <FolderInput className="w-4 h-4 shrink-0" />
                <span>
                  Přesunout do „{LIKED_SUBFOLDER_NAME}“ (
                  {selectedFiles.length.toLocaleString('cs-CZ')})
                </span>
              </>
            ) : (
              <>
                <FolderPlus className="w-4 h-4 shrink-0" />
                <span>
                  Zkopírovat do „{LIKED_SUBFOLDER_NAME}“ (
                  {selectedFiles.length.toLocaleString('cs-CZ')})
                </span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

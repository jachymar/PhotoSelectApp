import React, { useEffect, useState } from 'react';
import {
  Trash2,
  X,
  AlertTriangle,
  CheckCircle2,
  Image as ImageIcon,
  FileText,
  FolderInput,
} from 'lucide-react';
import {
  AuthExpiredError,
  DriveFolder,
  DrivePhotoFile,
  deleteDriveFilePermanently,
  formatBytes,
  trashDriveFile,
} from '../lib/driveApi';
import {
  TRASH_SUBFOLDER_NAME,
  buildLikedListText,
  downloadTextFile,
} from '../lib/localMedia';
import { getFastPreviewThumbnailUrl } from '../lib/rawParser';
import { triggerHaptic } from '../lib/haptics';
import { useI18n } from '../lib/i18n';

export type TrashExecutionMode = 'trash' | 'permanent';

interface FinishTrashModalProps {
  isOpen: boolean;
  folder?: DriveFolder | null;
  trashFiles: DrivePhotoFile[];
  trashShotCount: number;
  thumbnails: Record<string, string>;
  accessToken?: string | null;
  isStillLoadingFolder?: boolean;
  onCancel: () => void;
  onAuthExpired: () => void;
  onComplete: (
    processedIds: string[],
    mode: TrashExecutionMode,
    failedItems: { file: DrivePhotoFile; error: string }[],
    customMessage?: string
  ) => void;
}

export const FinishTrashModal: React.FC<FinishTrashModalProps> = ({
  isOpen,
  folder,
  trashFiles,
  trashShotCount,
  thumbnails,
  accessToken,
  isStillLoadingFolder = false,
  onCancel,
  onAuthExpired,
  onComplete,
}) => {
  const { t, formatNumber, plural } = useI18n();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteMode, setDeleteMode] = useState<TrashExecutionMode>('trash');
  const [confirmPermanent, setConfirmPermanent] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(100);
  const [isProcessing, setIsProcessing] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<{
    processedCount: number;
    failed: { file: DrivePhotoFile; error: string }[];
  } | null>(null);

  const sourceKind =
    folder?.sourceKind || trashFiles[0]?.sourceKind || 'drive';
  const capabilities = folder?.capabilities;
  const isDrive = sourceKind === 'drive';
  const isReadOnlyLocal =
    !isDrive &&
    (sourceKind === 'local-file' || Boolean(capabilities?.isReadOnlyFallback));
  const isAndroidSaf = sourceKind === 'android-saf';

  useEffect(() => {
    if (isOpen) {
      setSelectedIds(new Set(trashFiles.map((f) => f.id)));
      setDeleteMode('trash');
      setConfirmPermanent(false);
      setVisibleLimit(100);
      setIsProcessing(false);
      setExportNote(null);
      setPermissionError(null);
      setProgress({ done: 0, total: 0 });
      setSummary(null);
    }
  }, [isOpen, trashFiles]);

  if (!isOpen) return null;

  const selectedFiles = trashFiles.filter((f) => selectedIds.has(f.id));
  const rawFilesCount = selectedFiles.filter((f) => f.isRaw).length;
  const totalBytes = selectedFiles.reduce(
    (acc, f) => acc + (f.sizeBytes || 0),
    0
  );
  const visibleFiles = trashFiles.slice(0, visibleLimit);
  const remainingHidden = Math.max(0, trashFiles.length - visibleLimit);

  const toggleFile = (id: string) => {
    if (isProcessing) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDownloadList = () => {
    downloadTextFile(
      t('selectra-smazat-seznam.txt', 'selectra-delete-list.txt'),
      buildLikedListText(selectedFiles)
    );
    setExportNote(
      t(
        'Stažen textový seznam souborů určených ke smazání.',
        'Downloaded a text list of files marked for deletion.'
      )
    );
  };

  const handleConfirmDelete = async () => {
    if (selectedFiles.length === 0 || isProcessing) return;
    if (deleteMode === 'permanent' && !confirmPermanent) return;

    triggerHaptic(deleteMode === 'permanent' ? 'warning' : 'trash');
    setPermissionError(null);
    setIsProcessing(true);
    setProgress({ done: 0, total: selectedFiles.length });

    const processedIds: string[] = [];
    const failedItems: { file: DrivePhotoFile; error: string }[] = [];

    if (isAndroidSaf && window.FrameCullNative) {
      try {
        const uriToFile = new Map<string, DrivePhotoFile>();
        const uris: string[] = [];
        for (const f of selectedFiles) {
          if (f.nativeUri) {
            uriToFile.set(f.nativeUri, f);
            uris.push(f.nativeUri);
          } else {
            failedItems.push({
              file: f,
              error: t('Chybí Android SAF URI.', 'Missing Android SAF URI.'),
            });
          }
        }

        const nativeOp =
          deleteMode === 'permanent'
            ? window.FrameCullNative.deleteFilesPermanently
            : (fileUris: string[]) =>
                window.FrameCullNative!.moveToSubfolderTrash(
                  folder?.id || '',
                  fileUris
                );

        if (!nativeOp) {
          throw new Error(
            t(
              'Nativní Android obal v této verzi nepodporuje tuto operaci mazání.',
              'This native Android build does not support this delete action.'
            )
          );
        }

        const result = await nativeOp(uris);
        for (const uri of result.succeeded) {
          const matched = uriToFile.get(uri);
          if (matched) processedIds.push(matched.id);
        }
        for (const fail of result.failed) {
          const matched = uriToFile.get(fail.uri);
          if (matched) {
            failedItems.push({ file: matched, error: fail.error });
          }
        }
        setProgress({ done: selectedFiles.length, total: selectedFiles.length });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? err.message
            : t(
                'Chyba při odstraňování souborů ze zařízení.',
                'Failed to delete files from device.'
              );
        for (const f of selectedFiles) {
          if (!processedIds.includes(f.id)) {
            failedItems.push({ file: f, error: msg });
          }
        }
      }
    } else {
      // Google Drive API
      if (!accessToken) {
        onAuthExpired();
        setIsProcessing(false);
        return;
      }

      const batchSize = 4;
      for (let i = 0; i < selectedFiles.length; i += batchSize) {
        const batch = selectedFiles.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (file) => {
            try {
              if (deleteMode === 'permanent') {
                await deleteDriveFilePermanently(accessToken, file.id);
              } else {
                await trashDriveFile(accessToken, file.id);
              }
              processedIds.push(file.id);
            } catch (err: unknown) {
              if (err instanceof AuthExpiredError) {
                throw err;
              }
              failedItems.push({
                file,
                error:
                  err instanceof Error
                    ? err.message
                    : t(
                        'Nepodařilo se odstranit soubor z Google Drive.',
                        'Could not delete file from Google Drive.'
                      ),
              });
            } finally {
              setProgress((p) => ({ ...p, done: p.done + 1 }));
            }
          })
        ).catch((err) => {
          if (err instanceof AuthExpiredError) {
            onAuthExpired();
          }
        });
      }
    }

    setIsProcessing(false);
    setSummary({
      processedCount: processedIds.length,
      failed: failedItems,
    });

    const freedBytes = selectedFiles
      .filter((f) => processedIds.includes(f.id))
      .reduce((acc, f) => acc + (f.sizeBytes || 0), 0);

    const processedFilesLabel = `${formatNumber(processedIds.length)} ${plural(
      processedIds.length,
      ['soubor', 'soubory', 'souborů'],
      ['file', 'files']
    )}`;
    const customMsg =
      processedIds.length > 0
        ? deleteMode === 'permanent'
          ? t(
              `Trvale smazáno: ${processedFilesLabel} (uvolněno ${formatBytes(freedBytes)}).`,
              `Permanently deleted: ${processedFilesLabel} (freed ${formatBytes(freedBytes)}).`
            )
          : isDrive
            ? t(
                `Přesunuto do koše Google Drive: ${processedFilesLabel} (uvolněno ${formatBytes(freedBytes)}).`,
                `Moved to Google Drive Trash: ${processedFilesLabel} (freed ${formatBytes(freedBytes)}).`
              )
            : t(
                `Přesunuto do podsložky „${TRASH_SUBFOLDER_NAME}“: ${processedFilesLabel} (${formatBytes(freedBytes)}).`,
                `Moved to "${TRASH_SUBFOLDER_NAME}" subfolder: ${processedFilesLabel} (${formatBytes(freedBytes)}).`
              )
        : undefined;

    if (failedItems.length === 0 && processedIds.length > 0) {
      onComplete(processedIds, deleteMode, [], customMsg);
    } else if (processedIds.length > 0) {
      onComplete(processedIds, deleteMode, failedItems, customMsg);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="finish-trash-title"
    >
      <div className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-[#141417] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-5 border-b border-zinc-800 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-500/15 text-rose-400">
              <Trash2 className="w-5 h-5" />
            </div>
            <div>
              <h2
                id="finish-trash-title"
                className="font-display text-lg font-bold text-zinc-100"
              >
                {isReadOnlyLocal
                  ? t(
                      `Úklid vyřazených souborů (${formatNumber(selectedFiles.length)})`,
                      `Clean up rejected files (${formatNumber(selectedFiles.length)})`
                    )
                  : t(
                      `Smazat vyřazené snímky (${formatNumber(selectedFiles.length)} ${plural(selectedFiles.length, ['soubor', 'soubory', 'souborů'], ['file', 'files'])})`,
                      `Delete marked photos (${formatNumber(selectedFiles.length)} ${plural(selectedFiles.length, ['soubor', 'soubory', 'souborů'], ['file', 'files'])})`
                    )}
              </h2>
              <p className="mt-1 text-xs text-zinc-400 tabular-nums">
                {formatNumber(trashShotCount)}{' '}
                {plural(
                  trashShotCount,
                  ['označený snímek', 'označené snímky', 'označených snímků'],
                  ['marked shot', 'marked shots']
                )}
                {rawFilesCount > 0
                  ? t(
                      ` · z toho ${rawFilesCount} RAWů`,
                      ` · incl. ${rawFilesCount} RAW`
                    )
                  : ''}{' '}
                · {t('uvolní se', 'frees')} {formatBytes(totalBytes)}
              </p>
            </div>
          </div>
          {!isProcessing && (
            <button
              type="button"
              onClick={onCancel}
              aria-label={t('Zavřít', 'Close')}
              className="rounded-lg p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {isStillLoadingFolder && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200 leading-relaxed">
              {t(
                'Složka se stále načítá na pozadí — ve frontě jsou zatím označené snímky z dosud načtených fotografií.',
                'This folder is still loading in the background — the queue currently includes shots marked so far.'
              )}
            </div>
          )}

          {permissionError && (
            <div
              role="alert"
              className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200 leading-relaxed"
            >
              {permissionError}
            </div>
          )}

          {/* Mode Selection: Safe Trash vs Permanent Delete */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button
              type="button"
              disabled={isProcessing}
              onClick={() => {
                setDeleteMode('trash');
                setConfirmPermanent(false);
              }}
              className={`flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors cursor-pointer ${
                deleteMode === 'trash'
                  ? 'border-amber-400 bg-amber-500/10'
                  : 'border-zinc-800 bg-[#09090B] hover:border-zinc-700'
              }`}
            >
              <FolderInput
                className={`w-4 h-4 mt-0.5 shrink-0 ${
                  deleteMode === 'trash' ? 'text-amber-300' : 'text-zinc-400'
                }`}
              />
              <div>
                <p className="text-xs font-semibold text-zinc-100">
                  {isDrive
                    ? t('Přesunout do koše Drive', 'Move to Drive Trash')
                    : t(
                        `Přesunout do „${TRASH_SUBFOLDER_NAME}“`,
                        `Move to "${TRASH_SUBFOLDER_NAME}"`
                      )}{' '}
                  {t('(doporučeno)', '(recommended)')}
                </p>
                <p className="mt-1 text-[11px] text-zinc-400 leading-relaxed">
                  {isDrive
                    ? t(
                        'Bezpečný přesun do koše Google Drive s možností obnovy.',
                        'Safely moves files to Google Drive Trash so they can be restored.'
                      )
                    : t(
                        `Soubory se bezpečně přesunou do podsložky ${TRASH_SUBFOLDER_NAME}.`,
                        `Safely moves files into the ${TRASH_SUBFOLDER_NAME} subfolder.`
                      )}
                </p>
              </div>
            </button>

            <button
              type="button"
              disabled={isProcessing}
              onClick={() => setDeleteMode('permanent')}
              className={`flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors cursor-pointer ${
                deleteMode === 'permanent'
                  ? 'border-rose-500 bg-rose-500/15'
                  : 'border-zinc-800 bg-[#09090B] hover:border-zinc-700'
              }`}
            >
              <Trash2
                className={`w-4 h-4 mt-0.5 shrink-0 ${
                  deleteMode === 'permanent' ? 'text-rose-400' : 'text-zinc-400'
                }`}
              />
              <div>
                <p className="text-xs font-semibold text-zinc-100">
                  {t('Trvale smazat', 'Delete permanently')}
                </p>
                <p className="mt-1 text-[11px] text-zinc-400 leading-relaxed">
                  {t(
                    'Okamžitě a nevratně odstraní soubory včetně RAWů ze zdroje.',
                    'Immediately and irreversibly removes files (including RAWs) from storage.'
                  )}
                </p>
              </div>
            </button>
          </div>

          {deleteMode === 'permanent' && !isReadOnlyLocal && (
            <label className="flex items-start gap-3 rounded-xl border border-rose-500/50 bg-rose-500/10 p-3.5 text-xs text-rose-100 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmPermanent}
                disabled={isProcessing}
                onChange={(e) => setConfirmPermanent(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-rose-400 accent-rose-500 cursor-pointer shrink-0"
              />
              <span className="leading-relaxed">
                <strong className="font-semibold text-rose-200">
                  {t(
                    'Rozumím, že tento krok nelze vrátit zpět:',
                    'I understand this cannot be undone:'
                  )}
                </strong>{' '}
                {t(
                  `vybrané soubory (${formatNumber(selectedFiles.length)} ${plural(selectedFiles.length, ['soubor', 'soubory', 'souborů'], ['file', 'files'])} · ${formatBytes(totalBytes)}) budou trvale smazány bez přesunu do koše.`,
                  `the selected files (${formatNumber(selectedFiles.length)} ${plural(selectedFiles.length, ['soubor', 'soubory', 'souborů'], ['file', 'files'])} · ${formatBytes(totalBytes)}) will be permanently deleted without going to Trash.`
                )}
              </span>
            </label>
          )}

          {isReadOnlyLocal && (
            <div className="rounded-xl border border-zinc-800 bg-[#09090B] p-4 space-y-3">
              <p className="text-xs text-zinc-300 leading-relaxed">
                {t(
                  'U jednotlivě vybraných fotografií bez přímého přístupu ke složce nelze soubory mazat hromadně přímo v úložišti. Můžete si stáhnout textový seznam souborů určených ke smazání:',
                  'Individually picked files without folder access cannot be batch-deleted directly on disk. You can download a text list of files marked for deletion:'
                )}
              </p>

              <div className="flex">
                <button
                  type="button"
                  onClick={handleDownloadList}
                  className="w-full min-h-[42px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-[#141417] px-3 py-2 text-xs font-medium text-zinc-200 hover:border-zinc-500 cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>{t('Stáhnout seznam (.txt)', 'Download list (.txt)')}</span>
                </button>
              </div>

              {exportNote && (
                <p className="text-xs text-emerald-300">{exportNote}</p>
              )}
            </div>
          )}

          {/* Selection toggle bar */}
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span className="tabular-nums">
              {t(
                `Ke zpracování ${formatNumber(selectedFiles.length)} z ${formatNumber(trashFiles.length)} souborů`,
                `Selected ${formatNumber(selectedFiles.length)} of ${formatNumber(trashFiles.length)} files`
              )}
            </span>
            {!isProcessing && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds(new Set(trashFiles.map((f) => f.id)))
                  }
                  className="hover:text-zinc-200 cursor-pointer"
                >
                  {t('Vybrat vše', 'Select all')}
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="hover:text-zinc-200 cursor-pointer"
                >
                  {t('Zrušit vše', 'Clear all')}
                </button>
              </div>
            )}
          </div>

          {/* Thumbnail Grid */}
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2.5">
            {visibleFiles.map((file) => {
              const checked = selectedIds.has(file.id);
              const thumb =
                thumbnails[file.id] ||
                getFastPreviewThumbnailUrl(file.thumbnailLink);
              return (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => toggleFile(file.id)}
                  disabled={isProcessing}
                  className={`group relative aspect-square rounded-xl overflow-hidden border text-left transition-all cursor-pointer ${
                    checked
                      ? 'border-rose-500/80 ring-1 ring-rose-500/40'
                      : 'border-zinc-800 opacity-45 hover:opacity-80'
                  }`}
                >
                  {thumb ? (
                    <img
                      src={thumb}
                      alt={file.name}
                      referrerPolicy="no-referrer"
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="h-full w-full flex flex-col items-center justify-center bg-zinc-900 text-zinc-500 p-2">
                      <ImageIcon className="w-5 h-5 mb-1" />
                      <span className="text-[10px] font-mono uppercase">
                        {file.fileExtension || 'RAW'}
                      </span>
                    </div>
                  )}

                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-1.5">
                    <p className="text-[10px] font-medium text-zinc-100 truncate">
                      {file.name}
                    </p>
                    <p className="font-mono text-[9px] text-zinc-400 tabular-nums">
                      {file.fileExtension.toUpperCase()} ·{' '}
                      {formatBytes(file.sizeBytes)}
                    </p>
                  </div>

                  <div
                    className={`absolute top-1.5 right-1.5 h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                      checked
                        ? 'bg-rose-500 text-white'
                        : 'bg-zinc-900/80 border border-zinc-600 text-zinc-400'
                    }`}
                  >
                    {checked ? '✓' : ''}
                  </div>
                </button>
              );
            })}
          </div>

          {remainingHidden > 0 && (
            <button
              type="button"
              onClick={() => setVisibleLimit((l) => l + 100)}
              className="w-full py-2 rounded-lg border border-zinc-800 bg-[#09090B] text-xs font-medium text-zinc-300 hover:border-zinc-700 hover:text-white cursor-pointer tabular-nums"
            >
              {t(
                `Zobrazit dalších ${Math.min(100, remainingHidden)} souborů (zbývá ${formatNumber(remainingHidden)})`,
                `Show next ${Math.min(100, remainingHidden)} files (${formatNumber(remainingHidden)} remaining)`
              )}
            </button>
          )}

          {/* Progress during delete */}
          {isProcessing && (
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between text-xs text-zinc-300 tabular-nums">
                <span>
                  {deleteMode === 'permanent'
                    ? t('Trvale mažu soubory…', 'Permanently deleting files…')
                    : isDrive
                      ? t(
                          'Přesouvám soubory do koše Google Drive…',
                          'Moving files to Google Drive Trash…'
                        )
                      : t(
                          `Přesouvám do „${TRASH_SUBFOLDER_NAME}“…`,
                          `Moving to "${TRASH_SUBFOLDER_NAME}"…`
                        )}
                </span>
                <span className="font-mono">
                  {progress.done} / {progress.total}
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full bg-rose-500 transition-all duration-200"
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

          {/* Partial Error Summary */}
          {summary && summary.failed.length > 0 && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-rose-200">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>
                  {t(
                    `Zpracováno ${summary.processedCount}, chyb u ${summary.failed.length} souborů:`,
                    `Processed ${summary.processedCount}, failed on ${summary.failed.length} ${plural(summary.failed.length, ['souboru', 'souborů', 'souborů'], ['file', 'files'])}:`
                  )}
                </span>
              </div>
              <ul className="space-y-1 text-xs text-rose-200/85 max-h-32 overflow-y-auto">
                {summary.failed.map((item) => (
                  <li key={item.file.id}>
                    {item.file.name}: {item.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary && summary.failed.length === 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-200">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>
                {t(
                  `Všechny vybrané soubory (${summary.processedCount}) byly úspěšně zpracovány.`,
                  `All ${summary.processedCount} selected files were processed successfully.`
                )}
              </span>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-zinc-800 bg-[#0E0E11] flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isProcessing}
            className="min-h-[42px] px-4 py-2 rounded-lg border border-zinc-700 text-sm font-medium text-zinc-300 hover:text-white hover:border-zinc-500 transition-colors cursor-pointer disabled:opacity-50"
          >
            {isReadOnlyLocal
              ? t('Zavřít', 'Close')
              : t('Zpět k třídění', 'Back to culling')}
          </button>

          {!isReadOnlyLocal && (
            <button
              type="button"
              disabled={
                selectedFiles.length === 0 ||
                isProcessing ||
                (deleteMode === 'permanent' && !confirmPermanent)
              }
              onClick={handleConfirmDelete}
              className={`min-h-[42px] inline-flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed tabular-nums ${
                deleteMode === 'permanent'
                  ? 'bg-rose-600 hover:bg-rose-500'
                  : 'bg-rose-500 hover:bg-rose-400'
              }`}
            >
              <Trash2 className="w-4 h-4 shrink-0" />
              <span>
                {isProcessing
                  ? t('Zpracovávám…', 'Processing…')
                  : deleteMode === 'permanent'
                    ? t(
                        `Trvale smazat (${selectedFiles.length})`,
                        `Delete permanently (${selectedFiles.length})`
                      )
                    : isDrive
                      ? t(
                          `Přesunout do koše (${selectedFiles.length})`,
                          `Move to Trash (${selectedFiles.length})`
                        )
                      : t(
                          `Přesunout do ${TRASH_SUBFOLDER_NAME} (${selectedFiles.length})`,
                          `Move to ${TRASH_SUBFOLDER_NAME} (${selectedFiles.length})`
                        )}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

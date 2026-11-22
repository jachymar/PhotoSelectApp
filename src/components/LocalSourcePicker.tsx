import React, { useRef, useState } from 'react';
import { FolderOpen, Usb, FileImage, Star, Trash2 } from 'lucide-react';
import { WorkflowMode } from '../lib/cullPersistence';
import {
  LocalStreamStarter,
  hasAndroidNativeBridge,
  streamAndroidNativePickResult,
  streamFileListSession,
} from '../lib/localMedia';
import { useI18n } from '../lib/i18n';

interface LocalSourcePickerProps {
  onStartLocalStream: (starter: LocalStreamStarter, mode: WorkflowMode) => void;
  variant?: 'hero' | 'browser' | 'phone-hub';
  fixedMode?: WorkflowMode;
  onDirectoryHandleSaved?: () => void;
}

export const LocalSourcePicker: React.FC<LocalSourcePickerProps> = ({
  onStartLocalStream,
  variant = 'phone-hub',
  fixedMode,
  onDirectoryHandleSaved,
}) => {
  const { t } = useI18n();
  const dirInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const pendingModeRef = useRef<WorkflowMode>(fixedMode || 'select');
  const [openingMode, setOpeningMode] = useState<WorkflowMode | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const isOpening = openingMode !== null;

  const handleOpenFolder = async (mode: WorkflowMode) => {
    if (isOpening) return;
    pendingModeRef.current = mode;
    setLocalError(null);
    setOpeningMode(mode);
    try {
      if (hasAndroidNativeBridge() && window.FrameCullNative) {
        const res = await window.FrameCullNative.pickDirectoryTree();
        if (res) {
          onDirectoryHandleSaved?.();
          onStartLocalStream(
            {
              folderName:
                res.folderName || t('SD karta / Složka', 'SD Card / Folder'),
              launch: (onBatch, signal) =>
                streamAndroidNativePickResult(res, onBatch, signal),
            },
            mode
          );
        }
        return;
      }

      dirInputRef.current?.click();
    } catch (err: unknown) {
      setLocalError(
        err instanceof Error
          ? err.message
          : t(
              'Nepodařilo se otevřít vybranou složku.',
              'Could not open the selected folder.'
            )
      );
    } finally {
      setOpeningMode(null);
    }
  };

  const handleOpenFiles = (mode: WorkflowMode) => {
    if (isOpening) return;
    pendingModeRef.current = mode;
    filesInputRef.current?.click();
  };

  const handleDirectoryInputChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const filesArray = Array.from(files);
    e.target.value = '';

    const fallbackFolderLabel = t('Lokální složka', 'Local folder');
    const firstRel =
      (filesArray[0] as File & { webkitRelativePath?: string })
        ?.webkitRelativePath || '';
    const folderName = firstRel.includes('/')
      ? firstRel.split('/')[0]
      : fallbackFolderLabel;

    onStartLocalStream(
      {
        folderName,
        launch: (onBatch, signal) =>
          streamFileListSession(
            filesArray,
            fallbackFolderLabel,
            onBatch,
            signal
          ),
      },
      fixedMode || pendingModeRef.current
    );
  };

  const handleMultiFilesInputChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const filesArray = Array.from(files);
    e.target.value = '';

    const fallbackPhotosLabel = t(
      'Vybrané lokální fotky',
      'Selected local photos'
    );
    onStartLocalStream(
      {
        folderName: fallbackPhotosLabel,
        launch: (onBatch, signal) =>
          streamFileListSession(
            filesArray,
            fallbackPhotosLabel,
            onBatch,
            signal
          ),
      },
      fixedMode || pendingModeRef.current
    );
  };

  const hiddenInputs = (
    <>
      <input
        ref={dirInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory is supported in Chromium/WebKit/Firefox
        webkitdirectory=""
        directory=""
        onChange={handleDirectoryInputChange}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
      <input
        ref={filesInputRef}
        type="file"
        multiple
        accept="image/*,.cr3,.cr2,.crw,.nef,.nrw,.arw,.sr2,.srf,.dng,.raf,.orf,.rw2,.pef,.raw,.rwl,.iiq,.3fr"
        onChange={handleMultiFilesInputChange}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
    </>
  );

  if (fixedMode) {
    const isDelete = fixedMode === 'delete';
    return (
      <div className="space-y-3">
        {hiddenInputs}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => void handleOpenFolder(fixedMode)}
            disabled={isOpening}
            className={`min-h-[50px] px-4 py-3 rounded-xl font-semibold text-sm inline-flex items-center justify-center gap-2.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-2 ${
              isDelete
                ? 'bg-rose-500 text-white hover:bg-rose-400 focus-visible:outline-rose-500'
                : 'bg-amber-500 text-zinc-950 hover:bg-amber-400 focus-visible:outline-amber-500'
            }`}
          >
            <FolderOpen className="w-5 h-5 shrink-0" aria-hidden="true" />
            <span>
              {isOpening
                ? t('Otevírám složku…', 'Opening folder…')
                : t('Otevřít složku / SD kartu', 'Open folder / SD card')}
            </span>
          </button>

          <button
            type="button"
            onClick={() => handleOpenFiles(fixedMode)}
            disabled={isOpening}
            className="min-h-[50px] px-4 py-3 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-100 font-medium text-sm inline-flex items-center justify-center gap-2.5 hover:border-zinc-500 hover:bg-zinc-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-amber-500"
          >
            <FileImage
              className="w-5 h-5 text-zinc-400 shrink-0"
              aria-hidden="true"
            />
            <span>{t('Vybrat lokální fotky', 'Pick local photos')}</span>
          </button>
        </div>

        {localError && (
          <p role="alert" className="text-xs text-rose-400">
            {localError}
          </p>
        )}
      </div>
    );
  }

  if (variant === 'phone-hub') {
    return (
      <div className="space-y-3">
        {hiddenInputs}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => void handleOpenFolder('select')}
            disabled={isOpening}
            className="min-h-[52px] px-4 py-3 rounded-xl bg-amber-500 text-zinc-950 hover:bg-amber-400 font-semibold text-sm inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-amber-500"
          >
            <Star className="w-4 h-4 fill-current shrink-0" aria-hidden="true" />
            <span>
              {openingMode === 'select'
                ? t('Otevírám složku…', 'Opening folder…')
                : t('Vybrat složku pro Výběr', 'Choose folder to Select')}
            </span>
          </button>

          <button
            type="button"
            onClick={() => void handleOpenFolder('delete')}
            disabled={isOpening}
            className="min-h-[52px] px-4 py-3 rounded-xl bg-rose-500 text-white hover:bg-rose-400 font-semibold text-sm inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-rose-500"
          >
            <Trash2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>
              {openingMode === 'delete'
                ? t('Otevírám složku…', 'Opening folder…')
                : t('Vybrat složku pro Mazání', 'Choose folder to Delete')}
            </span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={() => handleOpenFiles('select')}
            disabled={isOpening}
            className="min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-800 bg-[#09090B] text-zinc-200 font-medium text-xs inline-flex items-center justify-center gap-2 hover:border-amber-500/50 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <FileImage
              className="w-4 h-4 text-amber-400 shrink-0"
              aria-hidden="true"
            />
            <span>
              {t('Jednotlivé fotky pro Výběr', 'Individual photos to Select')}
            </span>
          </button>

          <button
            type="button"
            onClick={() => handleOpenFiles('delete')}
            disabled={isOpening}
            className="min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-800 bg-[#09090B] text-zinc-200 font-medium text-xs inline-flex items-center justify-center gap-2 hover:border-rose-500/50 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <FileImage
              className="w-4 h-4 text-rose-400 shrink-0"
              aria-hidden="true"
            />
            <span>
              {t('Jednotlivé fotky pro Mazání', 'Individual photos to Delete')}
            </span>
          </button>
        </div>

        {localError && (
          <p role="alert" className="text-xs text-rose-400">
            {localError}
          </p>
        )}
      </div>
    );
  }

  if (variant === 'hero') {
    return (
      <div className="space-y-2.5">
        {hiddenInputs}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => void handleOpenFolder('select')}
            disabled={isOpening}
            className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-zinc-700 bg-[#141417] text-sm font-semibold text-zinc-100 hover:border-amber-500/70 hover:text-amber-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-amber-500"
          >
            <FolderOpen
              className="w-4 h-4 text-amber-400 shrink-0"
              aria-hidden="true"
            />
            <span>{t('Otevřít složku pro Výběr', 'Open folder to Select')}</span>
          </button>

          <button
            type="button"
            onClick={() => void handleOpenFolder('delete')}
            disabled={isOpening}
            className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-zinc-700 bg-[#141417] text-sm font-semibold text-zinc-100 hover:border-rose-500/70 hover:text-rose-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-rose-500"
          >
            <Trash2
              className="w-4 h-4 text-rose-400 shrink-0"
              aria-hidden="true"
            />
            <span>{t('Otevřít složku pro Mazání', 'Open folder to Delete')}</span>
          </button>
        </div>

        {localError && (
          <p role="alert" className="text-xs text-rose-400">
            {localError}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-7 space-y-5">
      {hiddenInputs}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5 max-w-2xl">
          <h2 className="font-display text-lg font-semibold text-zinc-100">
            {t(
              'Lokální složka nebo SD karta přes USB',
              'Local folder or SD card over USB'
            )}
          </h2>
          <p className="text-sm text-zinc-400 leading-relaxed">
            {t(
              'Otevřete složku z interního úložiště zařízení nebo z připojené čtečky SD karet. Aplikace čte hlavičky snímků lokálně bez nahrávání na internet.',
              'Open a folder from internal device storage or a connected SD card reader. Photos are read locally with zero cloud uploads.'
            )}
          </p>
        </div>
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
          <Usb className="w-5 h-5" aria-hidden="true" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void handleOpenFolder('select')}
          disabled={isOpening}
          className="min-h-[46px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 text-zinc-950 hover:bg-amber-400 font-semibold text-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-amber-500"
        >
          <Star className="w-4 h-4 fill-current shrink-0" aria-hidden="true" />
          <span>{t('Vybrat složku pro Výběr', 'Choose folder to Select')}</span>
        </button>

        <button
          type="button"
          onClick={() => void handleOpenFolder('delete')}
          disabled={isOpening}
          className="min-h-[46px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-rose-500 text-white hover:bg-rose-400 font-semibold text-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-rose-500"
        >
          <Trash2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{t('Vybrat složku pro Mazání', 'Choose folder to Delete')}</span>
        </button>
      </div>

      {localError && (
        <p role="alert" className="text-xs text-rose-400">
          {localError}
        </p>
      )}
    </div>
  );
};

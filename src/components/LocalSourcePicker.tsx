import React, { useRef, useState } from 'react';
import { FolderOpen, Usb, FileImage } from 'lucide-react';
import { AppMode } from '../lib/appMode';
import {
  LocalStreamStarter,
  buildStableStreamFolderId,
  hasAndroidNativeBridge,
  hasDesktopDirectoryPicker,
  pickDesktopDirectoryHandle,
  streamAndroidNativePickResult,
  streamDesktopDirectoryHandle,
  streamFileListSession,
} from '../lib/localMedia';
import { saveLocalDirHandle } from '../lib/localPersistence';

interface LocalSourcePickerProps {
  onStartLocalStream: (starter: LocalStreamStarter) => void;
  variant?: 'hero' | 'browser' | 'phone-hub';
  appMode?: AppMode;
  onDirectoryHandleSaved?: () => void;
}

export const LocalSourcePicker: React.FC<LocalSourcePickerProps> = ({
  onStartLocalStream,
  variant = 'phone-hub',
  appMode = 'selectra',
  onDirectoryHandleSaved,
}) => {
  const dirInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const [isOpening, setIsOpening] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const isFrameCull = appMode === 'framecull';

  const handleOpenFolder = async () => {
    if (isOpening) return;
    setLocalError(null);
    setIsOpening(true);
    try {
      if (hasAndroidNativeBridge() && window.FrameCullNative) {
        const res = await window.FrameCullNative.pickDirectoryTree();
        if (res) {
          onDirectoryHandleSaved?.();
          onStartLocalStream({
            folderName: res.folderName || 'SD karta / Složka',
            launch: (onBatch, signal) =>
              streamAndroidNativePickResult(res, onBatch, signal),
          });
        }
        return;
      }

      if (hasDesktopDirectoryPicker()) {
        try {
          const picked = await pickDesktopDirectoryHandle();
          if (picked) {
            const folderId = buildStableStreamFolderId(
              'local-fs-dir',
              picked.dirHandle.name
            );
            void saveLocalDirHandle({
              folderId,
              folderName: picked.dirHandle.name,
              dirHandle: picked.dirHandle,
              canWrite: picked.canWrite,
            }).then(() => {
              onDirectoryHandleSaved?.();
            });
            onStartLocalStream({
              folderName: picked.dirHandle.name,
              launch: (onBatch, signal) =>
                streamDesktopDirectoryHandle(
                  picked.dirHandle,
                  picked.canWrite,
                  onBatch,
                  signal
                ),
            });
          }
          return;
        } catch (err: unknown) {
          if (err instanceof Error && err.message === 'FALLBACK_REQUIRED') {
            dirInputRef.current?.click();
            return;
          }
          throw err;
        }
      }

      dirInputRef.current?.click();
    } catch (err: unknown) {
      setLocalError(
        err instanceof Error
          ? err.message
          : 'Nepodařilo se otevřít vybranou složku.'
      );
    } finally {
      setIsOpening(false);
    }
  };

  const handleDirectoryInputChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const filesArray = Array.from(files);
    e.target.value = '';

    const firstRel =
      (filesArray[0] as File & { webkitRelativePath?: string })
        ?.webkitRelativePath || '';
    const folderName = firstRel.includes('/')
      ? firstRel.split('/')[0]
      : 'Složka v telefonu';

    onStartLocalStream({
      folderName,
      launch: (onBatch, signal) =>
        streamFileListSession(filesArray, 'Složka v telefonu', onBatch, signal),
    });
  };

  const handleMultiFilesInputChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const filesArray = Array.from(files);
    e.target.value = '';

    onStartLocalStream({
      folderName: 'Vybrané fotky z telefonu',
      launch: (onBatch, signal) =>
        streamFileListSession(
          filesArray,
          'Vybrané fotky z telefonu',
          onBatch,
          signal
        ),
    });
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

  if (variant === 'phone-hub') {
    return (
      <div className="space-y-3">
        {hiddenInputs}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => void handleOpenFolder()}
            disabled={isOpening}
            className={`min-h-[52px] px-4 py-3 rounded-xl font-semibold text-sm inline-flex items-center justify-center gap-2.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-2 ${
              isFrameCull
                ? 'bg-rose-500 text-white hover:bg-rose-400 focus-visible:outline-rose-500'
                : 'bg-amber-500 text-zinc-950 hover:bg-amber-400 focus-visible:outline-amber-500'
            }`}
          >
            <FolderOpen className="w-5 h-5 shrink-0" aria-hidden="true" />
            <span>
              {isOpening ? 'Otevírám složku…' : 'Otevřít složku / SD kartu'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => filesInputRef.current?.click()}
            disabled={isOpening}
            className="min-h-[52px] px-4 py-3 rounded-xl border border-zinc-800 bg-[#141417] text-zinc-100 font-medium text-sm inline-flex items-center justify-center gap-2.5 hover:bg-zinc-800/70 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-amber-500"
          >
            <FileImage className="w-5 h-5 text-zinc-400 shrink-0" aria-hidden="true" />
            <span>Vybrat fotky z telefonu</span>
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
            onClick={() => void handleOpenFolder()}
            disabled={isOpening}
            className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-zinc-700 bg-[#141417] text-sm font-semibold text-zinc-100 hover:border-amber-500/70 hover:text-amber-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-amber-500"
          >
            <FolderOpen className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
            <span>
              {isOpening
                ? 'Otevírám první snímky…'
                : 'Otevřít složku z disku / SD karty'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => filesInputRef.current?.click()}
            disabled={isOpening}
            className="min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800/70 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500"
          >
            <FileImage className="w-3.5 h-3.5 text-zinc-400 shrink-0" aria-hidden="true" />
            <span>Vybrat jednotlivé soubory</span>
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
            Složka v telefonu nebo SD karta přes USB
          </h2>
          <p className="text-sm text-zinc-400 leading-relaxed">
            Otevřete složku z interní paměti telefonu, počítače nebo z připojené
            čtečky SD karet. Aplikace čte hlavičky snímků lokálně bez nahrávání
            na internet.
          </p>
        </div>
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
          <Usb className="w-5 h-5" aria-hidden="true" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void handleOpenFolder()}
          disabled={isOpening}
          className={`min-h-[46px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-2 ${
            isFrameCull
              ? 'bg-rose-500 text-white hover:bg-rose-400 focus-visible:outline-rose-500'
              : 'bg-amber-500 text-zinc-950 hover:bg-amber-400 focus-visible:outline-amber-500'
          }`}
        >
          <FolderOpen className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>
            {isOpening ? 'Otevírám první snímky…' : 'Vybrat složku / SD kartu'}
          </span>
        </button>

        <button
          type="button"
          onClick={() => filesInputRef.current?.click()}
          disabled={isOpening}
          className="min-h-[46px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-200 font-medium text-sm hover:border-zinc-500 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-amber-500"
        >
          <FileImage className="w-4 h-4 text-zinc-400 shrink-0" aria-hidden="true" />
          <span>Vybrat fotky z telefonu</span>
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


import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Smartphone,
  Folder,
  ChevronRight,
  HardDrive,
  Trash2,
  Star,
  X,
} from 'lucide-react';
import { DriveFolder } from '../lib/driveApi';
import { PersistedFolderSummary, WorkflowMode } from '../lib/cullPersistence';
import {
  LocalStreamStarter,
  NativePersistedFolderInfo,
  hasAndroidNativeBridge,
  streamAndroidNativePickResult,
  streamFileListSession,
} from '../lib/localMedia';
import {
  loadAllLocalFolderSummaries,
  removeSavedLocalFolderEntry,
} from '../lib/localPersistence';
import { LocalSourcePicker } from './LocalSourcePicker';

interface PhoneStorageHubProps {
  activeFolder: DriveFolder | null;
  activePhotosCount: number;
  pickedCount: number;
  trashCount: number;
  isAuthenticated: boolean;
  hasDriveToken: boolean;
  userEmail?: string | null;
  rememberedEmail?: string | null;
  onOpenStudio: (mode: WorkflowMode) => void;
  onOpenFinishSelection: () => void;
  onOpenFinishTrash: () => void;
  onStartLocalStream: (starter: LocalStreamStarter, mode: WorkflowMode) => void;
  onNavigateDrive: () => void;
}

interface CombinedLocalItem {
  folderId: string;
  folderName: string;
  keepCount: number;
  trashCount: number;
  lastShotName?: string;
  updatedAtMs: number;
  nativeFolder?: NativePersistedFolderInfo;
}

export const PhoneStorageHub: React.FC<PhoneStorageHubProps> = ({
  activeFolder,
  activePhotosCount,
  pickedCount,
  trashCount,
  isAuthenticated,
  hasDriveToken,
  userEmail,
  rememberedEmail,
  onOpenStudio,
  onOpenFinishSelection,
  onOpenFinishTrash,
  onStartLocalStream,
  onNavigateDrive,
}) => {
  const [localSummaries, setLocalSummaries] = useState<
    Record<string, PersistedFolderSummary>
  >({});
  const [nativeFolders, setNativeFolders] = useState<
    Record<string, NativePersistedFolderInfo>
  >({});
  const [reopeningId, setReopeningId] = useState<string | null>(null);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const fallbackDirInputRef = useRef<HTMLInputElement>(null);
  const fallbackPendingModeRef = useRef<WorkflowMode>('select');

  const refreshSavedLocalItems = useCallback(async () => {
    const [summaries, persistedNative] = await Promise.all([
      loadAllLocalFolderSummaries(),
      window.FrameCullNative?.listPersistedFolders
        ? window.FrameCullNative.listPersistedFolders().catch(() => [])
        : Promise.resolve([]),
    ]);
    const nativeMap: Record<string, NativePersistedFolderInfo> = {};
    for (const item of persistedNative) {
      if (item?.folderId) {
        nativeMap[item.folderId] = item;
      }
    }
    setLocalSummaries(summaries);
    setNativeFolders(nativeMap);
  }, []);

  useEffect(() => {
    void refreshSavedLocalItems();
  }, [refreshSavedLocalItems, activeFolder?.id, pickedCount, trashCount]);

  const savedItems = useMemo<CombinedLocalItem[]>(() => {
    const allIds = new Set<string>([
      ...Object.keys(localSummaries),
      ...Object.keys(nativeFolders),
    ]);
    const list: CombinedLocalItem[] = [];
    for (const id of allIds) {
      const summary = localSummaries[id];
      const nativeRec = nativeFolders[id];
      const folderName =
        summary?.folderName ||
        nativeRec?.folderName ||
        'Složka v telefonu';
      const updatedAtMs = Math.max(
        summary?.updatedAtMs || 0,
        nativeRec?.updatedAtMs || 0
      );
      list.push({
        folderId: id,
        folderName,
        keepCount: summary?.keepCount || 0,
        trashCount: summary?.trashCount || 0,
        lastShotName: summary?.lastShotName,
        updatedAtMs,
        nativeFolder: nativeRec,
      });
    }
    return list.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }, [localSummaries, nativeFolders]);

  const handleReopenSavedItem = async (
    item: CombinedLocalItem,
    mode: WorkflowMode
  ) => {
    setReopenError(null);
    fallbackPendingModeRef.current = mode;

    if (activeFolder && activeFolder.id === item.folderId) {
      onOpenStudio(mode);
      return;
    }

    if (
      item.nativeFolder &&
      hasAndroidNativeBridge() &&
      window.FrameCullNative?.openPersistedDirectoryTree
    ) {
      setReopeningId(item.folderId);
      try {
        const res = await window.FrameCullNative.openPersistedDirectoryTree(
          item.folderId
        );
        if (res) {
          onStartLocalStream(
            {
              folderName: res.folderName || item.folderName,
              launch: (onBatch, signal) =>
                streamAndroidNativePickResult(res, onBatch, signal),
            },
            mode
          );
          return;
        }
      } catch {
        setReopenError(
          `Přístup ke složce „${item.folderName}“ vypršel. Vyberte složku znovu — uložený postup zůstane zachován.`
        );
      } finally {
        setReopeningId(null);
      }
    }

    if (hasAndroidNativeBridge() && window.FrameCullNative) {
      setReopeningId(item.folderId);
      try {
        const res = await window.FrameCullNative.pickDirectoryTree();
        if (res) {
          void refreshSavedLocalItems();
          onStartLocalStream(
            {
              folderName: res.folderName || item.folderName,
              launch: (onBatch, signal) =>
                streamAndroidNativePickResult(res, onBatch, signal),
            },
            mode
          );
        }
      } finally {
        setReopeningId(null);
      }
      return;
    }

    fallbackDirInputRef.current?.click();
  };

  const handleFallbackDirInputChange = (
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
    onStartLocalStream(
      {
        folderName,
        launch: (onBatch, signal) =>
          streamFileListSession(
            filesArray,
            'Složka v telefonu',
            onBatch,
            signal
          ),
      },
      fallbackPendingModeRef.current
    );
  };

  const handleRemoveSavedItem = async (
    e: React.MouseEvent,
    folderId: string
  ) => {
    e.stopPropagation();
    await Promise.all([
      removeSavedLocalFolderEntry(folderId),
      window.FrameCullNative?.forgetPersistedFolder?.(folderId),
    ]);
    await refreshSavedLocalItems();
  };

  const formatShortDate = (ms: number) => {
    if (!ms) return '';
    try {
      return new Date(ms).toLocaleDateString('cs-CZ', {
        day: 'numeric',
        month: 'short',
      });
    } catch {
      return '';
    }
  };

  const knownGoogleEmail = userEmail || rememberedEmail;

  return (
    <main className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 pt-5 pb-24 md:pb-12">
      <input
        ref={fallbackDirInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory is supported in Chromium/WebKit/Firefox
        webkitdirectory=""
        directory=""
        onChange={handleFallbackDirInputChange}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* Top Row: Clean Header without mode-mixing toggle */}
      <div className="pb-5 border-b border-zinc-800/80">
        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-zinc-50 [text-wrap:balance]">
          Fotky a složky v telefonu
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Otevřete paměť telefonu nebo SD kartu samostatně pro výběr nejlepších
          záběrů (Liked) nebo pro promazání nepovedených fotek.
        </p>
      </div>

      {/* Active Open Session Quick Resume Banner */}
      {activeFolder && (
        <section
          aria-label="Právě otevřená složka"
          className="mt-5 rounded-2xl border border-zinc-800 bg-[#141417] p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
        >
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium text-zinc-400">
              Právě rozpracováno ·{' '}
              {activeFolder.sourceKind && activeFolder.sourceKind !== 'drive'
                ? 'V telefonu / SD karta'
                : 'Google Drive'}
            </p>
            <h2 className="font-display text-base sm:text-lg font-semibold text-zinc-100 truncate">
              {activeFolder.name}
            </h2>
            <p className="text-xs text-zinc-400 tabular-nums">
              {activePhotosCount.toLocaleString('cs-CZ')} souborů
              {pickedCount > 0
                ? ` · Vybráno ★ ${pickedCount.toLocaleString('cs-CZ')}`
                : ''}
              {trashCount > 0
                ? ` · Ke smazání ${trashCount.toLocaleString('cs-CZ')}`
                : ''}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {pickedCount > 0 && (
              <button
                type="button"
                onClick={onOpenFinishSelection}
                className="min-h-[42px] px-3.5 py-2 rounded-xl border border-amber-500/40 bg-amber-500/10 text-xs font-semibold text-amber-200 hover:bg-amber-500/20 transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums"
              >
                Uložit Liked ({pickedCount})
              </button>
            )}
            {trashCount > 0 && (
              <button
                type="button"
                onClick={onOpenFinishTrash}
                className="min-h-[42px] px-3.5 py-2 rounded-xl border border-rose-500/40 bg-rose-500/10 text-xs font-semibold text-rose-200 hover:bg-rose-500/20 transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums"
              >
                Dokončit mazání ({trashCount})
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenStudio('select')}
              className="min-h-[42px] px-4 py-2 rounded-xl bg-amber-500 text-zinc-950 hover:bg-amber-400 text-sm font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Star className="w-4 h-4 fill-current shrink-0" aria-hidden="true" />
              <span>Výběr</span>
            </button>
            <button
              type="button"
              onClick={() => onOpenStudio('delete')}
              className="min-h-[42px] px-4 py-2 rounded-xl bg-rose-500 text-white hover:bg-rose-400 text-sm font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Trash2 className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>Mazání</span>
            </button>
          </div>
        </section>
      )}

      {/* Main 2-column responsive layout */}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 space-y-6">
          <section
            aria-label="Otevřít soubory z telefonu"
            className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 space-y-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <h2 className="font-display text-lg font-semibold text-zinc-100">
                  Úložiště telefonu a SD karta
                </h2>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  Vyberte složku fotoaparátu (DCIM), stažené fotky nebo čtečku
                  SD karet připojenou přes USB-C. Podporuje JPG, HEIC i RAW
                  (CR3, CR2, NEF, ARW, DNG).
                </p>
              </div>
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
                <Smartphone className="w-5 h-5" aria-hidden="true" />
              </div>
            </div>

            <LocalSourcePicker
              variant="phone-hub"
              onStartLocalStream={onStartLocalStream}
              onDirectoryHandleSaved={() => void refreshSavedLocalItems()}
            />
          </section>

          {/* Recent & Saved Phone Folders */}
          <section aria-label="Nedávné složky v zařízení" className="space-y-3">
            <div className="flex items-baseline justify-between px-1">
              <h2 className="font-display text-base font-semibold text-zinc-100">
                Rozpracované složky v telefonu
              </h2>
              {savedItems.length > 0 && (
                <span className="text-xs text-zinc-500 tabular-nums">
                  {savedItems.length.toLocaleString('cs-CZ')}{' '}
                  {savedItems.length === 1
                    ? 'složka'
                    : savedItems.length >= 2 && savedItems.length <= 4
                      ? 'složky'
                      : 'složek'}
                </span>
              )}
            </div>

            {reopenError && (
              <p role="alert" className="px-1 text-xs text-amber-300">
                {reopenError}
              </p>
            )}

            {savedItems.length === 0 ? (
              <div className="rounded-2xl border border-zinc-800/80 bg-[#141417]/60 p-6 text-center space-y-1.5">
                <p className="text-sm font-medium text-zinc-300">
                  Zatím žádné uložené složky v telefonu
                </p>
                <p className="text-xs text-zinc-500 max-w-md mx-auto leading-relaxed">
                  Jakmile otevřete složku pro výběr nebo mazání, aplikace si
                  automaticky uloží vaši pozici i označené snímky.
                </p>
              </div>
            ) : (
              <ul className="rounded-2xl border border-zinc-800 bg-[#141417] divide-y divide-zinc-800/80 overflow-hidden">
                {savedItems.map((item) => {
                  const isReopening = reopeningId === item.folderId;
                  const isCurrentlyActive = activeFolder?.id === item.folderId;
                  return (
                    <li
                      key={item.folderId}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 hover:bg-zinc-800/35 transition-colors"
                    >
                      <div className="flex items-center gap-3.5 min-w-0 flex-1">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-800/90 text-zinc-200">
                          <Folder className="w-5 h-5" aria-hidden="true" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-zinc-100 truncate">
                            {item.folderName}
                          </p>
                          <p className="text-xs text-zinc-400 tabular-nums truncate mt-0.5">
                            {isCurrentlyActive ? 'Otevřeno · ' : ''}
                            {item.keepCount > 0 || item.trashCount > 0 ? (
                              <span>
                                {item.keepCount > 0
                                  ? `Vybráno ★ ${item.keepCount.toLocaleString('cs-CZ')}`
                                  : ''}
                                {item.keepCount > 0 && item.trashCount > 0
                                  ? ' · '
                                  : ''}
                                {item.trashCount > 0
                                  ? `Ke smazání ${item.trashCount.toLocaleString('cs-CZ')}`
                                  : ''}
                              </span>
                            ) : (
                              <span>Připraveno k otevření</span>
                            )}
                            {item.lastShotName
                              ? ` · ${item.lastShotName}`
                              : item.updatedAtMs
                                ? ` · ${formatShortDate(item.updatedAtMs)}`
                                : ''}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 self-end sm:self-auto shrink-0">
                        <button
                          type="button"
                          onClick={() =>
                            void handleReopenSavedItem(item, 'select')
                          }
                          disabled={isReopening}
                          className="min-h-[40px] px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                        >
                          <Star
                            className="w-3.5 h-3.5 fill-current shrink-0"
                            aria-hidden="true"
                          />
                          <span>{isReopening ? 'Otevírám…' : 'Výběr'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            void handleReopenSavedItem(item, 'delete')
                          }
                          disabled={isReopening}
                          className="min-h-[40px] px-3 py-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                        >
                          <Trash2
                            className="w-3.5 h-3.5 shrink-0"
                            aria-hidden="true"
                          />
                          <span>Mazání</span>
                        </button>

                        <button
                          type="button"
                          onClick={(e) =>
                            void handleRemoveSavedItem(e, item.folderId)
                          }
                          aria-label={`Odebrat záznam složky ${item.folderName}`}
                          title="Odebrat ze seznamu"
                          className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/70 transition-colors shrink-0 cursor-pointer"
                        >
                          <X className="w-4 h-4" aria-hidden="true" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {/* Secondary Column: Google Drive Sync Card */}
        <div className="lg:col-span-5">
          <section
            aria-label="Propojení s Google Drive"
            className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 space-y-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <h2 className="font-display text-base sm:text-lg font-semibold text-zinc-100">
                  Google Drive
                </h2>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  {isAuthenticated && hasDriveToken
                    ? `Připojeno jako ${knownGoogleEmail || 'Google účet'}. Složky na cloudu můžete kdykoliv otevřít pro výběr nebo mazání.`
                    : isAuthenticated || knownGoogleEmail
                      ? `Účet ${knownGoogleEmail} je v aplikaci zapamatován. Otevřete sekci Google Drive pro rychlý přístup ke složkám.`
                      : 'Volitelně se přihlaste přes Google — účet zůstane v aplikaci zapamatovaný pro otevírání a správu složek na Google Drive.'}
                </p>
              </div>
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-800/90 text-zinc-200">
                <HardDrive className="w-5 h-5" aria-hidden="true" />
              </div>
            </div>

            <button
              type="button"
              onClick={onNavigateDrive}
              className="w-full min-h-[46px] px-4 py-2.5 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-100 text-sm font-semibold hover:border-zinc-500 hover:bg-zinc-900 transition-colors inline-flex items-center justify-between cursor-pointer"
            >
              <span className="truncate">
                {isAuthenticated && hasDriveToken
                  ? 'Procházet složky na Google Drive'
                  : knownGoogleEmail
                    ? `Otevřít Drive (${knownGoogleEmail})`
                    : 'Připojit a otevřít Google Drive'}
              </span>
              <ChevronRight
                className="w-4 h-4 text-zinc-400 shrink-0 ml-2"
                aria-hidden="true"
              />
            </button>
          </section>
        </div>
      </div>
    </main>
  );
};

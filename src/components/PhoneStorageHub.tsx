import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Cloud,
  Folder,
  HardDrive,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { DriveFolder } from '../lib/driveApi';
import { PersistedFolderSummary, WorkflowMode } from '../lib/cullPersistence';
import {
  LocalStreamStarter,
  NativePersistedFolderInfo,
  hasAndroidNativeBridge,
  streamAndroidNativePickResult,
} from '../lib/localMedia';
import {
  loadAllLocalFolderSummaries,
  removeSavedLocalFolderEntry,
} from '../lib/localPersistence';
import { LocalFolderExplorer } from './LocalFolderExplorer';
import { useI18n } from '../lib/i18n';

interface PhoneStorageHubProps {
  activeFolder: DriveFolder | null;
  activePhotosCount: number;
  pickedCount: number;
  trashCount: number;
  isAuthenticated: boolean;
  hasDriveToken: boolean;
  userEmail?: string | null;
  rememberedEmail?: string | null;
  driveFolderSummaries?: Record<string, PersistedFolderSummary>;
  onSelectDriveFolder?: (folder: DriveFolder, mode: WorkflowMode) => void;
  onRemoveDriveFolderSummary?: (folderId: string, folderName: string) => void;
  onOpenStudio: (mode: WorkflowMode) => void;
  onOpenFinishSelection: () => void;
  onOpenFinishTrash: () => void;
  onStartLocalStream: (starter: LocalStreamStarter, mode: WorkflowMode) => void;
  onNavigateDrive: () => void;
}

interface CombinedSavedItem {
  folderId: string;
  folderName: string;
  source: 'local' | 'drive';
  keepCount: number;
  trashCount: number;
  lastShotName?: string;
  updatedAtMs: number;
  nativeFolder?: NativePersistedFolderInfo;
}

const DEFAULT_VISIBLE_SAVED_ITEMS = 4;

export const PhoneStorageHub: React.FC<PhoneStorageHubProps> = ({
  activeFolder,
  activePhotosCount,
  pickedCount,
  trashCount,
  isAuthenticated,
  hasDriveToken,
  userEmail,
  rememberedEmail,
  driveFolderSummaries = {},
  onSelectDriveFolder,
  onRemoveDriveFolderSummary,
  onOpenStudio,
  onOpenFinishSelection,
  onOpenFinishTrash,
  onStartLocalStream,
  onNavigateDrive,
}) => {
  const { t, locale, formatNumber, plural } = useI18n();
  const [localSummaries, setLocalSummaries] = useState<
    Record<string, PersistedFolderSummary>
  >({});
  const [nativeFolders, setNativeFolders] = useState<
    Record<string, NativePersistedFolderInfo>
  >({});
  const [reopeningId, setReopeningId] = useState<string | null>(null);
  const [reopenNotice, setReopenNotice] = useState<string | null>(null);
  const [showAllSaved, setShowAllSaved] = useState(false);

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

  const savedItems = useMemo<CombinedSavedItem[]>(() => {
    const allLocalIds = new Set<string>([
      ...Object.keys(localSummaries),
      ...Object.keys(nativeFolders),
    ]);
    const list: CombinedSavedItem[] = [];
    for (const id of allLocalIds) {
      if (
        driveFolderSummaries[id] &&
        !nativeFolders[id] &&
        !id.startsWith('local-') &&
        !id.startsWith('saf:') &&
        !id.startsWith('fs:')
      ) {
        continue;
      }
      const summary = localSummaries[id];
      const nativeRec = nativeFolders[id];
      const folderName =
        summary?.folderName ||
        nativeRec?.folderName ||
        t('Lokální složka', 'Local folder');
      const updatedAtMs = Math.max(
        summary?.updatedAtMs || 0,
        nativeRec?.updatedAtMs || 0
      );
      list.push({
        folderId: id,
        folderName,
        source: 'local',
        keepCount: summary?.keepCount || 0,
        trashCount: summary?.trashCount || 0,
        lastShotName: summary?.lastShotName,
        updatedAtMs,
        nativeFolder: nativeRec,
      });
    }

    for (const [id, driveSum] of Object.entries(driveFolderSummaries)) {
      if (!driveSum) continue;
      list.push({
        folderId: id,
        folderName:
          driveSum.folderName ||
          t('Složka na Google Drive', 'Google Drive folder'),
        source: 'drive',
        keepCount: driveSum.keepCount || 0,
        trashCount: driveSum.trashCount || 0,
        lastShotName: driveSum.lastShotName,
        updatedAtMs: driveSum.updatedAtMs || 0,
      });
    }

    return list.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }, [localSummaries, nativeFolders, driveFolderSummaries, t]);

  const visibleSavedItems = showAllSaved
    ? savedItems
    : savedItems.slice(0, DEFAULT_VISIBLE_SAVED_ITEMS);
  const hiddenSavedCount = Math.max(
    0,
    savedItems.length - DEFAULT_VISIBLE_SAVED_ITEMS
  );

  const handleReopenSavedItem = async (
    item: CombinedSavedItem,
    mode: WorkflowMode
  ) => {
    setReopenNotice(null);

    if (activeFolder && activeFolder.id === item.folderId) {
      onOpenStudio(mode);
      return;
    }

    if (item.source === 'drive') {
      if (!hasDriveToken) {
        onNavigateDrive();
        return;
      }
      if (onSelectDriveFolder) {
        onSelectDriveFolder(
          {
            id: item.folderId,
            name: item.folderName,
            sourceKind: 'drive',
          },
          mode
        );
      } else {
        onNavigateDrive();
      }
      return;
    }

    if (
      hasAndroidNativeBridge() &&
      window.FrameCullNative?.openPersistedDirectoryTree &&
      (item.nativeFolder ||
        item.folderId.startsWith('fs:') ||
        item.folderId.startsWith('saf:'))
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
        // Fall through to helpful notice below
      } finally {
        setReopeningId(null);
      }
    }

    setReopenNotice(
      t(
        `Složku „${item.folderName}“ otevřete znovu v průzkumníku úložiště níže — uložený postup i označené fotky se automaticky obnoví.`,
        `Re-open "${item.folderName}" in the storage explorer below — your saved progress and marks will be restored automatically.`
      )
    );
  };

  const handleRemoveSavedItem = async (
    e: React.MouseEvent,
    item: CombinedSavedItem
  ) => {
    e.stopPropagation();
    if (item.source === 'drive') {
      onRemoveDriveFolderSummary?.(item.folderId, item.folderName);
      return;
    }
    await Promise.all([
      removeSavedLocalFolderEntry(item.folderId),
      window.FrameCullNative?.forgetPersistedFolder?.(item.folderId),
    ]);
    await refreshSavedLocalItems();
  };

  const formatShortDate = (ms: number) => {
    if (!ms) return '';
    try {
      return new Date(ms).toLocaleDateString(locale, {
        day: 'numeric',
        month: 'short',
      });
    } catch {
      return '';
    }
  };

  const knownGoogleEmail = userEmail || rememberedEmail;

  return (
    <main className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 pt-5 pb-24 md:pb-12 space-y-6">
      {/* Top Header */}
      <div className="pb-5 border-b border-zinc-800/80 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-zinc-50 [text-wrap:balance]">
            {t('Lokální úložiště', 'Local Storage')}
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            {t(
              'Rozpracované složky a vestavěný průzkumník úložiště zařízení, SD karet i USB disků.',
              'In-progress folders and built-in explorer for device storage, SD cards, and USB drives.'
            )}
          </p>
        </div>
        <div className="hidden sm:flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
          <HardDrive className="w-5 h-5" aria-hidden="true" />
        </div>
      </div>

      {/* Active Open Session Quick Resume Banner */}
      {activeFolder && (
        <section
          aria-label={t('Právě otevřená složka', 'Currently open folder')}
          className="rounded-2xl border border-zinc-800 bg-[#141417] p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
        >
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium text-zinc-400">
              {t('Právě otevřeno', 'Currently open')} ·{' '}
              {activeFolder.sourceKind && activeFolder.sourceKind !== 'drive'
                ? t('Lokální úložiště', 'Local Storage')
                : 'Google Drive'}
            </p>
            <h2 className="font-display text-base sm:text-lg font-semibold text-zinc-100 truncate">
              {activeFolder.name}
            </h2>
            <p className="text-xs text-zinc-400 tabular-nums">
              {formatNumber(activePhotosCount)}{' '}
              {plural(
                activePhotosCount,
                ['soubor', 'soubory', 'souborů'],
                ['file', 'files']
              )}
              {pickedCount > 0
                ? ` · ${t('Vybráno', 'Picked')} ★ ${formatNumber(pickedCount)}`
                : ''}
              {trashCount > 0
                ? ` · ${t('Ke smazání', 'To delete')} ${formatNumber(trashCount)}`
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
                {t(`Uložit výběr (${pickedCount})`, `Save picks (${pickedCount})`)}
              </button>
            )}
            {trashCount > 0 && (
              <button
                type="button"
                onClick={onOpenFinishTrash}
                className="min-h-[42px] px-3.5 py-2 rounded-xl border border-rose-500/40 bg-rose-500/10 text-xs font-semibold text-rose-200 hover:bg-rose-500/20 transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums"
              >
                {t(
                  `Dokončit mazání (${trashCount})`,
                  `Finish deleting (${trashCount})`
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenStudio('select')}
              className="min-h-[42px] px-4 py-2 rounded-xl bg-amber-500 text-zinc-950 hover:bg-amber-400 text-sm font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Star className="w-4 h-4 fill-current shrink-0" aria-hidden="true" />
              <span>{t('Výběr', 'Select')}</span>
            </button>
            <button
              type="button"
              onClick={() => onOpenStudio('delete')}
              className="min-h-[42px] px-4 py-2 rounded-xl bg-rose-500 text-white hover:bg-rose-400 text-sm font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Trash2 className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{t('Mazání', 'Delete')}</span>
            </button>
          </div>
        </section>
      )}

      {/* TOP SECTION: Rozpracované složky (Local + Google Drive) */}
      <section
        aria-label={t('Rozpracované složky', 'In-progress folders')}
        className="space-y-3"
      >
        <div className="flex items-baseline justify-between px-0.5 gap-2">
          <h2 className="font-display text-base sm:text-lg font-semibold text-zinc-100">
            {t('Rozpracované složky', 'In-Progress Folders')}
          </h2>
          {savedItems.length > 0 && (
            <span className="text-xs text-zinc-500 tabular-nums shrink-0">
              {formatNumber(savedItems.length)}{' '}
              {plural(
                savedItems.length,
                ['složka', 'složky', 'složek'],
                ['folder', 'folders']
              )}
            </span>
          )}
        </div>

        {reopenNotice && (
          <p
            role="status"
            className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200 leading-relaxed"
          >
            {reopenNotice}
          </p>
        )}

        {savedItems.length === 0 ? (
          <div className="rounded-xl border border-zinc-800/80 bg-[#141417]/60 px-4 py-3.5 text-xs text-zinc-400 leading-relaxed">
            {t(
              'Zatím žádné rozpracované složky. Otevřete libovolnou složku v průzkumníku níže — pozice i označené záběry se uloží automaticky.',
              'No in-progress folders yet. Open any folder in the explorer below — your position and marked shots are saved automatically.'
            )}
          </div>
        ) : (
          <div className="rounded-2xl border border-zinc-800 bg-[#141417] overflow-hidden">
            <ul className="divide-y divide-zinc-800/80">
              {visibleSavedItems.map((item) => {
                const isReopening = reopeningId === item.folderId;
                const isCurrentlyActive = activeFolder?.id === item.folderId;
                const isDriveItem = item.source === 'drive';

                const metaParts: string[] = [
                  isDriveItem
                    ? 'Google Drive'
                    : t('Lokální úložiště', 'Local Storage'),
                ];
                if (isCurrentlyActive) {
                  metaParts.push(t('Otevřeno', 'Open'));
                }
                if (item.keepCount > 0) {
                  metaParts.push(
                    `${t('Vybráno', 'Picked')} ★ ${formatNumber(item.keepCount)}`
                  );
                }
                if (item.trashCount > 0) {
                  metaParts.push(
                    `${t('Ke smazání', 'To delete')} ${formatNumber(item.trashCount)}`
                  );
                }
                if (item.keepCount === 0 && item.trashCount === 0) {
                  metaParts.push(
                    t('Připraveno k pokračování', 'Ready to resume')
                  );
                }
                if (item.lastShotName) {
                  metaParts.push(item.lastShotName);
                } else if (item.updatedAtMs) {
                  const formattedDate = formatShortDate(item.updatedAtMs);
                  if (formattedDate) metaParts.push(formattedDate);
                }

                return (
                  <li
                    key={`${item.source}:${item.folderId}`}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 hover:bg-zinc-800/35 transition-colors"
                  >
                    <div className="flex items-center gap-3.5 min-w-0 flex-1">
                      <div
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                          isDriveItem
                            ? 'bg-sky-500/10 text-sky-300'
                            : 'bg-zinc-800/90 text-zinc-200'
                        }`}
                      >
                        {isDriveItem ? (
                          <Cloud className="w-5 h-5" aria-hidden="true" />
                        ) : (
                          <Folder className="w-5 h-5" aria-hidden="true" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-zinc-100 truncate">
                          {item.folderName}
                        </p>
                        <p className="text-xs text-zinc-400 tabular-nums truncate mt-0.5">
                          {metaParts.join(' · ')}
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
                        <span>
                          {isReopening
                            ? t('Otevírám…', 'Opening…')
                            : t('Výběr', 'Select')}
                        </span>
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
                        <span>{t('Mazání', 'Delete')}</span>
                      </button>

                      <button
                        type="button"
                        onClick={(e) => void handleRemoveSavedItem(e, item)}
                        aria-label={t(
                          `Odebrat záznam složky ${item.folderName}`,
                          `Remove folder record ${item.folderName}`
                        )}
                        title={t('Odebrat ze seznamu', 'Remove from list')}
                        className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/70 transition-colors shrink-0 cursor-pointer"
                      >
                        <X className="w-4 h-4" aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>

            {hiddenSavedCount > 0 && (
              <div className="border-t border-zinc-800/80 px-4 py-2 bg-[#111114]">
                <button
                  type="button"
                  onClick={() => setShowAllSaved((prev) => !prev)}
                  className="w-full min-h-[38px] inline-flex items-center justify-center gap-1.5 text-xs font-medium text-zinc-300 hover:text-white transition-colors cursor-pointer"
                >
                  {showAllSaved ? (
                    <>
                      <ChevronUp className="w-4 h-4" aria-hidden="true" />
                      <span>{t('Sbalit seznam', 'Show fewer')}</span>
                    </>
                  ) : (
                    <>
                      <ChevronDown className="w-4 h-4" aria-hidden="true" />
                      <span>
                        {t(
                          `Zobrazit všechny rozpracované (${formatNumber(savedItems.length)})`,
                          `Show all in-progress (${formatNumber(savedItems.length)})`
                        )}
                      </span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* MAIN FOCAL SECTION UNDERNEATH: In-App Local Folder Explorer */}
      <LocalFolderExplorer
        localSummaries={localSummaries}
        onStartLocalStream={onStartLocalStream}
        onFolderOpened={() => void refreshSavedLocalItems()}
      />

      {/* Compact Secondary Google Drive Row */}
      <section
        aria-label={t('Propojení s Google Drive', 'Google Drive connection')}
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
      >
        <div className="flex items-center gap-3.5 min-w-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-300">
            <Cloud className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="font-display text-sm sm:text-base font-semibold text-zinc-100">
              Google Drive
            </h2>
            <p className="text-xs text-zinc-400 truncate">
              {isAuthenticated && hasDriveToken
                ? t(
                    `Připojeno jako ${knownGoogleEmail || 'Google účet'}`,
                    `Connected as ${knownGoogleEmail || 'Google account'}`
                  )
                : isAuthenticated || knownGoogleEmail
                  ? t(
                      `Zapamatovaný účet ${knownGoogleEmail}`,
                      `Remembered account ${knownGoogleEmail}`
                    )
                  : t(
                      'Volitelné cloudové úložiště pro třídění složek na Google Drive',
                      'Optional cloud storage for culling Google Drive folders'
                    )}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onNavigateDrive}
          className="min-h-[44px] px-4 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-100 text-xs sm:text-sm font-semibold hover:border-zinc-500 hover:bg-zinc-900 transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <span>
            {isAuthenticated && hasDriveToken
              ? t('Procházet Google Drive', 'Browse Google Drive')
              : t('Otevřít Google Drive', 'Open Google Drive')}
          </span>
          <ChevronRight className="w-4 h-4 text-zinc-400 shrink-0" aria-hidden="true" />
        </button>
      </section>
    </main>
  );
};

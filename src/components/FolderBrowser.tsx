import React, { useEffect, useState, useCallback } from 'react';
import {
  Folder,
  ChevronRight,
  Search,
  RefreshCw,
  ArrowLeft,
  Images,
  Users,
  HardDrive,
  Cloud,
  Star,
  Trash2,
} from 'lucide-react';
import {
  AuthExpiredError,
  DriveFolder,
  listDriveFolders,
} from '../lib/driveApi';
import { PersistedFolderSummary, WorkflowMode } from '../lib/cullPersistence';
import { GoogleSignInButton } from './GoogleSignInButton';
import { useI18n } from '../lib/i18n';

interface BreadcrumbItem {
  id: string;
  name: string;
}

interface FolderBrowserProps {
  authResolved?: boolean;
  isAuthenticated?: boolean;
  accessToken: string | null;
  userEmail?: string | null;
  rememberedEmail?: string | null;
  onReconnectDrive?: () => void;
  onSwitchAccount?: () => void;
  onNavigatePhone?: () => void;
  isReconnectingDrive?: boolean;
  driveAuthNotice?: string | null;
  onSelectFolder: (folder: DriveFolder, mode: WorkflowMode) => void;
  onAuthExpired: () => void;
  isLoadingPhotos: boolean;
  loadingFolderId: string | null;
  folderSummaries?: Record<string, PersistedFolderSummary>;
}

export const FolderBrowser: React.FC<FolderBrowserProps> = ({
  authResolved = true,
  isAuthenticated = false,
  accessToken,
  userEmail,
  rememberedEmail,
  onReconnectDrive,
  onSwitchAccount,
  onNavigatePhone,
  isReconnectingDrive = false,
  driveAuthNotice = null,
  onSelectFolder,
  onAuthExpired,
  isLoadingPhotos,
  loadingFolderId,
  folderSummaries = {},
}) => {
  const { t, locale, formatNumber } = useI18n();
  const [tab, setTab] = useState<'my-drive' | 'shared'>('my-drive');
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([
    { id: 'root', name: 'Můj disk' },
  ]);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const rootCrumbLabel =
    tab === 'my-drive'
      ? t('Můj disk', 'My Drive')
      : t('Sdílené se mnou', 'Shared with me');
  const getCrumbDisplayName = (crumb: BreadcrumbItem, idx: number) =>
    idx === 0 && crumb.id === 'root' ? rootCrumbLabel : crumb.name;
  const currentFolder = breadcrumbs[breadcrumbs.length - 1];
  const currentFolderDisplayName = getCrumbDisplayName(
    currentFolder,
    breadcrumbs.length - 1
  );
  const knownEmail = userEmail || rememberedEmail;

  const loadFolders = useCallback(async () => {
    if (!accessToken) {
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const items = await listDriveFolders(accessToken, {
        parentId: currentFolder.id,
        sharedWithMe: tab === 'shared' && breadcrumbs.length === 1,
        searchQuery: activeSearch,
      });
      setFolders(items);
    } catch (err: unknown) {
      if (err instanceof AuthExpiredError) {
        onAuthExpired();
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : t(
              'Nepodařilo se načíst složky z Google Drive.',
              'Could not load folders from Google Drive.'
            )
      );
    } finally {
      setLoading(false);
    }
  }, [
    accessToken,
    currentFolder.id,
    tab,
    breadcrumbs.length,
    activeSearch,
    onAuthExpired,
    t,
  ]);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  const handleEnterFolder = (folder: DriveFolder) => {
    setActiveSearch('');
    setSearchInput('');
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
  };

  const handleBreadcrumbClick = (index: number) => {
    setActiveSearch('');
    setSearchInput('');
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
  };

  const handleSwitchTab = (nextTab: 'my-drive' | 'shared') => {
    setTab(nextTab);
    setActiveSearch('');
    setSearchInput('');
    setBreadcrumbs([
      {
        id: 'root',
        name:
          nextTab === 'my-drive'
            ? t('Můj disk', 'My Drive')
            : t('Sdílené se mnou', 'Shared with me'),
      },
    ]);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setActiveSearch(searchInput.trim());
  };

  const handleClearSearch = () => {
    setSearchInput('');
    setActiveSearch('');
  };

  const formatDate = (iso?: string) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString(locale, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return '';
    }
  };

  return (
    <section className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 pt-5 pb-24 md:pb-12">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-5 border-b border-zinc-800/80">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-zinc-50">
            Google Drive
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            {knownEmail
              ? t(
                  `Účet ${knownEmail} · Procházejte složky a otevřete je samostatně pro výběr nebo mazání.`,
                  `Account ${knownEmail} · Browse folders and open any of them to select or delete photos.`
                )
              : t(
                  'Připojte svůj Google účet pro otevírání a správu složek na Google Drive.',
                  'Connect your Google account to browse and cull folders on Google Drive.'
                )}
          </p>
        </div>

        {accessToken && (
          <div className="flex items-center gap-1 p-1 bg-[#141417] border border-zinc-800 rounded-xl self-start md:self-auto">
            <button
              type="button"
              onClick={() => handleSwitchTab('my-drive')}
              className={`flex items-center gap-2 min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                tab === 'my-drive'
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Cloud className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{t('Můj disk', 'My Drive')}</span>
            </button>
            <button
              type="button"
              onClick={() => handleSwitchTab('shared')}
              className={`flex items-center gap-2 min-h-[38px] px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                tab === 'shared'
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Users className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{t('Sdílené se mnou', 'Shared with me')}</span>
            </button>
          </div>
        )}
      </div>

      {!authResolved ? (
        <div className="mt-10 py-12 flex items-center justify-center">
          <div className="flex items-center gap-3 text-sm text-zinc-400">
            <span className="h-4 w-4 rounded-full border-2 border-zinc-700 border-t-amber-400 animate-spin" />
            <span>
              {t(
                'Obnovuji zapamatované přihlášení…',
                'Restoring saved sign-in…'
              )}
            </span>
          </div>
        </div>
      ) : !isAuthenticated && !knownEmail ? (
        <div className="mt-6 rounded-2xl border border-zinc-800 bg-[#141417] p-6 sm:p-8 max-w-2xl space-y-5">
          <div className="space-y-2">
            <h2 className="font-display text-xl font-semibold text-zinc-100">
              {t('Přihlásit se ke Google Drive', 'Sign in to Google Drive')}
            </h2>
            <p className="text-sm text-zinc-400 leading-relaxed">
              {t(
                'Po přihlášení si aplikace váš Google účet zapamatuje. Budete moci kdykoliv otevírat složky, plynule pokračovat v rozpracovaném výběru a ukládat fotky včetně RAWů přímo do složky Liked nebo koše.',
                'Once signed in, Selectra remembers your Google account so you can open folders anytime, resume culling where you left off, and save JPG + RAW picks directly to Liked or Trash.'
              )}
            </p>
          </div>

          {driveAuthNotice && (
            <p role="alert" className="text-xs text-rose-400">
              {driveAuthNotice}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {onReconnectDrive && (
              <GoogleSignInButton
                onClick={onReconnectDrive}
                loading={isReconnectingDrive}
                label={t('Přihlásit se přes Google', 'Sign in with Google')}
              />
            )}
            {onNavigatePhone && (
              <button
                type="button"
                onClick={onNavigatePhone}
                className="min-h-[44px] px-4 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-200 text-sm font-medium hover:border-zinc-500 hover:text-white transition-colors inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
              >
                <HardDrive
                  className="w-4 h-4 text-zinc-400 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  {t('Zpět na lokální úložiště', 'Back to local storage')}
                </span>
              </button>
            )}
          </div>
        </div>
      ) : !accessToken ? (
        <div className="mt-6 rounded-2xl border border-zinc-800 bg-[#141417] p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-5">
          <div className="space-y-1.5 max-w-xl">
            <p className="text-base font-semibold text-zinc-100">
              {t(
                `Účet ${knownEmail || 'Google'} je v aplikaci zapamatován`,
                `Account ${knownEmail || 'Google'} is remembered`
              )}
            </p>
            <p className="text-sm text-zinc-400 leading-relaxed">
              {driveAuthNotice ||
                t(
                  'Pro zobrazení a správu složek na Google Drive potvrďte pokračování pod svým uloženým účtem. Veškerý rozpracovaný postup je zachován.',
                  'Confirm continuing with your saved account to browse and manage Google Drive folders. All saved progress is preserved.'
                )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={onReconnectDrive}
              disabled={isReconnectingDrive}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-zinc-100 text-zinc-950 text-sm font-semibold hover:bg-white transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              {isReconnectingDrive
                ? t('Obnovuji přístup…', 'Restoring access…')
                : t('Otevřít uložený Drive', 'Open saved Drive')}
            </button>
            {onSwitchAccount && (
              <button
                type="button"
                onClick={onSwitchAccount}
                disabled={isReconnectingDrive}
                className="min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-200 text-sm font-medium hover:border-zinc-500 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                {t('Jiný účet', 'Switch account')}
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Toolbar: Breadcrumbs + Search */}
          <div className="mt-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <nav
              aria-label={t('Cesta ke složce', 'Folder path')}
              className="flex flex-wrap items-center gap-1.5 text-sm min-h-[40px]"
            >
              {breadcrumbs.length > 1 && (
                <button
                  type="button"
                  onClick={() => handleBreadcrumbClick(breadcrumbs.length - 2)}
                  className="mr-1 inline-flex items-center justify-center min-h-[36px] min-w-[36px] rounded-lg border border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors cursor-pointer"
                  aria-label={t('Zpět o úroveň výš', 'Go up one level')}
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}
              {breadcrumbs.map((crumb, idx) => {
                const isLast = idx === breadcrumbs.length - 1;
                return (
                  <React.Fragment key={`${crumb.id}-${idx}`}>
                    {idx > 0 && (
                      <ChevronRight
                        className="w-4 h-4 text-zinc-600 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => handleBreadcrumbClick(idx)}
                      disabled={isLast && !activeSearch}
                      className={`px-2 py-1 rounded-md transition-colors truncate max-w-[200px] ${
                        isLast && !activeSearch
                          ? 'font-semibold text-zinc-100 cursor-default'
                          : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 cursor-pointer'
                      }`}
                    >
                      {getCrumbDisplayName(crumb, idx)}
                    </button>
                  </React.Fragment>
                );
              })}

              {activeSearch && (
                <>
                  <ChevronRight className="w-4 h-4 text-zinc-600 shrink-0" />
                  <span className="text-amber-400 font-medium">
                    {t(
                      `Hledání: „${activeSearch}“`,
                      `Search: "${activeSearch}"`
                    )}
                  </span>
                </>
              )}
            </nav>

            <div className="flex items-center gap-2">
              <form
                onSubmit={handleSearchSubmit}
                className="relative flex-1 sm:w-72"
              >
                <Search
                  className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder={t('Hledat složku…', 'Search folders…')}
                  className="w-full h-10 pl-9 pr-16 rounded-lg bg-[#141417] border border-zinc-800 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
                />
                {(searchInput || activeSearch) && (
                  <button
                    type="button"
                    onClick={handleClearSearch}
                    className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer"
                  >
                    {t('Zrušit', 'Clear')}
                  </button>
                )}
              </form>

              <button
                type="button"
                onClick={loadFolders}
                disabled={loading}
                className="inline-flex items-center justify-center min-h-[40px] min-w-[40px] rounded-lg border border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors cursor-pointer disabled:opacity-50"
                aria-label={t('Obnovit seznam složek', 'Refresh folder list')}
                title={t('Obnovit', 'Refresh')}
              >
                <RefreshCw
                  className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
                />
              </button>
            </div>
          </div>

          {/* Action bar for currently opened folder */}
          {!activeSearch && (tab === 'my-drive' || breadcrumbs.length > 1) && (
            <div className="mt-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-zinc-800 bg-[#141417] p-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
                  <Images className="w-5 h-5" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-100 truncate">
                    {t('Aktuální složka', 'Current folder')}:{' '}
                    {currentFolderDisplayName}
                  </p>
                  <p className="text-xs text-zinc-400 tabular-nums truncate">
                    {(() => {
                      const summary = folderSummaries[currentFolder.id];
                      const reviewed =
                        (summary?.keepCount || 0) + (summary?.trashCount || 0);
                      if (summary && reviewed > 0) {
                        const parts: string[] = [];
                        if (summary.keepCount > 0) {
                          parts.push(
                            `${t('vybráno', 'picked')} ★ ${formatNumber(summary.keepCount)}`
                          );
                        }
                        if (summary.trashCount > 0) {
                          parts.push(
                            `${t('ke smazání', 'to delete')} ${formatNumber(summary.trashCount)}`
                          );
                        }
                        const base = `${t('Uložený postup', 'Saved progress')}: ${parts.join(' · ')}`;
                        return summary.lastShotName
                          ? `${base} · ${t('Naposledy', 'Last')} ${summary.lastShotName}`
                          : base;
                      }
                      if (summary?.lastShotName) {
                        return `${t('Uložená pozice', 'Saved position')}: ${summary.lastShotName}`;
                      }
                      return t(
                        'Načte všechny fotografie a RAW soubory (CR3, CR2, NEF, ARW, DNG) v této složce',
                        'Loads all photos and RAW files (CR3, CR2, NEF, ARW, DNG) in this folder'
                      );
                    })()}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={isLoadingPhotos}
                  onClick={() =>
                    onSelectFolder(
                      {
                        id: currentFolder.id,
                        name: currentFolderDisplayName,
                      },
                      'select'
                    )
                  }
                  className="min-h-[42px] px-4 py-2 rounded-lg bg-amber-500 text-zinc-950 hover:bg-amber-400 font-semibold text-sm inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <Star
                    className="w-4 h-4 fill-current shrink-0"
                    aria-hidden="true"
                  />
                  <span>
                    {isLoadingPhotos && loadingFolderId === currentFolder.id
                      ? t('Načítám…', 'Loading…')
                      : t('Výběr v této složce', 'Select in folder')}
                  </span>
                </button>

                <button
                  type="button"
                  disabled={isLoadingPhotos}
                  onClick={() =>
                    onSelectFolder(
                      {
                        id: currentFolder.id,
                        name: currentFolderDisplayName,
                      },
                      'delete'
                    )
                  }
                  className="min-h-[42px] px-4 py-2 rounded-lg bg-rose-500 text-white hover:bg-rose-400 font-semibold text-sm inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>{t('Mazání v této složce', 'Delete in folder')}</span>
                </button>
              </div>
            </div>
          )}

          {/* Folder List */}
          <div className="mt-5 rounded-xl border border-zinc-800 bg-[#141417] overflow-hidden">
            {error ? (
              <div className="p-8 text-center space-y-3">
                <p className="text-sm text-rose-400">{error}</p>
                <button
                  type="button"
                  onClick={loadFolders}
                  className="px-4 py-2 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-100 hover:bg-zinc-700 cursor-pointer"
                >
                  {t('Zkusit znovu', 'Try again')}
                </button>
              </div>
            ) : loading ? (
              <div className="divide-y divide-zinc-800/70">
                {Array.from({ length: 5 }).map((_, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between px-4 py-3.5 animate-pulse"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-zinc-800" />
                      <div className="space-y-1.5">
                        <div className="h-4 w-44 rounded bg-zinc-800" />
                        <div className="h-3 w-24 rounded bg-zinc-800/70" />
                      </div>
                    </div>
                    <div className="h-9 w-28 rounded-lg bg-zinc-800" />
                  </div>
                ))}
              </div>
            ) : folders.length === 0 ? (
              <div className="p-10 text-center space-y-2">
                <p className="text-sm font-medium text-zinc-300">
                  {activeSearch
                    ? t(
                        `Žádné složky neodpovídají hledání „${activeSearch}“.`,
                        `No folders match "${activeSearch}".`
                      )
                    : t(
                        'V této složce nejsou žádné další podsložky.',
                        'There are no subfolders in this folder.'
                      )}
                </p>
                <p className="text-xs text-zinc-500">
                  {t(
                    `Pokud jsou fotografie přímo v „${currentFolderDisplayName}“, použijte tlačítka „Výběr v této složce“ nebo „Mazání v této složce“ výše.`,
                    `If photos are stored directly in "${currentFolderDisplayName}", use "Select in folder" or "Delete in folder" above.`
                  )}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-zinc-800/70">
                {folders.map((folder) => {
                  const isSelecting =
                    isLoadingPhotos && loadingFolderId === folder.id;
                  const summary = folderSummaries[folder.id];
                  const reviewedCount =
                    (summary?.keepCount || 0) + (summary?.trashCount || 0);
                  return (
                    <li
                      key={folder.id}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 hover:bg-zinc-800/35 transition-colors"
                    >
                      <button
                        type="button"
                        onClick={() => handleEnterFolder(folder)}
                        className="flex items-center gap-3.5 min-w-0 flex-1 text-left cursor-pointer py-1 focus-visible:outline-2 focus-visible:outline-amber-500 rounded-md"
                      >
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-800/80 text-zinc-300">
                          <Folder className="w-5 h-5" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-zinc-100 truncate">
                            {folder.name}
                          </p>
                          <p className="text-xs text-zinc-500 tabular-nums truncate">
                            {folder.modifiedTime
                              ? `${t('Upraveno', 'Modified')} ${formatDate(folder.modifiedTime)}`
                              : t('Složka Google Drive', 'Google Drive folder')}
                            {reviewedCount > 0 ? (
                              <span className="text-zinc-300">
                                {' · '}
                                {summary && summary.keepCount > 0
                                  ? `${t('Vybráno', 'Picked')} ★ ${formatNumber(summary.keepCount)}`
                                  : ''}
                                {summary &&
                                summary.keepCount > 0 &&
                                summary.trashCount > 0
                                  ? ' · '
                                  : ''}
                                {summary && summary.trashCount > 0
                                  ? `${t('Ke smazání', 'To delete')} ${formatNumber(summary.trashCount)}`
                                  : ''}
                                {summary?.lastShotName
                                  ? ` · ${summary.lastShotName}`
                                  : ''}
                              </span>
                            ) : summary?.lastShotName ? (
                              <span className="text-amber-300/90">
                                {' '}
                                · {t('Naposledy', 'Last')} {summary.lastShotName}
                              </span>
                            ) : null}
                          </p>
                        </div>
                      </button>

                      <div className="flex items-center gap-1.5 self-end sm:self-auto shrink-0">
                        <button
                          type="button"
                          onClick={() => handleEnterFolder(folder)}
                          className="min-h-[40px] px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-white rounded-lg border border-zinc-800 hover:border-zinc-700 transition-colors whitespace-nowrap cursor-pointer"
                        >
                          {t('Otevřít', 'Open')}
                        </button>
                        <button
                          type="button"
                          disabled={isLoadingPhotos}
                          onClick={() => onSelectFolder(folder, 'select')}
                          className="min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 inline-flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
                        >
                          <Star
                            className="w-3.5 h-3.5 fill-current shrink-0"
                            aria-hidden="true"
                          />
                          <span>
                            {isSelecting
                              ? t('Načítám…', 'Loading…')
                              : t('Výběr', 'Select')}
                          </span>
                        </button>
                        <button
                          type="button"
                          disabled={isLoadingPhotos}
                          onClick={() => onSelectFolder(folder, 'delete')}
                          className="min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 inline-flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
                        >
                          <Trash2
                            className="w-3.5 h-3.5 shrink-0"
                            aria-hidden="true"
                          />
                          <span>{t('Mazání', 'Delete')}</span>
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
};

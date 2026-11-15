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
  Smartphone,
} from 'lucide-react';
import {
  AuthExpiredError,
  DriveFolder,
  listDriveFolders,
} from '../lib/driveApi';
import { PersistedFolderSummary } from '../lib/cullPersistence';
import { AppMode } from '../lib/appMode';
import { GoogleSignInButton } from './GoogleSignInButton';

interface BreadcrumbItem {
  id: string;
  name: string;
}

interface FolderBrowserProps {
  appMode?: AppMode;
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
  onSelectFolder: (folder: DriveFolder) => void;
  onAuthExpired: () => void;
  isLoadingPhotos: boolean;
  loadingFolderId: string | null;
  folderSummaries?: Record<string, PersistedFolderSummary>;
}

export const FolderBrowser: React.FC<FolderBrowserProps> = ({
  appMode = 'selectra',
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
  const isFrameCull = appMode === 'framecull';
  const [tab, setTab] = useState<'my-drive' | 'shared'>('my-drive');
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([
    { id: 'root', name: 'Můj disk' },
  ]);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const currentFolder = breadcrumbs[breadcrumbs.length - 1];
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
          : 'Nepodařilo se načíst složky z Google Drive.'
      );
    } finally {
      setLoading(false);
    }
  }, [accessToken, currentFolder.id, tab, breadcrumbs.length, activeSearch, onAuthExpired]);

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
        name: nextTab === 'my-drive' ? 'Můj disk' : 'Sdílené se mnou',
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
      return new Date(iso).toLocaleDateString('cs-CZ', {
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
              ? `Účet ${knownEmail} · Procházejte a spravujte složky na cloudu.`
              : 'Připojte svůj Google účet pro otevírání a správu složek na Google Drive.'}
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
              <HardDrive className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Můj disk</span>
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
              <span>Sdílené se mnou</span>
            </button>
          </div>
        )}
      </div>

      {!authResolved ? (
        <div className="mt-10 py-12 flex items-center justify-center">
          <div className="flex items-center gap-3 text-sm text-zinc-400">
            <span className="h-4 w-4 rounded-full border-2 border-zinc-700 border-t-amber-400 animate-spin" />
            <span>Obnovuji zapamatované přihlášení…</span>
          </div>
        </div>
      ) : !isAuthenticated && !knownEmail ? (
        <div className="mt-6 rounded-2xl border border-zinc-800 bg-[#141417] p-6 sm:p-8 max-w-2xl space-y-5">
          <div className="space-y-2">
            <h2 className="font-display text-xl font-semibold text-zinc-100">
              Přihlásit se ke Google Drive
            </h2>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Po přihlášení si aplikace váš Google účet zapamatuje. Budete moci
              kdykoliv otevírat složky, plynule pokračovat v rozpracovaném
              výběru a ukládat fotky včetně RAWů přímo do složky Liked nebo
              koše.
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
                label="Přihlásit se přes Google"
              />
            )}
            {onNavigatePhone && (
              <button
                type="button"
                onClick={onNavigatePhone}
                className="min-h-[44px] px-4 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-200 text-sm font-medium hover:border-zinc-500 hover:text-white transition-colors inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
              >
                <Smartphone className="w-4 h-4 text-zinc-400 shrink-0" aria-hidden="true" />
                <span>Zpět na soubory v telefonu</span>
              </button>
            )}
          </div>
        </div>
      ) : !accessToken ? (
        <div className="mt-6 rounded-2xl border border-zinc-800 bg-[#141417] p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-5">
          <div className="space-y-1.5 max-w-xl">
            <p className="text-base font-semibold text-zinc-100">
              Účet {knownEmail || 'Google'} je v aplikaci zapamatován
            </p>
            <p className="text-sm text-zinc-400 leading-relaxed">
              {driveAuthNotice ||
                'Pro zobrazení a správu složek na Google Drive potvrďte pokračování pod svým uloženým účtem. Veškerý rozpracovaný postup je zachován.'}
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
                ? 'Obnovuji přístup…'
                : 'Otevřít uložený Drive'}
            </button>
            {onSwitchAccount && (
              <button
                type="button"
                onClick={onSwitchAccount}
                disabled={isReconnectingDrive}
                className="min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-200 text-sm font-medium hover:border-zinc-500 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                Jiný účet
              </button>
            )}
          </div>
        </div>
      ) : (
        <>

      {/* Toolbar: Breadcrumbs + Search */}
      <div className="mt-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <nav
          aria-label="Cesta ke složce"
          className="flex flex-wrap items-center gap-1.5 text-sm min-h-[40px]"
        >
          {breadcrumbs.length > 1 && (
            <button
              type="button"
              onClick={() => handleBreadcrumbClick(breadcrumbs.length - 2)}
              className="mr-1 inline-flex items-center justify-center min-h-[36px] min-w-[36px] rounded-lg border border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors cursor-pointer"
              aria-label="Zpět o úroveň výš"
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
                  {crumb.name}
                </button>
              </React.Fragment>
            );
          })}

          {activeSearch && (
            <>
              <ChevronRight className="w-4 h-4 text-zinc-600 shrink-0" />
              <span className="text-amber-400 font-medium">
                Hledání: „{activeSearch}“
              </span>
            </>
          )}
        </nav>

        <div className="flex items-center gap-2">
          <form onSubmit={handleSearchSubmit} className="relative flex-1 sm:w-72">
            <Search
              className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Hledat složku…"
              className="w-full h-10 pl-9 pr-16 rounded-lg bg-[#141417] border border-zinc-800 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
            />
            {(searchInput || activeSearch) && (
              <button
                type="button"
                onClick={handleClearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer"
              >
                Zrušit
              </button>
            )}
          </form>

          <button
            type="button"
            onClick={loadFolders}
            disabled={loading}
            className="inline-flex items-center justify-center min-h-[40px] min-w-[40px] rounded-lg border border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors cursor-pointer disabled:opacity-50"
            aria-label="Obnovit seznam složek"
            title="Obnovit"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Action bar for currently opened folder (allows culling current folder directly) */}
      {!activeSearch && (tab === 'my-drive' || breadcrumbs.length > 1) && (
        <div className="mt-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-zinc-800 bg-[#141417] p-4">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                isFrameCull
                  ? 'bg-rose-500/10 text-rose-400'
                  : 'bg-amber-500/10 text-amber-400'
              }`}
            >
              <Images className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-100 truncate">
                Aktuální složka: {currentFolder.name}
              </p>
              <p className="text-xs text-zinc-400 tabular-nums truncate">
                {(() => {
                  const summary = folderSummaries[currentFolder.id];
                  const reviewed =
                    (summary?.keepCount || 0) + (summary?.trashCount || 0);
                  if (summary && reviewed > 0) {
                    const base = isFrameCull
                      ? `Uložený postup: ke smazání ${summary.trashCount.toLocaleString('cs-CZ')} · ponecháno ${summary.keepCount.toLocaleString('cs-CZ')}`
                      : `Uložený postup: vybráno ★ ${summary.keepCount.toLocaleString('cs-CZ')} · zahozeno ${summary.trashCount.toLocaleString('cs-CZ')}`;
                    return summary.lastShotName
                      ? `${base} · Naposledy ${summary.lastShotName}`
                      : base;
                  }
                  if (summary?.lastShotName) {
                    return `Uložená pozice: ${summary.lastShotName}`;
                  }
                  return 'Načte všechny fotografie a RAW soubory (CR3, CR2, NEF, ARW, DNG) v této složce';
                })()}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={isLoadingPhotos}
            onClick={() =>
              onSelectFolder({
                id: currentFolder.id,
                name: currentFolder.name,
              })
            }
            className={`min-h-[42px] px-4 py-2 rounded-lg font-semibold text-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
              isFrameCull
                ? 'bg-rose-500 text-white hover:bg-rose-400'
                : 'bg-amber-500 text-zinc-950 hover:bg-amber-400'
            }`}
          >
            {isLoadingPhotos && loadingFolderId === currentFolder.id
              ? 'Načítám fotky…'
              : folderSummaries[currentFolder.id] &&
                  (folderSummaries[currentFolder.id].keepCount +
                    folderSummaries[currentFolder.id].trashCount >
                    0 ||
                    Boolean(folderSummaries[currentFolder.id].lastShotId))
                ? isFrameCull
                  ? 'Pokračovat v mazání'
                  : 'Pokračovat ve výběru'
                : isFrameCull
                  ? 'Třídit tuto složku'
                  : 'Vybrat v této složce'}
          </button>
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
              Zkusit znovu
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
                ? `Žádné složky neodpovídají hledání „${activeSearch}“.`
                : 'V této složce nejsou žádné další podsložky.'}
            </p>
            <p className="text-xs text-zinc-500">
              Pokud jsou fotografie přímo v „{currentFolder.name}“, použijte
              tlačítko „{isFrameCull ? 'Třídit tuto složku' : 'Vybrat v této složce'}“ výše.
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
              const hasResumeProgress =
                reviewedCount > 0 || Boolean(summary?.lastShotId);
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
                          ? `Upraveno ${formatDate(folder.modifiedTime)}`
                          : 'Složka Google Drive'}
                        {reviewedCount > 0 ? (
                          <span
                            className={
                              isFrameCull
                                ? 'text-rose-300/90'
                                : 'text-amber-300/90'
                            }
                          >
                            {' '}
                            {isFrameCull
                              ? `· Ke smazání ${(summary?.trashCount || 0).toLocaleString('cs-CZ')}${
                                  summary && summary.keepCount > 0
                                    ? ` · Ponecháno ${summary.keepCount.toLocaleString('cs-CZ')}`
                                    : ''
                                }`
                              : `· Vybráno ★ ${(summary?.keepCount || 0).toLocaleString('cs-CZ')}${
                                  summary && summary.trashCount > 0
                                    ? ` · Zahozeno ${summary.trashCount.toLocaleString('cs-CZ')}`
                                    : ''
                                }`}
                            {summary?.lastShotName
                              ? ` · ${summary.lastShotName}`
                              : ''}
                          </span>
                        ) : summary?.lastShotName ? (
                          <span className="text-amber-300/90">
                            {' '}
                            · Naposledy {summary.lastShotName}
                          </span>
                        ) : null}
                      </p>
                    </div>
                  </button>

                  <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
                    <button
                      type="button"
                      onClick={() => handleEnterFolder(folder)}
                      className="min-h-[40px] px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-white rounded-lg border border-zinc-800 hover:border-zinc-700 transition-colors whitespace-nowrap cursor-pointer"
                    >
                      Otevřít
                    </button>
                    <button
                      type="button"
                      disabled={isLoadingPhotos}
                      onClick={() => onSelectFolder(folder)}
                      className="min-h-[40px] px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-zinc-100 text-zinc-950 hover:bg-white transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
                    >
                      {isSelecting
                        ? 'Načítám…'
                        : hasResumeProgress
                          ? 'Pokračovat'
                          : isFrameCull
                            ? 'Třídit fotky'
                            : 'Vybrat fotky'}
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

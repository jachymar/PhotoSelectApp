import React, { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Database,
  Download,
  ExternalLink,
  Globe,
  HardDrive,
  Layers,
  LogOut,
  RefreshCw,
  RotateCcw,
  Settings2,
  Smartphone,
  Trash2,
  UserCheck,
  Vibrate,
} from 'lucide-react';
import { formatBytes } from '../lib/driveApi';
import {
  PartialResetScope,
  PersistedFolderSummary,
  getPartialResetOptions,
  resetDriveFolderByScope,
} from '../lib/cullPersistence';
import {
  loadAllLocalFolderSummaries,
  resetLocalFolderByScope,
} from '../lib/localPersistence';
import { clearMediaCache } from '../lib/rawParser';
import {
  CacheStorageStats,
  clearAllMediaAndSeriesCache,
  getCacheStorageStats,
  purgeCulledDetailPreviewsNow,
} from '../lib/previewCacheDb';
import {
  HapticIntensity,
  HapticSettings,
  isHapticsSupported,
  loadHapticSettings,
  saveHapticSettings,
  triggerHaptic,
} from '../lib/haptics';
import {
  UpdateCheckResult,
  checkForAppUpdate,
  completePendingApkInstall,
  formatApkSizeMb,
  formatCzechReleaseDate,
  getBakedGitHubRepo,
  getConfiguredGitHubRepo,
  getInstalledVersionInfo,
  getSavedGitHubToken,
  openReleaseUrlExternally,
  saveCustomGitHubRepo,
  saveGitHubToken,
  startUpdateDownloadAndInstall,
} from '../lib/appUpdater';
import { APP_VERSION } from '../lib/version';
import { AppLanguage, useI18n } from '../lib/i18n';
import { GoogleSignInButton } from './GoogleSignInButton';

interface AppMenuViewProps {
  isAuthenticated: boolean;
  hasDriveToken: boolean;
  userEmail?: string | null;
  rememberedEmail?: string | null;
  isSigningIn: boolean;
  authError: string | null;
  onSignIn: () => void;
  onSwitchGoogleAccount: () => void;
  onSignOut: () => void;
  onNavigateDrive: () => void;
  filmstripSeriesEnabled: boolean;
  onToggleFilmstripSeriesEnabled: (enabled: boolean) => void;
  globalCalibrationSummary?: {
    sameCount: number;
    differentCount: number;
    accuracyPct: number;
    minScore: number;
    exampleCount: number;
  } | null;
  onResetGlobalCalibration?: () => void;
  userId?: string | null;
  driveFolderSummaries?: PersistedFolderSummary[];
  onFolderSummaryUpdated?: (
    folderId: string,
    summary: PersistedFolderSummary | null,
    isDrive: boolean,
    scope: PartialResetScope
  ) => void;
  initialUpdateCheck?: UpdateCheckResult | null;
  onUpdateCheckChange?: (result: UpdateCheckResult) => void;
}

export const AppMenuView: React.FC<AppMenuViewProps> = ({
  isAuthenticated,
  hasDriveToken,
  userEmail,
  rememberedEmail,
  isSigningIn,
  authError,
  onSignIn,
  onSwitchGoogleAccount,
  onSignOut,
  onNavigateDrive,
  filmstripSeriesEnabled,
  onToggleFilmstripSeriesEnabled,
  globalCalibrationSummary = null,
  onResetGlobalCalibration,
  userId = null,
  driveFolderSummaries = [],
  onFolderSummaryUpdated,
  initialUpdateCheck = null,
  onUpdateCheckChange,
}) => {
  const { lang, isEn, setLang, t, formatNumber, plural } = useI18n();
  const partialResetOptions = getPartialResetOptions(lang);

  const [haptics, setHaptics] = useState<HapticSettings>(() =>
    loadHapticSettings()
  );
  const hapticsAvailable = isHapticsSupported();
  const displayEmail = userEmail || rememberedEmail;

  const [installedLabel, setInstalledLabel] = useState<string>(APP_VERSION);
  const [installedCode, setInstalledCode] = useState<number | null>(null);
  const [isNativeAndroid, setIsNativeAndroid] = useState<boolean>(false);
  const [apkSha1, setApkSha1] = useState<string | null>(null);
  const [copiedSha1, setCopiedSha1] = useState<boolean>(false);

  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(
    initialUpdateCheck
  );
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isDownloadingApk, setIsDownloadingApk] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState<number>(0);
  const [needsInstallPermission, setNeedsInstallPermission] = useState(false);
  const [installNotice, setInstallNotice] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const [showRepoSettings, setShowRepoSettings] = useState(false);
  const [repoInput, setRepoInput] = useState<string>(() =>
    getConfiguredGitHubRepo()
  );
  const [tokenInput, setTokenInput] = useState<string>(() =>
    getSavedGitHubToken()
  );
  const bakedRepo = getBakedGitHubRepo();

  const [cacheStats, setCacheStats] = useState<CacheStorageStats | null>(null);
  const [isLoadingCacheStats, setIsLoadingCacheStats] = useState(true);
  const [isPurgingCulled, setIsPurgingCulled] = useState(false);
  const [isClearingAllCache, setIsClearingAllCache] = useState(false);
  const [confirmClearAllCache, setConfirmClearAllCache] = useState(false);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);

  const [localSummaries, setLocalSummaries] = useState<
    PersistedFolderSummary[]
  >([]);
  const [selectedResetFolderKey, setSelectedResetFolderKey] =
    useState<string>('');
  const [isResettingFolderScope, setIsResettingFolderScope] = useState(false);
  const [resetFolderNotice, setResetFolderNotice] = useState<string | null>(
    null
  );

  useEffect(() => {
    let active = true;
    void loadAllLocalFolderSummaries()
      .then((map) => {
        if (!active) return;
        setLocalSummaries(Object.values(map));
      })
      .catch(() => {
        // Ignore read failure
      });
    return () => {
      active = false;
    };
  }, []);

  const combinedResettableFolders = React.useMemo(() => {
    const items: Array<{
      key: string;
      folderId: string;
      folderName: string;
      isDrive: boolean;
      keepCount: number;
      trashCount: number;
      updatedAtMs: number;
    }> = [];
    const seen = new Set<string>();
    for (const s of localSummaries) {
      const key = `local:${s.folderId}`;
      seen.add(key);
      items.push({
        key,
        folderId: s.folderId,
        folderName: s.folderName,
        isDrive: false,
        keepCount: s.keepCount,
        trashCount: s.trashCount,
        updatedAtMs: s.updatedAtMs,
      });
    }
    for (const s of driveFolderSummaries) {
      if (s.folderId.startsWith('local-') || s.folderId.startsWith('saf-')) {
        continue;
      }
      const key = `drive:${s.folderId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        key,
        folderId: s.folderId,
        folderName: s.folderName,
        isDrive: true,
        keepCount: s.keepCount,
        trashCount: s.trashCount,
        updatedAtMs: s.updatedAtMs,
      });
    }
    return items.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }, [localSummaries, driveFolderSummaries]);

  useEffect(() => {
    if (
      combinedResettableFolders.length > 0 &&
      !combinedResettableFolders.some((f) => f.key === selectedResetFolderKey)
    ) {
      setSelectedResetFolderKey(combinedResettableFolders[0].key);
    }
  }, [combinedResettableFolders, selectedResetFolderKey]);

  const handleMenuFolderResetScope = async (scope: PartialResetScope) => {
    const target = combinedResettableFolders.find(
      (f) => f.key === selectedResetFolderKey
    );
    if (!target || isResettingFolderScope) return;
    setIsResettingFolderScope(true);
    setResetFolderNotice(null);
    try {
      let updatedSummary: PersistedFolderSummary | null = null;
      if (target.isDrive && userId) {
        updatedSummary = await resetDriveFolderByScope({
          userId,
          folderId: target.folderId,
          folderName: target.folderName,
          scope,
        });
      } else {
        updatedSummary = await resetLocalFolderByScope({
          folderId: target.folderId,
          folderName: target.folderName,
          scope,
        });
        const refreshed = await loadAllLocalFolderSummaries();
        setLocalSummaries(Object.values(refreshed));
      }
      onFolderSummaryUpdated?.(
        target.folderId,
        updatedSummary,
        target.isDrive,
        scope
      );
      const opt = partialResetOptions.find((o) => o.scope === scope);
      setResetFolderNotice(
        `${t('Hotovo', 'Done')} (${target.folderName}): ${opt?.label || scope}`
      );
    } catch (err: unknown) {
      setResetFolderNotice(
        err instanceof Error
          ? err.message
          : t(
              'Nepodařilo se vyresetovat vybranou část postupu.',
              'Failed to reset the selected progress scope.'
            )
      );
    } finally {
      setIsResettingFolderScope(false);
    }
  };

  const refreshCacheStats = async () => {
    setIsLoadingCacheStats(true);
    try {
      const stats = await getCacheStorageStats();
      setCacheStats(stats);
    } finally {
      setIsLoadingCacheStats(false);
    }
  };

  useEffect(() => {
    void refreshCacheStats();
  }, []);

  useEffect(() => {
    let active = true;
    void getInstalledVersionInfo().then((info) => {
      if (!active) return;
      setInstalledLabel(info.versionTag);
      setInstalledCode(info.versionCode);
      setIsNativeAndroid(info.isNativeAndroid);
      setApkSha1(info.sha1Fingerprint);
      if (info.hasPendingApk) {
        setNeedsInstallPermission(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const handleCopySha1 = async () => {
    if (!apkSha1) return;
    try {
      await navigator.clipboard.writeText(apkSha1);
      setCopiedSha1(true);
      window.setTimeout(() => setCopiedSha1(false), 2000);
    } catch {
      // Ignore clipboard restrictions
    }
  };

  useEffect(() => {
    if (initialUpdateCheck) {
      setUpdateCheck(initialUpdateCheck);
    }
  }, [initialUpdateCheck]);

  const handleCheckUpdates = async () => {
    setIsCheckingUpdate(true);
    setInstallError(null);
    setInstallNotice(null);
    try {
      const res = await checkForAppUpdate();
      setUpdateCheck(res);
      onUpdateCheckChange?.(res);
      if (
        res.status === 'repo_not_configured' ||
        res.status === 'private_or_no_release'
      ) {
        setShowRepoSettings(true);
      }
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const handleSaveSourceSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = saveCustomGitHubRepo(repoInput);
    setRepoInput(normalized || bakedRepo);
    saveGitHubToken(tokenInput);
    setShowRepoSettings(false);
    await handleCheckUpdates();
  };

  const handleDownloadAndInstall = async () => {
    if (updateCheck?.status !== 'update_available') return;
    setIsDownloadingApk(true);
    setDownloadPercent(0);
    setInstallError(null);
    setInstallNotice(null);
    try {
      const res = await startUpdateDownloadAndInstall(
        updateCheck.release,
        (prog) => {
          setDownloadPercent(prog.percent);
        }
      );
      if (res.status === 'needs_install_permission') {
        setNeedsInstallPermission(true);
        setInstallNotice(
          t(
            'Povolte v otevřeném nastavení přepínač „Povolit z tohoto zdroje“, vraťte se zpět a klepněte na Dokončit instalaci.',
            'Enable "Allow from this source" in the opened settings, return here, and tap Finish installation.'
          )
        );
      } else if (res.status === 'installer_launched') {
        setNeedsInstallPermission(false);
        setInstallNotice(
          t(
            'Bylo otevřeno systémové okno aktualizace Androidu. Potvrďte tlačítko Aktualizovat.',
            'Android system installer opened. Tap Update to confirm.'
          )
        );
      } else {
        setInstallNotice(
          t(
            'Stahování instalačního souboru Selectra.apk bylo otevřeno v prohlížeči.',
            'Selectra.apk download opened in your browser.'
          )
        );
      }
    } catch (err: unknown) {
      setInstallError(
        err instanceof Error
          ? err.message
          : t(
              'Stažení aktualizace se nezdařilo. Zkuste stažení v prohlížeči.',
              'Update download failed. Try downloading in your browser.'
            )
      );
    } finally {
      setIsDownloadingApk(false);
    }
  };

  const handleCompletePendingInstall = async () => {
    setInstallError(null);
    try {
      const res = await completePendingApkInstall();
      if (!res) return;
      if (res.status === 'needs_install_permission') {
        setInstallNotice(
          t(
            'Nejprve v nastavení Androidu zapněte přepínač „Povolit z tohoto zdroje“ pro aplikaci Selectra.',
            'First enable "Allow from this source" for Selectra in Android settings.'
          )
        );
      } else {
        setNeedsInstallPermission(false);
        setInstallNotice(
          t(
            'Potvrďte aktualizaci v systémovém okně Androidu.',
            'Confirm the update in the Android system dialog.'
          )
        );
      }
    } catch (err: unknown) {
      setInstallError(
        err instanceof Error
          ? err.message
          : t(
              'Nepodařilo se otevřít instalátor staženého balíčku.',
              'Could not open the downloaded package installer.'
            )
      );
    }
  };

  const handleToggleHaptics = () => {
    const next: HapticSettings = {
      ...haptics,
      enabled: !haptics.enabled,
    };
    setHaptics(next);
    saveHapticSettings(next);
    if (next.enabled) {
      triggerHaptic('selection', next);
    }
  };

  const handleSelectIntensity = (intensity: HapticIntensity) => {
    const next: HapticSettings = {
      enabled: true,
      intensity,
    };
    setHaptics(next);
    saveHapticSettings(next);
    triggerHaptic('keep', next);
  };

  const handleSelectLanguage = (nextLang: AppLanguage) => {
    if (nextLang === lang) return;
    setLang(nextLang);
    triggerHaptic('selection', haptics);
  };

  const handlePurgeCulledDetails = async () => {
    setIsPurgingCulled(true);
    setCacheNotice(null);
    try {
      const deletedCount = await purgeCulledDetailPreviewsNow();
      await refreshCacheStats();
      setCacheNotice(
        deletedCount > 0
          ? isEn
            ? `Freed ${formatNumber(deletedCount)} culled detail ${plural(deletedCount, ['náhled', 'náhledy', 'náhledů'], ['preview', 'previews'])}. Active series and 7-day gallery thumbnails were kept.`
            : `Uvolněno ${formatNumber(deletedCount)} protříděných detailních náhledů. Rozpracované série a 7denní galerie zůstaly zachovány.`
          : t(
              'Žádné protříděné detailní náhledy teď nezabírají místo.',
              'No culled detail previews are currently using storage.'
            )
      );
    } finally {
      setIsPurgingCulled(false);
    }
  };

  const handleConfirmClearAllCache = async () => {
    setIsClearingAllCache(true);
    setCacheNotice(null);
    try {
      await clearAllMediaAndSeriesCache();
      clearMediaCache();
      setConfirmClearAllCache(false);
      await refreshCacheStats();
      setCacheNotice(
        t(
          'Celá mezipaměť náhledů a zapamatovaných sérií byla vymazána. Vaše označené výběry a koše zůstaly nedotčené.',
          'All cached previews and remembered series were cleared. Your picks and trash selections remain untouched.'
        )
      );
    } finally {
      setIsClearingAllCache(false);
    }
  };

  const activeRepo = getConfiguredGitHubRepo();

  return (
    <main className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 pt-5 pb-24 md:pb-12 space-y-6">
      <div className="pb-5 border-b border-zinc-800/80">
        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-zinc-50">
          {t('Menu a nastavení', 'Menu & Settings')}
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          {t(
            'Správa jazyka, aktualizací, Google účtu a chování v telefonu.',
            'Manage language, updates, Google account, and device preferences.'
          )}
        </p>
      </div>

      {/* 0. Language Selector (Čeština / English) */}
      <section
        aria-label={t('Jazyk aplikace', 'App language')}
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-800/90 text-amber-400">
              <Globe className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="space-y-0.5 min-w-0">
              <h2 className="font-display text-lg font-semibold text-zinc-100">
                {t('Jazyk aplikace', 'Language')}
              </h2>
              <p className="text-sm text-zinc-400">
                {t(
                  'Přepnutí jazyka se projeví okamžitě v celé aplikaci.',
                  'Switch the interface language immediately across the app.'
                )}
              </p>
            </div>
          </div>

          <div
            className="grid grid-cols-2 gap-1 p-1 rounded-xl border border-zinc-800 bg-[#09090B] w-full sm:w-auto shrink-0"
            role="group"
            aria-label={t('Výběr jazyka', 'Choose language')}
          >
            <button
              type="button"
              onClick={() => handleSelectLanguage('cs')}
              aria-pressed={lang === 'cs'}
              className={`min-h-[40px] px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                lang === 'cs'
                  ? 'bg-amber-500 text-zinc-950'
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              Čeština
            </button>
            <button
              type="button"
              onClick={() => handleSelectLanguage('en')}
              aria-pressed={lang === 'en'}
              className={`min-h-[40px] px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                lang === 'en'
                  ? 'bg-amber-500 text-zinc-950'
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              English
            </button>
          </div>
        </div>
      </section>

      {/* 1. In-App APK Updates (GitHub Releases) */}
      <section
        aria-label={t('Aktualizace aplikace', 'App updates')}
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 space-y-4"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <h2 className="font-display text-lg font-semibold text-zinc-100">
              {t('Aktualizace aplikace', 'App updates')}
            </h2>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-400 tabular-nums">
              <span>
                {t('Nainstalováno', 'Installed')} {installedLabel}
              </span>
              {installedCode !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Build {installedCode}</span>
                </>
              )}
              {activeRepo && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="truncate max-w-[220px]">{activeRepo}</span>
                </>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowRepoSettings((prev) => !prev)}
            aria-expanded={showRepoSettings}
            aria-label={t(
              'Nastavení zdroje aktualizací na GitHubu',
              'GitHub update source settings'
            )}
            className="min-h-[44px] min-w-[44px] rounded-xl border border-zinc-800 bg-[#09090B] text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 inline-flex items-center justify-center transition-colors shrink-0 cursor-pointer"
          >
            <Settings2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {updateCheck?.status === 'update_available' && (
          <div className="py-3 border-y border-zinc-800/80 space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-amber-300">
                {t('Je dostupná nová verze', 'New version available')}{' '}
                {updateCheck.release.tagName}
              </p>
              <div className="flex items-center gap-1.5 text-xs text-zinc-400 tabular-nums">
                {updateCheck.release.apkSizeBytes > 0 && (
                  <span>
                    {formatApkSizeMb(updateCheck.release.apkSizeBytes, lang)}
                  </span>
                )}
                {updateCheck.release.publishedAt && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      {formatCzechReleaseDate(
                        updateCheck.release.publishedAt,
                        lang
                      )}
                    </span>
                  </>
                )}
              </div>
            </div>
            {updateCheck.release.releaseNotes && (
              <p className="text-xs text-zinc-400 leading-relaxed line-clamp-3">
                {updateCheck.release.releaseNotes}
              </p>
            )}
          </div>
        )}

        {updateCheck?.status === 'up_to_date' && (
          <p className="text-sm text-emerald-400">
            {isEn
              ? `You are on the latest available version (${updateCheck.latestTag}).`
              : `Používáte nejnovější dostupnou verzi (${updateCheck.latestTag}).`}
          </p>
        )}

        {updateCheck?.status === 'repo_not_configured' && (
          <p className="text-xs text-zinc-400 leading-relaxed">
            {isEn ? (
              <>
                Enter your GitHub repository as{' '}
                <span className="text-zinc-200 font-mono">owner/repo</span>.
                Builds created via GitHub Actions fill this automatically.
              </>
            ) : (
              <>
                Zadejte název svého GitHub repozitáře ve tvaru{' '}
                <span className="text-zinc-200 font-mono">
                  uzivatel/repozitar
                </span>
                . U balíčků sestavených přes GitHub Actions se vyplní
                automaticky.
              </>
            )}
          </p>
        )}

        {updateCheck?.status === 'private_or_no_release' && (
          <p className="text-xs text-amber-300/90 leading-relaxed">
            {updateCheck.hasToken
              ? isEn
                ? `No published release was found in ${updateCheck.repo} yet (or the token lacks Contents: Read-only permission).`
                : `V repozitáři ${updateCheck.repo} zatím nebyl nalezen publikovaný Release (nebo token nemá oprávnění Contents: Read-only).`
              : isEn
                ? `Repository ${updateCheck.repo} is either private or has no GitHub Release yet. For a private repo, enter a read-only GitHub Token below (Contents: Read-only).`
                : `Repozitář ${updateCheck.repo} je buď soukromý, nebo v něm zatím neproběhl nový build s GitHub Release. U soukromého repozitáře vložte níže čtecí GitHub Token (Contents: Read-only).`}
          </p>
        )}

        {updateCheck?.status === 'error' && (
          <p role="alert" className="text-xs text-rose-400">
            {updateCheck.message}
          </p>
        )}

        {installError && (
          <p role="alert" className="text-xs text-rose-400">
            {installError}
          </p>
        )}

        {installNotice && (
          <p className="text-xs text-zinc-300 leading-relaxed">
            {installNotice}
          </p>
        )}

        {isDownloadingApk && (
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center justify-between text-xs text-zinc-300 tabular-nums">
              <span>
                {t(
                  'Stahuji aktualizaci Selectra.apk…',
                  'Downloading Selectra.apk update…'
                )}
              </span>
              <span>{isEn ? `${downloadPercent}%` : `${downloadPercent} %`}</span>
            </div>
            <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
              <div
                className="h-full w-full bg-amber-400 origin-left transition-transform duration-150"
                style={{
                  transform: `scaleX(${Math.max(0.03, Math.min(1, downloadPercent / 100))})`,
                }}
              />
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2.5">
          {updateCheck?.status === 'update_available' ? (
            <>
              <button
                type="button"
                onClick={() => void handleDownloadAndInstall()}
                disabled={isDownloadingApk}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-amber-500 text-zinc-950 text-sm font-semibold hover:bg-amber-400 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>
                  {isDownloadingApk
                    ? t('Stahuji balíček…', 'Downloading package…')
                    : isNativeAndroid
                      ? `${t('Stáhnout a aktualizovat', 'Download & update')} (${updateCheck.release.tagName})`
                      : `${t('Stáhnout APK', 'Download APK')} (${updateCheck.release.tagName})`}
                </span>
              </button>

              <button
                type="button"
                onClick={() =>
                  void openReleaseUrlExternally(
                    updateCheck.release.browserDownloadUrl ||
                      updateCheck.release.htmlUrl
                  )
                }
                className="min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-200 text-sm font-medium hover:border-zinc-500 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <ExternalLink className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>
                  {t('Stáhnout v prohlížeči', 'Download in browser')}
                </span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void handleCheckUpdates()}
              disabled={isCheckingUpdate || isDownloadingApk}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-zinc-100 text-zinc-950 text-sm font-semibold hover:bg-white transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw
                className={`w-4 h-4 shrink-0 ${isCheckingUpdate ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>
                {isCheckingUpdate
                  ? t(
                      'Kontroluji GitHub Releases…',
                      'Checking GitHub Releases…'
                    )
                  : t('Zkontrolovat aktualizace', 'Check for updates')}
              </span>
            </button>
          )}

          {updateCheck?.status === 'update_available' && !isDownloadingApk && (
            <button
              type="button"
              onClick={() => void handleCheckUpdates()}
              disabled={isCheckingUpdate}
              className="min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-800 text-zinc-400 text-sm font-medium hover:text-zinc-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {t('Zkontrolovat znovu', 'Check again')}
            </button>
          )}

          {needsInstallPermission && !isDownloadingApk && (
            <button
              type="button"
              onClick={() => void handleCompletePendingInstall()}
              className="min-h-[44px] px-4 py-2 rounded-xl border border-amber-500/60 bg-amber-500/10 text-amber-200 text-sm font-semibold hover:bg-amber-500/20 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {t(
                'Dokončit instalaci stažené verze',
                'Finish installing downloaded update'
              )}
            </button>
          )}
        </div>

        {showRepoSettings && (
          <form
            onSubmit={(e) => void handleSaveSourceSettings(e)}
            className="pt-4 border-t border-zinc-800/80 space-y-3"
          >
            <div className="space-y-1.5">
              <label
                htmlFor="selectra-gh-repo"
                className="block text-xs font-medium text-zinc-300"
              >
                {t(
                  'GitHub repozitář pro aktualizace (vlastník/název)',
                  'GitHub repository for updates (owner/name)'
                )}
              </label>
              <input
                id="selectra-gh-repo"
                type="text"
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                placeholder={bakedRepo || t('např. jachym/selectra', 'e.g. owner/selectra')}
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="selectra-gh-token"
                className="block text-xs font-medium text-zinc-300"
              >
                {t(
                  'Čtecí GitHub Token (pouze pokud máte repozitář Private)',
                  'Read-only GitHub Token (only for Private repositories)'
                )}
              </label>
              <input
                id="selectra-gh-token"
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={t(
                  'Volitelné — github_pat_... (Contents: Read-only)',
                  'Optional — github_pat_... (Contents: Read-only)'
                )}
                autoComplete="off"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
              />
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                {t(
                  'U veřejného (Public) repozitáře nechte pole tokenu prázdné.',
                  'Leave the token field empty for Public repositories.'
                )}
              </p>
            </div>

            <div className="flex items-center gap-2.5 pt-1">
              <button
                type="submit"
                className="min-h-[42px] px-4 py-2 rounded-xl bg-zinc-100 text-zinc-950 text-xs font-semibold hover:bg-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {t('Uložit a zkontrolovat', 'Save & check')}
              </button>
              <button
                type="button"
                onClick={() => setShowRepoSettings(false)}
                className="min-h-[42px] px-3.5 py-2 rounded-xl border border-zinc-800 text-zinc-400 text-xs font-medium hover:text-zinc-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {t('Zavřít', 'Close')}
              </button>
            </div>
          </form>
        )}
      </section>

      {/* 2. Google Account & Remembered Login */}
      <section
        aria-label={t('Google účet', 'Google account')}
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 space-y-4"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <h2 className="font-display text-lg font-semibold text-zinc-100">
              {t('Google účet a Google Drive', 'Google Account & Google Drive')}
            </h2>
            <p className="text-sm text-zinc-400 leading-relaxed">
              {isAuthenticated && hasDriveToken
                ? t(
                    'Přihlášení je aktivní a zapamatované. Můžete otevírat složky na Google Drive, ukládat výběr do složky Liked i synchronizovat postup mezi zařízeními.',
                    'Signed in and remembered. Open Google Drive folders, save picks to your Liked folder, and sync progress across devices.'
                  )
                : displayEmail
                  ? t(
                      'Váš Google účet je v aplikaci zapamatován. Jedním klepnutím obnovíte přístup ke složkám Google Drive.',
                      'Your Google account is remembered. Tap once to reconnect access to your Google Drive folders.'
                    )
                  : t(
                      'Přihlaste se ke svému Google účtu. Aplikace si přihlášení zapamatuje, abyste měli své složky a rozpracovaný výběr vždy po ruce.',
                      'Sign in with Google to keep your Drive folders and culling progress synced across devices.'
                    )}
            </p>
          </div>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-800/90 text-zinc-200">
            {isAuthenticated || displayEmail ? (
              <UserCheck className="w-5 h-5 text-emerald-400" aria-hidden="true" />
            ) : (
              <HardDrive className="w-5 h-5" aria-hidden="true" />
            )}
          </div>
        </div>

        {displayEmail && (
          <div className="py-2.5 border-y border-zinc-800/80 flex items-center justify-between gap-3 text-sm">
            <span className="text-zinc-400">
              {t('Zapamatovaný účet', 'Remembered account')}
            </span>
            <span className="font-medium text-zinc-100 truncate">
              {displayEmail}
            </span>
          </div>
        )}

        {authError && (
          <p role="alert" className="text-xs text-rose-400 leading-relaxed">
            {authError}
          </p>
        )}

        {apkSha1 && (!hasDriveToken || Boolean(authError)) && (
          <div className="rounded-xl border border-zinc-800 bg-[#09090B] p-3 flex items-center justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <p className="text-[11px] text-zinc-400">
                {t(
                  'Otisk podpisu této nainstalované APK (SHA-1)',
                  'Installed APK signing fingerprint (SHA-1)'
                )}
              </p>
              <p className="font-mono text-xs text-zinc-100 break-all select-all">
                {apkSha1}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleCopySha1()}
              className="min-h-[38px] px-3 py-1.5 rounded-lg border border-zinc-700 bg-[#141417] text-xs font-medium text-zinc-200 hover:border-zinc-500 hover:text-white inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
            >
              {copiedSha1 ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                  <span>{t('Zkopírováno', 'Copied')}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t('Kopírovat', 'Copy')}</span>
                </>
              )}
            </button>
          </div>
        )}

        {isAuthenticated && hasDriveToken ? (
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onNavigateDrive}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-zinc-100 text-zinc-950 text-sm font-semibold hover:bg-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {t('Otevřít Google Drive', 'Open Google Drive')}
            </button>
            <button
              type="button"
              onClick={onSwitchGoogleAccount}
              disabled={isSigningIn}
              className="min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-200 text-sm font-medium hover:border-zinc-500 hover:text-white transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{t('Přepnout účet', 'Switch account')}</span>
            </button>
            <button
              type="button"
              onClick={onSignOut}
              className="min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-800 text-zinc-400 text-sm font-medium hover:text-rose-300 hover:border-rose-500/40 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{t('Odhlásit se', 'Sign out')}</span>
            </button>
          </div>
        ) : displayEmail ? (
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onSignIn}
              disabled={isSigningIn}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-zinc-100 text-zinc-950 text-sm font-semibold hover:bg-white transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {isSigningIn
                ? t('Připojuji Drive…', 'Connecting Drive…')
                : t('Pokračovat s tímto účtem', 'Continue with this account')}
            </button>
            <button
              type="button"
              onClick={onSwitchGoogleAccount}
              disabled={isSigningIn}
              className="min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-200 text-sm font-medium hover:border-zinc-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {t('Jiný účet', 'Other account')}
            </button>
            <button
              type="button"
              onClick={onSignOut}
              className="min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-800 text-zinc-400 text-sm font-medium hover:text-rose-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {t('Zapomenout účet', 'Forget account')}
            </button>
          </div>
        ) : (
          <div className="pt-1">
            <GoogleSignInButton
              onClick={onSignIn}
              loading={isSigningIn}
              label={t('Přihlásit se přes Google', 'Sign in with Google')}
            />
          </div>
        )}
      </section>

      {/* 3. Haptics & Mobile Ergonomics */}
      <section
        aria-label={t('Haptická odezva', 'Haptic feedback')}
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 space-y-4"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-display text-lg font-semibold text-zinc-100">
              {t('Vibrace při swipování', 'Swipe haptics')}
            </h2>
            <p className="text-sm text-zinc-400">
              {hapticsAvailable
                ? t(
                    'Jemná haptická odezva telefonu při označení fotky, návratu zpět a přepnutí záložky.',
                    'Subtle tactile feedback when rating a photo, undoing, or switching tabs.'
                  )
                : t(
                    'Nastavení se použije na zařízeních Android s podporou vibrací.',
                    'Applies on Android devices with vibration support.'
                  )}
            </p>
          </div>
          <button
            type="button"
            onClick={handleToggleHaptics}
            aria-pressed={haptics.enabled}
            className={`min-h-[44px] px-4 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              haptics.enabled
                ? 'bg-amber-500 text-zinc-950'
                : 'border border-zinc-700 bg-[#09090B] text-zinc-300'
            }`}
          >
            <Vibrate className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>
              {haptics.enabled ? t('Zapnuto', 'On') : t('Vypnuto', 'Off')}
            </span>
          </button>
        </div>

        {haptics.enabled && (
          <div
            className="flex items-center gap-1 p-1 rounded-xl border border-zinc-800 bg-[#09090B] w-fit"
            role="group"
            aria-label={t('Intenzita vibrací', 'Vibration intensity')}
          >
            {(
              [
                { id: 'light', label: t('Jemná', 'Light') },
                { id: 'medium', label: t('Střední', 'Medium') },
                { id: 'heavy', label: t('Výrazná', 'Strong') },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => handleSelectIntensity(opt.id)}
                className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  haptics.intensity === opt.id
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 4. Series in Filmstrip & Global Adaptive Calibration */}
      <section
        aria-label={t('Série a kalibrace', 'Series & calibration')}
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 space-y-4"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <h2 className="font-display text-lg font-semibold text-zinc-100">
              {t('Automatické série v dolní liště', 'Auto series in filmstrip')}
            </h2>
            <p className="text-sm text-zinc-400 leading-relaxed">
              {t(
                'Ve výchozím stavu se série v liště i galerii průběžně vyhledávají automaticky podle času a podobnosti snímků. Pokud automatiku vypnete, můžete série nadále vytvářet ručně přímo v Galerii přes Vytvořit sérii.',
                'By default, photo series are detected automatically in the filmstrip and gallery by time and visual similarity. If turned off, you can still group shots manually in Gallery via New series.'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onToggleFilmstripSeriesEnabled(!filmstripSeriesEnabled)}
            aria-pressed={filmstripSeriesEnabled}
            className={`min-h-[44px] px-4 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              filmstripSeriesEnabled
                ? 'bg-amber-500 text-zinc-950'
                : 'border border-zinc-700 bg-[#09090B] text-zinc-300'
            }`}
          >
            <Layers className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>
              {filmstripSeriesEnabled ? t('Zapnuto', 'On') : t('Vypnuto', 'Off')}
            </span>
          </button>
        </div>

        <div className="pt-3 border-t border-zinc-800/80 flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5 min-w-0">
            <p className="text-sm font-medium text-zinc-200">
              {t(
                'Průběžná kalibrace výběru sérií',
                'Adaptive series calibration'
              )}
            </p>
            <p className="text-xs text-zinc-400 tabular-nums">
              {globalCalibrationSummary
                ? isEn
                  ? `Learned across folders: ${globalCalibrationSummary.sameCount}× same, ${globalCalibrationSummary.differentCount}× different · threshold ${Math.round(globalCalibrationSummary.minScore * 100)}%`
                  : `Naučeno napříč složkami: ${globalCalibrationSummary.sameCount}× stejná, ${globalCalibrationSummary.differentCount}× jiná · práh ${Math.round(globalCalibrationSummary.minScore * 100)} %`
                : t(
                    'Učí se průběžně napříč všemi složkami podle toho, jaké fotky do sérií přidáváte nebo odebíráte.',
                    'Learns continuously across folders as you add or remove photos from series.'
                  )}
            </p>
          </div>
          {globalCalibrationSummary && onResetGlobalCalibration && (
            <button
              type="button"
              onClick={onResetGlobalCalibration}
              className="min-h-[38px] px-3 py-1.5 rounded-lg border border-zinc-700 bg-[#09090B] text-xs font-medium text-zinc-300 hover:text-white hover:border-zinc-500 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{t('Obnovit výchozí', 'Reset to default')}</span>
            </button>
          )}
        </div>
      </section>

      {/* 4b. Granular Progress Reset for In-Progress Folders */}
      <section
        aria-label={t(
          'Částečný reset postupu ve složkách',
          'Partial folder progress reset'
        )}
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 space-y-4"
      >
        <div className="space-y-1">
          <h2 className="font-display text-lg font-semibold text-zinc-100">
            {t('Reset postupu ve složkách', 'Reset folder progress')}
          </h2>
          <p className="text-sm text-zinc-400 leading-relaxed">
            {t(
              'Vyberte rozpracovanou složku z telefonu nebo Google Drive a vynulujte jen konkrétní část hodnocení (přeskočené, vybrané ★, smazané, ruční série nebo úplně vše).',
              'Choose an in-progress folder from your device or Google Drive and reset only a specific part (skipped, picked ★, trash, manual series, or everything).'
            )}
          </p>
        </div>

        {combinedResettableFolders.length === 0 ? (
          <p className="text-xs text-zinc-500">
            {t(
              'Zatím nemáte žádnou rozpracovanou složku s uloženým postupem.',
              'You have no in-progress folders with saved progress yet.'
            )}
          </p>
        ) : (
          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <label
                htmlFor="selectra-reset-folder-select"
                className="block text-xs font-medium text-zinc-300"
              >
                {t('Rozpracovaná složka', 'In-progress folder')}
              </label>
              <select
                id="selectra-reset-folder-select"
                value={selectedResetFolderKey}
                onChange={(e) => {
                  setSelectedResetFolderKey(e.target.value);
                  setResetFolderNotice(null);
                }}
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
              >
                {combinedResettableFolders.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.folderName} (
                    {f.isDrive ? 'Google Drive' : t('V telefonu', 'On device')} · ★{' '}
                    {f.keepCount} · {t('Smazat', 'Delete')} {f.trashCount})
                  </option>
                ))}
              </select>
            </div>

            {resetFolderNotice && (
              <p className="text-xs font-medium text-emerald-400">
                {resetFolderNotice}
              </p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {partialResetOptions.map((opt) => {
                const isDestructive =
                  opt.scope === 'everything' ||
                  opt.scope === 'all-select' ||
                  opt.scope === 'all-delete';
                return (
                  <button
                    key={opt.scope}
                    type="button"
                    disabled={isResettingFolderScope}
                    onClick={() => void handleMenuFolderResetScope(opt.scope)}
                    className={`min-h-[44px] px-3.5 py-2.5 rounded-xl border text-left transition-colors cursor-pointer flex items-center justify-between gap-2.5 disabled:opacity-50 ${
                      isDestructive
                        ? 'border-rose-500/35 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 hover:border-rose-500/60'
                        : 'border-zinc-800 bg-[#09090B] text-zinc-200 hover:border-zinc-600 hover:text-white'
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-semibold truncate">
                        {opt.label}
                      </p>
                      <p className="text-[11px] text-zinc-400 truncate">
                        {opt.description}
                      </p>
                    </div>
                    <RotateCcw
                      className={`w-4 h-4 shrink-0 ${
                        isDestructive ? 'text-rose-300' : 'text-zinc-400'
                      }`}
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {/* 5. Cache Storage, Retention Rules & Remembered Series */}
      <section
        aria-label={t('Úložiště a paměť sérií', 'Cache & series memory')}
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 space-y-4"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <h2 className="font-display text-lg font-semibold text-zinc-100">
              {t('Úložiště a paměť sérií', 'Cache & series memory')}
            </h2>
            <p className="text-sm text-zinc-400 leading-relaxed">
              {t(
                'Přehled uložených náhledů v zařízení a automatických lhůt pro plynulé třídění bez zbytečného zpomalování.',
                'Overview of cached previews on this device and automatic retention for fast, smooth culling.'
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="font-mono text-base font-semibold text-amber-300 tabular-nums">
              {isLoadingCacheStats && !cacheStats
                ? '…'
                : formatBytes(cacheStats?.totalBytes || 0)}
            </span>
            <button
              type="button"
              onClick={() => void refreshCacheStats()}
              disabled={isLoadingCacheStats}
              aria-label={t('Přepočítat využité místo', 'Recalculate storage')}
              className="min-h-[44px] min-w-[44px] rounded-xl border border-zinc-800 bg-[#09090B] text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 inline-flex items-center justify-center transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw
                className={`w-4 h-4 ${isLoadingCacheStats ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-xl border border-zinc-800/90 bg-[#09090B] p-3.5 space-y-1">
            <p className="text-[11px] uppercase tracking-wider text-zinc-400">
              {t('Detailní náhledy', 'Detail previews')}
            </p>
            <p className="font-mono text-base font-semibold text-zinc-100 tabular-nums">
              {formatBytes(cacheStats?.detailBytes || 0)}
            </p>
            <p className="text-xs text-zinc-400 tabular-nums">
              {cacheStats
                ? isEn
                  ? `${cacheStats.detailUnculledCount} active · ${cacheStats.detailCulledPendingCount} expiring (24h)`
                  : `${cacheStats.detailUnculledCount} aktivních · ${cacheStats.detailCulledPendingCount} čeká na smazání (24 h)`
                : t('Načítám…', 'Loading…')}
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800/90 bg-[#09090B] p-3.5 space-y-1">
            <p className="text-[11px] uppercase tracking-wider text-zinc-400">
              {t('Nízkokvalitní galerie', 'Gallery thumbnails')}
            </p>
            <p className="font-mono text-base font-semibold text-zinc-100 tabular-nums">
              {formatBytes(cacheStats?.microThumbBytes || 0)}
            </p>
            <p className="text-xs text-zinc-400 tabular-nums">
              {cacheStats
                ? isEn
                  ? `${formatNumber(cacheStats.microThumbCount)} micro thumbs · kept 7d`
                  : `${formatNumber(cacheStats.microThumbCount)} mikro-náhledů · 7 dní po dotřídění`
                : t('Načítám…', 'Loading…')}
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800/90 bg-[#09090B] p-3.5 space-y-1">
            <p className="text-[11px] uppercase tracking-wider text-zinc-400">
              {t('Zapamatované série', 'Remembered series')}
            </p>
            <p className="font-mono text-base font-semibold text-zinc-100 tabular-nums">
              {formatBytes(cacheStats?.seriesMemoryBytes || 0)}
            </p>
            <p className="text-xs text-zinc-400 tabular-nums">
              {cacheStats
                ? isEn
                  ? `${cacheStats.seriesFolderCount} ${plural(cacheStats.seriesFolderCount, ['složka', 'složky', 'složek'], ['folder', 'folders'])} · ${cacheStats.rememberedSeriesTotalCount} series`
                  : `${cacheStats.seriesFolderCount} složek · ${cacheStats.rememberedSeriesTotalCount} sérií`
                : t('Načítám…', 'Loading…')}
            </p>
          </div>
        </div>

        {cacheStats?.browserQuotaBytes !== null &&
          cacheStats?.browserQuotaBytes !== undefined && (
            <p className="text-xs text-zinc-400 tabular-nums">
              {t('Celková kvóta úložiště aplikace:', 'Total app storage quota:')}{' '}
              <span className="text-zinc-200 font-medium">
                {formatBytes(cacheStats.browserUsageBytes || 0)}
              </span>{' '}
              {t('z', 'of')}{' '}
              <span className="text-zinc-200 font-medium">
                {formatBytes(cacheStats.browserQuotaBytes)}
              </span>
              .
            </p>
          )}

        <div className="rounded-xl border border-zinc-800/90 bg-[#09090B] p-4 space-y-2 text-xs text-zinc-300 leading-relaxed">
          <div className="flex items-center gap-2 text-zinc-100 font-medium">
            <Database className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
            <span>
              {t(
                'Jak Selectra spravuje mezipaměť a kolik zabírá místa',
                'How Selectra manages cache and storage'
              )}
            </span>
          </div>
          {isEn ? (
            <>
              <p className="text-zinc-400">
                ·{' '}
                <strong className="text-zinc-200 font-medium">
                  Active series (~180–450 KB / shot):
                </strong>{' '}
                loaded detail previews in unculled series stay cached and
                preload ahead smoothly. Once a shot is rated (pick or trash),
                its detail preview is cleared automatically after{' '}
                <strong className="text-zinc-200 font-medium">24 hours</strong>.
              </p>
              <p className="text-zinc-400">
                ·{' '}
                <strong className="text-zinc-200 font-medium">
                  Gallery micro-thumbnails (~2.5–4 KB / shot):
                </strong>{' '}
                1,000 photos take only around{' '}
                <strong className="text-zinc-200 font-medium">2.5–4 MB</strong>{' '}
                and stay cached for{' '}
                <strong className="text-zinc-200 font-medium">
                  7 days after culling
                </strong>{' '}
                for instant grid and filmstrip browsing.
              </p>
              <p className="text-zinc-400">
                ·{' '}
                <strong className="text-zinc-200 font-medium">
                  Series & fingerprint memory (~0.2–0.6 MB per 1,000 shots):
                </strong>{' '}
                detected series layouts stay cached for{' '}
                <strong className="text-zinc-200 font-medium">
                  7 days after culling
                </strong>{' '}
                so folders open without re-scanning.
              </p>
            </>
          ) : (
            <>
              <p className="text-zinc-400">
                ·{' '}
                <strong className="text-zinc-200 font-medium">
                  Rozpracované série (~180–450 KB / snímek):
                </strong>{' '}
                načtené detailní náhledy v neprotříděných sériích zůstávají v
                paměti a přednačítají se plynule dopředu. Po označení fotky
                (výběr nebo koš) se detailní náhled automaticky uvolní za{' '}
                <strong className="text-zinc-200 font-medium">24 hodin</strong>.
              </p>
              <p className="text-zinc-400">
                ·{' '}
                <strong className="text-zinc-200 font-medium">
                  Nízkokvalitní náhledy galerie (~2,5–4 KB / snímek):
                </strong>{' '}
                tisíc fotografií zabere jen přibližně{' '}
                <strong className="text-zinc-200 font-medium">2,5–4 MB</strong>{' '}
                a zůstávají uložené{' '}
                <strong className="text-zinc-200 font-medium">
                  7 dní po dotřídění
                </strong>{' '}
                složky pro okamžité prohlížení mřížky a spodní lišty.
              </p>
              <p className="text-zinc-400">
                ·{' '}
                <strong className="text-zinc-200 font-medium">
                  Paměť sérií a otisků (~0,2–0,6 MB na 1 000 snímků):
                </strong>{' '}
                rozložení sérií se ukládá na{' '}
                <strong className="text-zinc-200 font-medium">
                  7 dní po dotřídění
                </strong>
                , aby se série při návratu nemusely znovu hledat.
              </p>
            </>
          )}
        </div>

        {cacheStats && cacheStats.folders.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-zinc-300">
              {t('Uložené složky v mezipaměti', 'Cached folders')} (
              {cacheStats.folders.length})
            </p>
            <div className="divide-y divide-zinc-800/80 rounded-xl border border-zinc-800/90 bg-[#09090B] overflow-hidden">
              {cacheStats.folders.slice(0, 6).map((f) => {
                const folderTotal =
                  f.detailBytes + f.microThumbBytes + f.seriesMemoryBytes;
                return (
                  <div
                    key={f.folderId}
                    className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-zinc-200 truncate">
                        {f.folderName}
                      </p>
                      <p className="text-[11px] text-zinc-400 tabular-nums">
                        {f.isFolderCulled
                          ? t('Dotříděno (7d paměť)', 'Culled (7d cache)')
                          : t('Rozpracovaná', 'In progress')}
                        {f.seriesCount > 0
                          ? ` · ${f.seriesCount} ${t('sérií', 'series')}`
                          : ''}
                        {f.microThumbCount > 0
                          ? ` · ${f.microThumbCount} ${t('náhledů', 'thumbs')}`
                          : ''}
                      </p>
                    </div>
                    <span className="font-mono text-xs text-zinc-300 tabular-nums shrink-0">
                      {formatBytes(folderTotal)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {cacheNotice && (
          <p className="text-xs text-amber-300 leading-relaxed">{cacheNotice}</p>
        )}

        <div className="pt-1 flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => void handlePurgeCulledDetails()}
            disabled={
              isPurgingCulled || (cacheStats?.detailCulledPendingCount || 0) === 0
            }
            className="min-h-[44px] px-4 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-200 text-xs font-semibold hover:border-zinc-500 transition-colors inline-flex items-center gap-2 whitespace-nowrap cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-4 h-4 text-zinc-400 shrink-0" aria-hidden="true" />
            <span>
              {isPurgingCulled
                ? t('Uvolňuji…', 'Clearing…')
                : t('Uvolnit protříděné náhledy', 'Free culled previews')}
            </span>
          </button>

          {!confirmClearAllCache ? (
            <button
              type="button"
              onClick={() => setConfirmClearAllCache(true)}
              disabled={
                isClearingAllCache || (cacheStats?.totalBytes || 0) === 0
              }
              className="min-h-[44px] px-4 py-2 rounded-xl border border-zinc-800 text-zinc-400 text-xs font-medium hover:text-rose-300 hover:border-rose-500/40 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
            >
              {t('Vymazat celou mezipaměť', 'Clear all cache')}
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleConfirmClearAllCache()}
                disabled={isClearingAllCache}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-rose-500 text-white text-xs font-semibold hover:bg-rose-400 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
              >
                {isClearingAllCache
                  ? t('Mažu…', 'Clearing…')
                  : t('Potvrdit smazání mezipaměti', 'Confirm clear cache')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmClearAllCache(false)}
                className="min-h-[44px] px-3 py-2 rounded-xl border border-zinc-700 text-zinc-300 text-xs font-medium hover:text-white cursor-pointer"
              >
                {t('Zrušit', 'Cancel')}
              </button>
            </div>
          )}
        </div>
      </section>

      {/* 6. Device Install & Version Info */}
      <section
        aria-label={t('O aplikaci', 'About')}
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
      >
        <div className="flex items-center gap-3.5 min-w-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-800/90 text-zinc-200">
            <Smartphone className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-100">
              {t('Selectra · Mobilní edice', 'Selectra · Mobile Edition')}
            </p>
            <p className="text-xs text-zinc-400 tabular-nums">
              {t('Verze', 'Version')} {installedLabel} ·{' '}
              {t(
                'Offline čtení RAW (CR3, CR2, NEF, ARW, DNG)',
                'Offline RAW preview (CR3, CR2, NEF, ARW, DNG)'
              )}
            </p>
          </div>
        </div>
      </section>
    </main>
  );
};

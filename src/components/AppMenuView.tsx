import React, { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Database,
  Download,
  ExternalLink,
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
import { GoogleSignInButton } from './GoogleSignInButton';
import { PWAInstallButton } from './PWAInstallButton';

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
  initialUpdateCheck = null,
  onUpdateCheckChange,
}) => {
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
          'Povolte v otevřeném nastavení přepínač „Povolit z tohoto zdroje“, vraťte se zpět a klepněte na Dokončit instalaci.'
        );
      } else if (res.status === 'installer_launched') {
        setNeedsInstallPermission(false);
        setInstallNotice(
          'Bylo otevřeno systémové okno aktualizace Androidu. Potvrďte tlačítko Aktualizovat.'
        );
      } else {
        setInstallNotice(
          'Stahování instalačního souboru Selectra.apk bylo otevřeno v prohlížeči.'
        );
      }
    } catch (err: unknown) {
      setInstallError(
        err instanceof Error
          ? err.message
          : 'Stažení aktualizace se nezdařilo. Zkuste stažení v prohlížeči.'
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
          'Nejprve v nastavení Androidu zapněte přepínač „Povolit z tohoto zdroje“ pro aplikaci Selectra.'
        );
      } else {
        setNeedsInstallPermission(false);
        setInstallNotice(
          'Potvrďte aktualizaci v systémovém okně Androidu.'
        );
      }
    } catch (err: unknown) {
      setInstallError(
        err instanceof Error
          ? err.message
          : 'Nepodařilo se otevřít instalátor staženého balíčku.'
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

  const handlePurgeCulledDetails = async () => {
    setIsPurgingCulled(true);
    setCacheNotice(null);
    try {
      const deletedCount = await purgeCulledDetailPreviewsNow();
      await refreshCacheStats();
      setCacheNotice(
        deletedCount > 0
          ? `Uvolněno ${deletedCount.toLocaleString('cs-CZ')} protříděných detailních náhledů. Rozpracované série a 7denní galerie zůstaly zachovány.`
          : 'Žádné protříděné detailní náhledy teď nezabírají místo.'
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
        'Celá mezipaměť náhledů a zapamatovaných sérií byla vymazána. Vaše označené výběry a koše zůstaly nedotčené.'
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
          Menu a nastavení
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Správa aktualizací, Google účtu a chování v telefonu.
        </p>
      </div>

      {/* 1. In-App APK Updates (GitHub Releases) */}
      <section
        aria-label="Aktualizace aplikace"
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 space-y-4"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <h2 className="font-display text-lg font-semibold text-zinc-100">
              Aktualizace aplikace
            </h2>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-400 tabular-nums">
              <span>Nainstalováno {installedLabel}</span>
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
            aria-label="Nastavení zdroje aktualizací na GitHubu"
            className="min-h-[44px] min-w-[44px] rounded-xl border border-zinc-800 bg-[#09090B] text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 inline-flex items-center justify-center transition-colors shrink-0 cursor-pointer"
          >
            <Settings2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {updateCheck?.status === 'update_available' && (
          <div className="py-3 border-y border-zinc-800/80 space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-amber-300">
                Je dostupná nová verze {updateCheck.release.tagName}
              </p>
              <div className="flex items-center gap-1.5 text-xs text-zinc-400 tabular-nums">
                {updateCheck.release.apkSizeBytes > 0 && (
                  <span>
                    {formatApkSizeMb(updateCheck.release.apkSizeBytes)}
                  </span>
                )}
                {updateCheck.release.publishedAt && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      {formatCzechReleaseDate(updateCheck.release.publishedAt)}
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
            Používáte nejnovější dostupnou verzi ({updateCheck.latestTag}).
          </p>
        )}

        {updateCheck?.status === 'repo_not_configured' && (
          <p className="text-xs text-zinc-400 leading-relaxed">
            Zadejte název svého GitHub repozitáře ve tvaru{' '}
            <span className="text-zinc-200 font-mono">uzivatel/repozitar</span>.
            U balíčků sestavených přes GitHub Actions se vyplní automaticky.
          </p>
        )}

        {updateCheck?.status === 'private_or_no_release' && (
          <p className="text-xs text-amber-300/90 leading-relaxed">
            {updateCheck.hasToken
              ? `V repozitáři ${updateCheck.repo} zatím nebyl nalezen publikovaný Release (nebo token nemá oprávnění Contents: Read-only).`
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
              <span>Stahuji aktualizaci Selectra.apk…</span>
              <span>{downloadPercent} %</span>
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
                    ? 'Stahuji balíček…'
                    : isNativeAndroid
                      ? `Stáhnout a aktualizovat (${updateCheck.release.tagName})`
                      : `Stáhnout APK (${updateCheck.release.tagName})`}
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
                <span>Stáhnout v prohlížeči</span>
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
                  ? 'Kontroluji GitHub Releases…'
                  : 'Zkontrolovat aktualizace'}
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
              Zkontrolovat znovu
            </button>
          )}

          {needsInstallPermission && !isDownloadingApk && (
            <button
              type="button"
              onClick={() => void handleCompletePendingInstall()}
              className="min-h-[44px] px-4 py-2 rounded-xl border border-amber-500/60 bg-amber-500/10 text-amber-200 text-sm font-semibold hover:bg-amber-500/20 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Dokončit instalaci stažené verze
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
                GitHub repozitář pro aktualizace (vlastník/název)
              </label>
              <input
                id="selectra-gh-repo"
                type="text"
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                placeholder={bakedRepo || 'např. jachym/selectra'}
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="selectra-gh-token"
                className="block text-xs font-medium text-zinc-300"
              >
                Čtecí GitHub Token (pouze pokud máte repozitář Private)
              </label>
              <input
                id="selectra-gh-token"
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Volitelné — github_pat_... (Contents: Read-only)"
                autoComplete="off"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
              />
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                U veřejného (Public) repozitáře nechte pole tokenu prázdné.
              </p>
            </div>

            <div className="flex items-center gap-2.5 pt-1">
              <button
                type="submit"
                className="min-h-[42px] px-4 py-2 rounded-xl bg-zinc-100 text-zinc-950 text-xs font-semibold hover:bg-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Uložit a zkontrolovat
              </button>
              <button
                type="button"
                onClick={() => setShowRepoSettings(false)}
                className="min-h-[42px] px-3.5 py-2 rounded-xl border border-zinc-800 text-zinc-400 text-xs font-medium hover:text-zinc-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Zavřít
              </button>
            </div>
          </form>
        )}
      </section>

      {/* 2. Google Account & Remembered Login */}
      <section
        aria-label="Google účet"
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 space-y-4"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <h2 className="font-display text-lg font-semibold text-zinc-100">
              Google účet a Google Drive
            </h2>
            <p className="text-sm text-zinc-400 leading-relaxed">
              {isAuthenticated && hasDriveToken
                ? 'Přihlášení je aktivní a zapamatované. Můžete otevírat složky na Google Drive, ukládat výběr do složky Liked i synchronizovat postup mezi zařízeními.'
                : displayEmail
                  ? 'Váš Google účet je v aplikaci zapamatován. Jedním klepnutím obnovíte přístup ke složkám Google Drive.'
                  : 'Přihlaste se ke svému Google účtu. Aplikace si přihlášení zapamatuje, abyste měli své složky a rozpracovaný výběr vždy po ruce.'}
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
            <span className="text-zinc-400">Zapamatovaný účet</span>
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
                Otisk podpisu této nainstalované APK (SHA-1)
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
                  <span>Zkopírováno</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Kopírovat</span>
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
              Otevřít Google Drive
            </button>
            <button
              type="button"
              onClick={onSwitchGoogleAccount}
              disabled={isSigningIn}
              className="min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-200 text-sm font-medium hover:border-zinc-500 hover:text-white transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>Přepnout účet</span>
            </button>
            <button
              type="button"
              onClick={onSignOut}
              className="min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-800 text-zinc-400 text-sm font-medium hover:text-rose-300 hover:border-rose-500/40 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>Odhlásit se</span>
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
              {isSigningIn ? 'Připojuji Drive…' : 'Pokračovat s tímto účtem'}
            </button>
            <button
              type="button"
              onClick={onSwitchGoogleAccount}
              disabled={isSigningIn}
              className="min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-200 text-sm font-medium hover:border-zinc-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              Jiný účet
            </button>
            <button
              type="button"
              onClick={onSignOut}
              className="min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-800 text-zinc-400 text-sm font-medium hover:text-rose-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Zapomenout účet
            </button>
          </div>
        ) : (
          <div className="pt-1">
            <GoogleSignInButton
              onClick={onSignIn}
              loading={isSigningIn}
              label="Přihlásit se přes Google"
            />
          </div>
        )}
      </section>

      {/* 3. Haptics & Mobile Ergonomics */}
      <section
        aria-label="Haptická odezva"
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 space-y-4"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-display text-lg font-semibold text-zinc-100">
              Vibrace při swipování
            </h2>
            <p className="text-sm text-zinc-400">
              {hapticsAvailable
                ? 'Jemná haptická odezva telefonu při označení fotky, návratu zpět a přepnutí záložky.'
                : 'Nastavení se použije na zařízeních Android s podporou vibrací.'}
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
            <span>{haptics.enabled ? 'Zapnuto' : 'Vypnuto'}</span>
          </button>
        </div>

        {haptics.enabled && (
          <div
            className="flex items-center gap-1 p-1 rounded-xl border border-zinc-800 bg-[#09090B] w-fit"
            role="group"
            aria-label="Intenzita vibrací"
          >
            {(
              [
                { id: 'light', label: 'Jemná' },
                { id: 'medium', label: 'Střední' },
                { id: 'heavy', label: 'Výrazná' },
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
        aria-label="Série a kalibrace"
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 space-y-4"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <h2 className="font-display text-lg font-semibold text-zinc-100">
              Automatické série v dolní liště
            </h2>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Ve výchozím stavu se dolní lišta načítá rovná bez automatických
              sérií. Série si kdykoliv najdete u aktuální fotky tlačítkem Najít
              sérii nebo v Galerii přes Najít všechny série.
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
            <span>{filmstripSeriesEnabled ? 'Zapnuto' : 'Vypnuto'}</span>
          </button>
        </div>

        <div className="pt-3 border-t border-zinc-800/80 flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5 min-w-0">
            <p className="text-sm font-medium text-zinc-200">
              Průběžná kalibrace výběru sérií
            </p>
            <p className="text-xs text-zinc-400 tabular-nums">
              {globalCalibrationSummary
                ? `Naučeno napříč složkami: ${globalCalibrationSummary.sameCount}× stejná, ${globalCalibrationSummary.differentCount}× jiná · práh ${Math.round(globalCalibrationSummary.minScore * 100)} %`
                : 'Učí se průběžně napříč všemi složkami podle toho, jaké fotky do sérií přidáváte nebo odebíráte.'}
            </p>
          </div>
          {globalCalibrationSummary && onResetGlobalCalibration && (
            <button
              type="button"
              onClick={onResetGlobalCalibration}
              className="min-h-[38px] px-3 py-1.5 rounded-lg border border-zinc-700 bg-[#09090B] text-xs font-medium text-zinc-300 hover:text-white hover:border-zinc-500 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Obnovit výchozí</span>
            </button>
          )}
        </div>
      </section>

      {/* 5. Cache Storage, Retention Rules & Remembered Series */}
      <section
        aria-label="Úložiště a paměť sérií"
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 space-y-4"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <h2 className="font-display text-lg font-semibold text-zinc-100">
              Úložiště a paměť sérií
            </h2>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Přehled uložených náhledů v zařízení a automatických lhůt pro
              plynulé třídění bez zbytečného zpomalování.
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
              aria-label="Přepočítat využité místo"
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
              Detailní náhledy
            </p>
            <p className="font-mono text-base font-semibold text-zinc-100 tabular-nums">
              {formatBytes(cacheStats?.detailBytes || 0)}
            </p>
            <p className="text-xs text-zinc-400 tabular-nums">
              {cacheStats
                ? `${cacheStats.detailUnculledCount} aktivních · ${cacheStats.detailCulledPendingCount} čeká na smazání (24 h)`
                : 'Načítám…'}
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800/90 bg-[#09090B] p-3.5 space-y-1">
            <p className="text-[11px] uppercase tracking-wider text-zinc-400">
              Nízkokvalitní galerie
            </p>
            <p className="font-mono text-base font-semibold text-zinc-100 tabular-nums">
              {formatBytes(cacheStats?.microThumbBytes || 0)}
            </p>
            <p className="text-xs text-zinc-400 tabular-nums">
              {cacheStats
                ? `${cacheStats.microThumbCount.toLocaleString('cs-CZ')} mikro-náhledů · 7 dní po dotřídění`
                : 'Načítám…'}
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800/90 bg-[#09090B] p-3.5 space-y-1">
            <p className="text-[11px] uppercase tracking-wider text-zinc-400">
              Zapamatované série
            </p>
            <p className="font-mono text-base font-semibold text-zinc-100 tabular-nums">
              {formatBytes(cacheStats?.seriesMemoryBytes || 0)}
            </p>
            <p className="text-xs text-zinc-400 tabular-nums">
              {cacheStats
                ? `${cacheStats.seriesFolderCount} složek · ${cacheStats.rememberedSeriesTotalCount} sérií`
                : 'Načítám…'}
            </p>
          </div>
        </div>

        {cacheStats?.browserQuotaBytes !== null &&
          cacheStats?.browserQuotaBytes !== undefined && (
            <p className="text-xs text-zinc-400 tabular-nums">
              Celková kvóta úložiště aplikace v prohlížeči:{' '}
              <span className="text-zinc-200 font-medium">
                {formatBytes(cacheStats.browserUsageBytes || 0)}
              </span>{' '}
              z{' '}
              <span className="text-zinc-200 font-medium">
                {formatBytes(cacheStats.browserQuotaBytes)}
              </span>
              .
            </p>
          )}

        <div className="rounded-xl border border-zinc-800/90 bg-[#09090B] p-4 space-y-2 text-xs text-zinc-300 leading-relaxed">
          <div className="flex items-center gap-2 text-zinc-100 font-medium">
            <Database className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
            <span>Jak Selectra spravuje mezipaměť a kolik zabírá místa</span>
          </div>
          <p className="text-zinc-400">
            · <strong className="text-zinc-200 font-medium">Rozpracované série (~180–450 KB / snímek):</strong>{' '}
            načtené detailní náhledy v neprotříděných sériích zůstávají v paměti a
            přednačítají se plynule dopředu. Po označení fotky (výběr nebo koš)
            se detailní náhled automaticky uvolní za <strong className="text-zinc-200 font-medium">24 hodin</strong>.
          </p>
          <p className="text-zinc-400">
            · <strong className="text-zinc-200 font-medium">Nízkokvalitní náhledy galerie (~2,5–4 KB / snímek):</strong>{' '}
            tisíc fotografií zabere jen přibližně <strong className="text-zinc-200 font-medium">2,5–4 MB</strong> a zůstávají uložené{' '}
            <strong className="text-zinc-200 font-medium">7 dní po dotřídění</strong> složky pro okamžité prohlížení mřížky a spodní lišty.
          </p>
          <p className="text-zinc-400">
            · <strong className="text-zinc-200 font-medium">Paměť sérií a otisků (~0,2–0,6 MB na 1 000 snímků):</strong>{' '}
            rozložení sérií se ukládá na <strong className="text-zinc-200 font-medium">7 dní po dotřídění</strong>, aby se série při návratu nemusely znovu hledat.
          </p>
        </div>

        {cacheStats && cacheStats.folders.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-zinc-300">
              Uložené složky v mezipaměti ({cacheStats.folders.length})
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
                        {f.isFolderCulled ? 'Dotříděno (7d paměť)' : 'Rozpracovaná'}
                        {f.seriesCount > 0 ? ` · ${f.seriesCount} sérií` : ''}
                        {f.microThumbCount > 0
                          ? ` · ${f.microThumbCount} náhledů`
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
                ? 'Uvolňuji…'
                : 'Uvolnit protříděné náhledy'}
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
              Vymazat celou mezipaměť
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleConfirmClearAllCache()}
                disabled={isClearingAllCache}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-rose-500 text-white text-xs font-semibold hover:bg-rose-400 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
              >
                {isClearingAllCache ? 'Mažu…' : 'Potvrdit smazání mezipaměti'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmClearAllCache(false)}
                className="min-h-[44px] px-3 py-2 rounded-xl border border-zinc-700 text-zinc-300 text-xs font-medium hover:text-white cursor-pointer"
              >
                Zrušit
              </button>
            </div>
          )}
        </div>
      </section>

      {/* 6. Device Install & Version Info */}
      <section
        aria-label="O aplikaci"
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
      >
        <div className="flex items-center gap-3.5 min-w-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-800/90 text-zinc-200">
            <Smartphone className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-100">
              Selectra · Mobilní edice
            </p>
            <p className="text-xs text-zinc-400 tabular-nums">
              Verze {installedLabel} · Offline čtení RAW (CR3, CR2, NEF, ARW,
              DNG)
            </p>
          </div>
        </div>
        {!isNativeAndroid && (
          <div className="shrink-0">
            <PWAInstallButton variant="subtle" />
          </div>
        )}
      </section>
    </main>
  );
};

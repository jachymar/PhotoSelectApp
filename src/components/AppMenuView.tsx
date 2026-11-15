import React, { useState } from 'react';
import {
  Check,
  Trash2,
  HardDrive,
  LogOut,
  RefreshCw,
  Smartphone,
  Vibrate,
  UserCheck,
} from 'lucide-react';
import { AppMode } from '../lib/appMode';
import {
  HapticIntensity,
  HapticSettings,
  isHapticsSupported,
  loadHapticSettings,
  saveHapticSettings,
  triggerHaptic,
} from '../lib/haptics';
import { APP_VERSION } from '../lib/version';
import { GoogleSignInButton } from './GoogleSignInButton';
import { PWAInstallButton } from './PWAInstallButton';

interface AppMenuViewProps {
  appMode: AppMode;
  onSwitchAppMode: (mode: AppMode) => void;
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
}

export const AppMenuView: React.FC<AppMenuViewProps> = ({
  appMode,
  onSwitchAppMode,
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
}) => {
  const [haptics, setHaptics] = useState<HapticSettings>(() =>
    loadHapticSettings()
  );
  const hapticsAvailable = isHapticsSupported();
  const displayEmail = userEmail || rememberedEmail;

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

  return (
    <main className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 pt-5 pb-24 md:pb-12 space-y-6">
      <div className="pb-5 border-b border-zinc-800/80">
        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-zinc-50">
          Menu a nastavení
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Správa Google účtu, režimu třídění a chování aplikace v telefonu.
        </p>
      </div>

      {/* 1. Google Account & Remembered Login */}
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
          <p role="alert" className="text-xs text-rose-400">
            {authError}
          </p>
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

      {/* 2. App Mode Selection */}
      <section
        aria-label="Režim práce"
        className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 space-y-4"
      >
        <div className="space-y-1">
          <h2 className="font-display text-lg font-semibold text-zinc-100">
            Režim třídění fotografií
          </h2>
          <p className="text-sm text-zinc-400">
            Zvolte, zda chcete nejlepší snímky vybírat do složky Liked, nebo
            promazávat nepovedené záběry. Postup ve složkách je pro oba režimy
            společný.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => onSwitchAppMode('selectra')}
            aria-pressed={appMode === 'selectra'}
            className={`min-h-[68px] p-4 rounded-xl border text-left transition-colors cursor-pointer ${
              appMode === 'selectra'
                ? 'border-emerald-500/70 bg-emerald-500/10 text-zinc-50'
                : 'border-zinc-800 bg-[#09090B] text-zinc-300 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-display text-sm font-semibold">
                Selectra · Výběr fotek
              </span>
              <Check
                className={`w-4 h-4 shrink-0 ${
                  appMode === 'selectra' ? 'text-emerald-400' : 'text-zinc-600'
                }`}
                aria-hidden="true"
              />
            </div>
            <p className="mt-1 text-xs text-zinc-400 leading-relaxed">
              Swipnutí doprava označí fotku ★ pro zkopírování nebo přesun do
              podsložky Liked. Nic se nemaže.
            </p>
          </button>

          <button
            type="button"
            onClick={() => onSwitchAppMode('framecull')}
            aria-pressed={appMode === 'framecull'}
            className={`min-h-[68px] p-4 rounded-xl border text-left transition-colors cursor-pointer ${
              appMode === 'framecull'
                ? 'border-rose-500/70 bg-rose-500/10 text-zinc-50'
                : 'border-zinc-800 bg-[#09090B] text-zinc-300 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-display text-sm font-semibold">
                FrameCull · Mazání fotek
              </span>
              <Trash2
                className={`w-4 h-4 shrink-0 ${
                  appMode === 'framecull' ? 'text-rose-400' : 'text-zinc-600'
                }`}
                aria-hidden="true"
              />
            </div>
            <p className="mt-1 text-xs text-zinc-400 leading-relaxed">
              Swipnutí doleva zařadí nepovedené fotky i RAWy k přesunu do koše /
              podsložky _Vyrazene nebo ke smazání.
            </p>
          </button>
        </div>
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

      {/* 4. Device Install & Version Info */}
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
              {appMode === 'framecull' ? 'FrameCull' : 'Selectra'} · Mobilní
              edice
            </p>
            <p className="text-xs text-zinc-400 tabular-nums">
              Verze {APP_VERSION} · Offline čtení RAW (CR3, CR2, NEF, ARW, DNG)
            </p>
          </div>
        </div>
        <div className="shrink-0">
          <PWAInstallButton variant="subtle" />
        </div>
      </section>
    </main>
  );
};

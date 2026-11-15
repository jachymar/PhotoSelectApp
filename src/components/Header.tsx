import React from 'react';
import { AppMode } from '../lib/appMode';

export type AppView = 'phone' | 'drive' | 'studio' | 'menu';

interface HeaderProps {
  appMode: AppMode;
  isAuthenticated: boolean;
  hasDriveToken: boolean;
  activeView: AppView;
  hasActiveFolder: boolean;
  pickedCount: number;
  trashCount: number;
  isSigningIn?: boolean;
  onNavigate: (view: AppView) => void;
  onOpenFinishModal: () => void;
  onConnectDrive: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  appMode,
  isAuthenticated,
  hasDriveToken,
  activeView,
  hasActiveFolder,
  pickedCount,
  trashCount,
  isSigningIn = false,
  onNavigate,
  onOpenFinishModal,
  onConnectDrive,
}) => {
  const isFrameCull = appMode === 'framecull';
  const activeQueueCount = isFrameCull ? trashCount : pickedCount;

  const handlePrimaryClick = () => {
    if (activeQueueCount > 0 && hasActiveFolder) {
      onOpenFinishModal();
      return;
    }
    if (!isAuthenticated || !hasDriveToken) {
      onConnectDrive();
      return;
    }
    if (hasActiveFolder) {
      onNavigate('studio');
      return;
    }
    onNavigate('drive');
  };

  const primaryLabel =
    activeQueueCount > 0 && hasActiveFolder
      ? isFrameCull
        ? `Ke smazání (${trashCount})`
        : `Uložit Liked (${pickedCount})`
      : !isAuthenticated || !hasDriveToken
        ? isSigningIn
          ? 'Připojování…'
          : 'Připojit Drive'
        : hasActiveFolder
          ? 'Pokračovat'
          : 'Google Drive';

  return (
    <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-[#09090B]/95 backdrop-blur-md pt-safe">
      <div className="mx-auto flex h-12 sm:h-14 max-w-6xl items-center justify-between gap-8 px-4 sm:px-6 lg:px-8">
        {/* Zone 1: Single text element Brand wordmark */}
        <button
          type="button"
          onClick={() => onNavigate('phone')}
          className={`font-display text-base sm:text-lg font-bold tracking-tight text-zinc-100 whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 rounded-sm cursor-pointer ${
            isFrameCull
              ? 'hover:text-rose-400 focus-visible:outline-rose-500'
              : 'hover:text-amber-400 focus-visible:outline-amber-500'
          }`}
        >
          {isFrameCull ? 'FrameCull' : 'Selectra'}
        </button>

        {/* Zone 2: Clean single-line text navigation links (Desktop) */}
        <nav
          aria-label="Hlavní navigace"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-zinc-400"
        >
          <button
            type="button"
            onClick={() => onNavigate('phone')}
            className={`whitespace-nowrap shrink-0 transition-colors hover:text-zinc-100 hover:underline underline-offset-4 cursor-pointer ${
              activeView === 'phone' ? 'text-zinc-100 underline' : ''
            }`}
          >
            V telefonu
          </button>
          <button
            type="button"
            onClick={() => onNavigate('drive')}
            className={`whitespace-nowrap shrink-0 transition-colors hover:text-zinc-100 hover:underline underline-offset-4 cursor-pointer ${
              activeView === 'drive' ? 'text-zinc-100 underline' : ''
            }`}
          >
            Google Drive
          </button>
          <button
            type="button"
            onClick={() => onNavigate('studio')}
            className={`whitespace-nowrap shrink-0 transition-colors hover:text-zinc-100 hover:underline underline-offset-4 cursor-pointer ${
              activeView === 'studio' ? 'text-zinc-100 underline' : ''
            }`}
          >
            {isFrameCull ? 'Mazání fotek' : 'Třídění fotek'}
          </button>
          <button
            type="button"
            onClick={() => onNavigate('menu')}
            className={`whitespace-nowrap shrink-0 transition-colors hover:text-zinc-100 hover:underline underline-offset-4 cursor-pointer ${
              activeView === 'menu' ? 'text-zinc-100 underline' : ''
            }`}
          >
            Menu
          </button>
        </nav>

        {/* Zone 3: Single primary action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={handlePrimaryClick}
            disabled={isSigningIn && (!isAuthenticated || !hasDriveToken)}
            className={`min-h-[38px] sm:min-h-[40px] px-3.5 sm:px-4 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-amber-500 tabular-nums ${
              activeQueueCount > 0 && hasActiveFolder
                ? isFrameCull
                  ? 'bg-rose-500 text-white hover:bg-rose-400'
                  : 'bg-amber-500 text-zinc-950 hover:bg-amber-400'
                : 'bg-zinc-100 text-zinc-950 hover:bg-white'
            }`}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </header>
  );
};


import React from 'react';
import { useI18n } from '../lib/i18n';

export type AppView = 'phone' | 'drive' | 'select' | 'delete' | 'menu';

interface HeaderProps {
  activeView: AppView;
  hasActiveFolder: boolean;
  pickedCount: number;
  trashCount: number;
  onNavigate: (view: AppView) => void;
  onOpenFinishSelection: () => void;
  onOpenFinishTrash: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeView,
  hasActiveFolder,
  pickedCount,
  trashCount,
  onNavigate,
  onOpenFinishSelection,
  onOpenFinishTrash,
}) => {
  const { t } = useI18n();
  const preferTrashAction =
    hasActiveFolder &&
    trashCount > 0 &&
    (activeView === 'delete' || pickedCount === 0);
  const preferPickAction = hasActiveFolder && !preferTrashAction && pickedCount > 0;
  const showPrimaryAction = preferTrashAction || preferPickAction || hasActiveFolder;

  const handlePrimaryClick = () => {
    if (preferTrashAction) {
      onOpenFinishTrash();
      return;
    }
    if (preferPickAction) {
      onOpenFinishSelection();
      return;
    }
    if (hasActiveFolder) {
      onNavigate('select');
    }
  };

  const primaryLabel = preferTrashAction
    ? t(`Ke smazání (${trashCount})`, `To Delete (${trashCount})`)
    : preferPickAction
      ? t(`Uložit Liked (${pickedCount})`, `Save Liked (${pickedCount})`)
      : t('Výběr fotek', 'Select Photos');

  return (
    <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-[#09090B]/95 backdrop-blur-md pt-safe">
      <div className="mx-auto flex h-12 sm:h-14 max-w-6xl items-center justify-between gap-8 px-4 sm:px-6 lg:px-8">
        {/* Zone 1: Single text element Brand wordmark */}
        <button
          type="button"
          onClick={() => onNavigate('phone')}
          className="font-display text-base sm:text-lg font-bold tracking-tight text-zinc-100 whitespace-nowrap shrink-0 transition-colors hover:text-amber-400 focus-visible:outline-2 focus-visible:outline-amber-500 rounded-sm cursor-pointer"
        >
          Selectra
        </button>

        {/* Zone 2: Clean single-line text navigation links (Desktop) */}
        <nav
          aria-label={t('Hlavní navigace', 'Main navigation')}
          className="hidden md:flex items-center gap-6 text-sm font-medium text-zinc-400"
        >
          <button
            type="button"
            onClick={() => onNavigate('phone')}
            className={`whitespace-nowrap shrink-0 transition-colors hover:text-zinc-100 hover:underline underline-offset-4 cursor-pointer ${
              activeView === 'phone' ? 'text-zinc-100 underline' : ''
            }`}
          >
            {t('V telefonu', 'Phone')}
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
            onClick={() => onNavigate('select')}
            className={`whitespace-nowrap shrink-0 transition-colors hover:text-amber-300 hover:underline underline-offset-4 cursor-pointer ${
              activeView === 'select' ? 'text-amber-400 underline' : ''
            }`}
          >
            {t('Výběr', 'Select')}
          </button>
          <button
            type="button"
            onClick={() => onNavigate('delete')}
            className={`whitespace-nowrap shrink-0 transition-colors hover:text-rose-300 hover:underline underline-offset-4 cursor-pointer ${
              activeView === 'delete' ? 'text-rose-400 underline' : ''
            }`}
          >
            {t('Mazání', 'Delete')}
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

        {/* Zone 3: Single primary contextual action when a folder is active */}
        {showPrimaryAction ? (
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handlePrimaryClick}
              className={`min-h-[38px] sm:min-h-[40px] px-3.5 sm:px-4 py-1.5 text-xs sm:text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 tabular-nums ${
                preferTrashAction
                  ? 'bg-rose-500 text-white hover:bg-rose-400'
                  : preferPickAction
                    ? 'bg-amber-500 text-zinc-950 hover:bg-amber-400'
                    : 'bg-zinc-100 text-zinc-950 hover:bg-white'
              }`}
            >
              {primaryLabel}
            </button>
          </div>
        ) : (
          <div className="hidden md:block shrink-0" aria-hidden="true" />
        )}
      </div>
    </header>
  );
};

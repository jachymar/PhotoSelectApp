import React from 'react';
import {
  Smartphone,
  HardDrive,
  Star,
  Trash2,
  SlidersHorizontal,
} from 'lucide-react';
import { triggerHaptic } from '../lib/haptics';
import { useI18n } from '../lib/i18n';

export type MobileTabId = 'phone' | 'drive' | 'select' | 'delete' | 'menu';

interface MobileBottomNavProps {
  activeTab: MobileTabId;
  hasActiveFolder: boolean;
  isGoogleConnected: boolean;
  hasUpdateAvailable?: boolean;
  onSelectTab: (tab: MobileTabId) => void;
}

export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({
  activeTab,
  hasActiveFolder,
  hasUpdateAvailable = false,
  onSelectTab,
}) => {
  const { t } = useI18n();
  const handleTap = (tab: MobileTabId) => {
    if (tab !== activeTab) {
      triggerHaptic('selection');
    }
    onSelectTab(tab);
  };

  return (
    <nav
      aria-label={t('Spodní navigace aplikace', 'Bottom app navigation')}
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-zinc-800/90 bg-[#09090B]/95 backdrop-blur-md pb-safe"
    >
      <div className="grid grid-cols-5 items-center h-14">
        <button
          type="button"
          onClick={() => handleTap('phone')}
          aria-current={activeTab === 'phone' ? 'page' : undefined}
          className={`min-h-[48px] flex flex-col items-center justify-center px-0.5 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 ${
            activeTab === 'phone'
              ? 'text-amber-400'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Smartphone className="w-[20px] h-[20px] shrink-0" aria-hidden="true" />
          <span className="text-[10px] font-medium tracking-tight mt-0.5 whitespace-nowrap">
            {t('V telefonu', 'Phone')}
          </span>
        </button>

        <button
          type="button"
          onClick={() => handleTap('drive')}
          aria-current={activeTab === 'drive' ? 'page' : undefined}
          className={`min-h-[48px] flex flex-col items-center justify-center px-0.5 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 ${
            activeTab === 'drive'
              ? 'text-amber-400'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <HardDrive className="w-[20px] h-[20px] shrink-0" aria-hidden="true" />
          <span className="text-[10px] font-medium tracking-tight mt-0.5 whitespace-nowrap">
            Drive
          </span>
        </button>

        <button
          type="button"
          onClick={() => handleTap('select')}
          aria-current={activeTab === 'select' ? 'page' : undefined}
          className={`min-h-[48px] flex flex-col items-center justify-center px-0.5 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 ${
            activeTab === 'select'
              ? 'text-amber-400'
              : hasActiveFolder
                ? 'text-zinc-200 hover:text-amber-300'
                : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Star className="w-[20px] h-[20px] shrink-0" aria-hidden="true" />
          <span className="text-[10px] font-medium tracking-tight mt-0.5 whitespace-nowrap">
            {t('Výběr', 'Select')}
          </span>
        </button>

        <button
          type="button"
          onClick={() => handleTap('delete')}
          aria-current={activeTab === 'delete' ? 'page' : undefined}
          className={`min-h-[48px] flex flex-col items-center justify-center px-0.5 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-rose-500 ${
            activeTab === 'delete'
              ? 'text-rose-400'
              : hasActiveFolder
                ? 'text-zinc-200 hover:text-rose-300'
                : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Trash2 className="w-[20px] h-[20px] shrink-0" aria-hidden="true" />
          <span className="text-[10px] font-medium tracking-tight mt-0.5 whitespace-nowrap">
            {t('Mazání', 'Delete')}
          </span>
        </button>

        <button
          type="button"
          onClick={() => handleTap('menu')}
          aria-current={activeTab === 'menu' ? 'page' : undefined}
          aria-label={
            hasUpdateAvailable
              ? t('Menu — je dostupná aktualizace', 'Menu — update available')
              : 'Menu'
          }
          className={`min-h-[48px] flex flex-col items-center justify-center px-0.5 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 ${
            activeTab === 'menu'
              ? 'text-amber-400'
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <span className="relative inline-flex">
            <SlidersHorizontal
              className="w-[20px] h-[20px] shrink-0"
              aria-hidden="true"
            />
            {hasUpdateAvailable && (
              <span
                aria-hidden="true"
                className="absolute -top-0.5 -right-1 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-[#09090B]"
              />
            )}
          </span>
          <span className="text-[10px] font-medium tracking-tight mt-0.5 whitespace-nowrap">
            Menu
          </span>
        </button>
      </div>
    </nav>
  );
};

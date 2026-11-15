import React from 'react';
import { Smartphone, HardDrive, Layers, SlidersHorizontal } from 'lucide-react';
import { AppMode } from '../lib/appMode';
import { triggerHaptic } from '../lib/haptics';

export type MobileTabId = 'phone' | 'drive' | 'studio' | 'menu';

interface MobileBottomNavProps {
  activeTab: MobileTabId;
  appMode: AppMode;
  hasActiveFolder: boolean;
  isGoogleConnected: boolean;
  onSelectTab: (tab: MobileTabId) => void;
}

export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({
  activeTab,
  appMode,
  hasActiveFolder,
  onSelectTab,
}) => {
  const isFrameCull = appMode === 'framecull';
  const activeColor = isFrameCull ? 'text-rose-400' : 'text-amber-400';

  const handleTap = (tab: MobileTabId) => {
    if (tab !== activeTab) {
      triggerHaptic('selection');
    }
    onSelectTab(tab);
  };

  return (
    <nav
      aria-label="Spodní navigace aplikace"
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-zinc-800/90 bg-[#09090B]/95 backdrop-blur-md pb-safe"
    >
      <div className="grid grid-cols-4 items-center h-14">
        <button
          type="button"
          onClick={() => handleTap('phone')}
          aria-current={activeTab === 'phone' ? 'page' : undefined}
          className={`min-h-[48px] flex flex-col items-center justify-center px-1 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 ${
            activeTab === 'phone'
              ? activeColor
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <Smartphone className="w-[21px] h-[21px] shrink-0" aria-hidden="true" />
          <span className="text-[11px] font-medium tracking-tight mt-0.5 whitespace-nowrap">
            V telefonu
          </span>
        </button>

        <button
          type="button"
          onClick={() => handleTap('drive')}
          aria-current={activeTab === 'drive' ? 'page' : undefined}
          className={`min-h-[48px] flex flex-col items-center justify-center px-1 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 ${
            activeTab === 'drive'
              ? activeColor
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <HardDrive className="w-[21px] h-[21px] shrink-0" aria-hidden="true" />
          <span className="text-[11px] font-medium tracking-tight mt-0.5 whitespace-nowrap">
            Google Drive
          </span>
        </button>

        <button
          type="button"
          onClick={() => handleTap('studio')}
          aria-current={activeTab === 'studio' ? 'page' : undefined}
          className={`min-h-[48px] flex flex-col items-center justify-center px-1 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 ${
            activeTab === 'studio'
              ? activeColor
              : hasActiveFolder
                ? 'text-zinc-200 hover:text-white'
                : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Layers className="w-[21px] h-[21px] shrink-0" aria-hidden="true" />
          <span className="text-[11px] font-medium tracking-tight mt-0.5 whitespace-nowrap">
            {isFrameCull ? 'Mazání' : 'Třídění'}
          </span>
        </button>

        <button
          type="button"
          onClick={() => handleTap('menu')}
          aria-current={activeTab === 'menu' ? 'page' : undefined}
          className={`min-h-[48px] flex flex-col items-center justify-center px-1 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 ${
            activeTab === 'menu'
              ? activeColor
              : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          <SlidersHorizontal
            className="w-[21px] h-[21px] shrink-0"
            aria-hidden="true"
          />
          <span className="text-[11px] font-medium tracking-tight mt-0.5 whitespace-nowrap">
            Menu
          </span>
        </button>
      </div>
    </nav>
  );
};

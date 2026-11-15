import React, { useState } from 'react';
import { Download, Share, PlusSquare, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'primary' | 'subtle';
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  variant = 'subtle',
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  // Already running as an installed standalone PWA
  if (isInstalled) {
    return null;
  }

  const handleClick = async () => {
    if (isInstallable) {
      const accepted = await install();
      if (!accepted) {
        setShowGuide(true);
      }
      return;
    }
    setShowGuide(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className={
          variant === 'primary'
            ? 'min-h-[44px] inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-[#141417] px-4 py-2 text-sm font-medium text-zinc-100 hover:border-amber-500/60 hover:text-amber-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500'
            : 'min-h-[40px] inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-[#141417] px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500'
        }
      >
        {isInstallable ? (
          <Download className="w-4 h-4 text-amber-400" aria-hidden="true" />
        ) : (
          <Smartphone className="w-4 h-4 text-amber-400" aria-hidden="true" />
        )}
        <span>
          {isInstallable
            ? 'Nainstalovat aplikaci'
            : isIOS
              ? 'Přidat na plochu iPhonu'
              : 'Do telefonu (PWA)'}
        </span>
      </button>

      {showGuide && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-guide-title"
          onClick={() => setShowGuide(false)}
        >
          <div
            className="w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl border border-zinc-800 bg-[#141417] p-6 shadow-2xl space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <img
                  src="/pwa-192x192.png"
                  alt="Ikona Selectra"
                  className="h-11 w-11 rounded-xl border border-zinc-800 shrink-0"
                />
                <div>
                  <h2
                    id="pwa-guide-title"
                    className="font-display text-lg font-semibold text-zinc-100"
                  >
                    Instalace Selectra do telefonu
                  </h2>
                  <p className="text-xs text-zinc-400">
                    Spouštění z plochy na celou obrazovku bez lišty prohlížeče
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                aria-label="Zavřít návod"
                className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 text-sm text-zinc-300">
              {isIOS ? (
                <div className="rounded-xl border border-zinc-800 bg-[#09090B] p-4 space-y-3">
                  <p className="font-semibold text-amber-300">
                    iPhone / iPad (Safari)
                  </p>
                  <ol className="space-y-2.5 text-xs sm:text-sm text-zinc-300">
                    <li className="flex items-start gap-2.5">
                      <span className="font-mono text-amber-400 shrink-0">
                        1.
                      </span>
                      <span>
                        V prohlížeči <strong>Safari</strong> klepněte na ikonu{' '}
                        <Share
                          className="inline w-4 h-4 mx-0.5 text-zinc-100"
                          aria-hidden="true"
                        />{' '}
                        <strong>Sdílet</strong> ve spodní liště.
                      </span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <span className="font-mono text-amber-400 shrink-0">
                        2.
                      </span>
                      <span>
                        Posuňte nabídku dolů a vyberte{' '}
                        <PlusSquare
                          className="inline w-4 h-4 mx-0.5 text-zinc-100"
                          aria-hidden="true"
                        />{' '}
                        <strong>Přidat na plochu</strong>.
                      </span>
                    </li>
                    <li className="flex items-start gap-2.5">
                      <span className="font-mono text-amber-400 shrink-0">
                        3.
                      </span>
                      <span>
                        Potvrďte tlačítkem <strong>Přidat</strong>. Aplikace se
                        objeví jako ikona na ploše.
                      </span>
                    </li>
                  </ol>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-xl border border-zinc-800 bg-[#09090B] p-4 space-y-2">
                    <p className="font-semibold text-amber-300 text-xs sm:text-sm">
                      Android (Chrome / Edge / Samsung Internet)
                    </p>
                    <p className="text-xs sm:text-sm text-zinc-300 leading-relaxed">
                      Otevřete odkaz aplikace přímo v Chromu na telefonu (ne v
                      náhledovém okně), klepněte na menu{' '}
                      <strong className="text-zinc-100">⋮</strong> vpravo nahoře
                      a zvolte{' '}
                      <strong className="text-zinc-100">
                        Nainstalovat aplikaci
                      </strong>{' '}
                      nebo{' '}
                      <strong className="text-zinc-100">
                        Přidat na plochu
                      </strong>
                      .
                    </p>
                  </div>

                  <div className="rounded-xl border border-zinc-800 bg-[#09090B] p-4 space-y-2">
                    <p className="font-semibold text-zinc-200 text-xs sm:text-sm">
                      iPhone / iPad (Safari)
                    </p>
                    <p className="text-xs sm:text-sm text-zinc-400 leading-relaxed">
                      V Safari klepněte na{' '}
                      <strong className="text-zinc-200">Sdílet</strong> a poté{' '}
                      <strong className="text-zinc-200">
                        Přidat na plochu
                      </strong>
                      .
                    </p>
                  </div>
                </div>
              )}

              <p className="text-xs text-zinc-500 leading-relaxed">
                Tip: Všechen váš postup třídění se ukládá do cloudu pod vaším
                Google účtem — práci rozdělanou na mobilu můžete kdykoliv
                dokončit na počítači.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="w-full min-h-[44px] rounded-xl bg-zinc-100 text-zinc-950 text-sm font-semibold hover:bg-white transition-colors cursor-pointer"
            >
              Rozumím
            </button>
          </div>
        </div>
      )}
    </>
  );
};

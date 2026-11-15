import React, { useState } from 'react';
import { GoogleSignInButton } from './GoogleSignInButton';
import { PWAInstallButton } from './PWAInstallButton';
import { LocalSourcePicker } from './LocalSourcePicker';
import { LocalStreamStarter } from '../lib/localMedia';
import { AppMode } from '../lib/appMode';
import { APP_VERSION } from '../lib/version';
import heroCameraImg from '../assets/images/hero_camera_darkroom_1794576098958.jpg';

interface LandingHeroProps {
  appMode: AppMode;
  onSignIn: () => void;
  onStartLocalStream: (starter: LocalStreamStarter) => void;
  isSigningIn: boolean;
  authError: string | null;
}

export const LandingHero: React.FC<LandingHeroProps> = ({
  appMode,
  onSignIn,
  onStartLocalStream,
  isSigningIn,
  authError,
}) => {
  const [imgFailed, setImgFailed] = useState(false);
  const isFrameCull = appMode === 'framecull';

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12 lg:py-16">
      {/* Split-Screen Hero */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-stretch">
        <div className="lg:col-span-6 flex flex-col justify-between py-2">
          <div className="space-y-6">
            <p
              className={`text-sm font-medium tracking-tight tabular-nums ${
                isFrameCull ? 'text-rose-400' : 'text-amber-400'
              }`}
            >
              {isFrameCull ? 'FrameCull' : 'Selectra'} {APP_VERSION} · Google Drive · Lokální soubory &amp; SD karty · Canon CR3
            </p>
            <h1 className="font-display text-4xl sm:text-5xl font-bold tracking-tight text-zinc-50 leading-[1.1] [text-wrap:balance]">
              {isFrameCull
                ? 'Rychle promažte nepovedené fotky z Drive i SD karty.'
                : 'Vyberte ty nejlepší fotografie z Drive i SD karty.'}
            </h1>
            <p className="text-base sm:text-lg text-zinc-400 leading-relaxed max-w-[60ch]">
              {isFrameCull
                ? 'Přihlaste se ke svému Google Drive nebo otevřete lokální složku či SD kartu. Porovnávejte série na filmstripu, swipem doleva zařazujte rozmazané snímky včetně spárovaných RAWů ke smazání a bezpečně uvolněte místo.'
                : 'Přihlaste se ke svému Google Drive nebo otevřete lokální složku z počítače, telefonu či USB čtečky SD karet bez přihlášení. Porovnávejte série na kontinuálním filmstripu a vybrané snímky včetně spárovaných RAWů jedním kliknutím uložte do podsložky Liked.'}
            </p>
          </div>

          <div className="mt-8 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <GoogleSignInButton
                onClick={onSignIn}
                loading={isSigningIn}
                label="Přihlásit se přes Google"
              />
              <PWAInstallButton variant="primary" />
            </div>

            <div className="pt-2 border-t border-zinc-800/80">
              <p className="text-xs font-medium text-zinc-400 mb-2.5">
                Nebo pracujte offline bez přihlášení:
              </p>
              <LocalSourcePicker
                variant="hero"
                onStartLocalStream={onStartLocalStream}
              />
            </div>

            {authError && (
              <p
                role="alert"
                className="text-sm text-rose-400 max-w-md"
              >
                {authError}
              </p>
            )}

            <p className="text-xs text-zinc-500">
              {isFrameCull
                ? 'Videa jsou automaticky přeskočena · Přesun do koše / _Vyrazene nebo trvalé smazání s potvrzením · Sdílený postup se Selectrou'
                : 'Videa jsou automaticky přeskočena · Nedestruktivní výběr bez nechtěného mazání · Export do podsložky Liked'}
            </p>
          </div>
        </div>

        <div className="lg:col-span-6">
          <div className="relative h-full min-h-[320px] lg:min-h-[440px] overflow-hidden rounded-2xl border border-zinc-800 bg-[#141417]">
            {!imgFailed ? (
              <img
                src={heroCameraImg}
                alt="Profesionální fotoaparát Canon a monitor se zobrazenou RAW fotografií krajiny"
                referrerPolicy="no-referrer"
                onError={() => setImgFailed(true)}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-950 p-8 text-center">
                <p className="text-sm text-zinc-400">
                  {isFrameCull
                    ? 'Nástroj pro rychlé třídění a mazání fotografií a RAW snímků na Google Drive i lokálních discích'
                    : 'Nástroj pro kurátorský výběr fotografií a RAW snímků na Google Drive i lokálních discích'}
                </p>
              </div>
            )}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-6">
              <p className="font-mono text-xs text-zinc-300 tabular-nums">
                IMG_4821.CR3 · 31.4 MB · Canon EOS R5 · 50mm · f/2.0 · ISO 100
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Full-width 4-column summary strip below hero split */}
      <section
        id="jak-to-funguje"
        className="mt-16 border-t border-zinc-800/80 pt-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8"
      >
        <div>
          <p
            className={`font-mono text-xs tabular-nums ${
              isFrameCull ? 'text-rose-400' : 'text-amber-400'
            }`}
          >
            01
          </p>
          <h2 className="mt-2 font-display text-lg font-semibold text-zinc-100">
            Drive, disk i SD karta
          </h2>
          <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
            {isFrameCull
              ? 'Procházejte a čistěte složky Google Drive, lokální disk nebo přímo čtečku SD karet připojenou přes USB.'
              : 'Vybírejte snímky ze složek Google Drive, lokálního počítače nebo přímo ze čtečky SD karet připojené přes USB.'}
          </p>
        </div>

        <div id="podpora-raw">
          <p
            className={`font-mono text-xs tabular-nums ${
              isFrameCull ? 'text-rose-400' : 'text-amber-400'
            }`}
          >
            02
          </p>
          <h2 className="mt-2 font-display text-lg font-semibold text-zinc-100">
            Podpora Canon CR3 a RAW
          </h2>
          <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
            Rychlá extrakce náhledu i EXIF dat přímo v prohlížeči pro CR3, CR2,
            NEF, ARW, DNG a RAF včetně automatického párování JPG+RAW.
          </p>
        </div>

        <div id="ovladani">
          <p
            className={`font-mono text-xs tabular-nums ${
              isFrameCull ? 'text-rose-400' : 'text-amber-400'
            }`}
          >
            03
          </p>
          <h2 className="mt-2 font-display text-lg font-semibold text-zinc-100">
            Filmstrip, série a galerie
          </h2>
          <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
            Plynule přichytávaný filmstrip, automatické rozpoznávání podobných
            sérií i oddálená galerie vám pomohou najít nejslabší snímky.
          </p>
        </div>

        <div id="bezpecnost">
          <p
            className={`font-mono text-xs tabular-nums ${
              isFrameCull ? 'text-rose-400' : 'text-amber-400'
            }`}
          >
            04
          </p>
          <h2 className="mt-2 font-display text-lg font-semibold text-zinc-100">
            {isFrameCull ? 'Koš i trvalé smazání' : 'Export do podsložky Liked'}
          </h2>
          <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
            {isFrameCull
              ? 'Na konci si vyberete mezi bezpečným přesunem do koše / podsložky _Vyrazene nebo potvrzeným trvalým smazáním s výpočtem uvolněného místa.'
              : 'Nic se nemaže omylem. Po dokončení výběru se označené fotky a jejich RAWy zkopírují nebo přesunou do nové složky Liked.'}
          </p>
        </div>
      </section>
    </main>
  );
};

#!/usr/bin/env node
/**
 * Generates crisp Selectra PWA & Android Adaptive Icon assets from src/lib/iconProposalsCore.js.
 * Usage:
 *   node scripts/generate-icons.mjs              # renders proposal A (default)
 *   node scripts/generate-icons.mjs --proposal=B # renders proposal B, C, or D
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import {
  ICON_PROPOSALS,
  buildProposalSvg,
  getProposalById,
} from '../src/lib/iconProposalsCore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function parseProposalArg() {
  const arg = process.argv.find((item) => item.startsWith('--proposal='));
  if (!arg) return 'A8';
  const raw = arg.split('=')[1]?.trim().toUpperCase();
  if (ICON_PROPOSALS.some((p) => p.id === raw)) {
    return raw;
  }
  const bySlug = ICON_PROPOSALS.find(
    (p) => p.slug.toLowerCase() === raw?.toLowerCase()
  );
  return bySlug ? bySlug.id : 'A8';
}

function renderPngBuffer(svgString, sizePx) {
  const resvg = new Resvg(svgString, {
    fitTo: {
      mode: 'width',
      value: sizePx,
    },
    shapeRendering: 2,
    textRendering: 1,
    imageRendering: 0,
  });
  const rendered = resvg.render();
  return rendered.asPng();
}

const proposalId = parseProposalArg();
const proposal = getProposalById(proposalId);

const PUBLIC_DIR = path.join(ROOT, 'public');
const ANDROID_RES_DIR = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

// 1. Web / PWA assets
const faviconSvg = buildProposalSvg(proposal.id, 'favicon', 'web');
fs.writeFileSync(path.join(PUBLIC_DIR, 'icon.svg'), `${faviconSvg}\n`, 'utf8');

const squareSvg = buildProposalSvg(proposal.id, 'square', 'pwa');
const maskableSvg = buildProposalSvg(proposal.id, 'maskable', 'pwa');
const adaptiveFgSvg = buildProposalSvg(
  proposal.id,
  'adaptiveForeground',
  'android'
);

fs.writeFileSync(
  path.join(PUBLIC_DIR, 'pwa-192x192.png'),
  renderPngBuffer(squareSvg, 192)
);
fs.writeFileSync(
  path.join(PUBLIC_DIR, 'pwa-512x512.png'),
  renderPngBuffer(squareSvg, 512)
);
fs.writeFileSync(
  path.join(PUBLIC_DIR, 'pwa-maskable-512x512.png'),
  renderPngBuffer(maskableSvg, 512)
);
fs.writeFileSync(
  path.join(PUBLIC_DIR, 'apple-touch-icon.png'),
  renderPngBuffer(squareSvg, 180)
);

// 2. Store transparent Android foreground master in scripts/ so configure-android.mjs stays idempotent
fs.writeFileSync(
  path.join(__dirname, 'android-foreground-512x512.png'),
  renderPngBuffer(adaptiveFgSvg, 512)
);

// 3. Density-exact Android mipmap icons (if android/ exists)
const ANDROID_DENSITIES = [
  { dir: 'mipmap-mdpi', launcherPx: 48, foregroundPx: 108 },
  { dir: 'mipmap-hdpi', launcherPx: 72, foregroundPx: 162 },
  { dir: 'mipmap-xhdpi', launcherPx: 96, foregroundPx: 216 },
  { dir: 'mipmap-xxhdpi', launcherPx: 144, foregroundPx: 324 },
  { dir: 'mipmap-xxxhdpi', launcherPx: 192, foregroundPx: 432 },
];

if (fs.existsSync(ANDROID_RES_DIR)) {
  const roundLauncherSvg = buildProposalSvg(proposal.id, 'square', 'android-round');
  for (const spec of ANDROID_DENSITIES) {
    const targetDir = path.join(ANDROID_RES_DIR, spec.dir);
    if (!fs.existsSync(targetDir)) continue;

    const launcherPng = renderPngBuffer(roundLauncherSvg, spec.launcherPx);
    const fgPng = renderPngBuffer(adaptiveFgSvg, spec.foregroundPx);

    fs.writeFileSync(path.join(targetDir, 'ic_launcher.png'), launcherPng);
    fs.writeFileSync(path.join(targetDir, 'ic_launcher_round.png'), launcherPng);
    fs.writeFileSync(path.join(targetDir, 'ic_launcher_foreground.png'), fgPng);
  }
}

console.log(
  `Vygenerovány ikony (${proposal.name}) pro PWA i Android adaptivní masku (~65 % střed).`
);

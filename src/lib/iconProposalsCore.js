/**
 * Shared vector definitions for 10 Selectra "Variant A" (Viewfinder) icon proposals.
 * Every variant uses thicker strokes and exact outer-span math so the entire visual
 * motif (including outer stroke width) occupies strictly LESS than 65% of the visible
 * Android launcher icon (72dp inside 108dp adaptive canvas) and PWA square icon.
 */

export const ICON_THEME = {
  background: '#09090B',
  amber: '#F59E0B',
  white: '#F4F4F5',
};

function buildViewfinderArtwork({
  inset,
  legLen,
  cornerRadius,
  bracketStroke,
  ringRadius,
  ringStroke,
  dotRadius,
}) {
  const min = inset;
  const max = 512 - inset;
  const r = cornerRadius;
  const leg = legLen;

  return `
      <path d="M ${min} ${min + leg} V ${min + r} C ${min} ${(min + r * 0.448).toFixed(2)} ${(min + r * 0.448).toFixed(2)} ${min} ${min + r} ${min} H ${min + leg}" stroke="${ICON_THEME.amber}" stroke-width="${bracketStroke}" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M ${max - leg} ${min} H ${max - r} C ${(max - r * 0.448).toFixed(2)} ${min} ${max} ${(min + r * 0.448).toFixed(2)} ${max} ${min + r} V ${min + leg}" stroke="${ICON_THEME.amber}" stroke-width="${bracketStroke}" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M ${max} ${max - leg} V ${max - r} C ${max} ${(max - r * 0.448).toFixed(2)} ${(max - r * 0.448).toFixed(2)} ${max} ${max - r} ${max} H ${max - leg}" stroke="${ICON_THEME.amber}" stroke-width="${bracketStroke}" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M ${min + leg} ${max} H ${min + r} C ${(min + r * 0.448).toFixed(2)} ${max} ${min} ${(max - r * 0.448).toFixed(2)} ${min} ${max - r} V ${max - leg}" stroke="${ICON_THEME.amber}" stroke-width="${bracketStroke}" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="256" cy="256" r="${ringRadius}" stroke="${ICON_THEME.white}" stroke-width="${ringStroke}"/>
      <circle cx="256" cy="256" r="${dotRadius}" fill="${ICON_THEME.amber}"/>
  `;
}

const RAW_A_VARIANTS = [
  {
    id: 'A1',
    slug: 'a1-vyvazena-60',
    name: 'Varianta A1 · Vyvážená tučná',
    shortName: 'A1',
    subtitle: '60 % plochy · Rohy 30 px · Střední vzdálenost',
    description:
      'Přirozené zesílení čar oproti původnímu návrhu A se zachováním čistých mezer mezi rohy a bílým prstencem.',
    targetVisiblePct: 60,
    spec: {
      inset: 88,
      legLen: 88,
      cornerRadius: 32,
      bracketStroke: 30,
      ringRadius: 68,
      ringStroke: 25,
      dotRadius: 27,
    },
  },
  {
    id: 'A2',
    slug: 'a2-tesna-58',
    name: 'Varianta A2 · Rohy blíž k prstenci',
    shortName: 'A2',
    subtitle: '58 % plochy · Těsné usazení · Silné tahy',
    description:
      'Rohy hledáčku jsou posunuté blíže k bílému prstenci, takže ikona působí sevřeně a má ještě větší volný okraj kolem.',
    targetVisiblePct: 58,
    spec: {
      inset: 104,
      legLen: 82,
      cornerRadius: 30,
      bracketStroke: 32,
      ringRadius: 68,
      ringStroke: 26,
      dotRadius: 28,
    },
  },
  {
    id: 'A3',
    slug: 'a3-tucna-56',
    name: 'Varianta A3 · Výrazně tučná kompaktní',
    shortName: 'A3',
    subtitle: '56 % plochy · Čáry 36 / 28 px · Kompaktní',
    description:
      'Extra čitelná na malé ploše telefonu díky silným oranžovým rohům a hrubšímu bílému prstenci v 56 % středu.',
    targetVisiblePct: 56,
    spec: {
      inset: 94,
      legLen: 84,
      cornerRadius: 32,
      bracketStroke: 36,
      ringRadius: 68,
      ringStroke: 28,
      dotRadius: 29,
    },
  },
  {
    id: 'A4',
    slug: 'a4-vzduch-52',
    name: 'Varianta A4 · Extra velký okraj',
    shortName: 'A4',
    subtitle: '52 % plochy · Velký odstup od masky',
    description:
      'Nejmenší a nejvzdušnější varianta — silný symbol soustředěný jen do 52 % středu s maximálním tmavým rámem kolem.',
    targetVisiblePct: 52,
    spec: {
      inset: 96,
      legLen: 86,
      cornerRadius: 30,
      bracketStroke: 34,
      ringRadius: 70,
      ringStroke: 28,
      dotRadius: 30,
    },
  },
  {
    id: 'A5',
    slug: 'a5-silny-prstenec-59',
    name: 'Varianta A5 · Dominantní bílý prstenec',
    shortName: 'A5',
    subtitle: '59 % plochy · Kratší rohy · Širší prstenec',
    description:
      'Krátké, robustní rohové značky a o něco výraznější bílý objektiv uprostřed pro okamžitou rozpoznatelnost.',
    targetVisiblePct: 59,
    spec: {
      inset: 96,
      legLen: 68,
      cornerRadius: 28,
      bracketStroke: 34,
      ringRadius: 74,
      ringStroke: 28,
      dotRadius: 29,
    },
  },
  {
    id: 'A6',
    slug: 'a6-maly-bily-stred-60',
    name: 'Varianta A6 · Kompaktní bílý střed',
    shortName: 'A6',
    subtitle: '60 % plochy · Menší bílý kruh · Delší rohy',
    description:
      'Bílý prstenec je menší a hluboko uvnitř, zatímco silné oranžové rohy s delšími rameny tvoří pevné ohraničení.',
    targetVisiblePct: 60,
    spec: {
      inset: 88,
      legLen: 98,
      cornerRadius: 32,
      bracketStroke: 32,
      ringRadius: 56,
      ringStroke: 24,
      dotRadius: 24,
    },
  },
  {
    id: 'A7',
    slug: 'a7-ostre-rohy-57',
    name: 'Varianta A7 · Ostřejší rohy hledáčku',
    shortName: 'A7',
    subtitle: '57 % plochy · Technický poloměr 16 px',
    description:
      'Techničtější vzhled zrcadlovky s menším zaoblením rohů a vyváženou tloušťkou všech prvků v 57 % plochy.',
    targetVisiblePct: 57,
    spec: {
      inset: 96,
      legLen: 84,
      cornerRadius: 16,
      bracketStroke: 32,
      ringRadius: 66,
      ringStroke: 26,
      dotRadius: 27,
    },
  },
  {
    id: 'A8',
    slug: 'a8-masivni-62',
    name: 'Varianta A8 · Maximální tučnost pod 65 %',
    shortName: 'A8',
    subtitle: '62 % plochy · Nejsilnější tahy 38 / 30 px',
    description:
      'Nejsilnější provedení, které se stále drží bezpečně pod 65 % hranicí. Vynikne i při nejmenší mřížce ikon.',
    targetVisiblePct: 62,
    spec: {
      inset: 96,
      legLen: 84,
      cornerRadius: 30,
      bracketStroke: 38,
      ringRadius: 70,
      ringStroke: 30,
      dotRadius: 31,
    },
  },
  {
    id: 'A9',
    slug: 'a9-uzavreny-55',
    name: 'Varianta A9 · Těsný rámeček 55 %',
    shortName: 'A9',
    subtitle: '55 % plochy · Dlouhé rohy blízko kruhu',
    description:
      'Rohy sahají hlouběji k sobě a pevně objímají menší bílý střed, přitom celý celek zabírá jen 55 % viditelného prostoru.',
    targetVisiblePct: 55,
    spec: {
      inset: 102,
      legLen: 106,
      cornerRadius: 28,
      bracketStroke: 30,
      ringRadius: 62,
      ringStroke: 25,
      dotRadius: 26,
    },
  },
  {
    id: 'A10',
    slug: 'a10-plny-stred-61',
    name: 'Varianta A10 · Velký středový bod',
    shortName: 'A10',
    subtitle: '61 % plochy · Výrazná oranžová tečka 35 px',
    description:
      'Těsné, zaoblené rohy hledáčku a výraznější oranžová spoušť uprostřed silného bílého prstence.',
    targetVisiblePct: 61,
    spec: {
      inset: 100,
      legLen: 76,
      cornerRadius: 36,
      bracketStroke: 32,
      ringRadius: 72,
      ringStroke: 26,
      dotRadius: 35,
    },
  },
];

export const ICON_PROPOSALS = RAW_A_VARIANTS.map((item) => {
  const outerSpan = 512 - 2 * item.spec.inset + item.spec.bracketStroke;
  const adaptiveScale = Number(
    (((item.targetVisiblePct / 100) * 341.333) / outerSpan).toFixed(4)
  );
  const squareScale = Number((adaptiveScale * 1.5).toFixed(4));
  const markup = buildViewfinderArtwork(item.spec);

  return {
    id: item.id,
    slug: item.slug,
    name: item.name,
    shortName: item.shortName,
    subtitle: item.subtitle,
    description: item.description,
    targetVisiblePct: item.targetVisiblePct,
    adaptiveScale,
    squareScale,
    strokeSummary: `${item.spec.bracketStroke} / ${item.spec.ringStroke}`,
    renderArtwork: () => markup,
  };
});

export function getProposalById(id) {
  return ICON_PROPOSALS.find((p) => p.id === id) || ICON_PROPOSALS[0];
}

/**
 * Generates an SVG string for one of the 10 A-variants:
 * - 'adaptiveForeground': Transparent background, exact adaptiveScale (<65% of visible 72dp window).
 * - 'maskable': Solid #09090B background, exact adaptiveScale.
 * - 'square': Solid #09090B background, squareScale (identical % of square icon).
 * - 'favicon': Rounded #09090B background (rx=112), squareScale.
 */
export function buildProposalSvg(proposalId, mode = 'square', uidSuffix = '') {
  const proposal = getProposalById(proposalId);
  const uid = `${proposal.id}-${mode}${uidSuffix ? `-${uidSuffix}` : ''}`;
  const isAdaptiveScale = mode === 'adaptiveForeground' || mode === 'maskable';
  const scale = isAdaptiveScale ? proposal.adaptiveScale : proposal.squareScale;

  let backgroundRect = '';
  if (mode === 'favicon') {
    backgroundRect = `<rect width="512" height="512" rx="112" fill="${ICON_THEME.background}"/>`;
  } else if (mode === 'square' || mode === 'maskable') {
    backgroundRect = `<rect width="512" height="512" fill="${ICON_THEME.background}"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
  ${backgroundRect}
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    ${proposal.renderArtwork(uid)}
  </g>
</svg>`;
}

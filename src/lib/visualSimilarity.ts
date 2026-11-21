import { DrivePhotoFile } from './driveApi';
import {
  extractFastHeaderThumbnailBlob,
  fetchPhotoBytes,
  getCachedFilmstripThumbnailUrl,
  getFastPreviewThumbnailUrl,
} from './rawParser';
import { getCachedMicroThumbBlob } from './previewCacheDb';
import { waitForBackgroundSlot } from './interactionGate';

import {
  computeFingerprintFromRgba32x32,
  type VisualFingerprint,
} from './fingerprintMath';

export type { VisualFingerprint };
export type SimilaritySensitivity = 'strict' | 'balanced' | 'loose';
export type SimilarityScope = 'nearby' | 'folder';

interface SensitivityProfile {
  minScore: number;
  minStruct: number;
  minCenter: number;
  minEdge: number;
  minSpatialColor: number;
  minCenterColor: number;
  maxMeanLumaDiff: number;
}

export interface VisualSimilarityMetrics {
  score: number;
  structSim: number;
  centerSim: number;
  edgeSim: number;
  spatialColorSim: number;
  centerColorSim: number;
  histSim: number;
  meanLumaDiff: number;
  incompatible: boolean;
}

export interface CustomVisualCalibration {
  minScore: number;
  minStruct: number;
  minCenter: number;
  minEdge: number;
  minSpatialColor: number;
  minCenterColor: number;
  maxMeanLumaDiff: number;
  sameCount: number;
  differentCount: number;
  accuracyPct: number;
  updatedAt: number;
}

export interface VisualCalibrationExample {
  pairKey: string;
  idA: string;
  idB: string;
  label: 'same' | 'different';
  metrics: VisualSimilarityMetrics;
}

/**
 * Calibrated so the middle level ('balanced' / Střední) enforces tighter,
 * multi-gate visual matching including inner subject color layout, leaving genuine
 * headroom on both sides ('strict' = Přísnější, 'loose' = Volnější).
 */
const SENSITIVITY_PROFILES: Record<SimilaritySensitivity, SensitivityProfile> = {
  strict: {
    minScore: 0.85,
    minStruct: 0.80,
    minCenter: 0.75,
    minEdge: 0.62,
    minSpatialColor: 0.76,
    minCenterColor: 0.74,
    maxMeanLumaDiff: 0.16,
  },
  balanced: {
    minScore: 0.78,
    minStruct: 0.72,
    minCenter: 0.66,
    minEdge: 0.52,
    minSpatialColor: 0.68,
    minCenterColor: 0.66,
    maxMeanLumaDiff: 0.22,
  },
  loose: {
    minScore: 0.69,
    minStruct: 0.62,
    minCenter: 0.54,
    minEdge: 0.40,
    minSpatialColor: 0.58,
    minCenterColor: 0.56,
    maxMeanLumaDiff: 0.28,
  },
};

const NEIGHBOR_THRESHOLD_BONUS = 0.015;

function clamp01(val: number): number {
  if (val <= 0) return 0;
  if (val >= 1) return 1;
  return val;
}

/**
 * Computes normalized Pearson correlation between two 16x16 Z-normalized grids
 * on a sub-rectangle at shift (dx, dy).
 */
function shiftedRegionCorrelation16(
  a: Float32Array,
  b: Float32Array,
  dx: number,
  dy: number,
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number
): number {
  const yStart = Math.max(yMin, -dy);
  const yEnd = Math.min(yMax, 16 - dy);
  const xStart = Math.max(xMin, -dx);
  const xEnd = Math.min(xMax, 16 - dx);

  let count = 0;
  let sumA = 0;
  let sumB = 0;

  for (let y = yStart; y < yEnd; y++) {
    const rowA = y * 16;
    const rowB = (y + dy) * 16;
    for (let x = xStart; x < xEnd; x++) {
      sumA += a[rowA + x];
      sumB += b[rowB + x + dx];
      count++;
    }
  }

  if (count < 16) return 0;
  const meanA = sumA / count;
  const meanB = sumB / count;

  let num = 0;
  let varA = 0;
  let varB = 0;

  for (let y = yStart; y < yEnd; y++) {
    const rowA = y * 16;
    const rowB = (y + dy) * 16;
    for (let x = xStart; x < xEnd; x++) {
      const da = a[rowA + x] - meanA;
      const db = b[rowB + x + dx] - meanB;
      num += da * db;
      varA += da * da;
      varB += db * db;
    }
  }

  const denom = Math.sqrt(varA * varB);
  return denom > 1e-6 ? num / denom : 0;
}

/**
 * Finds the best alignment shift (dx, dy ∈ [-1, 0, +1], i.e. ±6.25% framing tolerance)
 * for 16x16 luma structure, and also measures inner 10x10 subject core correlation
 * and smoothed Sobel edge layout correlation at that aligned shift.
 */
function alignedStructuralMetrics(
  a: VisualFingerprint,
  b: VisualFingerprint
): {
  structSim: number;
  centerSim: number;
  edgeSim: number;
  bestDx: number;
  bestDy: number;
} {
  let bestCorr = -1;
  let bestDx = 0;
  let bestDy = 0;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const corr = shiftedRegionCorrelation16(
        a.lumaGrid,
        b.lumaGrid,
        dx,
        dy,
        0,
        16,
        0,
        16
      );
      if (corr > bestCorr) {
        bestCorr = corr;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  // Center 10x10 subject core ([3..13) x [3..13)) aligned with camera shift
  const centerCorr = shiftedRegionCorrelation16(
    a.lumaGrid,
    b.lumaGrid,
    bestDx,
    bestDy,
    3,
    13,
    3,
    13
  );

  // Edge layout correlation at optimal shift (also check zero shift & take max)
  const edgeAtShift = shiftedRegionCorrelation16(
    a.edgeGrid,
    b.edgeGrid,
    bestDx,
    bestDy,
    0,
    16,
    0,
    16
  );
  const edgeAtZero =
    bestDx === 0 && bestDy === 0
      ? edgeAtShift
      : shiftedRegionCorrelation16(a.edgeGrid, b.edgeGrid, 0, 0, 0, 16, 0, 16);

  return {
    structSim: clamp01(bestCorr),
    centerSim: clamp01(centerCorr),
    edgeSim: clamp01(Math.max(edgeAtShift, edgeAtZero)),
    bestDx,
    bestDy,
  };
}

/**
 * Evaluates 8x8 spatial opponent-color similarity [L, R-G, Y-B] with alignment tolerance,
 * returning both full-frame spatialColorSim and central 4x4 subject core centerColorSim
 * (penalized by top-quartile local cell mismatch so distinct subjects never hide behind matching backgrounds).
 */
function computeSpatialColorSimilarity(
  a: Float32Array,
  b: Float32Array,
  bestDx16: number,
  bestDy16: number
): { spatialColorSim: number; centerColorSim: number } {
  const candidates: Array<[number, number]> = [[0, 0]];
  const dx8 = Math.round(bestDx16 / 2);
  const dy8 = Math.round(bestDy16 / 2);
  if (dx8 !== 0 || dy8 !== 0) {
    candidates.push([dx8, dy8]);
  }
  if (bestDx16 !== 0 || bestDy16 !== 0) {
    const signX = Math.sign(bestDx16);
    const signY = Math.sign(bestDy16);
    if (signX !== dx8 || signY !== dy8) {
      candidates.push([signX, signY]);
    }
  }

  let bestSpatial = 0;
  let bestCenter = 0;

  for (const [dx, dy] of candidates) {
    const yStart = Math.max(0, -dy);
    const yEnd = Math.min(8, 8 - dy);
    const xStart = Math.max(0, -dx);
    const xEnd = Math.min(8, 8 - dx);

    let count = 0;
    let lumaDiffSum = 0;
    let chromaDiffSum = 0;

    let centerCount = 0;
    let centerLumaSum = 0;
    let centerChromaSum = 0;
    const centerDiffs: number[] = [];

    for (let y = yStart; y < yEnd; y++) {
      for (let x = xStart; x < xEnd; x++) {
        const idxA = (y * 8 + x) * 3;
        const idxB = ((y + dy) * 8 + (x + dx)) * 3;

        const dL = Math.abs(a[idxA] - b[idxB]);
        const dC =
          (Math.abs(a[idxA + 1] - b[idxB + 1]) +
            Math.abs(a[idxA + 2] - b[idxB + 2])) *
          0.5;

        lumaDiffSum += dL;
        chromaDiffSum += dC;
        count++;

        if (x >= 2 && x <= 5 && y >= 2 && y <= 5) {
          centerLumaSum += dL;
          centerChromaSum += dC;
          centerDiffs.push(0.35 * (dL / 0.24) + 0.65 * (dC / 0.14));
          centerCount++;
        }
      }
    }

    if (count === 0) continue;
    const meanLumaDiff = lumaDiffSum / count;
    const meanChromaDiff = chromaDiffSum / count;

    const lumaSim = clamp01(1 - meanLumaDiff / 0.24);
    const chromaSim = clamp01(1 - meanChromaDiff / 0.14);
    const combined = 0.35 * lumaSim + 0.65 * chromaSim;
    if (combined > bestSpatial) {
      bestSpatial = combined;
    }

    if (centerCount > 0) {
      const cLumaSim = clamp01(1 - centerLumaSum / centerCount / 0.24);
      const cChromaSim = clamp01(1 - centerChromaSum / centerCount / 0.14);
      const cMeanSim = 0.35 * cLumaSim + 0.65 * cChromaSim;

      // Top-quartile discrepancy inside subject core catches localized subject swaps
      centerDiffs.sort((u, v) => v - u);
      const topK = Math.max(1, Math.floor(centerDiffs.length / 4));
      let topSum = 0;
      for (let k = 0; k < topK; k++) topSum += centerDiffs[k];
      const topSim = clamp01(1 - topSum / topK / 1.35);

      const centerCombined = 0.65 * cMeanSim + 0.35 * topSim;
      if (centerCombined > bestCenter) {
        bestCenter = centerCombined;
      }
    }
  }

  return { spatialColorSim: bestSpatial, centerColorSim: bestCenter };
}

export function computeVisualSimilarity(
  a: VisualFingerprint,
  b: VisualFingerprint
): VisualSimilarityMetrics {
  const maxAr = Math.max(a.aspectRatio, b.aspectRatio);
  const arDiff =
    maxAr > 0 ? Math.abs(a.aspectRatio - b.aspectRatio) / maxAr : 0;
  if (arDiff > 0.20) {
    return {
      score: 0,
      structSim: 0,
      centerSim: 0,
      edgeSim: 0,
      spatialColorSim: 0,
      centerColorSim: 0,
      histSim: 0,
      meanLumaDiff: 1,
      incompatible: true,
    };
  }

  const { structSim, centerSim, edgeSim, bestDx, bestDy } =
    alignedStructuralMetrics(a, b);

  const { spatialColorSim, centerColorSim } = computeSpatialColorSimilarity(
    a.spatialColor,
    b.spatialColor,
    bestDx,
    bestDy
  );

  let histSim = 0;
  const histLen = Math.min(a.colorHist.length, b.colorHist.length);
  for (let i = 0; i < histLen; i++) {
    histSim += Math.min(a.colorHist[i], b.colorHist[i]);
  }
  histSim = clamp01(histSim);

  const meanLumaDiff = Math.abs(a.meanLuma - b.meanLuma);

  const score =
    0.30 * structSim +
    0.22 * centerSim +
    0.16 * edgeSim +
    0.14 * spatialColorSim +
    0.12 * centerColorSim +
    0.06 * histSim;

  return {
    score,
    structSim,
    centerSim,
    edgeSim,
    spatialColorSim,
    centerColorSim,
    histSim,
    meanLumaDiff,
    incompatible: false,
  };
}

export function evaluateSimilarityMetrics(
  sim: VisualSimilarityMetrics,
  sensitivity: SimilaritySensitivity,
  options: {
    isImmediateNeighbor?: boolean;
    extraSlack?: number;
    requireHighMatch?: boolean;
    calibration?: CustomVisualCalibration | null;
  } = {}
): boolean {
  if (sim.incompatible) return false;

  const cal = options.calibration;
  const profile: SensitivityProfile = cal
    ? {
        minScore: cal.minScore,
        minStruct: cal.minStruct,
        minCenter: cal.minCenter,
        minEdge: cal.minEdge,
        minSpatialColor: cal.minSpatialColor,
        minCenterColor: cal.minCenterColor,
        maxMeanLumaDiff: cal.maxMeanLumaDiff,
      }
    : SENSITIVITY_PROFILES[sensitivity];

  const highBoost = options.requireHighMatch ? 0.06 : 0;
  const neighborBonus =
    options.isImmediateNeighbor && !options.requireHighMatch && !cal
      ? NEIGHBOR_THRESHOLD_BONUS
      : 0;
  const extraSlack = options.requireHighMatch ? 0 : (options.extraSlack ?? 0);
  const totalSlack = neighborBonus + extraSlack;

  // Hard multi-feature veto gates prevent false merges even if global score is near threshold
  const maxLumaDiff = options.requireHighMatch
    ? profile.maxMeanLumaDiff * 0.85
    : profile.maxMeanLumaDiff + totalSlack * 0.5;
  if (sim.meanLumaDiff > maxLumaDiff) {
    return false;
  }
  if (
    sim.structSim <
    Math.min(0.97, Math.max(0.40, profile.minStruct + highBoost - totalSlack))
  ) {
    return false;
  }
  if (
    sim.centerSim <
    Math.min(0.97, Math.max(0.35, profile.minCenter + highBoost - totalSlack))
  ) {
    return false;
  }
  if (
    sim.edgeSim <
    Math.min(0.95, Math.max(0.25, profile.minEdge + highBoost - totalSlack))
  ) {
    return false;
  }
  if (
    sim.spatialColorSim <
    Math.min(
      0.96,
      Math.max(0.35, profile.minSpatialColor + highBoost - totalSlack)
    )
  ) {
    return false;
  }
  if (
    sim.centerColorSim <
    Math.min(
      0.96,
      Math.max(0.30, profile.minCenterColor + highBoost - totalSlack)
    )
  ) {
    return false;
  }

  const effectiveThreshold = Math.min(
    0.97,
    Math.max(0.50, profile.minScore + highBoost - totalSlack)
  );
  return sim.score >= effectiveThreshold;
}

export function areVisuallySimilar(
  a: VisualFingerprint,
  b: VisualFingerprint,
  sensitivity: SimilaritySensitivity,
  options: {
    isImmediateNeighbor?: boolean;
    extraSlack?: number;
    requireHighMatch?: boolean;
    calibration?: CustomVisualCalibration | null;
  } = {}
): boolean {
  const sim = computeVisualSimilarity(a, b);
  return evaluateSimilarityMetrics(sim, sensitivity, options);
}

/**
 * Fits a custom multi-gate visual similarity calibration profile from user-labeled
 * photo pairs ('same' = should belong to one series, 'different' = should separate).
 */
export function fitVisualCalibration(
  examples: VisualCalibrationExample[],
  baseSensitivity: SimilaritySensitivity
): CustomVisualCalibration | null {
  const compatible = examples.filter((e) => !e.metrics.incompatible);
  if (compatible.length === 0) return null;

  const sames = compatible.filter((e) => e.label === 'same');
  const diffs = compatible.filter((e) => e.label === 'different');
  const base = SENSITIVITY_PROFILES[baseSensitivity];

  const profile: SensitivityProfile = { ...base };

  // 1. If positive ('same') examples exist, adapt sub-gates so valid same-series variations aren't vetoed
  if (sames.length > 0) {
    profile.minScore = Math.min(
      base.minScore,
      Math.max(0.55, Math.min(...sames.map((e) => e.metrics.score)) - 0.012)
    );
    profile.minStruct = Math.min(
      base.minStruct,
      Math.max(0.45, Math.min(...sames.map((e) => e.metrics.structSim)) - 0.015)
    );
    profile.minCenter = Math.min(
      base.minCenter,
      Math.max(0.40, Math.min(...sames.map((e) => e.metrics.centerSim)) - 0.015)
    );
    profile.minEdge = Math.min(
      base.minEdge,
      Math.max(0.28, Math.min(...sames.map((e) => e.metrics.edgeSim)) - 0.015)
    );
    profile.minSpatialColor = Math.min(
      base.minSpatialColor,
      Math.max(
        0.40,
        Math.min(...sames.map((e) => e.metrics.spatialColorSim)) - 0.015
      )
    );
    profile.minCenterColor = Math.min(
      base.minCenterColor,
      Math.max(
        0.35,
        Math.min(...sames.map((e) => e.metrics.centerColorSim)) - 0.015
      )
    );
    profile.maxMeanLumaDiff = Math.max(
      base.maxMeanLumaDiff,
      Math.min(0.45, Math.max(...sames.map((e) => e.metrics.meanLumaDiff)) + 0.015)
    );
  }

  // 2. If negative ('different') examples exist, find the best separating thresholds across metrics
  if (diffs.length > 0) {
    type MetricKey = keyof Omit<SensitivityProfile, 'maxMeanLumaDiff'>;
    const metricExtractors: Array<{
      key: MetricKey;
      get: (m: VisualSimilarityMetrics) => number;
      priority: number;
    }> = [
      { key: 'minScore', get: (m) => m.score, priority: 0 },
      { key: 'minCenterColor', get: (m) => m.centerColorSim, priority: 1 },
      { key: 'minCenter', get: (m) => m.centerSim, priority: 2 },
      { key: 'minStruct', get: (m) => m.structSim, priority: 3 },
      { key: 'minSpatialColor', get: (m) => m.spatialColorSim, priority: 4 },
      { key: 'minEdge', get: (m) => m.edgeSim, priority: 5 },
    ];

    const evalAccuracy = (cand: SensitivityProfile) => {
      let sameOk = 0;
      let diffOk = 0;
      for (const ex of compatible) {
        const pred = evaluateSimilarityMetrics(ex.metrics, baseSensitivity, {
          calibration: {
            ...cand,
            sameCount: sames.length,
            differentCount: diffs.length,
            accuracyPct: 0,
            updatedAt: 0,
          },
        });
        if (ex.label === 'same' && pred) sameOk++;
        if (ex.label === 'different' && !pred) diffOk++;
      }
      return {
        correct: sameOk + diffOk,
        sameOk,
        diffOk,
      };
    };

    // Coordinate tightening passes: pick single best threshold updates that improve separation
    for (let pass = 0; pass < 3; pass++) {
      let bestCand: SensitivityProfile | null = null;
      let bestScoreTuple = [
        evalAccuracy(profile).correct,
        evalAccuracy(profile).diffOk,
        -99,
      ];

      for (const m of metricExtractors) {
        const diffVals = diffs.map((e) => m.get(e.metrics));
        const sameVals = sames.map((e) => m.get(e.metrics));
        const rawThresholds = new Set<number>();

        for (const dv of diffVals) {
          rawThresholds.add(Math.min(0.96, dv + 0.015));
          for (const sv of sameVals) {
            if (sv > dv) {
              rawThresholds.add((sv + dv) * 0.5);
            }
          }
        }

        for (const t of rawThresholds) {
          const cand = { ...profile, [m.key]: t };
          const stats = evalAccuracy(cand);
          // Compute minimum safety margin to tagged examples
          let margin = 0;
          if (sameVals.length > 0 && diffVals.length > 0) {
            const minSameAbove = Math.min(...sameVals) - t;
            const maxDiffBelow = t - Math.max(...diffVals);
            margin = Math.min(minSameAbove, maxDiffBelow);
          } else if (diffVals.length > 0) {
            margin = t - Math.max(...diffVals);
          }

          const better =
            stats.correct > bestScoreTuple[0] ||
            (stats.correct === bestScoreTuple[0] &&
              stats.diffOk > bestScoreTuple[1]) ||
            (stats.correct === bestScoreTuple[0] &&
              stats.diffOk === bestScoreTuple[1] &&
              margin > bestScoreTuple[2] + 1e-4);

          if (better) {
            bestCand = cand;
            bestScoreTuple = [stats.correct, stats.diffOk, margin];
          }
        }
      }

      if (!bestCand) break;
      Object.assign(profile, bestCand);
    }
  }

  const finalCal: CustomVisualCalibration = {
    minScore: Number(profile.minScore.toFixed(4)),
    minStruct: Number(profile.minStruct.toFixed(4)),
    minCenter: Number(profile.minCenter.toFixed(4)),
    minEdge: Number(profile.minEdge.toFixed(4)),
    minSpatialColor: Number(profile.minSpatialColor.toFixed(4)),
    minCenterColor: Number(profile.minCenterColor.toFixed(4)),
    maxMeanLumaDiff: Number(profile.maxMeanLumaDiff.toFixed(4)),
    sameCount: sames.length,
    differentCount: diffs.length,
    accuracyPct: 100,
    updatedAt: Date.now(),
  };

  let correct = 0;
  for (const ex of compatible) {
    const pred = evaluateSimilarityMetrics(ex.metrics, baseSensitivity, {
      calibration: finalCal,
    });
    if ((ex.label === 'same' && pred) || (ex.label === 'different' && !pred)) {
      correct++;
    }
  }
  finalCal.accuracyPct = Math.round((correct / compatible.length) * 100);
  return finalCal;
}

let sharedWorkCanvas: HTMLCanvasElement | null = null;

function fingerprintFromDrawable(
  source: CanvasImageSource,
  width: number,
  height: number
): VisualFingerprint | null {
  if (width <= 0 || height <= 0) return null;

  if (!sharedWorkCanvas) {
    sharedWorkCanvas = document.createElement('canvas');
    sharedWorkCanvas.width = 32;
    sharedWorkCanvas.height = 32;
  }

  const ctx = sharedWorkCanvas.getContext('2d', {
    willReadFrequently: true,
  });
  if (!ctx) return null;

  ctx.clearRect(0, 0, 32, 32);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(source, 0, 0, 32, 32);

  const pixels = ctx.getImageData(0, 0, 32, 32).data;
  return computeFingerprintFromRgba32x32(pixels, width, height);
}

function getCorsThumbnailUrl(thumbnailLink?: string): string | null {
  const base = getFastPreviewThumbnailUrl(thumbnailLink);
  if (!base) return null;
  if (/=s\d+$/.test(base)) {
    return base.replace(/=s\d+$/, '=s220');
  }
  return base;
}

function loadCorsImage(
  url: string,
  signal?: AbortSignal
): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';

    let settled = false;
    const finish = (result: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const onAbort = () => {
      img.src = '';
      finish(null);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    img.onload = () => finish(img);
    img.onerror = () => finish(null);
    img.src = url;
  });
}

async function fingerprintFromUrl(
  url: string,
  signal?: AbortSignal
): Promise<VisualFingerprint | null> {
  const img = await loadCorsImage(url, signal);
  if (!img) return null;
  try {
    return fingerprintFromDrawable(img, img.naturalWidth, img.naturalHeight);
  } catch {
    // Tainted canvas if CDN blocked anonymous CORS
    return null;
  }
}

async function fingerprintFromBlob(
  blob: Blob
): Promise<VisualFingerprint | null> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    try {
      return fingerprintFromDrawable(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }
  const objUrl = URL.createObjectURL(blob);
  try {
    return await fingerprintFromUrl(objUrl);
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

// Circuit breaker: if Drive CDN refuses anonymous CORS pixel reads twice in a row,
// bypass futile CDN CORS attempts for the rest of the session and jump straight
// to fast authenticated Range-header thumbnail extraction.
let consecutiveCdnCorsFailures = 0;

/**
 * Computes a shift- and exposure-tolerant perceptual fingerprint locally in the browser:
 * 1) Reuses an already-loaded local blob URL if available (0 network cost),
 * 2) Tries Drive thumbnail CDN with anonymous CORS (with automatic circuit breaker),
 * 3) Extracts embedded EXIF/RAW thumbnail via tiny authenticated Drive Range request (128 KB JPG / 512 KB RAW),
 * 4) Falls back to full Drive media only if a standard image lacks an embedded EXIF thumbnail.
 */
export async function computePhotoFingerprint(
  accessToken: string | null | undefined,
  file: DrivePhotoFile,
  options: { existingLocalUrl?: string; signal?: AbortSignal } = {}
): Promise<VisualFingerprint | null> {
  if (options.signal?.aborted) return null;

  const isLocalCachedUrl = (url?: string | null) =>
    Boolean(
      url &&
        (url.startsWith('blob:') ||
          url.includes('/_capacitor_file_/') ||
          url.startsWith('capacitor://'))
    );

  // 1. Zero-network reuse when a local blob, filmstrip cache, or Capacitor cached file URL is already available
  const reusableLocalUrl = isLocalCachedUrl(options.existingLocalUrl)
    ? options.existingLocalUrl
    : getCachedFilmstripThumbnailUrl(file.id);
  if (isLocalCachedUrl(reusableLocalUrl) && reusableLocalUrl) {
    const localFp = await fingerprintFromUrl(
      reusableLocalUrl,
      options.signal
    );
    if (localFp) return localFp;
  }

  // 1a. Fast IndexedDB micro-thumbnail reuse (zero disk/Drive header read!)
  try {
    const idbMicro = await getCachedMicroThumbBlob(file.id);
    if (options.signal?.aborted) return null;
    if (idbMicro && idbMicro.size > 0) {
      const microFp = await fingerprintFromBlob(idbMicro);
      if (microFp) return microFp;
    }
  } catch {
    // Fall through to header extraction
  }

  const isLocal = Boolean(file.sourceKind && file.sourceKind !== 'drive');

  // 1b. Native Android RAW mini-thumbnailer reuse (fast disk-cached upright JPEG, zero Base64 slices)
  if (
    file.isRaw &&
    file.sourceKind === 'android-saf' &&
    file.nativeUri &&
    window.FrameCullNative?.extractRawThumbnailUrl
  ) {
    try {
      const nativeThumb = await window.FrameCullNative.extractRawThumbnailUrl(
        file.nativeUri
      );
      if (options.signal?.aborted) return null;
      if (nativeThumb?.url) {
        const nativeFp = await fingerprintFromUrl(
          nativeThumb.url,
          options.signal
        );
        if (nativeFp) return nativeFp;
      }
    } catch {
      // Fall through to JS header extraction
    }
  }

  // 2. Fast tiny Drive thumbnail with anonymous CORS (skipped for local files or once CDN CORS is confirmed blocked)
  const thumbUrl = !isLocal ? getCorsThumbnailUrl(file.thumbnailLink) : null;
  if (thumbUrl && consecutiveCdnCorsFailures < 2) {
    const thumbFp = await fingerprintFromUrl(thumbUrl, options.signal);
    if (options.signal?.aborted) return null;
    if (thumbFp) {
      consecutiveCdnCorsFailures = 0;
      return thumbFp;
    }
    consecutiveCdnCorsFailures += 1;
  }

  if (options.signal?.aborted) return null;

  // 3. Fast CORS-safe Range/Slice embedded thumbnail (128 KB JPG EXIF / 512 KB–1.5 MB RAW THMB/PRVW)
  const headerThumbBlob = await extractFastHeaderThumbnailBlob(
    accessToken,
    file,
    options.signal
  );
  if (options.signal?.aborted) return null;

  if (headerThumbBlob) {
    try {
      const headerFp = await fingerprintFromBlob(headerThumbBlob);
      if (headerFp) return headerFp;
    } catch {
      // Corrupt or unreadable embedded stub -> fall through to full standard image fetch
    }
  }

  if (options.signal?.aborted) return null;

  // 4. Final fallback for standard images without an embedded EXIF thumbnail (<= 25 MB)
  if (!file.isRaw && file.sizeBytes <= 25 * 1024 * 1024) {
    try {
      if (file.localFile) {
        return await fingerprintFromBlob(file.localFile);
      }
      const buffer = await fetchPhotoBytes(
        accessToken,
        file,
        undefined,
        options.signal
      );
      const blob = new Blob([buffer], { type: file.mimeType || 'image/jpeg' });
      return await fingerprintFromBlob(blob);
    } catch {
      return null;
    }
  }

  return null;
}

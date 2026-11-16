import {
  CustomVisualCalibration,
  SimilaritySensitivity,
  VisualCalibrationExample,
  VisualSimilarityMetrics,
  fitVisualCalibration,
} from './visualSimilarity';

const FILMSTRIP_SERIES_ENABLED_KEY = 'selectra_filmstrip_series_enabled_v1';
const GLOBAL_CALIBRATION_STATE_KEY = 'selectra_global_series_calibration_v1';
const LEGACY_CUSTOM_CALIBRATION_KEY = 'selectra_custom_visual_calibration_v1';

const MAX_TOTAL_EXAMPLES = 60;
const MAX_SAME_EXAMPLES = 35;
const MAX_DIFF_EXAMPLES = 25;

export interface GlobalCalibrationState {
  baseSensitivity: SimilaritySensitivity;
  calibration: CustomVisualCalibration | null;
  examples: VisualCalibrationExample[];
  updatedAtMs: number;
}

export function readFilmstripSeriesEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(FILMSTRIP_SERIES_ENABLED_KEY);
    if (raw === '1' || raw === 'true') return true;
    return false;
  } catch {
    return false;
  }
}

export function writeFilmstripSeriesEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(
      FILMSTRIP_SERIES_ENABLED_KEY,
      enabled ? '1' : '0'
    );
  } catch {
    // Ignore storage quota errors
  }
}

function sanitizeMetrics(raw: unknown): VisualSimilarityMetrics | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<VisualSimilarityMetrics>;
  if (
    typeof r.score !== 'number' ||
    typeof r.structSim !== 'number' ||
    typeof r.centerSim !== 'number' ||
    typeof r.edgeSim !== 'number' ||
    typeof r.spatialColorSim !== 'number' ||
    typeof r.centerColorSim !== 'number' ||
    typeof r.meanLumaDiff !== 'number'
  ) {
    return null;
  }
  return {
    score: r.score,
    structSim: r.structSim,
    centerSim: r.centerSim,
    edgeSim: r.edgeSim,
    spatialColorSim: r.spatialColorSim,
    centerColorSim: r.centerColorSim,
    histSim: typeof r.histSim === 'number' ? r.histSim : 0,
    meanLumaDiff: r.meanLumaDiff,
    incompatible: Boolean(r.incompatible),
  };
}

export function sanitizeCalibrationExamples(
  raw: unknown
): VisualCalibrationExample[] {
  if (!Array.isArray(raw)) return [];
  const deduped = new Map<string, VisualCalibrationExample>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const ex = item as Partial<VisualCalibrationExample>;
    if (
      typeof ex.pairKey !== 'string' ||
      !ex.pairKey ||
      typeof ex.idA !== 'string' ||
      typeof ex.idB !== 'string' ||
      (ex.label !== 'same' && ex.label !== 'different')
    ) {
      continue;
    }
    const metrics = sanitizeMetrics(ex.metrics);
    if (!metrics || metrics.incompatible) continue;
    deduped.delete(ex.pairKey);
    deduped.set(ex.pairKey, {
      pairKey: ex.pairKey.slice(0, 256),
      idA: ex.idA.slice(0, 200),
      idB: ex.idB.slice(0, 200),
      label: ex.label,
      metrics,
    });
  }
  return capBalancedExamples(Array.from(deduped.values()));
}

function capBalancedExamples(
  list: VisualCalibrationExample[]
): VisualCalibrationExample[] {
  const sames = list.filter((e) => e.label === 'same').slice(-MAX_SAME_EXAMPLES);
  const diffs = list
    .filter((e) => e.label === 'different')
    .slice(-MAX_DIFF_EXAMPLES);
  const merged = [...sames, ...diffs];
  return merged.slice(-MAX_TOTAL_EXAMPLES);
}

export function sanitizeCustomCalibration(
  raw: unknown
): CustomVisualCalibration | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<CustomVisualCalibration>;
  if (
    typeof c.minScore !== 'number' ||
    typeof c.minStruct !== 'number' ||
    typeof c.minCenter !== 'number' ||
    typeof c.minEdge !== 'number' ||
    typeof c.minSpatialColor !== 'number' ||
    typeof c.minCenterColor !== 'number' ||
    typeof c.maxMeanLumaDiff !== 'number'
  ) {
    return null;
  }
  return {
    minScore: c.minScore,
    minStruct: c.minStruct,
    minCenter: c.minCenter,
    minEdge: c.minEdge,
    minSpatialColor: c.minSpatialColor,
    minCenterColor: c.minCenterColor,
    maxMeanLumaDiff: c.maxMeanLumaDiff,
    sameCount: Math.max(0, Math.round(Number(c.sameCount) || 0)),
    differentCount: Math.max(0, Math.round(Number(c.differentCount) || 0)),
    accuracyPct: Math.max(0, Math.min(100, Math.round(Number(c.accuracyPct) || 0))),
    updatedAt: Number(c.updatedAt) || Date.now(),
  };
}

export function normalizeBaseSensitivity(
  raw: unknown
): SimilaritySensitivity {
  if (raw === 'strict' || raw === 'balanced' || raw === 'loose') return raw;
  return 'balanced';
}

export function readGlobalCalibrationState(): GlobalCalibrationState {
  try {
    const raw = window.localStorage.getItem(GLOBAL_CALIBRATION_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GlobalCalibrationState>;
      const baseSensitivity = normalizeBaseSensitivity(parsed.baseSensitivity);
      const examples = sanitizeCalibrationExamples(parsed.examples);
      const calibration = sanitizeCustomCalibration(parsed.calibration);
      return {
        baseSensitivity,
        calibration,
        examples,
        updatedAtMs: Number(parsed.updatedAtMs) || 0,
      };
    }

    // One-time migration from legacy v1 custom calibration storage key
    const legacyRaw = window.localStorage.getItem(LEGACY_CUSTOM_CALIBRATION_KEY);
    if (legacyRaw) {
      const legacyCal = sanitizeCustomCalibration(JSON.parse(legacyRaw));
      if (legacyCal) {
        const migrated: GlobalCalibrationState = {
          baseSensitivity: 'balanced',
          calibration: legacyCal,
          examples: [],
          updatedAtMs: legacyCal.updatedAt || Date.now(),
        };
        writeGlobalCalibrationState(migrated);
        return migrated;
      }
    }
  } catch {
    // Ignore storage errors
  }
  return {
    baseSensitivity: 'balanced',
    calibration: null,
    examples: [],
    updatedAtMs: 0,
  };
}

export function writeGlobalCalibrationState(state: GlobalCalibrationState): void {
  try {
    const clean: GlobalCalibrationState = {
      baseSensitivity: normalizeBaseSensitivity(state.baseSensitivity),
      calibration: sanitizeCustomCalibration(state.calibration),
      examples: sanitizeCalibrationExamples(state.examples),
      updatedAtMs: Number(state.updatedAtMs) || Date.now(),
    };
    window.localStorage.setItem(
      GLOBAL_CALIBRATION_STATE_KEY,
      JSON.stringify(clean)
    );
    if (clean.calibration) {
      window.localStorage.setItem(
        LEGACY_CUSTOM_CALIBRATION_KEY,
        JSON.stringify(clean.calibration)
      );
    } else {
      window.localStorage.removeItem(LEGACY_CUSTOM_CALIBRATION_KEY);
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function appendContinuousCalibrationFeedback(params: {
  currentState: GlobalCalibrationState;
  newExamples: VisualCalibrationExample[];
  baseSensitivityOverride?: SimilaritySensitivity;
}): GlobalCalibrationState {
  const { currentState, newExamples, baseSensitivityOverride } = params;
  const baseSensitivity = normalizeBaseSensitivity(
    baseSensitivityOverride ?? currentState.baseSensitivity
  );
  const combined = new Map<string, VisualCalibrationExample>();
  for (const ex of currentState.examples) {
    combined.set(ex.pairKey, ex);
  }
  for (const ex of newExamples) {
    if (ex.metrics.incompatible) continue;
    combined.delete(ex.pairKey);
    combined.set(ex.pairKey, ex);
  }
  const mergedExamples = capBalancedExamples(Array.from(combined.values()));
  const fitted =
    mergedExamples.length > 0
      ? fitVisualCalibration(mergedExamples, baseSensitivity)
      : currentState.calibration;

  const nextState: GlobalCalibrationState = {
    baseSensitivity,
    calibration: fitted || currentState.calibration,
    examples: mergedExamples,
    updatedAtMs: Date.now(),
  };
  writeGlobalCalibrationState(nextState);
  return nextState;
}

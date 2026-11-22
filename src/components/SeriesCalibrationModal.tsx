import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  HIGH_MATCH_VISUAL_MAX_GAP_MS,
  PhotoShotItem,
  STANDARD_VISUAL_MAX_GAP_MS,
  groupShotsIntoSeries,
} from '../lib/burstGrouping';
import {
  CustomVisualCalibration,
  SimilaritySensitivity,
  VisualCalibrationExample,
  VisualFingerprint,
  VisualSimilarityMetrics,
  computePhotoFingerprint,
  computeVisualSimilarity,
  evaluateSimilarityMetrics,
  fitVisualCalibration,
} from '../lib/visualSimilarity';
import {
  ResolvedPhotoMedia,
  getCachedFilmstripThumbnailUrl,
  getFastPreviewThumbnailUrl,
  getFilmstripThumbnailUrl,
  resolveFilmstripThumbnailUrl,
} from '../lib/rawParser';
import { useI18n } from '../lib/i18n';

interface SeriesCalibrationModalProps {
  isOpen: boolean;
  shots: PhotoShotItem[];
  activeShotId: string | null;
  accessToken?: string | null;
  fingerprintsMap: Record<string, VisualFingerprint>;
  onAddFingerprints: (updates: Record<string, VisualFingerprint>) => void;
  sharpMediaMap: Record<string, ResolvedPhotoMedia>;
  tempPreviewMap: Record<string, string>;
  baseSensitivity: SimilaritySensitivity;
  currentCalibration: CustomVisualCalibration | null;
  savedExamples: VisualCalibrationExample[];
  onApplyCalibration: (
    calibration: CustomVisualCalibration,
    examples: VisualCalibrationExample[]
  ) => void;
  onResetCalibration: () => void;
  onClose: () => void;
}

interface CandidatePair {
  pairKey: string;
  shotA: PhotoShotItem;
  shotB: PhotoShotItem;
  timeDiffMs: number | null;
}

function makePairKey(idA: string, idB: string): string {
  return `${idA}__${idB}`;
}

function formatTimeGap(ms: number | null, noTimeLabel: string): string {
  if (ms === null || Number.isNaN(ms)) return noTimeLabel;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `+${sec} s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `+${min} min ${rem} s` : `+${min} min`;
}

export const SeriesCalibrationModal: React.FC<SeriesCalibrationModalProps> = ({
  isOpen,
  shots,
  activeShotId,
  accessToken,
  fingerprintsMap,
  onAddFingerprints,
  sharpMediaMap,
  tempPreviewMap,
  baseSensitivity,
  currentCalibration,
  savedExamples,
  onApplyCalibration,
  onResetCalibration,
  onClose,
}) => {
  const { t, formatNumber } = useI18n();
  const [pairIdx, setPairIdx] = useState(0);
  const [labelsByKey, setLabelsByKey] = useState<
    Record<string, 'same' | 'different'>
  >({});
  const [pairThumbs, setPairThumbs] = useState<Record<string, string>>({});
  const [localFps, setLocalFps] = useState<Record<string, VisualFingerprint>>(
    {}
  );
  const [isComputingFp, setIsComputingFp] = useState(false);

  const mergedFps = useMemo(
    () => ({ ...fingerprintsMap, ...localFps }),
    [fingerprintsMap, localFps]
  );
  const mergedFpsRef = useRef(mergedFps);
  mergedFpsRef.current = mergedFps;

  // Build candidate pairs starting immediately around activeShotId, plus representative nearby pairs
  const candidatePairs: CandidatePair[] = useMemo(() => {
    if (shots.length < 2) return [];
    const activeIdx = activeShotId
      ? Math.max(
          0,
          shots.findIndex((s) => s.id === activeShotId)
        )
      : 0;

    const pairs: CandidatePair[] = [];
    const seenKeys = new Set<string>();

    const addPair = (iA: number, iB: number) => {
      if (iA < 0 || iB < 0 || iA >= shots.length || iB >= shots.length || iA === iB) {
        return;
      }
      const shotA = shots[iA];
      const shotB = shots[iB];
      const timeDiffMs =
        shotA.takenAtMs !== null && shotB.takenAtMs !== null
          ? Math.abs(shotB.takenAtMs - shotA.takenAtMs)
          : null;
      if (timeDiffMs !== null && timeDiffMs > HIGH_MATCH_VISUAL_MAX_GAP_MS) {
        return;
      }
      const key = makePairKey(shotA.primary.id, shotB.primary.id);
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      pairs.push({ pairKey: key, shotA, shotB, timeDiffMs });
    };

    // 1. Consecutive pairs right around the active photo (e.g. shots 1-2, 2-3, 3-4, 4-5, 5-6)
    const startLocal = Math.max(0, activeIdx - 3);
    const endLocal = Math.min(shots.length - 2, activeIdx + 8);
    for (let i = startLocal; i <= endLocal; i++) {
      addPair(i, i + 1);
    }

    // 2. Also add a few nearby non-adjacent pairs around active photo (skip-1) within time cap
    for (let i = Math.max(0, activeIdx - 2); i <= Math.min(shots.length - 3, activeIdx + 4); i++) {
      addPair(i, i + 2);
    }

    // 3. Add sample pairs distributed across the folder so calibration generalizes well
    const step = Math.max(1, Math.floor((shots.length - 1) / 14));
    for (let i = 0; i < shots.length - 1 && pairs.length < 26; i += step) {
      addPair(i, i + 1);
    }

    // Fallback if all consecutive shots had > 3m gaps
    if (pairs.length === 0) {
      for (let i = 0; i < Math.min(shots.length - 1, 12); i++) {
        const shotA = shots[i];
        const shotB = shots[i + 1];
        const key = makePairKey(shotA.primary.id, shotB.primary.id);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          pairs.push({
            pairKey: key,
            shotA,
            shotB,
            timeDiffMs:
              shotA.takenAtMs !== null && shotB.takenAtMs !== null
                ? Math.abs(shotB.takenAtMs - shotA.takenAtMs)
                : null,
          });
        }
      }
    }

    return pairs;
  }, [shots, activeShotId]);

  // Reset modal session state when opened
  useEffect(() => {
    if (!isOpen) return;
    setPairIdx(0);
    const initial: Record<string, 'same' | 'different'> = {};
    for (const ex of savedExamples) {
      initial[ex.pairKey] = ex.label;
    }
    setLabelsByKey(initial);
  }, [isOpen, savedExamples]);

  const currentPair = candidatePairs[pairIdx] || null;

  // Ensure fingerprints & crisp preview thumbnails exist for current pair and next 2 pairs
  useEffect(() => {
    if (!isOpen || candidatePairs.length === 0) return;

    const controller = new AbortController();
    const targets = candidatePairs.slice(
      Math.max(0, pairIdx),
      Math.min(candidatePairs.length, pairIdx + 3)
    );

    const filesToLoad = new Map<string, PhotoShotItem>();
    for (const p of targets) {
      filesToLoad.set(p.shotA.primary.id, p.shotA);
      filesToLoad.set(p.shotB.primary.id, p.shotB);
    }

    const resolveAll = async () => {
      const missingFps: PhotoShotItem[] = [];
      const thumbUpdates: Record<string, string> = {};

      for (const [id, shot] of filesToLoad.entries()) {
        if (!mergedFpsRef.current[id]) {
          missingFps.push(shot);
        }
        const existingThumb =
          pairThumbs[id] ||
          sharpMediaMap[id]?.url ||
          tempPreviewMap[id] ||
          getCachedFilmstripThumbnailUrl(id) ||
          getFilmstripThumbnailUrl(shot.primary.thumbnailLink) ||
          getFastPreviewThumbnailUrl(shot.primary.thumbnailLink);
        if (existingThumb) {
          thumbUpdates[id] = existingThumb;
        } else {
          const resolved = await resolveFilmstripThumbnailUrl(
            accessToken,
            shot.primary,
            controller.signal
          );
          if (resolved && !controller.signal.aborted) {
            thumbUpdates[id] = resolved;
          }
        }
      }

      if (!controller.signal.aborted && Object.keys(thumbUpdates).length > 0) {
        setPairThumbs((prev) => ({ ...prev, ...thumbUpdates }));
      }

      if (missingFps.length > 0 && !controller.signal.aborted) {
        setIsComputingFp(true);
        const fpUpdates: Record<string, VisualFingerprint> = {};
        for (const shot of missingFps) {
          if (controller.signal.aborted) break;
          const id = shot.primary.id;
          const localUrl =
            sharpMediaMap[id]?.url || tempPreviewMap[id] || undefined;
          const fp = await computePhotoFingerprint(accessToken, shot.primary, {
            existingLocalUrl: localUrl,
            signal: controller.signal,
          });
          if (fp) {
            fpUpdates[id] = fp;
          }
        }
        if (!controller.signal.aborted && Object.keys(fpUpdates).length > 0) {
          setLocalFps((prev) => ({ ...prev, ...fpUpdates }));
          onAddFingerprints(fpUpdates);
        }
        if (!controller.signal.aborted) {
          setIsComputingFp(false);
        }
      }
    };

    void resolveAll();
    return () => controller.abort();
  }, [
    isOpen,
    pairIdx,
    candidatePairs,
    accessToken,
    sharpMediaMap,
    tempPreviewMap,
    onAddFingerprints,
  ]);

  // Assemble all tagged VisualCalibrationExamples from current pairs + saved examples
  const taggedExamples: VisualCalibrationExample[] = useMemo(() => {
    const map = new Map<string, VisualCalibrationExample>();

    for (const ex of savedExamples) {
      if (
        labelsByKey[ex.pairKey] &&
        typeof ex.metrics?.centerColorSim === 'number'
      ) {
        map.set(ex.pairKey, { ...ex, label: labelsByKey[ex.pairKey] });
      }
    }

    for (const p of candidatePairs) {
      const label = labelsByKey[p.pairKey];
      if (!label) continue;
      const fpA = mergedFps[p.shotA.primary.id];
      const fpB = mergedFps[p.shotB.primary.id];
      if (!fpA || !fpB) continue;
      const metrics = computeVisualSimilarity(fpA, fpB);
      map.set(p.pairKey, {
        pairKey: p.pairKey,
        idA: p.shotA.primary.id,
        idB: p.shotB.primary.id,
        label,
        metrics,
      });
    }

    return Array.from(map.values());
  }, [savedExamples, labelsByKey, candidatePairs, mergedFps]);

  const draftCalibration: CustomVisualCalibration | null = useMemo(() => {
    if (taggedExamples.length === 0) return currentCalibration;
    return fitVisualCalibration(taggedExamples, baseSensitivity);
  }, [taggedExamples, baseSensitivity, currentCalibration]);

  const activeCalibrationForPreview = draftCalibration;

  const previewSeriesCount = useMemo(() => {
    return groupShotsIntoSeries(shots, {
      maxGapMs: 3000,
      visualEnabled: true,
      fingerprints: mergedFps,
      sensitivity: baseSensitivity,
      calibration: activeCalibrationForPreview,
    }).length;
  }, [shots, mergedFps, baseSensitivity, activeCalibrationForPreview]);

  const currentPairMetrics: VisualSimilarityMetrics | null = useMemo(() => {
    if (!currentPair) return null;
    const fpA = mergedFps[currentPair.shotA.primary.id];
    const fpB = mergedFps[currentPair.shotB.primary.id];
    if (!fpA || !fpB) return null;
    return computeVisualSimilarity(fpA, fpB);
  }, [currentPair, mergedFps]);

  const currentPairPredictedSame = useMemo(() => {
    if (!currentPair || !currentPairMetrics) return null;
    const requireHighMatch =
      currentPair.timeDiffMs !== null &&
      currentPair.timeDiffMs > STANDARD_VISUAL_MAX_GAP_MS;
    return evaluateSimilarityMetrics(currentPairMetrics, baseSensitivity, {
      requireHighMatch,
      calibration: activeCalibrationForPreview,
    });
  }, [
    currentPair,
    currentPairMetrics,
    baseSensitivity,
    activeCalibrationForPreview,
  ]);

  const handleLabelCurrent = useCallback(
    (label: 'same' | 'different') => {
      if (!currentPair) return;
      setLabelsByKey((prev) => ({ ...prev, [currentPair.pairKey]: label }));
      if (pairIdx < candidatePairs.length - 1) {
        setPairIdx((i) => Math.min(candidatePairs.length - 1, i + 1));
      }
    },
    [currentPair, pairIdx, candidatePairs.length]
  );

  const handleClearCurrentLabel = useCallback(() => {
    if (!currentPair) return;
    setLabelsByKey((prev) => {
      const next = { ...prev };
      delete next[currentPair.pairKey];
      return next;
    });
  }, [currentPair]);

  if (!isOpen) return null;

  const sameCount = taggedExamples.filter((e) => e.label === 'same').length;
  const diffCount = taggedExamples.filter((e) => e.label === 'different').length;
  const currentLabel = currentPair ? labelsByKey[currentPair.pairKey] : undefined;

  const getThumbUrl = (shot: PhotoShotItem): string | null => {
    const id = shot.primary.id;
    return (
      sharpMediaMap[id]?.url ||
      tempPreviewMap[id] ||
      pairThumbs[id] ||
      getCachedFilmstripThumbnailUrl(id) ||
      getFilmstripThumbnailUrl(shot.primary.thumbnailLink) ||
      getFastPreviewThumbnailUrl(shot.primary.thumbnailLink) ||
      null
    );
  };

  const thumbA = currentPair ? getThumbUrl(currentPair.shotA) : null;
  const thumbB = currentPair ? getThumbUrl(currentPair.shotB) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-label={t(
        'Kalibrace podobnosti sérií',
        'Visual series calibration'
      )}
    >
      <div className="w-full max-w-4xl max-h-[94dvh] flex flex-col rounded-2xl border border-zinc-800 bg-[#111114] text-zinc-100 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-3.5 sm:px-5 py-2.5 sm:py-3.5 border-b border-zinc-800">
          <div className="min-w-0">
            <h2 className="font-display text-sm sm:text-lg font-semibold text-white truncate">
              {t('Kalibrace sérií podle vzhledu', 'Visual Series Calibration')}
            </h2>
            <p className="text-[11px] sm:text-xs text-zinc-400 truncate">
              {t(
                'Označte pár dvojic a aplikace nastaví přesný práh podobnosti',
                'Tag a few photo pairs so Selectra learns your exact series threshold'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('Zavřít kalibraci', 'Close calibration')}
            className="min-h-[38px] min-w-[38px] sm:min-h-[40px] sm:min-w-[40px] inline-flex items-center justify-center rounded-lg border border-zinc-800 bg-[#141417] text-zinc-400 hover:text-white cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-5 space-y-3 sm:space-y-4">
          {!currentPair ? (
            <div className="py-12 text-center text-sm text-zinc-400">
              {t(
                'Pro kalibraci jsou potřeba alespoň dvě fotografie v časovém okně do 3 minut.',
                'At least two photos taken within 3 minutes are needed for calibration.'
              )}
            </div>
          ) : (
            <>
              {/* Pair Navigation Strip */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400 tabular-nums">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPairIdx((i) => Math.max(0, i - 1))}
                    disabled={pairIdx === 0}
                    className="min-h-[38px] min-w-[38px] inline-flex items-center justify-center rounded-lg border border-zinc-800 bg-[#09090B] text-zinc-200 hover:border-zinc-600 disabled:opacity-35 cursor-pointer"
                    aria-label={t('Předchozí dvojice', 'Previous pair')}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="font-mono text-zinc-200">
                    {t('Dvojice', 'Pair')} {pairIdx + 1} / {candidatePairs.length}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setPairIdx((i) =>
                        Math.min(candidatePairs.length - 1, i + 1)
                      )
                    }
                    disabled={pairIdx >= candidatePairs.length - 1}
                    className="min-h-[38px] min-w-[38px] inline-flex items-center justify-center rounded-lg border border-zinc-800 bg-[#09090B] text-zinc-200 hover:border-zinc-600 disabled:opacity-35 cursor-pointer"
                    aria-label={t('Další dvojice', 'Next pair')}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <span>
                    {t('Rozestup', 'Gap')}:{' '}
                    {formatTimeGap(
                      currentPair.timeDiffMs,
                      t('Bez času', 'No time')
                    )}
                  </span>
                  <span aria-hidden="true">·</span>
                  {currentPairPredictedSame !== null ? (
                    <span
                      className={
                        currentPairPredictedSame
                          ? 'text-amber-300 font-medium'
                          : 'text-zinc-300 font-medium'
                      }
                    >
                      {currentPairPredictedSame
                        ? t(
                            'Aktuálně: Spojí se do série',
                            'Currently: Grouped in series'
                          )
                        : t('Aktuálně: Oddělené', 'Currently: Separate')}
                    </span>
                  ) : (
                    <span>
                      {isComputingFp
                        ? t('Analyzuji vzhled…', 'Analyzing visuals…')
                        : t('Čekám na náhled', 'Waiting for preview')}
                    </span>
                  )}
                </div>
              </div>

              {/* Quick Pair Dots */}
              <div className="flex items-center gap-1 overflow-x-auto pb-1">
                {candidatePairs.map((p, idx) => {
                  const lbl = labelsByKey[p.pairKey];
                  const isCurr = idx === pairIdx;
                  return (
                    <button
                      key={p.pairKey}
                      type="button"
                      onClick={() => setPairIdx(idx)}
                      title={`${t('Dvojice', 'Pair')} ${idx + 1}: ${p.shotA.primary.name} / ${p.shotB.primary.name}`}
                      className={`h-7 min-w-[28px] px-1.5 rounded text-[11px] font-mono tabular-nums transition-colors cursor-pointer shrink-0 ${
                        isCurr
                          ? 'ring-2 ring-white bg-zinc-700 text-white font-semibold'
                          : lbl === 'same'
                            ? 'bg-amber-500/25 border border-amber-400/70 text-amber-200'
                            : lbl === 'different'
                              ? 'bg-rose-500/20 border border-rose-400/60 text-rose-200'
                              : 'bg-[#09090B] border border-zinc-800 text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {idx + 1}
                    </button>
                  );
                })}
              </div>

              {/* Side-by-Side Comparison Photos (always 2 columns even on phones) */}
              <div className="grid grid-cols-2 gap-2 sm:gap-3">
                {[
                  { shot: currentPair.shotA, url: thumbA, label: 'A' },
                  { shot: currentPair.shotB, url: thumbB, label: 'B' },
                ].map(({ shot, url, label }) => (
                  <div
                    key={shot.id}
                    className="rounded-xl border border-zinc-800 bg-[#09090B] overflow-hidden flex flex-col"
                  >
                    <div className="aspect-[4/3] w-full bg-[#09090B] flex items-center justify-center p-1 sm:p-2">
                      {url ? (
                        <img
                          src={url}
                          alt={shot.primary.name}
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-contain rounded"
                        />
                      ) : (
                        <div className="h-6 w-6 rounded-full border-2 border-zinc-700 border-t-amber-400 animate-spin" />
                      )}
                    </div>
                    <div className="px-2 sm:px-3 py-1.5 sm:py-2 border-t border-zinc-800/80 flex items-center justify-between gap-1.5 text-[10px] sm:text-[11px] text-zinc-400 tabular-nums">
                      <span className="truncate font-medium text-zinc-200">
                        {label} · {shot.primary.name}
                      </span>
                      {shot.takenAtLabel && (
                        <span className="hidden sm:inline shrink-0 font-mono text-zinc-500">
                          {shot.takenAtLabel}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Measured Similarity Metrics (Unboxed Text) */}
              {currentPairMetrics && !currentPairMetrics.incompatible && (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-zinc-400 tabular-nums px-1">
                  <span>
                    {t('Celková shoda', 'Overall match')}:{' '}
                    <strong className="text-zinc-100 font-mono">
                      {Math.round(currentPairMetrics.score * 100)} %
                    </strong>
                  </span>
                  <span>
                    {t('Tvar a scéna', 'Structure & scene')}:{' '}
                    <strong className="text-zinc-200 font-mono">
                      {Math.round(currentPairMetrics.structSim * 100)} %
                    </strong>
                  </span>
                  <span>
                    {t('Středový motiv', 'Center subject')}:{' '}
                    <strong className="text-zinc-200 font-mono">
                      {Math.round(currentPairMetrics.centerSim * 100)} %
                    </strong>
                  </span>
                  <span>
                    {t('Barvy středu', 'Center color')}:{' '}
                    <strong className="text-zinc-200 font-mono">
                      {Math.round(currentPairMetrics.centerColorSim * 100)} %
                    </strong>
                  </span>
                </div>
              )}

              {/* Tagging Action Buttons */}
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => handleLabelCurrent('same')}
                  className={`min-h-[48px] px-4 py-2.5 rounded-xl border text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors cursor-pointer whitespace-nowrap ${
                    currentLabel === 'same'
                      ? 'border-amber-400 bg-amber-500 text-zinc-950'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
                  }`}
                >
                  <Check className="w-4 h-4" />
                  <span>{t('Stejná série', 'Same series')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleLabelCurrent('different')}
                  className={`min-h-[48px] px-4 py-2.5 rounded-xl border text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors cursor-pointer whitespace-nowrap ${
                    currentLabel === 'different'
                      ? 'border-rose-400 bg-rose-500 text-white'
                      : 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
                  }`}
                >
                  <X className="w-4 h-4" />
                  <span>{t('Jiné fotky', 'Different')}</span>
                </button>
              </div>

              {currentLabel && (
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={handleClearCurrentLabel}
                    className="text-xs text-zinc-400 hover:text-zinc-200 underline underline-offset-4 cursor-pointer"
                  >
                    {t(
                      'Zrušit označení u této dvojice',
                      'Clear tag for this pair'
                    )}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer Summary & Apply */}
        <div className="px-5 py-3.5 border-t border-zinc-800 bg-[#0D0D10] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-xs text-zinc-400 tabular-nums space-y-0.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-zinc-200">
              <span>
                {t(
                  `Označeno: ${sameCount}× stejná · ${diffCount}× jiná`,
                  `Tagged: ${sameCount}× same · ${diffCount}× different`
                )}
              </span>
              {draftCalibration && taggedExamples.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-amber-300 font-medium">
                    {t(
                      `Přesnost na ukázkách: ${draftCalibration.accuracyPct} %`,
                      `Sample accuracy: ${draftCalibration.accuracyPct}%`
                    )}
                  </span>
                </>
              )}
            </div>
            <div>
              {t('Odhad sérií ve složce', 'Estimated series in folder')}:{' '}
              {formatNumber(previewSeriesCount)}
              {draftCalibration && (
                <>
                  {' '}
                  · {t('Práh shody', 'Match threshold')}:{' '}
                  {Math.round(draftCalibration.minScore * 100)} %
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {(currentCalibration || taggedExamples.length > 0) && (
              <button
                type="button"
                onClick={() => {
                  setLabelsByKey({});
                  onResetCalibration();
                }}
                className="min-h-[42px] px-3.5 py-2 rounded-xl border border-zinc-700 bg-[#141417] text-xs font-medium text-zinc-300 hover:text-white inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{t('Výchozí', 'Default')}</span>
              </button>
            )}

            <button
              type="button"
              disabled={!draftCalibration || taggedExamples.length === 0}
              onClick={() => {
                if (!draftCalibration || taggedExamples.length === 0) return;
                onApplyCalibration(draftCalibration, taggedExamples);
                onClose();
              }}
              className="min-h-[42px] px-4 py-2 rounded-xl bg-amber-500 text-zinc-950 text-xs sm:text-sm font-semibold hover:bg-amber-400 transition-colors inline-flex items-center gap-1.5 disabled:opacity-40 cursor-pointer whitespace-nowrap"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>{t('Použít kalibraci', 'Apply calibration')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

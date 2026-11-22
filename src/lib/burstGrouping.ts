import { DrivePhotoFile } from './driveApi';
import { getIntlLocale, tr } from './i18n';
import {
  CustomVisualCalibration,
  SimilarityScope,
  SimilaritySensitivity,
  VisualFingerprint,
  computeVisualSimilarity,
  evaluateSimilarityMetrics,
} from './visualSimilarity';

export interface PhotoShotItem {
  id: string;
  stem: string;
  primary: DrivePhotoFile;
  files: DrivePhotoFile[];
  totalBytes: number;
  formatSummary: string;
  isPaired: boolean;
  takenAtMs: number | null;
  takenAtLabel?: string;
}

export type BurstMatchReason = 'time' | 'visual' | 'mixed';

export interface ManualLockedSeries {
  id: string;
  shotIds: string[];
  stems: string[];
  updatedAtMs: number;
}

export interface PhotoBurstGroup {
  id: string;
  shots: PhotoShotItem[];
  startTimeMs: number;
  endTimeMs: number;
  durationSec: number;
  timeLabel: string;
  matchReason: BurstMatchReason;
  isManual?: boolean;
}

/**
 * Merges paired JPG/PNG + RAW files sharing the same base filename stem into unified PhotoShotItems
 * when pairEnabled is true, or keeps each file separate when pairEnabled is false.
 */
export function buildShotItems(
  activePhotos: DrivePhotoFile[],
  options: {
    pairEnabled: boolean;
    formatFilter: 'all' | 'raw' | 'standard';
    decidedIds?: Set<string>;
  }
): PhotoShotItem[] {
  const { pairEnabled, formatFilter } = options;
  const decidedIds = options.decidedIds ?? new Set<string>();

  if (!pairEnabled) {
    const items: PhotoShotItem[] = [];
    for (const file of activePhotos) {
      if (decidedIds.has(file.id)) continue;
      if (formatFilter === 'raw' && !file.isRaw) continue;
      if (formatFilter === 'standard' && file.isRaw) continue;
      items.push({
        id: file.id,
        stem: file.stem,
        primary: file,
        files: [file],
        totalBytes: file.sizeBytes || 0,
        formatSummary: file.fileExtension.toUpperCase(),
        isPaired: false,
        takenAtMs: file.takenAtMs,
        takenAtLabel: file.takenAtLabel,
      });
    }
    return items;
  }

  // Group all active photos by stem while preserving discovery order
  const byStem = new Map<string, DrivePhotoFile[]>();
  for (const file of activePhotos) {
    const list = byStem.get(file.stem);
    if (list) {
      list.push(file);
    } else {
      byStem.set(file.stem, [file]);
    }
  }

  const shots: PhotoShotItem[] = [];
  for (const [stem, groupFiles] of byStem.entries()) {
    const undecided = groupFiles.filter((f) => !decidedIds.has(f.id));
    if (undecided.length === 0) continue;

    // Respect active format filter
    if (formatFilter === 'raw' && !undecided.some((f) => f.isRaw)) continue;
    if (formatFilter === 'standard' && !undecided.some((f) => !f.isRaw)) continue;

    // Choose primary preview file:
    // - In 'raw' filter: prefer the RAW file
    // - In 'all' or 'standard' filter: prefer fast standard JPG/PNG/WEBP/HEIC if present
    let primary: DrivePhotoFile;
    if (formatFilter === 'raw') {
      primary = undecided.find((f) => f.isRaw) || undecided[0];
    } else {
      primary = undecided.find((f) => !f.isRaw) || undecided[0];
    }

    // Inherit EXIF timestamp from any file in the stem group (e.g. JPG -> CR3)
    const withTime = groupFiles.find((f) => f.takenAtMs !== null);
    const takenAtMs = withTime?.takenAtMs ?? null;
    const takenAtLabel = withTime?.takenAtLabel;

    // Order format summary cleanly: standard first, then RAW (e.g. "JPG + CR3")
    const sortedForLabel = [...undecided].sort((a, b) => {
      if (a.isRaw !== b.isRaw) return a.isRaw ? 1 : -1;
      return a.fileExtension.localeCompare(b.fileExtension);
    });
    const exts = Array.from(
      new Set(sortedForLabel.map((f) => f.fileExtension.toUpperCase()))
    );

    shots.push({
      id: primary.id,
      stem,
      primary,
      files: undecided,
      totalBytes: undecided.reduce((sum, f) => sum + (f.sizeBytes || 0), 0),
      formatSummary: exts.join(' + '),
      isPaired: undecided.length > 1,
      takenAtMs,
      takenAtLabel,
    });
  }

  return shots;
}

function getSortTimestampMs(shot: PhotoShotItem): number | null {
  if (shot.takenAtMs !== null && !Number.isNaN(shot.takenAtMs)) {
    return shot.takenAtMs;
  }
  const mod = shot.primary.modifiedTime;
  if (mod) {
    const parsed = Date.parse(mod);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * Orders shots chronologically oldest-first by EXIF takenAtMs (falling back to modifiedTime
 * while EXIF enriches), with natural path/name tie-breaking.
 */
export function orderShotsChronologically(
  shots: PhotoShotItem[]
): PhotoShotItem[] {
  if (shots.length <= 1) return shots;
  return [...shots]
    .map((shot, originalIdx) => ({
      shot,
      originalIdx,
      sortMs: getSortTimestampMs(shot),
    }))
    .sort((a, b) => {
      const ta = a.sortMs;
      const tb = b.sortMs;
      if (ta !== null && tb !== null) {
        if (ta !== tb) return ta - tb;
        const pa = a.shot.primary.relativePath || a.shot.primary.name;
        const pb = b.shot.primary.relativePath || b.shot.primary.name;
        return pa.localeCompare(pb, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      }
      if (ta !== null) return -1;
      if (tb !== null) return 1;
      return a.originalIdx - b.originalIdx;
    })
    .map((entry) => entry.shot);
}

/**
 * Legacy helper: groups PhotoShotItems strictly by EXIF timestamp interval (< maxGapMs).
 */
export function groupShotsByExifInterval(
  shots: PhotoShotItem[],
  maxGapMs = 3000
): PhotoBurstGroup[] {
  return groupShotsIntoSeries(shots, {
    maxGapMs,
    visualEnabled: false,
    fingerprints: {},
    scope: 'nearby',
    sensitivity: 'balanced',
  });
}

export interface SeriesGroupingOptions {
  maxGapMs?: number;
  visualEnabled: boolean;
  fingerprints: Record<string, VisualFingerprint>;
  scope?: SimilarityScope;
  sensitivity: SimilaritySensitivity;
  calibration?: CustomVisualCalibration | null;
}

export const STANDARD_VISUAL_MAX_GAP_MS = 60 * 1000; // 1 minute for standard adjacent match
export const HIGH_MATCH_VISUAL_MAX_GAP_MS = 180 * 1000; // 3 minutes for high-confidence adjacent match

// Fast LRU cache for adjacent fingerprint similarity metrics so incremental background scans
// never re-run 16x16 correlation for pairs that were already compared.
const adjacentMetricsCache = new Map<
  string,
  ReturnType<typeof computeVisualSimilarity>
>();
const MAX_ADJACENT_CACHE_ENTRIES = 12000;

function getCachedPairSimilarity(
  idA: string,
  fpA: VisualFingerprint,
  idB: string,
  fpB: VisualFingerprint
) {
  const key = `${idA}|${idB}`;
  const cached = adjacentMetricsCache.get(key);
  if (cached) return cached;
  const computed = computeVisualSimilarity(fpA, fpB);
  if (adjacentMetricsCache.size >= MAX_ADJACENT_CACHE_ENTRIES) {
    const firstKey = adjacentMetricsCache.keys().next().value;
    if (firstKey) adjacentMetricsCache.delete(firstKey);
  }
  adjacentMetricsCache.set(key, computed);
  return computed;
}

/**
 * Strictly adjacent O(N) series grouping:
 * - Each photo `ordered[i]` is ONLY ever compared with its immediate neighbor `ordered[i - 1]`.
 * - Never skips intermediate photos ("nikdy ne na přeskáčku").
 * - Single linear pass O(N) with cached pair metrics for sub-millisecond updates during progressive loading.
 * - Users can still manually group or merge any photos across series via `ManualLockedSeries`.
 */
export function groupShotsIntoSeries(
  shots: PhotoShotItem[],
  options: SeriesGroupingOptions
): PhotoBurstGroup[] {
  const {
    maxGapMs = 3000,
    visualEnabled,
    fingerprints,
    sensitivity,
    calibration = null,
  } = options;

  if (shots.length < 2) return [];

  // Check if shots are already in chronological order to avoid unnecessary sort allocations
  let alreadyOrdered = true;
  for (let i = 1; i < shots.length; i++) {
    const prevT = shots[i - 1].takenAtMs;
    const currT = shots[i].takenAtMs;
    if (prevT !== null && currT !== null && currT < prevT) {
      alreadyOrdered = false;
      break;
    }
    if (prevT === null && currT !== null) {
      alreadyOrdered = false;
      break;
    }
  }

  const ordered = alreadyOrdered
    ? shots
    : [...shots]
        .map((shot, originalIdx) => ({ shot, originalIdx }))
        .sort((a, b) => {
          const ta = a.shot.takenAtMs;
          const tb = b.shot.takenAtMs;
          if (ta !== null && tb !== null) {
            if (ta !== tb) return ta - tb;
            return a.shot.primary.name.localeCompare(
              b.shot.primary.name,
              undefined,
              {
                numeric: true,
                sensitivity: 'base',
              }
            );
          }
          if (ta !== null) return -1;
          if (tb !== null) return 1;
          return a.originalIdx - b.originalIdx;
        })
        .map((entry) => entry.shot);

  const n = ordered.length;
  const getFpWithId = (
    idx: number
  ): { id: string; fp: VisualFingerprint } | undefined => {
    const shot = ordered[idx];
    const primaryFp = fingerprints[shot.primary.id];
    if (primaryFp) return { id: shot.primary.id, fp: primaryFp };
    for (const f of shot.files) {
      const fileFp = fingerprints[f.id];
      if (fileFp) return { id: f.id, fp: fileFp };
    }
    return undefined;
  };

  const checkPairMatch = (
    idxA: number,
    idxB: number,
    opts: {
      isImmediateNeighbor?: boolean;
      requireHighMatch?: boolean;
      extraSlack?: number;
    }
  ): boolean => {
    const a = getFpWithId(idxA);
    const b = getFpWithId(idxB);
    if (!a || !b) return false;
    const sim = getCachedPairSimilarity(a.id, a.fp, b.id, b.fp);
    return evaluateSimilarityMetrics(sim, sensitivity, {
      ...opts,
      calibration,
    });
  };

  // Single linear O(N) pass: photo `i` can ONLY join the series ending at `i - 1`
  const groups: PhotoBurstGroup[] = [];
  let runStart = 0;
  let runAnchorFpIdx = getFpWithId(0) ? 0 : -1;
  let runMinTime = ordered[0].takenAtMs;
  let runMaxTime = ordered[0].takenAtMs;
  let runHadTime = false;
  let runHadVisual = false;

  const flushRun = (endExclusive: number) => {
    const count = endExclusive - runStart;
    if (count < 2) return;
    const batch = ordered.slice(runStart, endExclusive);
    const distinctStems = new Set(batch.map((s) => s.stem));
    if (distinctStems.size < 2) return;

    const timed = batch
      .map((s) => s.takenAtMs)
      .filter((t): t is number => t !== null);
    const startTimeMs = timed.length > 0 ? Math.min(...timed) : 0;
    const endTimeMs = timed.length > 0 ? Math.max(...timed) : 0;
    const durationSec = Math.max(0, Math.round((endTimeMs - startTimeMs) / 1000));

    const timeLabel =
      batch.find((s) => s.takenAtLabel)?.takenAtLabel ||
      (startTimeMs > 0
        ? new Date(startTimeMs).toLocaleString(getIntlLocale(), {
            day: 'numeric',
            month: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })
        : tr('Podobný vzhled', 'Visual match'));

    const matchReason: BurstMatchReason =
      runHadTime && runHadVisual
        ? 'mixed'
        : runHadVisual
          ? 'visual'
          : 'time';

    groups.push({
      id: `burst-${batch[0].id}-${startTimeMs}`,
      shots: batch,
      startTimeMs,
      endTimeMs,
      durationSec,
      timeLabel,
      matchReason,
    });
  };

  for (let i = 1; i < n; i++) {
    const prev = ordered[i - 1];
    const curr = ordered[i];
    const hasCurrFp = Boolean(getFpWithId(i));
    const hasPrevFp = Boolean(getFpWithId(i - 1));

    let linked = false;
    let linkType: 'time' | 'visual' = 'time';

    const hasBothTimes = prev.takenAtMs !== null && curr.takenAtMs !== null;
    const diffMs = hasBothTimes
      ? (curr.takenAtMs as number) - (prev.takenAtMs as number)
      : -1;

    // Prevent any single auto-series from spanning more than 3 minutes total
    const candidateTotalSpanMs =
      runMinTime !== null && curr.takenAtMs !== null
        ? curr.takenAtMs - runMinTime
        : 0;
    const withinTotalSpan = candidateTotalSpanMs <= HIGH_MATCH_VISUAL_MAX_GAP_MS;

    if (withinTotalSpan) {
      // Case A: Rapid consecutive burst (< maxGapMs, default 3s)
      if (hasBothTimes && diffMs >= 0 && diffMs < maxGapMs) {
        if (!visualEnabled || !hasPrevFp || !hasCurrFp) {
          linked = true;
          linkType = 'time';
        } else {
          const allowNeighborSlack =
            !calibration && sensitivity !== 'strict' && diffMs < 1200;
          const matchesPrev = checkPairMatch(i - 1, i, {
            isImmediateNeighbor: allowNeighborSlack,
          });
          const matchesAnchor =
            runAnchorFpIdx === -1 ||
            runAnchorFpIdx === i - 1 ||
            checkPairMatch(runAnchorFpIdx, i, {});
          if (matchesPrev && matchesAnchor) {
            linked = true;
            linkType = 'time';
          }
        }
      }

      // Case B: Strictly adjacent visual similarity (i - 1 and i only, within 1–3 min)
      if (!linked && visualEnabled && hasPrevFp && hasCurrFp) {
        const withinVisualTimeGap =
          !hasBothTimes ||
          (diffMs >= 0 && diffMs <= HIGH_MATCH_VISUAL_MAX_GAP_MS);
        if (withinVisualTimeGap) {
          const needsHighMatch =
            hasBothTimes && diffMs > STANDARD_VISUAL_MAX_GAP_MS;
          const matchesPrev = checkPairMatch(i - 1, i, {
            isImmediateNeighbor: !needsHighMatch,
            requireHighMatch: needsHighMatch,
          });
          const matchesAnchor =
            runAnchorFpIdx === -1 ||
            runAnchorFpIdx === i - 1 ||
            checkPairMatch(runAnchorFpIdx, i, {
              requireHighMatch: needsHighMatch,
              extraSlack:
                calibration || needsHighMatch || sensitivity === 'strict'
                  ? 0
                  : 0.01,
            });
          if (matchesPrev && matchesAnchor) {
            linked = true;
            linkType = 'visual';
          }
        }
      }
    }

    if (linked) {
      if (linkType === 'time') runHadTime = true;
      else runHadVisual = true;
      if (runAnchorFpIdx === -1 && hasCurrFp) {
        runAnchorFpIdx = i;
      }
      if (curr.takenAtMs !== null) {
        if (runMinTime === null || curr.takenAtMs < runMinTime) {
          runMinTime = curr.takenAtMs;
        }
        if (runMaxTime === null || curr.takenAtMs > runMaxTime) {
          runMaxTime = curr.takenAtMs;
        }
      }
    } else {
      flushRun(i);
      runStart = i;
      runAnchorFpIdx = hasCurrFp ? i : -1;
      runMinTime = curr.takenAtMs;
      runMaxTime = curr.takenAtMs;
      runHadTime = false;
      runHadVisual = false;
    }
  }

  flushRun(n);
  return groups;
}

function buildBurstGroupFromOrderedShots(
  id: string,
  batch: PhotoShotItem[],
  matchReason: BurstMatchReason,
  isManual: boolean
): PhotoBurstGroup {
  const timed = batch
    .map((s) => s.takenAtMs)
    .filter((t): t is number => t !== null);
  const startTimeMs = timed.length > 0 ? Math.min(...timed) : 0;
  const endTimeMs = timed.length > 0 ? Math.max(...timed) : 0;
  const durationSec = Math.max(0, Math.round((endTimeMs - startTimeMs) / 1000));
  const timeLabel =
    batch.find((s) => s.takenAtLabel)?.takenAtLabel ||
    (startTimeMs > 0
      ? new Date(startTimeMs).toLocaleString(getIntlLocale(), {
          day: 'numeric',
          month: 'numeric',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : isManual
        ? tr('Ruční série', 'Manual series')
        : tr('Podobný vzhled', 'Visual match'));

  return {
    id,
    shots: batch,
    startTimeMs,
    endTimeMs,
    durationSec,
    timeLabel,
    matchReason,
    ...(isManual ? { isManual: true } : {}),
  };
}

/**
 * Merges immutable user-edited ManualLockedSeries over auto-detected series.
 * Locked manual series are ALWAYS resolved first and never broken or dissolved by recalculation.
 * When `includeAuto` is false, only locked manual series are returned (keeping default filmstrip ungrouped elsewhere).
 */
export function mergeManualAndAutoSeries(
  allOrderedShots: PhotoShotItem[],
  manualSeries: ManualLockedSeries[],
  autoGroups: PhotoBurstGroup[],
  options: { includeAuto?: boolean } = {}
): PhotoBurstGroup[] {
  const includeAuto = options.includeAuto !== false;
  if (allOrderedShots.length < 2) return [];

  const shotIndexById = new Map<string, number>();
  const shotByFileId = new Map<string, PhotoShotItem>();
  const shotsByStem = new Map<string, PhotoShotItem[]>();

  allOrderedShots.forEach((shot, idx) => {
    shotIndexById.set(shot.id, idx);
    for (const f of shot.files) {
      shotByFileId.set(f.id, shot);
    }
    const list = shotsByStem.get(shot.stem);
    if (list) list.push(shot);
    else shotsByStem.set(shot.stem, [shot]);
  });

  const lockedShotIds = new Set<string>();
  const resolvedGroups: Array<{ firstIdx: number; group: PhotoBurstGroup }> = [];

  // Process newest manual edits first in case two manual edits overlap
  const sortedManual = [...manualSeries].sort(
    (a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0)
  );

  for (const ms of sortedManual) {
    const matchedShots = new Map<string, PhotoShotItem>();
    for (const sid of ms.shotIds) {
      const exact = allOrderedShots.find((s) => s.id === sid) || shotByFileId.get(sid);
      if (exact && !lockedShotIds.has(exact.id)) {
        matchedShots.set(exact.id, exact);
      }
    }
    // Stem fallback only when an exact shotId didn't resolve (e.g. reopened handle/filter change)
    if (matchedShots.size < ms.stems.length) {
      for (const stem of ms.stems) {
        const candidates = shotsByStem.get(stem) || [];
        for (const cand of candidates) {
          if (!lockedShotIds.has(cand.id) && !matchedShots.has(cand.id)) {
            matchedShots.set(cand.id, cand);
            break;
          }
        }
      }
    }

    const batch = Array.from(matchedShots.values()).sort(
      (a, b) => (shotIndexById.get(a.id) ?? 0) - (shotIndexById.get(b.id) ?? 0)
    );
    const distinctStems = new Set(batch.map((s) => s.stem));
    if (batch.length >= 2 && distinctStems.size >= 2) {
      for (const s of batch) {
        lockedShotIds.add(s.id);
      }
      const firstIdx = shotIndexById.get(batch[0].id) ?? 0;
      resolvedGroups.push({
        firstIdx,
        group: buildBurstGroupFromOrderedShots(ms.id, batch, 'mixed', true),
      });
    }
  }

  if (includeAuto) {
    for (const ag of autoGroups) {
      const remaining = ag.shots.filter((s) => !lockedShotIds.has(s.id));
      const distinctStems = new Set(remaining.map((s) => s.stem));
      if (remaining.length >= 2 && distinctStems.size >= 2) {
        const firstIdx = shotIndexById.get(remaining[0].id) ?? 0;
        resolvedGroups.push({
          firstIdx,
          group: buildBurstGroupFromOrderedShots(
            ag.id,
            remaining,
            ag.matchReason,
            false
          ),
        });
      }
    }
  }

  resolvedGroups.sort((a, b) => a.firstIdx - b.firstIdx);
  return resolvedGroups.map((item) => item.group);
}


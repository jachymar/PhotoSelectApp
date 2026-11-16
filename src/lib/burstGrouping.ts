import { DrivePhotoFile } from './driveApi';
import {
  CustomVisualCalibration,
  SimilarityScope,
  SimilaritySensitivity,
  VisualFingerprint,
  areVisuallySimilar,
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

export const STANDARD_VISUAL_MAX_GAP_MS = 60 * 1000; // 1 minute for standard match
export const HIGH_MATCH_VISUAL_MAX_GAP_MS = 180 * 1000; // 3 minutes for high visual match
const BRIDGE_MAX_SKIPPED_SHOTS = 6; // Allow a few intermediate frames within the tight time window

/**
 * Appearance-first series grouping within a strict 1-3 minute window:
 * 1) Rapid consecutive shots (< maxGapMs, default 3s) form initial bursts only when visually compatible
 *    with BOTH the previous shot and the burst anchor (preventing 3+3 chain drift).
 * 2) When visualEnabled is true, bursts or standalone shots of the same scene are grouped
 *    within 1 minute (standard match) or up to 3 minutes (high-confidence visual match),
 *    never merging shots across different hours or days.
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

  // Sort shots chronologically where timestamps exist, appending undated shots cleanly in order
  const ordered = [...shots]
    .map((shot, originalIdx) => ({ shot, originalIdx }))
    .sort((a, b) => {
      const ta = a.shot.takenAtMs;
      const tb = b.shot.takenAtMs;
      if (ta !== null && tb !== null) {
        if (ta !== tb) return ta - tb;
        return a.shot.primary.name.localeCompare(b.shot.primary.name, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      }
      if (ta !== null) return -1;
      if (tb !== null) return 1;
      return a.originalIdx - b.originalIdx;
    })
    .map((entry) => entry.shot);

  const n = ordered.length;
  const parent = new Int32Array(n);
  const clusterAnchor = new Int32Array(n);
  const clusterMinTime = new Float64Array(n);
  const clusterMaxTime = new Float64Array(n);
  const hasTimeEdge = new Uint8Array(n);
  const hasVisualEdge = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    parent[i] = i;
    clusterAnchor[i] = i;
    const t = ordered[i].takenAtMs;
    clusterMinTime[i] = t !== null ? t : Number.NaN;
    clusterMaxTime[i] = t !== null ? t : Number.NaN;
  }

  const getFp = (idx: number): VisualFingerprint | undefined => {
    const shot = ordered[idx];
    if (fingerprints[shot.primary.id]) return fingerprints[shot.primary.id];
    for (const f of shot.files) {
      if (fingerprints[f.id]) return fingerprints[f.id];
    }
    return undefined;
  };

  const find = (x: number): number => {
    let curr = x;
    while (parent[curr] !== curr) {
      parent[curr] = parent[parent[curr]];
      curr = parent[curr];
    }
    return curr;
  };

  const union = (a: number, b: number, reason: 'time' | 'visual') => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) {
      if (reason === 'time') hasTimeEdge[ra] = 1;
      else hasVisualEdge[ra] = 1;
      return;
    }
    const keepRoot = ra < rb ? ra : rb;
    const dropRoot = ra < rb ? rb : ra;
    parent[dropRoot] = keepRoot;
    hasTimeEdge[keepRoot] =
      hasTimeEdge[ra] | hasTimeEdge[rb] | (reason === 'time' ? 1 : 0);
    hasVisualEdge[keepRoot] =
      hasVisualEdge[ra] | hasVisualEdge[rb] | (reason === 'visual' ? 1 : 0);

    const minA = clusterMinTime[ra];
    const minB = clusterMinTime[rb];
    if (!Number.isNaN(minA) && !Number.isNaN(minB)) {
      clusterMinTime[keepRoot] = Math.min(minA, minB);
    } else {
      clusterMinTime[keepRoot] = !Number.isNaN(minA) ? minA : minB;
    }

    const maxA = clusterMaxTime[ra];
    const maxB = clusterMaxTime[rb];
    if (!Number.isNaN(maxA) && !Number.isNaN(maxB)) {
      clusterMaxTime[keepRoot] = Math.max(maxA, maxB);
    } else {
      clusterMaxTime[keepRoot] = !Number.isNaN(maxA) ? maxA : maxB;
    }

    // Prefer an anchor that actually has a computed fingerprint
    const anchorKeep = clusterAnchor[keepRoot];
    const anchorDrop = clusterAnchor[dropRoot];
    if (!getFp(anchorKeep) && getFp(anchorDrop)) {
      clusterAnchor[keepRoot] = anchorDrop;
    }
  };

  // 1. Primary pass: rapid consecutive shots (< maxGapMs, default 3s) form time bursts,
  //    but when visual analysis is enabled, check BOTH previous frame and burst anchor to stop 3+3 drift.
  for (let i = 1; i < n; i++) {
    const prev = ordered[i - 1];
    const curr = ordered[i];
    if (prev.takenAtMs !== null && curr.takenAtMs !== null) {
      const diffMs = curr.takenAtMs - prev.takenAtMs;
      if (diffMs >= 0 && diffMs < maxGapMs) {
        if (visualEnabled) {
          const fpPrev = getFp(i - 1);
          const fpCurr = getFp(i);
          if (fpPrev && fpCurr) {
            const allowNeighborSlack =
              !calibration && sensitivity !== 'strict' && diffMs < 1200;
            if (
              !areVisuallySimilar(fpPrev, fpCurr, sensitivity, {
                isImmediateNeighbor: allowNeighborSlack,
                calibration,
              })
            ) {
              continue;
            }
            const prevRoot = find(i - 1);
            const anchorIdx = clusterAnchor[prevRoot];
            if (anchorIdx !== i - 1) {
              const fpAnchor = getFp(anchorIdx);
              if (
                fpAnchor &&
                !areVisuallySimilar(fpAnchor, fpCurr, sensitivity, {
                  calibration,
                })
              ) {
                continue;
              }
            }
          }
        }
        union(i - 1, i, 'time');
      }
    }
  }

  // 2. Secondary pass: appearance-first grouping bounded to 1 minute (standard) / 3 minutes (high match)
  if (visualEnabled) {
    interface TimeCluster {
      startIdx: number;
      endIdx: number;
      startTimeMs: number | null;
      endTimeMs: number | null;
      fpIndices: number[];
    }

    const initialClusters: TimeCluster[] = [];
    let idx = 0;
    while (idx < n) {
      const root = find(idx);
      let endIdx = idx;
      while (endIdx + 1 < n && find(endIdx + 1) === root) {
        endIdx++;
      }

      const fpIndices: number[] = [];
      let startTimeMs: number | null = null;
      let endTimeMs: number | null = null;
      for (let k = idx; k <= endIdx; k++) {
        if (getFp(k)) fpIndices.push(k);
        const t = ordered[k].takenAtMs;
        if (t !== null) {
          if (startTimeMs === null || t < startTimeMs) startTimeMs = t;
          if (endTimeMs === null || t > endTimeMs) endTimeMs = t;
        }
      }

      initialClusters.push({
        startIdx: idx,
        endIdx,
        startTimeMs,
        endTimeMs,
        fpIndices,
      });

      idx = endIdx + 1;
    }

    const pickReps = (indices: number[], fromEnd: boolean): number[] => {
      if (indices.length === 0) return [];
      if (indices.length <= 3) return fromEnd ? [...indices].reverse() : indices;
      const mid = indices[Math.floor(indices.length / 2)];
      return fromEnd
        ? [indices[indices.length - 1], mid, indices[0]]
        : [indices[0], mid, indices[indices.length - 1]];
    };

    for (let a = 0; a < initialClusters.length; a++) {
      const clusterA = initialClusters[a];
      if (clusterA.fpIndices.length === 0) continue;
      const repsA = pickReps(clusterA.fpIndices, true);

      for (let b = a + 1; b < initialClusters.length; b++) {
        const clusterB = initialClusters[b];
        const skippedShots = clusterB.startIdx - clusterA.endIdx - 1;
        if (skippedShots > BRIDGE_MAX_SKIPPED_SHOTS) {
          break;
        }

        const rootA = find(clusterA.startIdx);
        const rootB = find(clusterB.startIdx);
        if (rootA === rootB) continue;

        let timeGapMs = 0;
        let hasValidTimes = false;
        if (clusterA.endTimeMs !== null && clusterB.startTimeMs !== null) {
          hasValidTimes = true;
          timeGapMs = clusterB.startTimeMs - clusterA.endTimeMs;
          if (timeGapMs > HIGH_MATCH_VISUAL_MAX_GAP_MS) {
            break;
          }
        } else if (skippedShots > 1) {
          // Without timestamps, only allow bridging across at most 1 intermediate shot
          break;
        }

        // Prevent total merged series span from ever exceeding 3 minutes
        const minA = clusterMinTime[rootA];
        const maxA = clusterMaxTime[rootA];
        const minB = clusterMinTime[rootB];
        const maxB = clusterMaxTime[rootB];
        if (
          !Number.isNaN(minA) &&
          !Number.isNaN(maxA) &&
          !Number.isNaN(minB) &&
          !Number.isNaN(maxB)
        ) {
          const mergedSpan = Math.max(maxA, maxB) - Math.min(minA, minB);
          if (mergedSpan > HIGH_MATCH_VISUAL_MAX_GAP_MS) {
            continue;
          }
        }

        if (clusterB.fpIndices.length === 0) continue;

        const needsHighMatch =
          hasValidTimes && timeGapMs > STANDARD_VISUAL_MAX_GAP_MS;
        const repsB = pickReps(clusterB.fpIndices, false);
        const isImmediateNeighbor = skippedShots === 0 && !needsHighMatch;

        let matchedBoundary = false;
        for (const ia of repsA) {
          const fpA = getFp(ia);
          if (!fpA) continue;
          for (const ib of repsB) {
            const fpB = getFp(ib);
            if (!fpB) continue;
            if (
              areVisuallySimilar(fpA, fpB, sensitivity, {
                isImmediateNeighbor,
                requireHighMatch: needsHighMatch,
                calibration,
              })
            ) {
              matchedBoundary = true;
              break;
            }
          }
          if (matchedBoundary) break;
        }

        if (!matchedBoundary) continue;

        // Guard against chain drift by verifying against the existing cluster anchors
        const anchorA = getFp(clusterAnchor[rootA]);
        const anchorB = getFp(clusterAnchor[rootB]);
        if (
          anchorA &&
          anchorB &&
          !areVisuallySimilar(anchorA, anchorB, sensitivity, {
            requireHighMatch: needsHighMatch,
            extraSlack:
              calibration || needsHighMatch || sensitivity === 'strict'
                ? 0
                : 0.01,
            calibration,
          })
        ) {
          continue;
        }

        union(clusterA.startIdx, clusterB.startIdx, 'visual');
      }
    }
  }

  // 3. Collect finalized groups (>= 2 distinct stems)
  const buckets = new Map<number, PhotoShotItem[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = buckets.get(r);
    if (list) list.push(ordered[i]);
    else buckets.set(r, [ordered[i]]);
  }

  const groups: PhotoBurstGroup[] = [];
  for (const [root, batch] of buckets.entries()) {
    if (batch.length < 2) continue;
    const distinctStems = new Set(batch.map((s) => s.stem));
    if (distinctStems.size < 2) continue;

    const timed = batch
      .map((s) => s.takenAtMs)
      .filter((t): t is number => t !== null);
    const startTimeMs = timed.length > 0 ? Math.min(...timed) : 0;
    const endTimeMs = timed.length > 0 ? Math.max(...timed) : 0;
    const durationSec = Math.max(0, Math.round((endTimeMs - startTimeMs) / 1000));

    const timeLabel =
      batch.find((s) => s.takenAtLabel)?.takenAtLabel ||
      (startTimeMs > 0
        ? new Date(startTimeMs).toLocaleString('cs-CZ', {
            day: 'numeric',
            month: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })
        : 'Podobný vzhled');

    const hadTime = hasTimeEdge[root] === 1;
    const hadVisual = hasVisualEdge[root] === 1;
    const matchReason: BurstMatchReason =
      hadTime && hadVisual ? 'mixed' : hadVisual ? 'visual' : 'time';

    groups.push({
      id: `burst-${batch[0].id}-${startTimeMs}`,
      shots: batch,
      startTimeMs,
      endTimeMs,
      durationSec,
      timeLabel,
      matchReason,
    });
  }

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
      ? new Date(startTimeMs).toLocaleString('cs-CZ', {
          day: 'numeric',
          month: 'numeric',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : isManual
        ? 'Ruční série'
        : 'Podobný vzhled');

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


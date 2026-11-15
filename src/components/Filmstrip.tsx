import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Check,
  CheckCheck,
  Image as ImageIcon,
  Layers,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { AppMode } from '../lib/appMode';
import { PhotoBurstGroup, PhotoShotItem } from '../lib/burstGrouping';
import { SelectionRating } from '../lib/cullPersistence';
import {
  ResolvedPhotoMedia,
  getCachedFilmstripThumbnailUrl,
  getFilmstripThumbnailUrl,
  resolveFilmstripThumbnailUrl,
} from '../lib/rawParser';

interface FilmstripProps {
  appMode?: AppMode;
  shots: PhotoShotItem[];
  activeShotId: string | null;
  ratingsByShotId: Record<string, SelectionRating>;
  burstGroupByShotId: Map<string, PhotoBurstGroup>;
  seriesEnabled: boolean;
  activeComparisonIds: Set<string>;
  isEditingSeries: boolean;
  isFindingSeries?: boolean;
  accessToken?: string | null;
  tempPreviewMap: Record<string, string>;
  sharpMediaMap: Record<string, ResolvedPhotoMedia>;
  onSelectShot: (shotId: string) => void;
  onToggleShotInSeries: (shotId: string) => void;
  onToggleEditingSeries: () => void;
  onOpenSeries?: () => void;
  onFindSeries?: () => void;
  onKeepEntireSeries?: () => void;
  onRejectEntireSeries?: () => void;
}

const ITEM_WIDTH = 72;
const IN_SERIES_GAP = 4;
const STANDALONE_GAP = 8;
const SERIES_SEPARATOR_GAP = 22;
const TRACK_PADDING_X = 14;
const OVERSCAN = 8;
const THUMB_CONCURRENCY = 4;

interface StripLayout {
  xPositions: number[];
  hasSeparatorBefore: boolean[];
  burstKeys: (string | null)[];
  isSeriesStart: boolean[];
  isSeriesEnd: boolean[];
  seriesCounts: number[];
  totalTrackWidth: number;
}

function findFirstVisibleIndex(xPositions: number[], targetX: number): number {
  let lo = 0;
  let hi = xPositions.length - 1;
  let ans = xPositions.length;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (xPositions[mid] + ITEM_WIDTH >= targetX) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

function findNearestIndexToCenter(
  xPositions: number[],
  centerX: number
): number {
  const n = xPositions.length;
  if (n === 0) return -1;
  if (n === 1) return 0;

  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const itemCenter = xPositions[mid] + ITEM_WIDTH / 2;
    if (itemCenter < centerX) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  if (lo > 0) {
    const distCurr = Math.abs(xPositions[lo] + ITEM_WIDTH / 2 - centerX);
    const distPrev = Math.abs(xPositions[lo - 1] + ITEM_WIDTH / 2 - centerX);
    if (distPrev <= distCurr) return lo - 1;
  }
  return lo;
}

export const Filmstrip: React.FC<FilmstripProps> = ({
  appMode = 'selectra',
  shots,
  activeShotId,
  ratingsByShotId,
  burstGroupByShotId,
  seriesEnabled,
  activeComparisonIds,
  isEditingSeries,
  isFindingSeries = false,
  accessToken,
  tempPreviewMap,
  sharpMediaMap,
  onSelectShot,
  onToggleShotInSeries,
  onToggleEditingSeries,
  onOpenSeries,
  onFindSeries,
  onKeepEntireSeries,
  onRejectEntireSeries,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [filmstripThumbs, setFilmstripThumbs] = useState<
    Record<string, string>
  >({});
  const filmstripThumbsRef = useRef(filmstripThumbs);
  filmstripThumbsRef.current = filmstripThumbs;
  const failedThumbIdsRef = useRef<Set<string>>(new Set());

  const activeShotIdRef = useRef(activeShotId);
  activeShotIdRef.current = activeShotId;
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  const isEditingSeriesRef = useRef(isEditingSeries);
  isEditingSeriesRef.current = isEditingSeries;

  const programmaticScrollUntilRef = useRef(0);
  const lastCenteredByScrollRef = useRef<string | null>(null);
  const scrollDrivenShotIdsRef = useRef<Set<string>>(new Set());
  const prevCenteredShotIdRef = useRef<string | null>(null);
  const hasAlignedInitialWidthRef = useRef(false);
  const rafScrollRef = useRef<number | null>(null);
  const isTouchActiveRef = useRef(false);
  const snapTimerRef = useRef<number | null>(null);

  const mouseDragRef = useRef<{
    active: boolean;
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    didDrag: boolean;
  }>({
    active: false,
    pointerId: -1,
    startX: 0,
    startScrollLeft: 0,
    didDrag: false,
  });
  const suppressNextClickRef = useRef(false);

  useEffect(() => {
    if (shots.length === 0) {
      setFilmstripThumbs({});
      failedThumbIdsRef.current.clear();
    }
  }, [shots.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const updateWidth = () => {
      setViewportWidth(el.clientWidth);
    };
    updateWidth();

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(updateWidth);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  const clearSnapTimer = useCallback(() => {
    if (snapTimerRef.current !== null) {
      window.clearTimeout(snapTimerRef.current);
      snapTimerRef.current = null;
    }
  }, []);

  const snapToNearestCenter = useCallback(() => {
    clearSnapTimer();
    const el = scrollRef.current;
    if (
      !el ||
      isEditingSeriesRef.current ||
      isTouchActiveRef.current ||
      mouseDragRef.current.active ||
      Date.now() < programmaticScrollUntilRef.current ||
      shotsRef.current.length === 0
    ) {
      return;
    }

    const xPositions = layoutRef.current.xPositions;
    if (xPositions.length === 0) return;

    const centerX = el.scrollLeft + el.clientWidth / 2;
    const nearestIdx = findNearestIndexToCenter(xPositions, centerX);
    if (nearestIdx === -1) return;

    const candidate = shotsRef.current[nearestIdx];
    if (candidate && candidate.id !== activeShotIdRef.current) {
      lastCenteredByScrollRef.current = candidate.id;
      scrollDrivenShotIdsRef.current.add(candidate.id);
      onSelectShot(candidate.id);
    }

    const itemCenter = xPositions[nearestIdx] + ITEM_WIDTH / 2;
    const targetLeft = Math.max(0, itemCenter - el.clientWidth / 2);
    if (Math.abs(el.scrollLeft - targetLeft) > 1.5) {
      programmaticScrollUntilRef.current = Date.now() + 360;
      el.scrollTo({
        left: targetLeft,
        behavior: 'smooth',
      });
    }
  }, [clearSnapTimer, onSelectShot]);

  const scheduleSnapAfterIdle = useCallback(
    (delayMs = 110) => {
      clearSnapTimer();
      snapTimerRef.current = window.setTimeout(() => {
        snapTimerRef.current = null;
        snapToNearestCenter();
      }, delayMs);
    },
    [clearSnapTimer, snapToNearestCenter]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && e.deltaY !== 0) {
        e.preventDefault();
        programmaticScrollUntilRef.current = 0;
        el.scrollLeft += e.deltaY;
        scheduleSnapAfterIdle(140);
      } else if (e.deltaX !== 0) {
        programmaticScrollUntilRef.current = 0;
        scheduleSnapAfterIdle(140);
      }
    };
    const onTouchStart = () => {
      isTouchActiveRef.current = true;
      programmaticScrollUntilRef.current = 0;
      clearSnapTimer();
    };
    const onTouchEndOrCancel = (e: TouchEvent) => {
      if (e.touches.length > 0) return;
      isTouchActiveRef.current = false;
      scheduleSnapAfterIdle(100);
    };
    const onScrollEnd = () => {
      if (
        Date.now() >= programmaticScrollUntilRef.current &&
        !isTouchActiveRef.current &&
        !mouseDragRef.current.active
      ) {
        snapToNearestCenter();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchend', onTouchEndOrCancel, { passive: true });
    el.addEventListener('touchcancel', onTouchEndOrCancel, { passive: true });
    el.addEventListener('scrollend', onScrollEnd, { passive: true });
    return () => {
      clearSnapTimer();
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchend', onTouchEndOrCancel);
      el.removeEventListener('touchcancel', onTouchEndOrCancel);
      el.removeEventListener('scrollend', onScrollEnd);
    };
  }, [clearSnapTimer, scheduleSnapAfterIdle, snapToNearestCenter]);

  const edgePad =
    viewportWidth > 0
      ? Math.max(TRACK_PADDING_X, Math.floor(viewportWidth / 2 - ITEM_WIDTH / 2))
      : TRACK_PADDING_X;

  // Precompute horizontal layout with symmetric center padding so even first/last shots center cleanly
  const layout: StripLayout = useMemo(() => {
    const n = shots.length;
    const xPositions = new Array<number>(n);
    const hasSeparatorBefore = new Array<boolean>(n).fill(false);
    const burstKeys = new Array<string | null>(n).fill(null);
    const isSeriesStart = new Array<boolean>(n).fill(false);
    const isSeriesEnd = new Array<boolean>(n).fill(false);
    const seriesCounts = new Array<number>(n).fill(0);

    if (n === 0) {
      return {
        xPositions,
        hasSeparatorBefore,
        burstKeys,
        isSeriesStart,
        isSeriesEnd,
        seriesCounts,
        totalTrackWidth: 0,
      };
    }

    for (let i = 0; i < n; i++) {
      const s = shots[i];
      if (seriesEnabled) {
        const bg = burstGroupByShotId.get(s.id);
        burstKeys[i] = bg ? bg.id : null;
      }
    }

    let cursorX = edgePad;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const prevKey = burstKeys[i - 1];
        const currKey = burstKeys[i];
        const prevActive = activeComparisonIds.has(shots[i - 1].id);
        const currActive = activeComparisonIds.has(shots[i].id);

        if (currKey !== null && prevKey === currKey) {
          cursorX += IN_SERIES_GAP;
        } else if (currKey !== prevKey || prevActive !== currActive) {
          cursorX += SERIES_SEPARATOR_GAP;
          hasSeparatorBefore[i] = true;
        } else {
          cursorX += STANDALONE_GAP;
        }
      }
      xPositions[i] = cursorX;
      cursorX += ITEM_WIDTH;
    }

    let runStart = 0;
    while (runStart < n) {
      const key = burstKeys[runStart];
      let runEnd = runStart;
      while (runEnd + 1 < n && burstKeys[runEnd + 1] === key) {
        runEnd++;
      }
      if (key !== null) {
        const len = runEnd - runStart + 1;
        isSeriesStart[runStart] = true;
        isSeriesEnd[runEnd] = true;
        for (let k = runStart; k <= runEnd; k++) {
          seriesCounts[k] = len;
        }
      }
      runStart = runEnd + 1;
    }

    return {
      xPositions,
      hasSeparatorBefore,
      burstKeys,
      isSeriesStart,
      isSeriesEnd,
      seriesCounts,
      totalTrackWidth: cursorX + edgePad,
    };
  }, [shots, seriesEnabled, burstGroupByShotId, activeComparisonIds, edgePad]);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (
      !isEditingSeriesRef.current &&
      Date.now() >= programmaticScrollUntilRef.current
    ) {
      // Live-preview the center frame while scrolling without ever nudging scrollLeft
      const centerX = el.scrollLeft + el.clientWidth / 2;
      const nearestIdx = findNearestIndexToCenter(
        layoutRef.current.xPositions,
        centerX
      );
      if (nearestIdx !== -1) {
        const candidate = shotsRef.current[nearestIdx];
        if (candidate && candidate.id !== activeShotIdRef.current) {
          lastCenteredByScrollRef.current = candidate.id;
          scrollDrivenShotIdsRef.current.add(candidate.id);
          if (scrollDrivenShotIdsRef.current.size > 32) {
            scrollDrivenShotIdsRef.current.clear();
            scrollDrivenShotIdsRef.current.add(candidate.id);
          }
          onSelectShot(candidate.id);
        }
      }

      // Only schedule centering snap after thumb/mouse is released and scroll momentum settles
      if (!isTouchActiveRef.current && !mouseDragRef.current.active) {
        scheduleSnapAfterIdle(110);
      }
    }

    if (rafScrollRef.current !== null) return;
    rafScrollRef.current = window.requestAnimationFrame(() => {
      rafScrollRef.current = null;
      if (scrollRef.current) {
        setScrollLeft(scrollRef.current.scrollLeft);
      }
    });
  }, [onSelectShot, scheduleSnapAfterIdle]);

  useEffect(() => {
    return () => {
      if (rafScrollRef.current !== null) {
        window.cancelAnimationFrame(rafScrollRef.current);
      }
    };
  }, []);

  const totalWidth = Math.max(viewportWidth, layout.totalTrackWidth);

  const visibleRange = useMemo(() => {
    if (shots.length === 0) {
      return { startIndex: 0, endIndex: -1 };
    }
    const effectiveWidth = viewportWidth > 0 ? viewportWidth : 900;
    const first = findFirstVisibleIndex(layout.xPositions, scrollLeft);
    let last = first;
    const maxRight = scrollLeft + effectiveWidth;
    while (
      last + 1 < shots.length &&
      layout.xPositions[last + 1] <= maxRight
    ) {
      last++;
    }
    return {
      startIndex: Math.max(0, first - OVERSCAN),
      endIndex: Math.min(shots.length - 1, last + OVERSCAN),
    };
  }, [shots.length, layout.xPositions, scrollLeft, viewportWidth]);

  // Center activeShotId cleanly under the center reticle when changed externally or clicked
  // Never nudge scrollLeft while thumb/mouse is held down or when change came from live scrubbing
  useEffect(() => {
    if (!activeShotId || shots.length === 0 || viewportWidth <= 0) return;

    if (
      lastCenteredByScrollRef.current === activeShotId ||
      scrollDrivenShotIdsRef.current.has(activeShotId)
    ) {
      if (lastCenteredByScrollRef.current === activeShotId) {
        lastCenteredByScrollRef.current = null;
      }
      scrollDrivenShotIdsRef.current.delete(activeShotId);
      prevCenteredShotIdRef.current = activeShotId;
      return;
    }

    if (isTouchActiveRef.current || mouseDragRef.current.active) {
      prevCenteredShotIdRef.current = activeShotId;
      return;
    }

    const el = scrollRef.current;
    if (!el) return;

    const idx = shots.findIndex((s) => s.id === activeShotId);
    if (idx === -1) return;

    const itemCenter = (layout.xPositions[idx] ?? 0) + ITEM_WIDTH / 2;
    const targetLeft = Math.max(0, itemCenter - el.clientWidth / 2);

    const isInitialAlign = !hasAlignedInitialWidthRef.current;
    hasAlignedInitialWidthRef.current = true;
    const shotChanged = prevCenteredShotIdRef.current !== activeShotId;
    prevCenteredShotIdRef.current = activeShotId;

    if (Math.abs(el.scrollLeft - targetLeft) <= 2) return;

    const useSmooth = !isInitialAlign && shotChanged;
    programmaticScrollUntilRef.current = Date.now() + (useSmooth ? 420 : 220);
    el.scrollTo({
      left: targetLeft,
      behavior: useSmooth ? 'smooth' : 'auto',
    });
    if (!useSmooth) {
      setScrollLeft(targetLeft);
    }
  }, [activeShotId, shots, layout.xPositions, viewportWidth]);

  // Desktop mouse/pen click-and-drag horizontal scrubbing
  const handleTrackMousePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;

    clearSnapTimer();
    programmaticScrollUntilRef.current = 0;
    mouseDragRef.current = {
      active: true,
      pointerId: e.pointerId,
      startX: e.clientX,
      startScrollLeft: el.scrollLeft,
      didDrag: false,
    };
  };

  const handleTrackMousePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = mouseDragRef.current;
    if (!drag.active) return;
    const el = scrollRef.current;
    if (!el) return;

    const deltaX = e.clientX - drag.startX;
    if (!drag.didDrag && Math.abs(deltaX) > 5) {
      drag.didDrag = true;
      try {
        el.setPointerCapture(drag.pointerId);
      } catch {
        // Ignore capture failure
      }
    }
    if (drag.didDrag) {
      el.scrollLeft = drag.startScrollLeft - deltaX;
    }
  };

  const handleTrackMousePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = mouseDragRef.current;
    if (!drag.active) return;
    const wasDrag = drag.didDrag;
    drag.active = false;
    drag.didDrag = false;

    if (e.currentTarget.hasPointerCapture?.(drag.pointerId)) {
      try {
        e.currentTarget.releasePointerCapture(drag.pointerId);
      } catch {
        // Ignore release failure
      }
    }
    if (wasDrag) {
      suppressNextClickRef.current = true;
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 60);
      snapToNearestCenter();
    }
  };

  // Lazily resolve thumbnails ONLY for visible items + overscan
  useEffect(() => {
    if (shots.length === 0 || visibleRange.endIndex < visibleRange.startIndex) {
      return;
    }

    const controller = new AbortController();
    const fetchStart = Math.max(0, visibleRange.startIndex);
    const fetchEnd = Math.min(shots.length - 1, visibleRange.endIndex);

    const pending: { id: string; shot: PhotoShotItem; idx: number }[] = [];
    const syncHits: Record<string, string> = {};

    for (let i = fetchStart; i <= fetchEnd; i++) {
      const shot = shots[i];
      const file = shot.primary;
      if (
        filmstripThumbsRef.current[file.id] ||
        sharpMediaMap[file.id]?.url ||
        tempPreviewMap[file.id] ||
        failedThumbIdsRef.current.has(file.id)
      ) {
        continue;
      }
      const cached = getCachedFilmstripThumbnailUrl(file.id);
      if (cached) {
        syncHits[file.id] = cached;
        continue;
      }
      const fastDrive = getFilmstripThumbnailUrl(file.thumbnailLink);
      if (fastDrive && (!file.sourceKind || file.sourceKind === 'drive')) {
        syncHits[file.id] = fastDrive;
        continue;
      }
      pending.push({ id: file.id, shot, idx: i });
    }

    if (Object.keys(syncHits).length > 0) {
      setFilmstripThumbs((prev) => ({ ...prev, ...syncHits }));
    }

    if (pending.length === 0) return;

    const activeIdx = activeShotIdRef.current
      ? shots.findIndex((s) => s.id === activeShotIdRef.current)
      : -1;
    const focusIdx =
      activeIdx >= fetchStart && activeIdx <= fetchEnd
        ? activeIdx
        : Math.floor((fetchStart + fetchEnd) / 2);
    pending.sort(
      (a, b) => Math.abs(a.idx - focusIdx) - Math.abs(b.idx - focusIdx)
    );

    let cursor = 0;
    const batchUpdates: Record<string, string> = {};
    let flushTimer: number | null = null;

    const flush = () => {
      flushTimer = null;
      const keys = Object.keys(batchUpdates);
      if (keys.length === 0) return;
      const copy = { ...batchUpdates };
      for (const k of keys) delete batchUpdates[k];
      setFilmstripThumbs((prev) => {
        const next = { ...prev, ...copy };
        if (Object.keys(next).length > 360) {
          const keepIds = new Set<string>();
          const keepFrom = Math.max(0, fetchStart - 100);
          const keepTo = Math.min(shots.length - 1, fetchEnd + 100);
          for (let j = keepFrom; j <= keepTo; j++) {
            keepIds.add(shots[j].primary.id);
          }
          for (const existingId of Object.keys(next)) {
            if (!keepIds.has(existingId)) {
              delete next[existingId];
            }
          }
        }
        return next;
      });
    };

    const scheduleFlush = () => {
      if (flushTimer !== null) return;
      flushTimer = window.setTimeout(() => {
        if (!controller.signal.aborted) flush();
      }, 60);
    };

    const worker = async () => {
      while (!controller.signal.aborted && cursor < pending.length) {
        const item = pending[cursor++];
        const url = await resolveFilmstripThumbnailUrl(
          accessToken,
          item.shot.primary,
          controller.signal
        );
        if (controller.signal.aborted) return;
        if (url) {
          batchUpdates[item.id] = url;
          if (Object.keys(batchUpdates).length >= 6) {
            flush();
          } else {
            scheduleFlush();
          }
        } else {
          failedThumbIdsRef.current.add(item.id);
        }
      }
    };

    void Promise.all(
      Array.from(
        { length: Math.min(THUMB_CONCURRENCY, pending.length) },
        () => worker()
      )
    ).then(() => {
      if (!controller.signal.aborted) flush();
    });

    return () => {
      controller.abort();
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
      }
    };
  }, [
    shots,
    visibleRange.startIndex,
    visibleRange.endIndex,
    accessToken,
    sharpMediaMap,
    tempPreviewMap,
  ]);

  const visibleIndices = useMemo(() => {
    const arr: number[] = [];
    for (let i = visibleRange.startIndex; i <= visibleRange.endIndex; i++) {
      arr.push(i);
    }
    return arr;
  }, [visibleRange.startIndex, visibleRange.endIndex]);

  if (shots.length === 0) return null;

  const hasActiveSeries = activeComparisonIds.size > 0;
  const isFrameCull = appMode === 'framecull';

  return (
    <div
      aria-label="Chronologická lišta všech fotografií se středovým výběrem"
      className="shrink-0 w-full rounded-xl border border-zinc-800/90 bg-[#0D0D10]/95 overflow-hidden select-none"
    >
      {/* Compact Single-Row Strip Bar */}
      <div className="flex items-center justify-between gap-2 px-2.5 sm:px-3 py-1 sm:py-1.5 border-b border-zinc-800/80 bg-[#09090B]/85 text-[11px]">
        <div className="flex items-center gap-1.5 min-w-0 truncate text-zinc-400 tabular-nums">
          {hasActiveSeries ? (
            <>
              <span className="font-semibold text-amber-300 whitespace-nowrap">
                Série · {activeComparisonIds.size}{' '}
                <span className="hidden sm:inline">
                  {activeComparisonIds.size === 1
                    ? 'snímek'
                    : activeComparisonIds.size < 5
                      ? 'snímky'
                      : 'snímků'}
                </span>
              </span>
              {isEditingSeries && (
                <>
                  <span aria-hidden="true" className="hidden sm:inline">·</span>
                  <span className="hidden sm:inline text-zinc-300 truncate">
                    Klepnutím na vedlejší sérii ji připojíte celou · označené lze po jedné odebírat
                  </span>
                </>
              )}
            </>
          ) : (
            <>
              <span className="sm:hidden truncate">
                Lišta · {shots.length.toLocaleString('cs-CZ')}
              </span>
              <span className="hidden sm:inline truncate">
                Lišta složky · {shots.length.toLocaleString('cs-CZ')} snímků · posunem
                otvíráte fotky · po puštění se vycentruje
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          {onFindSeries &&
            (!hasActiveSeries ||
              (activeShotId && !activeComparisonIds.has(activeShotId))) && (
            <button
              type="button"
              onClick={onFindSeries}
              disabled={isFindingSeries}
              className="min-h-[28px] sm:min-h-[30px] inline-flex items-center gap-1 sm:gap-1.5 rounded-md border border-zinc-700/90 bg-[#141417] px-2 sm:px-2.5 py-0.5 text-[11px] font-medium text-amber-300 hover:border-amber-400/70 hover:bg-amber-500/10 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              <Sparkles className="w-3 h-3" aria-hidden="true" />
              <span>
                {isFindingSeries ? 'Hledám…' : 'Najít sérii'}
              </span>
            </button>
          )}

          {hasActiveSeries && (
            <>
              {!isEditingSeries && activeComparisonIds.size >= 2 && (
                <>
                  {onRejectEntireSeries && (
                    <button
                      type="button"
                      onClick={onRejectEntireSeries}
                      aria-label={
                        isFrameCull
                          ? `Smazat celou sérii aktuální fotky (${activeComparisonIds.size} snímků)`
                          : `Zahodit celou sérii aktuální fotky (${activeComparisonIds.size} snímků)`
                      }
                      title={
                        isFrameCull
                          ? `Smazat celou sérii aktuální fotky (${activeComparisonIds.size} snímků)`
                          : `Zahodit celou sérii aktuální fotky (${activeComparisonIds.size} snímků)`
                      }
                      className="min-h-[28px] sm:min-h-[30px] inline-flex items-center gap-1 rounded-md border border-rose-500/50 bg-rose-500/15 px-2 sm:px-2.5 py-0.5 text-[11px] font-medium text-rose-200 hover:bg-rose-500/28 hover:border-rose-400/75 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <Trash2
                        className="w-3.5 h-3.5 text-rose-300 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="hidden sm:inline">
                        {isFrameCull ? 'Smazat sérii' : 'Zahodit sérii'}
                      </span>
                    </button>
                  )}

                  {onKeepEntireSeries && (
                    <button
                      type="button"
                      onClick={onKeepEntireSeries}
                      aria-label={
                        isFrameCull
                          ? `Ponechat celou sérii aktuální fotky (${activeComparisonIds.size} snímků)`
                          : `Vybrat celou sérii aktuální fotky (${activeComparisonIds.size} snímků)`
                      }
                      title={
                        isFrameCull
                          ? `Ponechat celou sérii aktuální fotky (${activeComparisonIds.size} snímků)`
                          : `Vybrat celou sérii aktuální fotky (${activeComparisonIds.size} snímků)`
                      }
                      className="min-h-[28px] sm:min-h-[30px] inline-flex items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-500/15 px-2 sm:px-2.5 py-0.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/28 hover:border-emerald-400/75 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <CheckCheck
                        className="w-3.5 h-3.5 text-emerald-300 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="hidden sm:inline">
                        {isFrameCull ? 'Ponechat sérii' : 'Vybrat sérii'}
                      </span>
                    </button>
                  )}
                </>
              )}

              <button
                type="button"
                onClick={onToggleEditingSeries}
                className={`min-h-[28px] sm:min-h-[30px] inline-flex items-center gap-1 sm:gap-1.5 rounded-md border px-2 sm:px-2.5 py-0.5 text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  isEditingSeries
                    ? 'border-amber-400 bg-amber-500 text-zinc-950 font-semibold'
                    : 'border-zinc-700/90 bg-[#141417] text-zinc-200 hover:border-amber-400/70 hover:text-amber-200'
                }`}
              >
                <SlidersHorizontal className="w-3 h-3" aria-hidden="true" />
                <span>{isEditingSeries ? 'Hotovo' : 'Upravit'}</span>
              </button>

              {onOpenSeries && (
                <button
                  type="button"
                  onClick={onOpenSeries}
                  className="min-h-[28px] sm:min-h-[30px] inline-flex items-center gap-1 sm:gap-1.5 rounded-md border border-amber-400/70 bg-amber-500/15 px-2 sm:px-2.5 py-0.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-500 hover:text-zinc-950 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Layers className="w-3 h-3" aria-hidden="true" />
                  <span className="hidden sm:inline">Otevřít sérii</span>
                  <span className="sm:hidden">Série</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Horizontal Touch/Mouse/Wheel Scrubbing Track with Fixed Center Reticle */}
      <div className="relative h-[74px] sm:h-[96px] w-full overflow-hidden">
        {/* Fixed Samsung-style Center Frame Reticle */}
        {!isEditingSeries && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center justify-center"
          >
            <span className="h-1 sm:h-1.5 w-3 rounded-b bg-amber-400 shadow" />
            <div className="my-auto h-[58px] sm:h-[78px] w-[62px] sm:w-[72px] rounded-xl border-2 border-white/95 shadow-[0_0_18px_rgba(0,0,0,0.65)]" />
            <span className="h-1 sm:h-1.5 w-3 rounded-t bg-amber-400 shadow" />
          </div>
        )}

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          onPointerDown={handleTrackMousePointerDown}
          onPointerMove={handleTrackMousePointerMove}
          onPointerUp={handleTrackMousePointerEnd}
          onPointerCancel={handleTrackMousePointerEnd}
          className="relative h-full w-full overflow-x-auto overflow-y-hidden touch-pan-x overscroll-x-contain scrollbar-thin cursor-grab active:cursor-grabbing"
        >
          <div
            className="relative h-full"
            style={{ width: `${totalWidth}px` }}
          >
            {visibleIndices.map((idx) => {
              const shot = shots[idx];
              const isActive = shot.id === activeShotId;
              const rating: SelectionRating =
                ratingsByShotId[shot.id] || 'unrated';
              const burstKey = layout.burstKeys[idx];
              const isPartOfAnySeries = burstKey !== null;
              const isInActiveGroup = activeComparisonIds.has(shot.id);
              const isProminentActive = isInActiveGroup && hasActiveSeries;

              const prevSameActive =
                idx > 0 && activeComparisonIds.has(shots[idx - 1].id);
              const nextSameActive =
                idx < shots.length - 1 &&
                activeComparisonIds.has(shots[idx + 1].id);

              const prevSameSeries =
                isPartOfAnySeries &&
                idx > 0 &&
                layout.burstKeys[idx - 1] === burstKey;
              const nextSameSeries =
                isPartOfAnySeries &&
                idx < shots.length - 1 &&
                layout.burstKeys[idx + 1] === burstKey;

              const x = layout.xPositions[idx];
              const showSeparator = layout.hasSeparatorBefore[idx];
              const seriesCount = layout.seriesCounts[idx];
              const isStartOfSeries = layout.isSeriesStart[idx];

              const fileId = shot.primary.id;
              const thumbUrl =
                filmstripThumbs[fileId] ||
                getCachedFilmstripThumbnailUrl(fileId) ||
                getFilmstripThumbnailUrl(shot.primary.thumbnailLink) ||
                tempPreviewMap[fileId] ||
                sharpMediaMap[fileId]?.url ||
                null;

              return (
                <React.Fragment key={shot.id}>
                  {/* Explicit Series Divider Line in the Separation Gap */}
                  {showSeparator && (
                    <div
                      aria-hidden="true"
                      style={{
                        transform: `translate3d(${x - Math.round(SERIES_SEPARATOR_GAP / 2)}px, 0, 0)`,
                      }}
                      className="pointer-events-none absolute top-3 bottom-3 left-0 w-px bg-zinc-700/75"
                    />
                  )}

                  <div
                    style={{
                      width: `${ITEM_WIDTH}px`,
                      transform: `translate3d(${x}px, 0, 0)`,
                    }}
                    className="group absolute top-1 bottom-1 left-0 flex items-center justify-center"
                  >
                    {/* Prominent Active Series Framing vs Subtle Inactive Series Grouping */}
                    {isProminentActive ? (
                      <div
                        aria-hidden="true"
                        className={`pointer-events-none absolute inset-y-0 bg-amber-500/18 border-y-2 border-amber-400 shadow-[0_0_16px_rgba(245,158,11,0.18)] ${
                          prevSameActive
                            ? '-left-[3px]'
                            : 'left-0 rounded-l-lg border-l-2'
                        } ${
                          nextSameActive
                            ? '-right-[3px]'
                            : 'right-0 rounded-r-lg border-r-2'
                        }`}
                      />
                    ) : isPartOfAnySeries ? (
                      <div
                        aria-hidden="true"
                        className={`pointer-events-none absolute inset-y-0.5 bg-zinc-800/45 border-y border-zinc-700/80 ${
                          prevSameSeries
                            ? '-left-[3px]'
                            : 'left-0 rounded-l-lg border-l'
                        } ${
                          nextSameSeries
                            ? '-right-[3px]'
                            : 'right-0 rounded-r-lg border-r'
                        }`}
                      />
                    ) : null}

                    {/* Quiet Top Series Count Label on First Shot of a Series */}
                    {(isStartOfSeries || (isProminentActive && !prevSameActive)) && (
                      <span
                        aria-hidden="true"
                        className={`pointer-events-none absolute -top-0.5 left-1.5 z-20 px-1 rounded text-[9px] font-mono leading-tight tabular-nums ${
                          isProminentActive
                            ? 'bg-amber-400 text-zinc-950 font-bold'
                            : 'bg-zinc-800 text-zinc-300'
                        }`}
                      >
                        {isProminentActive
                          ? `★ ${activeComparisonIds.size}`
                          : `${seriesCount}×`}
                      </span>
                    )}

                    {/* Thumbnail Frame Button */}
                    <button
                      type="button"
                      onClick={() => {
                        if (suppressNextClickRef.current) return;
                        if (isEditingSeries) {
                          onToggleShotInSeries(shot.id);
                        } else {
                          lastCenteredByScrollRef.current = null;
                          scrollDrivenShotIdsRef.current.delete(shot.id);
                          onSelectShot(shot.id);
                        }
                      }}
                      aria-label={
                        isEditingSeries
                          ? `${isInActiveGroup ? 'Odebrat ze série' : 'Zařadit do série'}: ${shot.primary.name}`
                          : `Zobrazit snímek ${shot.primary.name}${
                              rating === 'pick'
                                ? appMode === 'framecull'
                                  ? ' (ponecháno)'
                                  : ' (vybráno)'
                                : rating === 'reject'
                                  ? appMode === 'framecull'
                                    ? ' (ke smazání)'
                                    : ' (zahozeno)'
                                  : ''
                            }`
                      }
                      aria-current={!isEditingSeries && isActive ? 'true' : undefined}
                      aria-pressed={isEditingSeries ? isInActiveGroup : undefined}
                      className={`relative z-10 h-[54px] sm:h-[72px] w-[58px] sm:w-[66px] overflow-hidden rounded-lg transition-transform duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-400 ${
                        isEditingSeries
                          ? isInActiveGroup
                            ? 'border-2 border-amber-400 bg-zinc-900 opacity-100 shadow-[0_0_12px_rgba(245,158,11,0.28)]'
                            : 'border border-zinc-700 bg-zinc-900 opacity-50 hover:opacity-90'
                          : isActive
                            ? 'scale-[1.03] bg-zinc-900'
                            : rating === 'pick'
                              ? appMode === 'framecull'
                                ? 'border-2 border-emerald-400/80 bg-zinc-900 opacity-90 hover:opacity-100'
                                : 'border-2 border-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.28)] bg-zinc-900 opacity-85 hover:opacity-100'
                              : rating === 'reject' && appMode === 'framecull'
                                ? 'border-2 border-rose-500/80 bg-zinc-900 opacity-80 hover:opacity-100'
                                : isProminentActive
                                  ? 'border border-amber-400/70 bg-zinc-900 opacity-90 hover:opacity-100'
                                  : 'border border-zinc-800 hover:border-zinc-500 bg-zinc-900 opacity-75 hover:opacity-100'
                      }`}
                    >
                      {thumbUrl ? (
                        <img
                          src={thumbUrl}
                          alt={shot.primary.name}
                          referrerPolicy="no-referrer"
                          draggable={false}
                          onError={() => {
                            setFilmstripThumbs((prev) => {
                              if (!prev[fileId]) return prev;
                              const next = { ...prev };
                              delete next[fileId];
                              return next;
                            });
                          }}
                          className={`h-full w-full object-cover transition-opacity pointer-events-none ${
                            rating === 'reject'
                              ? appMode === 'framecull'
                                ? 'opacity-50'
                                : 'opacity-30 grayscale'
                              : 'opacity-100'
                          }`}
                        />
                      ) : (
                        <div
                          className={`h-full w-full flex flex-col items-center justify-center gap-0.5 text-zinc-600 pointer-events-none ${
                            rating === 'reject' ? 'opacity-35' : ''
                          }`}
                        >
                          <ImageIcon className="w-3.5 h-3.5" aria-hidden="true" />
                          <span className="font-mono text-[9px] uppercase">
                            {shot.primary.fileExtension}
                          </span>
                        </div>
                      )}

                      {/* Pick / Keep Marker */}
                      {rating === 'pick' && (
                        <span
                          aria-hidden="true"
                          className={`pointer-events-none absolute bottom-1 left-1 flex h-4 w-4 items-center justify-center rounded shadow ${
                            appMode === 'framecull'
                              ? 'bg-emerald-500 text-zinc-950'
                              : 'bg-amber-400 text-zinc-950'
                          }`}
                        >
                          {appMode === 'framecull' ? (
                            <Check className="w-2.5 h-2.5 stroke-[3]" />
                          ) : (
                            <Star className="w-2.5 h-2.5 fill-zinc-950" />
                          )}
                        </span>
                      )}

                      {/* Reject / Trash Overlay */}
                      {rating === 'reject' &&
                        (appMode === 'framecull' ? (
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute bottom-1 left-1 flex h-4 w-4 items-center justify-center rounded bg-rose-500 text-white shadow"
                          >
                            <Trash2 className="w-2.5 h-2.5" />
                          </span>
                        ) : (
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35 text-zinc-400"
                          >
                            <X className="w-4 h-4 opacity-80" />
                          </span>
                        ))}

                      {/* Series Membership Checkmark Only During Edit Mode */}
                      {isEditingSeries && isInActiveGroup && (
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 text-zinc-950 shadow"
                        >
                          <Check className="w-3 h-3 stroke-[3]" />
                        </span>
                      )}
                    </button>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

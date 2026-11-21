import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Check,
  Image as ImageIcon,
  Layers,
  Lock,
  SkipForward,
  SlidersHorizontal,
  Star,
  Trash2,
} from 'lucide-react';
import { PhotoBurstGroup, PhotoShotItem } from '../lib/burstGrouping';
import {
  DeleteModeState,
  SelectModeState,
  WorkflowMode,
} from '../lib/cullPersistence';
import {
  ResolvedPhotoMedia,
  getCachedFilmstripThumbnailUrl,
  getFilmstripThumbnailUrl,
  invalidateThumbnailCache,
  resolveFilmstripThumbnailUrl,
} from '../lib/rawParser';
import {
  beginActiveGesture,
  markInteractionActive,
} from '../lib/interactionGate';

interface FilmstripProps {
  workflowMode: WorkflowMode;
  folderId?: string;
  shots: PhotoShotItem[];
  activeShotId: string | null;
  selectStateByShotId: Record<string, SelectModeState>;
  deleteStateByShotId: Record<string, DeleteModeState>;
  autoDimmedShotIds: Set<string>;
  burstGroupByShotId: Map<string, PhotoBurstGroup>;
  seriesEnabled: boolean;
  activeComparisonIds: Set<string>;
  isEditingSeries: boolean;
  isFolderFullyCulled?: boolean;
  resumeLeftContextCount?: number;
  accessToken?: string | null;
  tempPreviewMap: Record<string, string>;
  sharpMediaMap: Record<string, ResolvedPhotoMedia>;
  microThumbsMap?: Record<string, string>;
  singlePhotoSeriesCount?: number;
  onRevealSinglePhotoSeries?: () => void;
  onSelectShot: (shotId: string) => void;
  onActivateCurrentShot?: (shotId: string) => void;
  onToggleShotInSeries: (shotId: string) => void;
  onToggleEditingSeries: () => void;
  onOpenSeries?: () => void;
  onSkipEntireSeries?: () => void;
  onRejectEntireSeries?: () => void;
}

const IN_SERIES_GAP = 2;
const OUTSIDE_SERIES_GAP = 12;
const TRACK_PADDING_X = 14;
const OVERSCAN = 8;
const DEFAULT_LEFT_CONTEXT = 8;
const THUMB_CONCURRENCY = 4;

interface StripLayout {
  xPositions: number[];
  hasSeparatorBefore: boolean[];
  burstKeys: (string | null)[];
  isSeriesStart: boolean[];
  isSeriesEnd: boolean[];
  seriesCounts: number[];
  isManualSeries: boolean[];
  totalTrackWidth: number;
}

function findFirstVisibleIndex(
  xPositions: number[],
  itemWidth: number,
  targetX: number
): number {
  let lo = 0;
  let hi = xPositions.length - 1;
  let ans = xPositions.length;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (xPositions[mid] + itemWidth >= targetX) {
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
  itemWidth: number,
  centerX: number
): number {
  const n = xPositions.length;
  if (n === 0) return -1;
  if (n === 1) return 0;

  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const itemCenter = xPositions[mid] + itemWidth / 2;
    if (itemCenter < centerX) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  if (lo > 0) {
    const distCurr = Math.abs(xPositions[lo] + itemWidth / 2 - centerX);
    const distPrev = Math.abs(xPositions[lo - 1] + itemWidth / 2 - centerX);
    if (distPrev <= distCurr) return lo - 1;
  }
  return lo;
}

const FilmstripInner: React.FC<FilmstripProps> = ({
  workflowMode,
  folderId,
  shots,
  activeShotId,
  selectStateByShotId,
  deleteStateByShotId,
  autoDimmedShotIds,
  burstGroupByShotId,
  seriesEnabled,
  activeComparisonIds,
  isEditingSeries,
  isFolderFullyCulled = false,
  resumeLeftContextCount = DEFAULT_LEFT_CONTEXT,
  accessToken,
  tempPreviewMap,
  sharpMediaMap,
  microThumbsMap,
  singlePhotoSeriesCount = 0,
  onRevealSinglePhotoSeries,
  onSelectShot,
  onActivateCurrentShot,
  onToggleShotInSeries,
  onToggleEditingSeries,
  onOpenSeries,
  onSkipEntireSeries,
  onRejectEntireSeries,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [isSmUp, setIsSmUp] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 640 : false
  );
  const itemWidth = isSmUp ? 66 : 58;
  const itemWidthRef = useRef(itemWidth);
  itemWidthRef.current = itemWidth;

  const [scrollLeft, setScrollLeft] = useState(0);
  const [filmstripThumbs, setFilmstripThumbs] = useState<
    Record<string, string>
  >({});
  const filmstripThumbsRef = useRef(filmstripThumbs);
  filmstripThumbsRef.current = filmstripThumbs;
  const failedRetryRef = useRef<
    Map<string, { attempts: number; retryAt: number }>
  >(new Map());
  const [thumbRetryTick, setThumbRetryTick] = useState(0);
  const retryTimerRef = useRef<number | null>(null);

  const activeShotIdRef = useRef(activeShotId);
  activeShotIdRef.current = activeShotId;
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  const isEditingSeriesRef = useRef(isEditingSeries);
  isEditingSeriesRef.current = isEditingSeries;
  const sharpMediaMapRef = useRef(sharpMediaMap);
  sharpMediaMapRef.current = sharpMediaMap;
  const tempPreviewMapRef = useRef(tempPreviewMap);
  tempPreviewMapRef.current = tempPreviewMap;
  const microThumbsMapRef = useRef(microThumbsMap);
  microThumbsMapRef.current = microThumbsMap;

  // Deterministic scroll/snap state machine eliminates competing smooth scrolls & skipped frames
  const scrollPhaseRef = useRef<
    'idle' | 'touching' | 'momentum' | 'snapping' | 'programmatic'
  >('idle');
  const gestureReleaseRef = useRef<(() => void) | null>(null);
  const programmaticScrollUntilRef = useRef(0);
  const programmaticTargetShotIdRef = useRef<string | null>(null);
  const programmaticVerifyTimerRef = useRef<number | null>(null);
  const lastUserScrollShotRef = useRef<{ id: string; at: number } | null>(null);
  const prevCenteredShotIdRef = useRef<string | null>(null);
  const hasAlignedInitialWidthRef = useRef(false);
  const rafScrollRef = useRef<number | null>(null);
  const isTouchActiveRef = useRef(false);
  const snapTimerRef = useRef<number | null>(null);
  const settleRafRef = useRef<number | null>(null);
  const verifySnapTimerRef = useRef<number | null>(null);
  const scrollVelocitySampleRef = useRef<{ x: number; t: number }>({
    x: 0,
    t: 0,
  });

  // Freeze background series-gap reflows while the user is actively scrubbing or decelerating
  const [settledBurstGroups, setSettledBurstGroups] = useState(
    () => burstGroupByShotId
  );
  const pendingBurstGroupsRef = useRef<Map<string, PhotoBurstGroup> | null>(
    null
  );

  const flushPendingBurstGroups = useCallback(() => {
    if (
      pendingBurstGroupsRef.current &&
      scrollPhaseRef.current === 'idle' &&
      !isTouchActiveRef.current
    ) {
      const latest = pendingBurstGroupsRef.current;
      pendingBurstGroupsRef.current = null;
      setSettledBurstGroups(latest);
    }
  }, []);

  useEffect(() => {
    if (
      isTouchActiveRef.current ||
      scrollPhaseRef.current === 'touching' ||
      scrollPhaseRef.current === 'momentum' ||
      scrollPhaseRef.current === 'snapping'
    ) {
      pendingBurstGroupsRef.current = burstGroupByShotId;
      return;
    }
    pendingBurstGroupsRef.current = null;
    setSettledBurstGroups(burstGroupByShotId);
  }, [burstGroupByShotId]);

  useEffect(() => {
    if (shots.length === 0) {
      setFilmstripThumbs({});
      failedRetryRef.current.clear();
    }
  }, [shots.length]);

  useEffect(() => {
    return () => {
      gestureReleaseRef.current?.();
      gestureReleaseRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }
      if (programmaticVerifyTimerRef.current !== null) {
        window.clearTimeout(programmaticVerifyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const onWindowResize = () => {
      setIsSmUp(window.innerWidth >= 640);
    };
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const updateWidth = () => {
      setViewportWidth(el.clientWidth);
      if (typeof window !== 'undefined') {
        setIsSmUp(window.innerWidth >= 640);
      }
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
    if (settleRafRef.current !== null) {
      window.cancelAnimationFrame(settleRafRef.current);
      settleRafRef.current = null;
    }
    if (verifySnapTimerRef.current !== null) {
      window.clearTimeout(verifySnapTimerRef.current);
      verifySnapTimerRef.current = null;
    }
  }, []);

  const clearProgrammaticLock = useCallback(() => {
    programmaticTargetShotIdRef.current = null;
    programmaticScrollUntilRef.current = 0;
    if (programmaticVerifyTimerRef.current !== null) {
      window.clearTimeout(programmaticVerifyTimerRef.current);
      programmaticVerifyTimerRef.current = null;
    }
  }, []);

  const snapToNearestCenter = useCallback(() => {
    clearSnapTimer();
    const el = scrollRef.current;
    if (
      !el ||
      isEditingSeriesRef.current ||
      isTouchActiveRef.current ||
      scrollPhaseRef.current === 'touching' ||
      scrollPhaseRef.current === 'programmatic' ||
      programmaticTargetShotIdRef.current !== null ||
      shotsRef.current.length === 0
    ) {
      return;
    }

    const xPositions = layoutRef.current.xPositions;
    if (xPositions.length === 0) return;

    const w = itemWidthRef.current;
    const centerX = el.scrollLeft + el.clientWidth / 2;
    const nearestIdx = findNearestIndexToCenter(xPositions, w, centerX);
    if (nearestIdx === -1) return;

    const candidate = shotsRef.current[nearestIdx];
    if (candidate && candidate.id !== activeShotIdRef.current) {
      lastUserScrollShotRef.current = { id: candidate.id, at: Date.now() };
      onSelectShot(candidate.id);
    }

    const itemCenter = xPositions[nearestIdx] + w / 2;
    const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
    const targetLeft = Math.max(
      0,
      Math.min(maxScroll, itemCenter - el.clientWidth / 2)
    );
    if (Math.abs(el.scrollLeft - targetLeft) > 1.5) {
      scrollPhaseRef.current = 'snapping';
      programmaticScrollUntilRef.current = Date.now() + 340;
      el.scrollTo({
        left: targetLeft,
        behavior: 'smooth',
      });
      // Guarantee clean alignment on mobile WebViews after smooth snap finishes
      verifySnapTimerRef.current = window.setTimeout(() => {
        verifySnapTimerRef.current = null;
        if (
          !scrollRef.current ||
          isTouchActiveRef.current ||
          isEditingSeriesRef.current ||
          scrollPhaseRef.current !== 'snapping'
        ) {
          return;
        }
        const currEl = scrollRef.current;
        if (Math.abs(currEl.scrollLeft - targetLeft) > 1.5) {
          programmaticScrollUntilRef.current = Date.now() + 80;
          currEl.scrollLeft = targetLeft;
          setScrollLeft(targetLeft);
        }
        scrollPhaseRef.current = 'idle';
        flushPendingBurstGroups();
      }, 340);
    } else {
      scrollPhaseRef.current = 'idle';
      flushPendingBurstGroups();
    }
  }, [clearSnapTimer, onSelectShot, flushPendingBurstGroups]);

  const startMomentumSettleMonitor = useCallback(() => {
    clearSnapTimer();
    const el = scrollRef.current;
    if (!el) return;
    scrollPhaseRef.current = 'momentum';
    let lastLeft = el.scrollLeft;
    let stillFrames = 0;
    const startedAt = Date.now();

    const step = () => {
      settleRafRef.current = null;
      const currEl = scrollRef.current;
      if (
        !currEl ||
        isTouchActiveRef.current ||
        scrollPhaseRef.current !== 'momentum'
      ) {
        return;
      }
      const currLeft = currEl.scrollLeft;
      const delta = Math.abs(currLeft - lastLeft);
      lastLeft = currLeft;

      if (delta <= 0.45) {
        stillFrames += 1;
      } else {
        stillFrames = 0;
      }

      if (stillFrames >= 3 || Date.now() - startedAt > 950) {
        snapToNearestCenter();
        return;
      }

      settleRafRef.current = window.requestAnimationFrame(step);
    };

    settleRafRef.current = window.requestAnimationFrame(step);
  }, [clearSnapTimer, snapToNearestCenter]);

  const scheduleSnapAfterIdle = useCallback(
    (delayMs = 115) => {
      clearSnapTimer();
      snapTimerRef.current = window.setTimeout(() => {
        snapTimerRef.current = null;
        if (scrollPhaseRef.current === 'momentum') {
          startMomentumSettleMonitor();
        }
      }, delayMs);
    },
    [clearSnapTimer, startMomentumSettleMonitor]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onTouchStart = () => {
      isTouchActiveRef.current = true;
      scrollPhaseRef.current = 'touching';
      if (!gestureReleaseRef.current) {
        gestureReleaseRef.current = beginActiveGesture(15_000, 620);
      } else {
        markInteractionActive(550);
      }
      clearProgrammaticLock();
      clearSnapTimer();
    };
    const onTouchEndOrCancel = (e: TouchEvent) => {
      if (e.touches.length > 0) return;
      isTouchActiveRef.current = false;
      gestureReleaseRef.current?.();
      gestureReleaseRef.current = null;
      startMomentumSettleMonitor();
    };
    const onScrollEnd = () => {
      if (
        scrollPhaseRef.current === 'momentum' &&
        !isTouchActiveRef.current
      ) {
        snapToNearestCenter();
      } else if (scrollPhaseRef.current === 'snapping') {
        clearSnapTimer();
        scrollPhaseRef.current = 'idle';
        flushPendingBurstGroups();
      }
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchend', onTouchEndOrCancel, { passive: true });
    el.addEventListener('touchcancel', onTouchEndOrCancel, { passive: true });
    el.addEventListener('scrollend', onScrollEnd, { passive: true });
    return () => {
      clearSnapTimer();
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchend', onTouchEndOrCancel);
      el.removeEventListener('touchcancel', onTouchEndOrCancel);
      el.removeEventListener('scrollend', onScrollEnd);
    };
  }, [
    clearProgrammaticLock,
    clearSnapTimer,
    startMomentumSettleMonitor,
    snapToNearestCenter,
    flushPendingBurstGroups,
  ]);

  const edgePad =
    viewportWidth > 0
      ? Math.max(TRACK_PADDING_X, Math.floor(viewportWidth / 2 - itemWidth / 2))
      : TRACK_PADDING_X;

  // Precompute horizontal layout: 2px inside a series, 12px outside a series or between two series
  const layout: StripLayout = useMemo(() => {
    const n = shots.length;
    const xPositions = new Array<number>(n);
    const hasSeparatorBefore = new Array<boolean>(n).fill(false);
    const burstKeys = new Array<string | null>(n).fill(null);
    const isSeriesStart = new Array<boolean>(n).fill(false);
    const isSeriesEnd = new Array<boolean>(n).fill(false);
    const seriesCounts = new Array<number>(n).fill(0);
    const isManualSeries = new Array<boolean>(n).fill(false);

    if (n === 0) {
      return {
        xPositions,
        hasSeparatorBefore,
        burstKeys,
        isSeriesStart,
        isSeriesEnd,
        seriesCounts,
        isManualSeries,
        totalTrackWidth: 0,
      };
    }

    for (let i = 0; i < n; i++) {
      const s = shots[i];
      const bg = settledBurstGroups.get(s.id);
      if (bg && seriesEnabled) {
        burstKeys[i] = bg.id;
        isManualSeries[i] = Boolean(bg.isManual);
      }
    }

    let cursorX = edgePad;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const prevKey = burstKeys[i - 1];
        const currKey = burstKeys[i];
        const prevActive = activeComparisonIds.has(shots[i - 1].id);
        const currActive = activeComparisonIds.has(shots[i].id);

        const sameActiveSeries =
          activeComparisonIds.size >= 2 && prevActive && currActive;
        const sameDetectedSeries = currKey !== null && prevKey === currKey;

        if (sameActiveSeries || sameDetectedSeries) {
          cursorX += IN_SERIES_GAP;
        } else {
          cursorX += OUTSIDE_SERIES_GAP;
          if (currKey !== prevKey || prevActive !== currActive) {
            hasSeparatorBefore[i] = true;
          }
        }
      }
      xPositions[i] = cursorX;
      cursorX += itemWidth;
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
      isManualSeries,
      totalTrackWidth: cursorX + edgePad,
    };
  }, [
    shots,
    seriesEnabled,
    settledBurstGroups,
    activeComparisonIds,
    edgePad,
    itemWidth,
  ]);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    markInteractionActive(520);

    const now = performance.now();
    const prevSample = scrollVelocitySampleRef.current;
    const dt = Math.max(1, now - prevSample.t);
    const dx = Math.abs(el.scrollLeft - prevSample.x);
    const velocityPxPerMs = dt < 140 ? dx / dt : 0;
    scrollVelocitySampleRef.current = { x: el.scrollLeft, t: now };

    const phase = scrollPhaseRef.current;
    const isProgrammaticOrSnapping =
      phase === 'snapping' ||
      phase === 'programmatic' ||
      programmaticTargetShotIdRef.current !== null ||
      Date.now() < programmaticScrollUntilRef.current;

    if (!isEditingSeriesRef.current && !isProgrammaticOrSnapping) {
      if (phase === 'idle' && !isTouchActiveRef.current) {
        scrollPhaseRef.current = 'momentum';
      }

      // Skip intermediate commits only on extreme high-velocity flicks (> 2.1 px/ms);
      // snapToNearestCenter commits the exact resting frame smoothly on settle.
      if (velocityPxPerMs <= 2.1) {
        const centerX = el.scrollLeft + el.clientWidth / 2;
        const nearestIdx = findNearestIndexToCenter(
          layoutRef.current.xPositions,
          itemWidthRef.current,
          centerX
        );
        if (nearestIdx !== -1) {
          const candidate = shotsRef.current[nearestIdx];
          if (candidate && candidate.id !== activeShotIdRef.current) {
            lastUserScrollShotRef.current = {
              id: candidate.id,
              at: Date.now(),
            };
            onSelectShot(candidate.id);
          }
        }
      }

      // For mouse-wheel / non-touch scrolling, schedule settle monitor cleanly
      if (!isTouchActiveRef.current && settleRafRef.current === null) {
        scheduleSnapAfterIdle(115);
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

  const activeShotIdx = useMemo(
    () => (activeShotId ? shots.findIndex((s) => s.id === activeShotId) : -1),
    [shots, activeShotId]
  );

  const visibleRange = useMemo(() => {
    if (shots.length === 0) {
      return { startIndex: 0, endIndex: -1 };
    }
    const effectiveWidth = viewportWidth > 0 ? viewportWidth : 900;
    const first = findFirstVisibleIndex(
      layout.xPositions,
      itemWidth,
      scrollLeft
    );
    let last = first;
    const maxRight = scrollLeft + effectiveWidth;
    while (
      last + 1 < shots.length &&
      layout.xPositions[last + 1] <= maxRight
    ) {
      last++;
    }
    let startIndex = Math.max(0, first - OVERSCAN);
    let endIndex = Math.min(shots.length - 1, last + OVERSCAN);
    // Guarantee at least resumeLeftContextCount (8) thumbnails to the left of activeShot are hydrated immediately
    if (activeShotIdx >= 0) {
      startIndex = Math.min(
        startIndex,
        Math.max(0, activeShotIdx - resumeLeftContextCount)
      );
      endIndex = Math.max(
        endIndex,
        Math.min(shots.length - 1, activeShotIdx + OVERSCAN)
      );
    }
    return {
      startIndex,
      endIndex,
    };
  }, [
    shots.length,
    layout.xPositions,
    itemWidth,
    scrollLeft,
    viewportWidth,
    activeShotIdx,
    resumeLeftContextCount,
  ]);

  useEffect(() => {
    if (!activeShotId || shots.length === 0 || viewportWidth <= 0) return;

    // NEVER fight active touch, momentum, or snap settling (eliminates skipping a photo on lag spikes!)
    if (
      isTouchActiveRef.current ||
      scrollPhaseRef.current === 'touching' ||
      scrollPhaseRef.current === 'momentum' ||
      scrollPhaseRef.current === 'snapping'
    ) {
      prevCenteredShotIdRef.current = activeShotId;
      return;
    }

    const userDriven = Boolean(
      lastUserScrollShotRef.current &&
        lastUserScrollShotRef.current.id === activeShotId &&
        Date.now() - lastUserScrollShotRef.current.at < 1200
    );
    if (userDriven) {
      lastUserScrollShotRef.current = null;
      prevCenteredShotIdRef.current = activeShotId;
      return;
    }

    const el = scrollRef.current;
    if (!el) return;

    const idx = shots.findIndex((s) => s.id === activeShotId);
    if (idx === -1) return;

    clearSnapTimer();
    if (programmaticVerifyTimerRef.current !== null) {
      window.clearTimeout(programmaticVerifyTimerRef.current);
      programmaticVerifyTimerRef.current = null;
    }

    const itemCenter = (layout.xPositions[idx] ?? 0) + itemWidth / 2;
    const maxScroll = Math.max(0, totalWidth - el.clientWidth);
    const targetLeft = Math.max(
      0,
      Math.min(maxScroll, itemCenter - el.clientWidth / 2)
    );

    const isInitialAlign = !hasAlignedInitialWidthRef.current;
    hasAlignedInitialWidthRef.current = true;
    const shotChanged = prevCenteredShotIdRef.current !== activeShotId;
    prevCenteredShotIdRef.current = activeShotId;

    const dist = Math.abs(el.scrollLeft - targetLeft);
    if (dist <= 1.5) {
      programmaticTargetShotIdRef.current = null;
      scrollPhaseRef.current = 'idle';
      return;
    }

    // Use instant 'auto' jump on initial mount, gap reflows on the same shot, or multi-shot series skips (>5 items)
    // so the center reticle NEVER lags behind or snaps back to an old scroll position!
    const useSmooth = !isInitialAlign && shotChanged && dist <= itemWidth * 5;
    if (useSmooth) {
      scrollPhaseRef.current = 'programmatic';
      programmaticTargetShotIdRef.current = activeShotId;
      programmaticScrollUntilRef.current = Date.now() + 480;
      el.scrollTo({
        left: targetLeft,
        behavior: 'smooth',
      });
      programmaticVerifyTimerRef.current = window.setTimeout(() => {
        programmaticVerifyTimerRef.current = null;
        if (programmaticTargetShotIdRef.current === activeShotId) {
          programmaticTargetShotIdRef.current = null;
        }
        if (scrollPhaseRef.current === 'programmatic') {
          scrollPhaseRef.current = 'idle';
        }
        const currEl = scrollRef.current;
        if (
          !currEl ||
          isTouchActiveRef.current ||
          isEditingSeriesRef.current ||
          activeShotIdRef.current !== activeShotId
        ) {
          return;
        }
        if (Math.abs(currEl.scrollLeft - targetLeft) > 1.5) {
          programmaticScrollUntilRef.current = Date.now() + 80;
          currEl.scrollLeft = targetLeft;
          setScrollLeft(targetLeft);
        }
        flushPendingBurstGroups();
      }, 480);
    } else {
      programmaticTargetShotIdRef.current = null;
      programmaticScrollUntilRef.current = Date.now() + 140;
      scrollPhaseRef.current = 'idle';
      el.scrollLeft = targetLeft;
      setScrollLeft(targetLeft);
    }
  }, [
    activeShotId,
    shots,
    layout.xPositions,
    itemWidth,
    viewportWidth,
    totalWidth,
    clearSnapTimer,
    flushPendingBurstGroups,
  ]);

  useEffect(() => {
    if (shots.length === 0 || visibleRange.endIndex < visibleRange.startIndex) {
      return;
    }

    const controller = new AbortController();
    const fetchStart = Math.max(0, visibleRange.startIndex);
    const fetchEnd = Math.min(shots.length - 1, visibleRange.endIndex);
    const now = Date.now();

    const pending: { id: string; shot: PhotoShotItem; idx: number }[] = [];
    const syncHits: Record<string, string> = {};

    for (let i = fetchStart; i <= fetchEnd; i++) {
      const shot = shots[i];
      const file = shot.primary;
      const failInfo = failedRetryRef.current.get(file.id);
      if (
        filmstripThumbsRef.current[file.id] ||
        sharpMediaMapRef.current[file.id]?.url ||
        tempPreviewMapRef.current[file.id] ||
        (failInfo && (failInfo.attempts >= 3 || now < failInfo.retryAt))
      ) {
        continue;
      }
      const cached = getCachedFilmstripThumbnailUrl(file.id);
      if (cached) {
        syncHits[file.id] = cached;
        continue;
      }
      const cachedMicro = microThumbsMapRef.current?.[file.id];
      if (cachedMicro && isFolderFullyCulled) {
        syncHits[file.id] = cachedMicro;
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
    pending.sort((a, b) => {
      // Prioritize active item and up to 8 items to the left alongside near-right frames
      const aIsLeftContext =
        activeIdx >= 0 &&
        a.idx >= activeIdx - resumeLeftContextCount &&
        a.idx <= activeIdx;
      const bIsLeftContext =
        activeIdx >= 0 &&
        b.idx >= activeIdx - resumeLeftContextCount &&
        b.idx <= activeIdx;
      if (aIsLeftContext !== bIsLeftContext) {
        if (Math.abs(a.idx - focusIdx) <= 2) return -1;
        if (Math.abs(b.idx - focusIdx) <= 2) return 1;
      }
      return Math.abs(a.idx - focusIdx) - Math.abs(b.idx - focusIdx);
    });

    let cursor = 0;
    const batchUpdates: Record<string, string> = {};
    let flushTimer: number | null = null;
    let scheduledRetry = false;

    const flush = () => {
      flushTimer = null;
      const keys = Object.keys(batchUpdates);
      if (keys.length === 0) return;
      const copy = { ...batchUpdates };
      for (const k of keys) delete batchUpdates[k];
      setFilmstripThumbs((prev) => {
        const next = { ...prev, ...copy };
        if (Object.keys(next).length > 350) {
          const keepIds = new Set<string>();
          const keepFrom = Math.max(0, fetchStart - 110);
          const keepTo = Math.min(shots.length - 1, fetchEnd + 110);
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
          controller.signal,
          {
            folderId,
            preferMicroOnly: isFolderFullyCulled,
          }
        );
        if (controller.signal.aborted) return;
        if (url) {
          failedRetryRef.current.delete(item.id);
          batchUpdates[item.id] = url;
          if (Object.keys(batchUpdates).length >= 6) {
            flush();
          } else {
            scheduleFlush();
          }
        } else {
          const prevAttempts = failedRetryRef.current.get(item.id)?.attempts || 0;
          const nextAttempts = prevAttempts + 1;
          failedRetryRef.current.set(item.id, {
            attempts: nextAttempts,
            retryAt: Date.now() + 1800 * nextAttempts,
          });
          if (nextAttempts < 3 && !scheduledRetry) {
            scheduledRetry = true;
            if (retryTimerRef.current !== null) {
              window.clearTimeout(retryTimerRef.current);
            }
            retryTimerRef.current = window.setTimeout(() => {
              retryTimerRef.current = null;
              setThumbRetryTick((t) => t + 1);
            }, 1850 * nextAttempts);
          }
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
    folderId,
    isFolderFullyCulled,
    resumeLeftContextCount,
    thumbRetryTick,
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
  const isDeleteMode = workflowMode === 'delete';

  return (
    <div
      aria-label="Chronologická lišta všech fotografií se středovým výběrem"
      className="shrink-0 w-full rounded-xl border border-zinc-800/90 bg-[#0D0D10]/95 overflow-hidden select-none"
    >
      {/* Compact Single-Row Strip Bar */}
      <div className="flex items-center justify-between gap-2 px-2.5 sm:px-3 py-1 sm:py-1.5 border-b border-zinc-800/80 bg-[#09090B]/85 text-[11px] overflow-x-auto no-scrollbar">
        <div className="flex items-center gap-1.5 min-w-0 truncate text-zinc-400 tabular-nums">
          {hasActiveSeries ? (
            <>
              <span className="inline-flex items-center gap-1 font-mono font-semibold text-amber-300 whitespace-nowrap">
                <Layers className="w-3 h-3 shrink-0" aria-hidden="true" />
                <span>{activeComparisonIds.size}×</span>
              </span>
              {isEditingSeries && (
                <>
                  <span aria-hidden="true" className="hidden sm:inline">
                    ·
                  </span>
                  <span className="hidden sm:inline text-zinc-300 truncate">
                    Klepnutím na vedlejší skupinu ji připojíte celou · označené
                    lze po jedné odebírat
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
                Lišta složky · {shots.length.toLocaleString('cs-CZ')} snímků ·
                posunem otvíráte fotky · po puštění se vycentruje
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          {!seriesEnabled &&
            !hasActiveSeries &&
            singlePhotoSeriesCount >= 2 &&
            onRevealSinglePhotoSeries && (
              <button
                type="button"
                onClick={onRevealSinglePhotoSeries}
                title="Okamžitě ukáže již nalezenou sérii pouze u této fotky"
                className="min-h-[28px] sm:min-h-[30px] inline-flex items-center gap-1 sm:gap-1.5 rounded-md border border-amber-400/70 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-500 hover:text-zinc-950 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Layers className="w-3 h-3 shrink-0" aria-hidden="true" />
                <span>Zobrazit sérii ({singlePhotoSeriesCount})</span>
              </button>
            )}

          {hasActiveSeries && (
            <>
              {!isEditingSeries && activeComparisonIds.size >= 2 && (
                <>
                  {isDeleteMode && onRejectEntireSeries && (
                    <button
                      type="button"
                      onClick={onRejectEntireSeries}
                      aria-label={`Smazat všechny snímky ve skupině (${activeComparisonIds.size})`}
                      title={`Smazat všechny snímky ve skupině (${activeComparisonIds.size})`}
                      className="min-h-[28px] sm:min-h-[30px] inline-flex items-center gap-1 rounded-md border border-rose-500/50 bg-rose-500/15 px-2 sm:px-2.5 py-0.5 text-[11px] font-medium text-rose-200 hover:bg-rose-500/28 hover:border-rose-400/75 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <Trash2
                        className="w-3.5 h-3.5 text-rose-300 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="hidden sm:inline">Smazat vše</span>
                    </button>
                  )}

                  {!isDeleteMode && onSkipEntireSeries && (
                    <button
                      type="button"
                      onClick={onSkipEntireSeries}
                      aria-label={`Přeskočit celou skupinu (${activeComparisonIds.size})`}
                      title={`Přeskočit celou skupinu (${activeComparisonIds.size})`}
                      className="min-h-[28px] sm:min-h-[30px] inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-[#141417] px-2 sm:px-2.5 py-0.5 text-[11px] font-medium text-zinc-200 hover:bg-zinc-800 hover:border-zinc-500 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <SkipForward
                        className="w-3.5 h-3.5 text-zinc-300 shrink-0"
                        aria-hidden="true"
                      />
                      <span>Přeskočit</span>
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
                  <span>Otevřít ({activeComparisonIds.size})</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Horizontal Touch/Mouse/Wheel Scrubbing Track with Fixed Center Reticle */}
      <div className="relative h-[74px] sm:h-[96px] w-full overflow-hidden">
        {/* Fixed Center Frame Reticle */}
        {!isEditingSeries && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center justify-center"
          >
            <span className="h-1 sm:h-1.5 w-3 rounded-b bg-amber-400 shadow" />
            <div className="my-auto h-[58px] sm:h-[78px] w-[62px] sm:w-[70px] rounded-xl border-2 border-white/95 shadow-[0_0_18px_rgba(0,0,0,0.65)]" />
            <span className="h-1 sm:h-1.5 w-3 rounded-t bg-amber-400 shadow" />
          </div>
        )}

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="relative h-full w-full overflow-x-auto overflow-y-hidden touch-pan-x overscroll-x-contain scrollbar-thin"
        >
          <div
            className="relative h-full"
            style={{ width: `${totalWidth}px` }}
          >
            {visibleIndices.map((idx) => {
              const shot = shots[idx];
              const isActive = shot.id === activeShotId;

              const selectState: SelectModeState =
                selectStateByShotId[shot.id] || 'unrated';
              const deleteState: DeleteModeState =
                deleteStateByShotId[shot.id] || 'unrated';

              const isSelectedInSelectMode =
                !isDeleteMode && selectState === 'selected';
              const isDimmedInSelectMode =
                !isDeleteMode &&
                !isSelectedInSelectMode &&
                (selectState === 'dimmed' || autoDimmedShotIds.has(shot.id));

              const isTrashInDeleteMode =
                isDeleteMode && deleteState === 'trash';

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
                microThumbsMap?.[fileId] ||
                getFilmstripThumbnailUrl(shot.primary.thumbnailLink) ||
                tempPreviewMap[fileId] ||
                sharpMediaMap[fileId]?.url ||
                null;

              return (
                <React.Fragment key={shot.id}>
                  {/* Explicit Series Divider Line in the 24px Separation Gap */}
                  {showSeparator && (
                    <div
                      aria-hidden="true"
                      style={{
                        transform: `translate3d(${x - Math.round(OUTSIDE_SERIES_GAP / 2)}px, 0, 0)`,
                      }}
                      className="pointer-events-none absolute top-3 bottom-3 left-0 w-px bg-zinc-700/75"
                    />
                  )}

                  <div
                    style={{
                      width: `${itemWidth}px`,
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
                            ? '-left-[2px]'
                            : 'left-0 rounded-l-lg border-l-2'
                        } ${
                          nextSameActive
                            ? '-right-[2px]'
                            : 'right-0 rounded-r-lg border-r-2'
                        }`}
                      />
                    ) : isPartOfAnySeries ? (
                      <div
                        aria-hidden="true"
                        className={`pointer-events-none absolute inset-y-0.5 bg-zinc-800/45 border-y border-zinc-700/80 ${
                          prevSameSeries
                            ? '-left-[1px]'
                            : 'left-0 rounded-l-lg border-l'
                        } ${
                          nextSameSeries
                            ? '-right-[1px]'
                            : 'right-0 rounded-r-lg border-r'
                        }`}
                      />
                    ) : null}

                    {/* Quiet Top Series Count Label on First Shot of a Series */}
                    {(isStartOfSeries ||
                      (isProminentActive && !prevSameActive)) && (
                      <span
                        aria-hidden="true"
                        className={`pointer-events-none absolute -top-0.5 left-1 z-20 inline-flex items-center gap-0.5 px-1 rounded text-[9px] font-mono leading-tight tabular-nums ${
                          isProminentActive
                            ? 'bg-amber-400 text-zinc-950 font-bold'
                            : layout.isManualSeries[idx]
                              ? 'bg-amber-500/85 text-zinc-950 font-semibold'
                              : 'bg-zinc-800 text-zinc-300'
                        }`}
                      >
                        {layout.isManualSeries[idx] && (
                          <Lock className="w-2.5 h-2.5 shrink-0" />
                        )}
                        <span>
                          {isProminentActive
                            ? `${activeComparisonIds.size}×`
                            : `${seriesCount}×`}
                        </span>
                      </span>
                    )}

                    {/* Thumbnail Frame Button (full slot width so gap is exact 2px / 24px) */}
                    <button
                      type="button"
                      onClick={() => {
                        if (isEditingSeries) {
                          onToggleShotInSeries(shot.id);
                        } else if (
                          shot.id === activeShotId &&
                          onActivateCurrentShot
                        ) {
                          onActivateCurrentShot(shot.id);
                        } else {
                          lastUserScrollShotRef.current = null;
                          scrollPhaseRef.current = 'idle';
                          clearProgrammaticLock();
                          clearSnapTimer();
                          onSelectShot(shot.id);
                        }
                      }}
                      aria-label={
                        isEditingSeries
                          ? `${isInActiveGroup ? 'Odebrat ze série' : 'Zařadit do série'}: ${shot.primary.name}`
                          : `Zobrazit snímek ${shot.primary.name}${
                              isSelectedInSelectMode
                                ? ' (vybráno)'
                                : isTrashInDeleteMode
                                  ? ' (ke smazání)'
                                  : ''
                            }`
                      }
                      aria-current={
                        !isEditingSeries && isActive ? 'true' : undefined
                      }
                      aria-pressed={isEditingSeries ? isInActiveGroup : undefined}
                      className={`relative z-10 h-[54px] sm:h-[72px] w-full overflow-hidden rounded-lg transition-transform duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-400 ${
                        isEditingSeries
                          ? isInActiveGroup
                            ? 'border-2 border-amber-400 bg-zinc-900 opacity-100 shadow-[0_0_12px_rgba(245,158,11,0.28)]'
                            : 'border border-zinc-700 bg-zinc-900 opacity-50 hover:opacity-90'
                          : isActive
                            ? 'scale-[1.03] bg-zinc-900'
                            : isSelectedInSelectMode
                              ? 'border-2 border-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.28)] bg-zinc-900 opacity-95 hover:opacity-100'
                              : isTrashInDeleteMode
                                ? 'border-2 border-rose-500/85 bg-zinc-900 opacity-85 hover:opacity-100'
                                : isDimmedInSelectMode
                                  ? 'border border-zinc-800/80 bg-zinc-900 opacity-75 hover:opacity-100'
                                  : isProminentActive
                                    ? 'border border-amber-400/70 bg-zinc-900 opacity-90 hover:opacity-100'
                                    : 'border border-zinc-800 hover:border-zinc-500 bg-zinc-900 opacity-80 hover:opacity-100'
                      }`}
                    >
                      {thumbUrl ? (
                        <img
                          src={thumbUrl}
                          alt={shot.primary.name}
                          referrerPolicy="no-referrer"
                          draggable={false}
                          onError={() => {
                            invalidateThumbnailCache(fileId);
                            setFilmstripThumbs((prev) => {
                              if (!prev[fileId]) return prev;
                              const next = { ...prev };
                              delete next[fileId];
                              return next;
                            });
                            const prevAttempts =
                              failedRetryRef.current.get(fileId)?.attempts || 0;
                            if (prevAttempts < 3) {
                              failedRetryRef.current.set(fileId, {
                                attempts: prevAttempts + 1,
                                retryAt: Date.now() + 900 * (prevAttempts + 1),
                              });
                              window.setTimeout(() => {
                                setThumbRetryTick((t) => t + 1);
                              }, 950 * (prevAttempts + 1));
                            }
                          }}
                          className={`h-full w-full object-cover transition-opacity pointer-events-none ${
                            isDimmedInSelectMode
                              ? 'opacity-35 grayscale'
                              : isTrashInDeleteMode
                                ? 'opacity-45'
                                : 'opacity-100'
                          }`}
                        />
                      ) : (
                        <div
                          className={`h-full w-full flex flex-col items-center justify-center gap-0.5 text-zinc-600 pointer-events-none ${
                            isDimmedInSelectMode || isTrashInDeleteMode
                              ? 'opacity-35'
                              : ''
                          }`}
                        >
                          <ImageIcon
                            className="w-3.5 h-3.5"
                            aria-hidden="true"
                          />
                          <span className="font-mono text-[9px] uppercase">
                            {shot.primary.fileExtension}
                          </span>
                        </div>
                      )}

                      {/* Selected Star Badge (ONLY in Výběr mode!) */}
                      {isSelectedInSelectMode && (
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute bottom-1 left-1 flex h-4 w-4 items-center justify-center rounded bg-amber-400 text-zinc-950 shadow"
                        >
                          <Star className="w-2.5 h-2.5 fill-zinc-950" />
                        </span>
                      )}

                      {/* Trash Badge (ONLY in Mazání mode!) */}
                      {isTrashInDeleteMode && (
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute bottom-1 left-1 flex h-4 w-4 items-center justify-center rounded bg-rose-500 text-white shadow"
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                        </span>
                      )}

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

export const Filmstrip = React.memo(FilmstripInner);

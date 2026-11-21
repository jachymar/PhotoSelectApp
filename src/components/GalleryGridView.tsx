import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ZoomIn,
  ZoomOut,
  Star,
  Image as ImageIcon,
  Crosshair,
  Check,
  ChevronLeft,
  ChevronRight,
  Layers,
  Lock,
  Plus,
  SlidersHorizontal,
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
  getGalleryThumbnailUrl,
  invalidateThumbnailCache,
  resolveFilmstripThumbnailUrl,
} from '../lib/rawParser';
import { markInteractionActive } from '../lib/interactionGate';

export interface GalleryZoomPreset {
  level: number;
  label: string;
  minTilePx: number;
}

export const GALLERY_ZOOM_PRESETS: GalleryZoomPreset[] = [
  { level: 0, label: 'Přehled', minTilePx: 84 },
  { level: 1, label: 'Kompaktní', minTilePx: 132 },
  { level: 2, label: 'Střední', minTilePx: 192 },
  { level: 3, label: 'Detailní', minTilePx: 272 },
];

interface GalleryGridViewProps {
  workflowMode: WorkflowMode;
  folderId?: string;
  shots: PhotoShotItem[];
  activeShotId: string | null;
  selectStateByShotId: Record<string, SelectModeState>;
  deleteStateByShotId: Record<string, DeleteModeState>;
  autoDimmedShotIds: Set<string>;
  burstGroupByShotId: Map<string, PhotoBurstGroup>;
  seriesEnabled: boolean;
  onlySeriesFilter: boolean;
  activeComparisonIds: Set<string>;
  isEditingSeries: boolean;
  isFolderFullyCulled?: boolean;
  zoomLevel: number;
  accessToken?: string | null;
  tempPreviewMap: Record<string, string>;
  sharpMediaMap: Record<string, ResolvedPhotoMedia>;
  microThumbsMap?: Record<string, string>;
  onChangeZoomLevel: (nextLevel: number) => void;
  onToggleSeriesEnabled: (enabled: boolean) => void;
  onToggleOnlySeriesFilter: (next: boolean) => void;
  onSelectShot: (shotId: string) => void;
  onOpenShotDetail: (shotId: string, sourceRect?: DOMRect) => void;
  onToggleShotInSeries: (shotId: string) => void;
  onToggleEditingSeries: () => void;
  onOpenSeries?: () => void;
  onCreateSeries?: () => void;
}

type VirtualRow =
  | {
      type: 'series-header';
      key: string;
      seriesId: string;
      seriesIndex: number;
      firstShotId: string;
      count: number;
      timeLabel: string;
      isActiveSeries: boolean;
      isManual: boolean;
      y: number;
      height: number;
    }
  | {
      type: 'tile-row';
      key: string;
      items: PhotoShotItem[];
      seriesId: string | null;
      isActiveSeries: boolean;
      isFirstRowInSeries: boolean;
      isLastRowInSeries: boolean;
      y: number;
      height: number;
      tileWidth: number;
      tileHeight: number;
      gap: number;
      innerPadX: number;
    };

const THUMB_CONCURRENCY = 4;
const HEADER_ROW_HEIGHT = 40;
const SERIES_GAP_BOTTOM = 16;

function findFirstVisibleRow(rows: VirtualRow[], scrollTop: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  let ans = rows.length;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].y + rows[mid].height >= scrollTop) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

export const GalleryGridView: React.FC<GalleryGridViewProps> = ({
  workflowMode,
  folderId,
  shots,
  activeShotId,
  selectStateByShotId,
  deleteStateByShotId,
  autoDimmedShotIds,
  burstGroupByShotId,
  seriesEnabled,
  onlySeriesFilter,
  activeComparisonIds,
  isEditingSeries,
  isFolderFullyCulled = false,
  zoomLevel,
  accessToken,
  tempPreviewMap,
  sharpMediaMap,
  microThumbsMap,
  onChangeZoomLevel,
  onToggleSeriesEnabled,
  onToggleOnlySeriesFilter,
  onSelectShot,
  onOpenShotDetail,
  onToggleShotInSeries,
  onToggleEditingSeries,
  onOpenSeries,
  onCreateSeries,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 960, height: 600 });
  const [scrollTop, setScrollTop] = useState(0);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;
  const failedRetryRef = useRef<
    Map<string, { attempts: number; retryAt: number }>
  >(new Map());
  const [thumbRetryTick, setThumbRetryTick] = useState(0);
  const rafScrollRef = useRef<number | null>(null);
  const hasScrolledInitialRef = useRef(false);
  const anchorShotIdRef = useRef<string | null>(activeShotId);
  const lastZoomLevelRef = useRef(zoomLevel);
  const lastSeriesEnabledRef = useRef(seriesEnabled);
  const lastOnlySeriesFilterRef = useRef(onlySeriesFilter);

  // Two-finger pinch zoom state on gallery grid
  const pinchDistRef = useRef<number | null>(null);
  const zoomLevelRef = useRef(zoomLevel);
  zoomLevelRef.current = zoomLevel;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setViewportSize({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    markInteractionActive(220);
    if (rafScrollRef.current !== null) return;
    rafScrollRef.current = window.requestAnimationFrame(() => {
      rafScrollRef.current = null;
      if (scrollRef.current) {
        setScrollTop(scrollRef.current.scrollTop);
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      if (rafScrollRef.current !== null) {
        window.cancelAnimationFrame(rafScrollRef.current);
      }
    };
  }, []);

  // Build flat virtualized rows separating every detected series cleanly
  const { rows, totalHeight, shotRowYMap, seriesHeaders } = useMemo(() => {
    const preset =
      GALLERY_ZOOM_PRESETS[zoomLevel] || GALLERY_ZOOM_PRESETS[1];
    const outerPadX = viewportSize.width < 640 ? 8 : 16;
    const innerPadX = zoomLevel === 0 ? 6 : 10;
    const gap = zoomLevel === 0 ? 5 : 8;
    const availWidth = Math.max(220, viewportSize.width - outerPadX * 2);
    const usableSeriesWidth = Math.max(160, availWidth - innerPadX * 2 - 4);
    const minCols = zoomLevel === 0 ? 4 : zoomLevel === 1 ? 3 : 2;
    const cols = Math.max(
      minCols,
      Math.floor((usableSeriesWidth + gap) / (preset.minTilePx + gap))
    );
    const tileWidth = Math.max(
      56,
      Math.floor((usableSeriesWidth - gap * (cols - 1)) / cols)
    );
    const tileHeight =
      zoomLevel === 0 ? tileWidth : Math.round(tileWidth * 0.78);

    // Group chronological shots into Series vs Standalone segments
    interface Segment {
      type: 'series' | 'standalone';
      seriesId: string | null;
      timeLabel: string;
      isActiveSeries: boolean;
      isManual: boolean;
      items: PhotoShotItem[];
    }

    const segments: Segment[] = [];
    let i = 0;
    while (i < shots.length) {
      const burst = seriesEnabled ? burstGroupByShotId.get(shots[i].id) : undefined;
      const key = burst ? burst.id : null;

      if (key !== null && burst) {
        const items: PhotoShotItem[] = [];
        let hasActive = false;
        while (
          i < shots.length &&
          (seriesEnabled ? burstGroupByShotId.get(shots[i].id)?.id : null) === key
        ) {
          if (activeComparisonIds.has(shots[i].id)) {
            hasActive = true;
          }
          items.push(shots[i]);
          i++;
        }
        segments.push({
          type: 'series',
          seriesId: key,
          timeLabel: burst.timeLabel,
          isActiveSeries: hasActive,
          isManual: Boolean(burst.isManual),
          items,
        });
      } else {
        const items: PhotoShotItem[] = [];
        while (
          i < shots.length &&
          (!seriesEnabled || !burstGroupByShotId.has(shots[i].id))
        ) {
          items.push(shots[i]);
          i++;
        }
        if (!(seriesEnabled && onlySeriesFilter)) {
          segments.push({
            type: 'standalone',
            seriesId: null,
            timeLabel: '',
            isActiveSeries: false,
            isManual: false,
            items,
          });
        }
      }
    }

    const builtRows: VirtualRow[] = [];
    const yByShotId = new Map<string, number>();
    const headers: Array<{
      seriesId: string;
      firstShotId: string;
      shotIds: Set<string>;
      y: number;
    }> = [];
    let y = 12;

    const modeTag = seriesEnabled
      ? onlySeriesFilter
        ? 'series-only'
        : 'series-all'
      : 'flat';

    for (let sIdx = 0; sIdx < segments.length; sIdx++) {
      const seg = segments[sIdx];
      if (seg.type === 'series' && seg.seriesId) {
        if (sIdx > 0) y += 6;
        const seriesIdx = headers.length;
        headers.push({
          seriesId: seg.seriesId,
          firstShotId: seg.items[0].id,
          shotIds: new Set(seg.items.map((it) => it.id)),
          y,
        });
        builtRows.push({
          type: 'series-header',
          key: `hdr:${modeTag}:${sIdx}:${seg.seriesId}`,
          seriesId: seg.seriesId,
          seriesIndex: seriesIdx,
          firstShotId: seg.items[0].id,
          count: seg.items.length,
          timeLabel: seg.timeLabel,
          isActiveSeries: seg.isActiveSeries,
          isManual: seg.isManual,
          y,
          height: HEADER_ROW_HEIGHT,
        });
        y += HEADER_ROW_HEIGHT;

        const rowCount = Math.ceil(seg.items.length / cols);
        for (let r = 0; r < rowCount; r++) {
          const slice = seg.items.slice(r * cols, (r + 1) * cols);
          const isFirst = r === 0;
          const isLast = r === rowCount - 1;
          const topPad = isFirst ? 6 : 0;
          const rowHeight = tileHeight + topPad + (isLast ? 10 : gap);
          for (const item of slice) {
            yByShotId.set(item.id, y);
          }
          builtRows.push({
            type: 'tile-row',
            key: `srow:${modeTag}:${sIdx}:${seg.seriesId}:${r}`,
            items: slice,
            seriesId: seg.seriesId,
            isActiveSeries: seg.isActiveSeries,
            isFirstRowInSeries: isFirst,
            isLastRowInSeries: isLast,
            y,
            height: rowHeight,
            tileWidth,
            tileHeight,
            gap,
            innerPadX,
          });
          y += rowHeight;
        }
        y += SERIES_GAP_BOTTOM;
      } else {
        const rowCount = Math.ceil(seg.items.length / cols);
        for (let r = 0; r < rowCount; r++) {
          const slice = seg.items.slice(r * cols, (r + 1) * cols);
          const isLast = r === rowCount - 1;
          const rowHeight = tileHeight + (isLast ? 12 : gap);
          for (const item of slice) {
            yByShotId.set(item.id, y);
          }
          builtRows.push({
            type: 'tile-row',
            key: `flat:${modeTag}:${sIdx}:${r}`,
            items: slice,
            seriesId: null,
            isActiveSeries: false,
            isFirstRowInSeries: false,
            isLastRowInSeries: false,
            y,
            height: rowHeight,
            tileWidth,
            tileHeight,
            gap,
            innerPadX,
          });
          y += rowHeight;
        }
      }
    }

    return {
      rows: builtRows,
      totalHeight: y + 24,
      shotRowYMap: yByShotId,
      seriesHeaders: headers,
    };
  }, [
    shots,
    zoomLevel,
    viewportSize.width,
    seriesEnabled,
    onlySeriesFilter,
    burstGroupByShotId,
    activeComparisonIds,
  ]);

  const visibleRows = useMemo(() => {
    if (rows.length === 0) return [];
    const overscanPx = 320;
    const minTop = Math.max(0, scrollTop - overscanPx);
    const maxBottom = scrollTop + viewportSize.height + overscanPx;
    const first = findFirstVisibleRow(rows, minTop);
    const result: VirtualRow[] = [];
    for (let i = first; i < rows.length; i++) {
      if (rows[i].y > maxBottom) break;
      result.push(rows[i]);
    }
    return result;
  }, [rows, scrollTop, viewportSize.height]);

  // Capture anchor shot currently in center of viewport before zoom changes
  const captureCenterShotId = useCallback((): string | null => {
    const centerY = scrollTop + viewportSize.height * 0.35;
    for (const row of visibleRows) {
      if (row.type === 'tile-row' && row.y + row.height >= centerY) {
        return row.items[0]?.id || null;
      }
    }
    return activeShotId;
  }, [scrollTop, viewportSize.height, visibleRows, activeShotId]);

  const handleStepZoom = useCallback(
    (nextLevel: number) => {
      const clamped = Math.max(
        0,
        Math.min(GALLERY_ZOOM_PRESETS.length - 1, nextLevel)
      );
      if (clamped === zoomLevelRef.current) return;
      anchorShotIdRef.current = captureCenterShotId() || activeShotId;
      onChangeZoomLevel(clamped);
    },
    [captureCenterShotId, activeShotId, onChangeZoomLevel]
  );

  // Scroll cleanly to activeShotId on first open, keep scroll anchored on zoom/series toggles, and clamp scrollTop when totalHeight changes
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const maxScroll = Math.max(0, totalHeight - el.clientHeight);
    if (rows.length === 0) {
      if (el.scrollTop !== 0) el.scrollTop = 0;
      if (scrollTop !== 0) setScrollTop(0);
      lastZoomLevelRef.current = zoomLevel;
      lastSeriesEnabledRef.current = seriesEnabled;
      lastOnlySeriesFilterRef.current = onlySeriesFilter;
      return;
    }

    if (!hasScrolledInitialRef.current && activeShotId) {
      hasScrolledInitialRef.current = true;
      const targetY = shotRowYMap.get(activeShotId);
      if (targetY !== undefined) {
        const nextTop = Math.max(
          0,
          Math.min(maxScroll, targetY - el.clientHeight * 0.32)
        );
        el.scrollTop = nextTop;
        setScrollTop(nextTop);
      }
      return;
    }

    const modeOrZoomChanged =
      lastZoomLevelRef.current !== zoomLevel ||
      lastSeriesEnabledRef.current !== seriesEnabled ||
      lastOnlySeriesFilterRef.current !== onlySeriesFilter;

    if (modeOrZoomChanged) {
      lastZoomLevelRef.current = zoomLevel;
      lastSeriesEnabledRef.current = seriesEnabled;
      lastOnlySeriesFilterRef.current = onlySeriesFilter;
      const anchorId = anchorShotIdRef.current || activeShotId;
      const targetY = anchorId ? shotRowYMap.get(anchorId) : undefined;
      if (targetY !== undefined) {
        const nextTop = Math.max(
          0,
          Math.min(maxScroll, targetY - el.clientHeight * 0.3)
        );
        el.scrollTop = nextTop;
        setScrollTop(nextTop);
      } else {
        const clamped = Math.max(0, Math.min(maxScroll, el.scrollTop));
        el.scrollTop = clamped;
        setScrollTop(clamped);
      }
      return;
    }

    if (el.scrollTop > maxScroll + 1 || Math.abs(el.scrollTop - scrollTop) > 2) {
      const clamped = Math.max(0, Math.min(maxScroll, el.scrollTop));
      if (el.scrollTop !== clamped) {
        el.scrollTop = clamped;
      }
      if (Math.abs(scrollTop - clamped) > 1) {
        setScrollTop(clamped);
      }
    }
  }, [
    zoomLevel,
    seriesEnabled,
    onlySeriesFilter,
    rows.length,
    totalHeight,
    viewportSize.height,
    scrollTop,
    activeShotId,
    shotRowYMap,
  ]);

  const scrollToActiveShot = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !activeShotId) return;
    const targetY = shotRowYMap.get(activeShotId);
    if (targetY !== undefined) {
      el.scrollTo({
        top: Math.max(0, targetY - el.clientHeight * 0.32),
        behavior: 'smooth',
      });
    }
  }, [activeShotId, shotRowYMap]);

  // Touch pinch-to-zoom on gallery grid
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      pinchDistRef.current = Math.hypot(dx, dy);
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && pinchDistRef.current !== null) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      const dist = Math.hypot(dx, dy);
      if (dist > 20 && pinchDistRef.current > 20) {
        const ratio = dist / pinchDistRef.current;
        if (ratio >= 1.24) {
          pinchDistRef.current = dist;
          handleStepZoom(zoomLevelRef.current + 1);
        } else if (ratio <= 0.8) {
          pinchDistRef.current = dist;
          handleStepZoom(zoomLevelRef.current - 1);
        }
      }
    }
  };

  const handleTouchEnd = () => {
    if (pinchDistRef.current !== null) {
      pinchDistRef.current = null;
    }
  };

  // Lazy-load thumbnails ONLY for visible rows
  useEffect(() => {
    if (visibleRows.length === 0) return;

    const controller = new AbortController();
    const visibleShots: PhotoShotItem[] = [];
    for (const r of visibleRows) {
      if (r.type === 'tile-row') {
        for (const item of r.items) visibleShots.push(item);
      }
    }
    if (visibleShots.length === 0) return;

    const highDetail = zoomLevel >= 2;
    const pending: PhotoShotItem[] = [];
    const syncHits: Record<string, string> = {};
    const now = Date.now();

    for (const shot of visibleShots) {
      const file = shot.primary;
      const failInfo = failedRetryRef.current.get(file.id);
      if (
        thumbsRef.current[file.id] ||
        sharpMediaMap[file.id]?.url ||
        tempPreviewMap[file.id] ||
        (failInfo && (failInfo.attempts >= 3 || now < failInfo.retryAt))
      ) {
        continue;
      }
      const cached = getCachedFilmstripThumbnailUrl(file.id);
      if (cached) {
        syncHits[file.id] = cached;
        continue;
      }
      const cachedMicro = microThumbsMap?.[file.id];
      if (cachedMicro && (isFolderFullyCulled || zoomLevel <= 1)) {
        syncHits[file.id] = cachedMicro;
        continue;
      }
      const driveThumb = getGalleryThumbnailUrl(file.thumbnailLink, highDetail);
      if (driveThumb && (!file.sourceKind || file.sourceKind === 'drive')) {
        syncHits[file.id] = driveThumb;
        continue;
      }
      pending.push(shot);
    }

    if (Object.keys(syncHits).length > 0) {
      setThumbs((prev) => ({ ...prev, ...syncHits }));
    }

    if (pending.length === 0) return;

    let cursor = 0;
    const batch: Record<string, string> = {};
    let flushTimer: number | null = null;
    let retryTimer: number | null = null;

    const flush = () => {
      flushTimer = null;
      const keys = Object.keys(batch);
      if (keys.length === 0) return;
      const copy = { ...batch };
      for (const k of keys) delete batch[k];
      const keepIds = new Set(visibleShots.map((s) => s.primary.id));
      setThumbs((prev) => {
        const next = { ...prev, ...copy };
        if (Object.keys(next).length > 360) {
          for (const existing of Object.keys(next)) {
            if (!keepIds.has(existing)) {
              delete next[existing];
              if (Object.keys(next).length <= 260) break;
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
        const shot = pending[cursor++];
        const url = await resolveFilmstripThumbnailUrl(
          accessToken,
          shot.primary,
          controller.signal,
          {
            folderId,
            preferMicroOnly: isFolderFullyCulled,
          }
        );
        if (controller.signal.aborted) return;
        if (url) {
          failedRetryRef.current.delete(shot.primary.id);
          batch[shot.primary.id] = url;
          if (Object.keys(batch).length >= 8) {
            flush();
          } else {
            scheduleFlush();
          }
        } else {
          const prevAttempts =
            failedRetryRef.current.get(shot.primary.id)?.attempts || 0;
          const nextAttempts = prevAttempts + 1;
          failedRetryRef.current.set(shot.primary.id, {
            attempts: nextAttempts,
            retryAt: Date.now() + 1800 * nextAttempts,
          });
          if (nextAttempts < 3 && retryTimer === null) {
            retryTimer = window.setTimeout(() => {
              retryTimer = null;
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
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [
    visibleRows,
    zoomLevel,
    accessToken,
    sharpMediaMap,
    tempPreviewMap,
    microThumbsMap,
    folderId,
    isFolderFullyCulled,
    thumbRetryTick,
  ]);

  const currentSeriesHeaderIndex = useMemo(() => {
    if (!seriesEnabled || seriesHeaders.length === 0) return -1;
    if (activeShotId) {
      const idx = seriesHeaders.findIndex((h) => h.shotIds.has(activeShotId));
      if (idx !== -1) return idx;
    }
    const viewMidY = scrollTop + viewportSize.height * 0.25;
    let best = 0;
    for (let i = 0; i < seriesHeaders.length; i++) {
      if (seriesHeaders[i].y <= viewMidY + 40) best = i;
      else break;
    }
    return best;
  }, [
    seriesEnabled,
    seriesHeaders,
    activeShotId,
    scrollTop,
    viewportSize.height,
  ]);

  const handleJumpToSeriesIndex = useCallback(
    (targetIdx: number) => {
      if (seriesHeaders.length === 0) return;
      const clamped = Math.max(0, Math.min(seriesHeaders.length - 1, targetIdx));
      const hdr = seriesHeaders[clamped];
      if (!hdr) return;
      onSelectShot(hdr.firstShotId);
      if (scrollRef.current) {
        scrollRef.current.scrollTo({
          top: Math.max(0, hdr.y - 12),
          behavior: 'smooth',
        });
      }
    },
    [seriesHeaders, onSelectShot]
  );

  const outerPadX = viewportSize.width < 640 ? 8 : 16;

  const hasActiveSeries = activeComparisonIds.size > 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-[#0D0D10]">
      {/* Gallery Zoom Level & Series Toolbar (modular 2-row on mobile, unified on desktop) */}
      <div className="shrink-0 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-1.5 lg:gap-2 px-2.5 sm:px-4 py-1.5 sm:py-2 border-b border-zinc-800/90 bg-[#09090B]/95">
        {/* Top Row: Count + Mobile Jump/Zoom */}
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0 text-xs text-zinc-400 tabular-nums">
            <span className="font-medium text-zinc-200 whitespace-nowrap">
              <span className="sm:hidden">
                Galerie ({shots.length.toLocaleString('cs-CZ')})
              </span>
              <span className="hidden sm:inline">
                Celá galerie ({shots.length.toLocaleString('cs-CZ')})
              </span>
            </span>
            <span aria-hidden="true" className="hidden xl:inline">
              ·
            </span>
            <span className="hidden xl:inline truncate">
              {isEditingSeries
                ? 'Klepnutím na snímky upravíte složení aktivní série'
                : hasActiveSeries
                  ? `Aktivní série (${activeComparisonIds.size}) · klepnutí označí · další klepnutí otevře`
                  : 'Klepnutí označí fotku · další klepnutí ji otevře'}
            </span>
          </div>

          {/* Mobile/Tablet Quick Active & Zoom Stepper (kept unclipped on row 1) */}
          <div className="flex lg:hidden items-center gap-1.5 shrink-0">
            {activeShotId && (
              <button
                type="button"
                onClick={scrollToActiveShot}
                title="Přejít na aktivní snímek"
                aria-label="Přejít na aktivní snímek"
                className="min-h-[32px] min-w-[32px] inline-flex items-center justify-center px-2 py-1 rounded-lg border border-zinc-800 bg-[#141417] text-xs font-medium text-amber-300 hover:border-amber-500/60 transition-colors cursor-pointer shrink-0"
              >
                <Crosshair className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              </button>
            )}

            <div
              className="flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-[#141417]"
              role="group"
              aria-label="Úroveň přiblížení galerie"
            >
              <button
                type="button"
                onClick={() => handleStepZoom(zoomLevel - 1)}
                disabled={zoomLevel <= 0}
                aria-label="Oddálit galerii"
                className="min-h-[28px] min-w-[28px] inline-flex items-center justify-center rounded-md text-zinc-300 hover:text-white hover:bg-zinc-800 disabled:opacity-35 cursor-pointer"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="px-1.5 font-mono text-[11px] text-zinc-200 whitespace-nowrap">
                {GALLERY_ZOOM_PRESETS[zoomLevel]?.label}
              </span>
              <button
                type="button"
                onClick={() => handleStepZoom(zoomLevel + 1)}
                disabled={zoomLevel >= GALLERY_ZOOM_PRESETS.length - 1}
                aria-label="Přiblížit galerii"
                className="min-h-[28px] min-w-[28px] inline-flex items-center justify-center rounded-md text-zinc-300 hover:text-white hover:bg-zinc-800 disabled:opacity-35 cursor-pointer"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Scrollable Modular Series & Desktop Zoom Controls (never clipped) */}
        <div className="flex items-center gap-1.5 sm:gap-2 w-full lg:w-auto min-w-0 overflow-x-auto no-scrollbar">
          {/* Gallery Series Grouping Toggle (Bez sérií / V sériích) */}
          <div
            className="flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-[#141417] shrink-0"
            role="group"
            aria-label="Režim zobrazení sérií v galerii"
          >
            <button
              type="button"
              onClick={() => {
                if (!seriesEnabled) return;
                anchorShotIdRef.current = captureCenterShotId() || activeShotId;
                onToggleSeriesEnabled(false);
              }}
              aria-pressed={!seriesEnabled}
              className={`min-h-[30px] px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                !seriesEnabled
                  ? 'bg-amber-500 text-zinc-950 font-semibold'
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              Bez sérií
            </button>
            <button
              type="button"
              onClick={() => {
                if (seriesEnabled) return;
                anchorShotIdRef.current = captureCenterShotId() || activeShotId;
                onToggleSeriesEnabled(true);
              }}
              aria-pressed={seriesEnabled}
              className={`min-h-[30px] inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                seriesEnabled
                  ? 'bg-amber-500 text-zinc-950 font-semibold'
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              <Layers className="w-3 h-3 shrink-0" aria-hidden="true" />
              <span>V sériích</span>
            </button>
          </div>

          {seriesEnabled && (
            <div
              className="flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-[#141417] shrink-0"
              role="group"
              aria-label="Filtr zobrazení sérií"
            >
              <button
                type="button"
                onClick={() => onToggleOnlySeriesFilter(false)}
                aria-pressed={!onlySeriesFilter}
                className={`min-h-[28px] px-2 py-0.5 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  !onlySeriesFilter
                    ? 'bg-zinc-700 text-zinc-100 font-semibold'
                    : 'text-zinc-400 hover:text-zinc-100'
                }`}
              >
                Vše
              </button>
              <button
                type="button"
                onClick={() => onToggleOnlySeriesFilter(true)}
                aria-pressed={onlySeriesFilter}
                className={`min-h-[28px] px-2 py-0.5 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  onlySeriesFilter
                    ? 'bg-amber-500 text-zinc-950 font-semibold'
                    : 'text-zinc-400 hover:text-zinc-100'
                }`}
              >
                Jen série ({seriesHeaders.length})
              </button>
            </div>
          )}

          {seriesEnabled && seriesHeaders.length > 0 && (
            <div
              className="flex items-center rounded-lg border border-zinc-800 bg-[#141417] overflow-hidden shrink-0"
              role="group"
              aria-label="Krokování po nalezených sériích"
            >
              <button
                type="button"
                onClick={() =>
                  handleJumpToSeriesIndex(
                    currentSeriesHeaderIndex <= 0
                      ? 0
                      : currentSeriesHeaderIndex - 1
                  )
                }
                disabled={currentSeriesHeaderIndex <= 0}
                aria-label="Předchozí série"
                title="Předchozí série"
                className="min-h-[32px] lg:min-h-[34px] px-2 inline-flex items-center justify-center text-zinc-200 hover:text-amber-300 hover:bg-zinc-800 disabled:opacity-35 cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="inline-flex items-center gap-1 px-2 font-mono text-[11px] text-zinc-300 tabular-nums border-x border-zinc-800 whitespace-nowrap">
                <Layers className="w-3 h-3 text-amber-400 shrink-0" aria-hidden="true" />
                <span>
                  {currentSeriesHeaderIndex >= 0
                    ? currentSeriesHeaderIndex + 1
                    : 1}{' '}
                  / {seriesHeaders.length}
                </span>
              </span>
              <button
                type="button"
                onClick={() =>
                  handleJumpToSeriesIndex(
                    currentSeriesHeaderIndex < 0
                      ? 0
                      : currentSeriesHeaderIndex + 1
                  )
                }
                disabled={
                  currentSeriesHeaderIndex >= seriesHeaders.length - 1
                }
                aria-label="Další série"
                title="Další série"
                className="min-h-[32px] lg:min-h-[34px] px-2 inline-flex items-center justify-center text-zinc-200 hover:text-amber-300 hover:bg-zinc-800 disabled:opacity-35 cursor-pointer"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {onCreateSeries &&
            (!hasActiveSeries ||
              (activeShotId && !activeComparisonIds.has(activeShotId))) && (
            <button
              type="button"
              onClick={onCreateSeries}
              title="Ručně seskupit označenou fotku s dalšími snímky do nové série"
              className="min-h-[34px] lg:min-h-[36px] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-800 bg-[#141417] text-xs font-medium text-amber-300 hover:border-amber-500/60 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Vytvořit sérii</span>
            </button>
          )}

          {hasActiveSeries && (
            <>
              <button
                type="button"
                onClick={onToggleEditingSeries}
                className={`min-h-[34px] lg:min-h-[36px] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  isEditingSeries
                    ? 'border-amber-400 bg-amber-500 text-zinc-950 font-semibold'
                    : 'border-zinc-800 bg-[#141417] text-zinc-200 hover:border-amber-400/60 hover:text-amber-200'
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>{isEditingSeries ? 'Hotovo' : 'Upravit sérii'}</span>
              </button>

              {onOpenSeries && (
                <button
                  type="button"
                  onClick={onOpenSeries}
                  className="min-h-[34px] lg:min-h-[36px] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-amber-400/70 bg-amber-500/15 text-xs font-semibold text-amber-200 hover:bg-amber-500 hover:text-zinc-950 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Layers className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>Otevřít ({activeComparisonIds.size})</span>
                </button>
              )}
            </>
          )}

          {/* Desktop Active Jump & Zoom Presets */}
          {activeShotId && (
            <button
              type="button"
              onClick={scrollToActiveShot}
              title="Přejít na aktivní snímek"
              className="hidden lg:inline-flex min-h-[36px] items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-800 bg-[#141417] text-xs font-medium text-amber-300 hover:border-amber-500/60 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Crosshair className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Aktivní</span>
            </button>
          )}

          <div
            className="hidden lg:flex items-center gap-1 p-1 rounded-lg border border-zinc-800 bg-[#141417] shrink-0"
            role="group"
            aria-label="Úroveň přiblížení galerie"
          >
            <button
              type="button"
              onClick={() => handleStepZoom(zoomLevel - 1)}
              disabled={zoomLevel <= 0}
              aria-label="Oddálit galerii"
              title="Oddálit galerii (více fotek)"
              className="min-h-[30px] min-w-[30px] inline-flex items-center justify-center rounded-md text-zinc-300 hover:text-white hover:bg-zinc-800 disabled:opacity-35 cursor-pointer"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>

            <div className="flex items-center gap-0.5">
              {GALLERY_ZOOM_PRESETS.map((preset) => (
                <button
                  key={preset.level}
                  type="button"
                  onClick={() => handleStepZoom(preset.level)}
                  className={`min-h-[30px] px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    zoomLevel === preset.level
                      ? 'bg-amber-500 text-zinc-950 font-semibold'
                      : 'text-zinc-400 hover:text-zinc-100'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => handleStepZoom(zoomLevel + 1)}
              disabled={zoomLevel >= GALLERY_ZOOM_PRESETS.length - 1}
              aria-label="Přiblížit galerii"
              title="Přiblížit galerii (větší náhledy)"
              className="min-h-[30px] min-w-[30px] inline-flex items-center justify-center rounded-md text-zinc-300 hover:text-white hover:bg-zinc-800 disabled:opacity-35 cursor-pointer"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Scrollable Virtualized Series-Separated Gallery Grid */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className="relative flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin"
      >
        {seriesEnabled && onlySeriesFilter && seriesHeaders.length === 0 ? (
          <div className="h-full w-full flex flex-col items-center justify-center gap-3 px-6 text-center">
            <Layers className="w-8 h-8 text-zinc-600" aria-hidden="true" />
            <div className="space-y-1 max-w-sm">
              <p className="text-sm font-medium text-zinc-200">
                Zatím nebyly nalezeny žádné série
              </p>
              <p className="text-xs text-zinc-400">
                Série se průběžně vyhledávají automaticky na pozadí.
              </p>
            </div>
          </div>
        ) : (
        <div
          className="relative w-full"
          style={{ height: `${totalHeight}px` }}
        >
          {visibleRows.map((row) => {
            if (row.type === 'series-header') {
              return (
                <div
                  key={row.key}
                  style={{
                    transform: `translate3d(0, ${row.y}px, 0)`,
                    height: `${row.height}px`,
                    left: `${outerPadX}px`,
                    right: `${outerPadX}px`,
                  }}
                  className={`absolute top-0 flex items-center justify-between gap-2 px-3 rounded-t-xl border-x border-t ${
                    row.isActiveSeries
                      ? 'bg-amber-500/18 border-amber-400/80 text-amber-200'
                      : row.isManual
                        ? 'bg-amber-500/10 border-amber-500/40 text-amber-200'
                        : 'bg-zinc-900/75 border-zinc-800 text-zinc-300'
                  }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0 text-xs truncate tabular-nums">
                    {row.isManual ? (
                      <Lock
                        className="w-3 h-3 text-amber-300 shrink-0"
                        aria-label="Ručně uzamčeno"
                      />
                    ) : (
                      <Layers
                        className={`w-3 h-3 shrink-0 ${
                          row.isActiveSeries ? 'text-amber-300' : 'text-zinc-400'
                        }`}
                        aria-hidden="true"
                      />
                    )}
                    <span
                      className={`font-mono text-[11px] ${
                        row.isActiveSeries
                          ? 'font-bold text-amber-300'
                          : row.isManual
                            ? 'font-semibold text-amber-200'
                            : 'font-semibold text-zinc-200'
                      }`}
                    >
                      #{row.seriesIndex + 1}
                    </span>
                    <span aria-hidden="true" className="text-zinc-500">
                      ·
                    </span>
                    <span className="font-mono text-[11px] font-semibold text-zinc-300">
                      {row.count}×
                    </span>
                    {row.timeLabel && (
                      <>
                        <span
                          aria-hidden="true"
                          className="hidden sm:inline text-zinc-500"
                        >
                          ·
                        </span>
                        <span className="hidden sm:inline font-mono text-[11px] text-zinc-400 truncate">
                          {row.timeLabel}
                        </span>
                      </>
                    )}
                  </div>

                  {row.isActiveSeries && onOpenSeries && (
                    <button
                      type="button"
                      onClick={onOpenSeries}
                      className="inline-flex items-center gap-1 rounded-md border border-amber-400/60 bg-[#09090B]/90 px-2.5 py-0.5 text-[11px] font-medium text-amber-200 hover:bg-amber-500 hover:text-zinc-950 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                    >
                      <Layers className="w-3 h-3" aria-hidden="true" />
                      <span>Otevřít ({row.count})</span>
                    </button>
                  )}
                </div>
              );
            }

            const isSeriesRow = row.seriesId !== null;

            return (
              <div
                key={row.key}
                style={{
                  transform: `translate3d(0, ${row.y}px, 0)`,
                  height: `${row.height}px`,
                  left: `${outerPadX}px`,
                  right: `${outerPadX}px`,
                  paddingTop: `${row.isFirstRowInSeries ? 6 : 0}px`,
                  paddingLeft: `${row.innerPadX}px`,
                  paddingRight: `${row.innerPadX}px`,
                  gap: `${row.gap}px`,
                }}
                className={`absolute top-0 flex items-start overflow-hidden ${
                  isSeriesRow
                    ? row.isActiveSeries
                      ? `border-x bg-amber-500/10 border-amber-400/80 ${
                          row.isLastRowInSeries
                            ? 'border-b rounded-b-xl'
                            : ''
                        }`
                      : `border-x bg-zinc-900/45 border-zinc-800 ${
                          row.isLastRowInSeries
                            ? 'border-b rounded-b-xl'
                            : ''
                        }`
                    : ''
                }`}
              >
                {row.items.map((shot) => {
                  const isActive = shot.id === activeShotId;
                  const isDeleteMode = workflowMode === 'delete';
                  const selectState: SelectModeState =
                    selectStateByShotId[shot.id] || 'unrated';
                  const deleteState: DeleteModeState =
                    deleteStateByShotId[shot.id] || 'unrated';
                  const isSelectedInSelectMode =
                    !isDeleteMode && selectState === 'selected';
                  const isDimmedInSelectMode =
                    !isDeleteMode &&
                    !isSelectedInSelectMode &&
                    (selectState === 'dimmed' ||
                      autoDimmedShotIds.has(shot.id));
                  const isTrashInDeleteMode =
                    isDeleteMode && deleteState === 'trash';
                  const isInActiveGroup = activeComparisonIds.has(shot.id);
                  const fileId = shot.primary.id;

                  const thumbUrl =
                    thumbs[fileId] ||
                    getCachedFilmstripThumbnailUrl(fileId) ||
                    microThumbsMap?.[fileId] ||
                    getGalleryThumbnailUrl(
                      shot.primary.thumbnailLink,
                      zoomLevel >= 2
                    ) ||
                    getFilmstripThumbnailUrl(shot.primary.thumbnailLink) ||
                    tempPreviewMap[fileId] ||
                    sharpMediaMap[fileId]?.url ||
                    null;

                  return (
                    <div
                      key={shot.id}
                      style={{
                        width: `${row.tileWidth}px`,
                        height: `${row.tileHeight}px`,
                      }}
                      className="group relative shrink-0"
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          if (isEditingSeries) {
                            onToggleShotInSeries(shot.id);
                            return;
                          }
                          if (shot.id === activeShotId) {
                            onOpenShotDetail(
                              shot.id,
                              e.currentTarget.getBoundingClientRect()
                            );
                          } else {
                            onSelectShot(shot.id);
                          }
                        }}
                        aria-label={
                          isEditingSeries
                            ? `${isInActiveGroup ? 'Odebrat ze série' : 'Zařadit do série'}: ${shot.primary.name}`
                            : isActive
                              ? `Otevřít snímek ${shot.primary.name}`
                              : `Označit snímek (dalším klepnutím otevřete): ${shot.primary.name}`
                        }
                        aria-pressed={isEditingSeries ? isInActiveGroup : isActive}
                        className={`relative h-full w-full overflow-hidden rounded-lg bg-zinc-900 touch-manipulation transition-transform duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-400 ${
                          isEditingSeries
                            ? isInActiveGroup
                              ? 'border-2 border-amber-400 opacity-100 shadow-[0_0_12px_rgba(245,158,11,0.28)]'
                              : 'border border-zinc-800 opacity-50 hover:opacity-90'
                            : isActive
                              ? 'ring-2 ring-white ring-offset-2 ring-offset-[#0D0D10]'
                              : isSelectedInSelectMode
                                ? 'border-2 border-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.25)]'
                                : isTrashInDeleteMode
                                  ? 'border-2 border-rose-500/85'
                                  : isInActiveGroup
                                    ? 'border-2 border-amber-400/75'
                                    : 'border border-zinc-800 hover:border-zinc-500'
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
                              setThumbs((prev) => {
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
                            className={`h-full w-full object-cover transition-opacity ${
                              isDimmedInSelectMode
                                ? 'opacity-35 grayscale'
                                : isTrashInDeleteMode
                                  ? 'opacity-45'
                                  : 'opacity-100'
                            }`}
                          />
                        ) : (
                          <div
                            className={`h-full w-full flex flex-col items-center justify-center gap-1 text-zinc-600 ${
                              isDimmedInSelectMode || isTrashInDeleteMode
                                ? 'opacity-35'
                                : ''
                            }`}
                          >
                            <ImageIcon
                              className="w-4 h-4"
                              aria-hidden="true"
                            />
                            <span className="font-mono text-[10px] uppercase">
                              {shot.primary.fileExtension}
                            </span>
                          </div>
                        )}

                        {/* Selected Star Badge (ONLY in Výběr mode!) */}
                        {isSelectedInSelectMode && (
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute bottom-1.5 left-1.5 flex h-5 w-5 items-center justify-center rounded bg-amber-400 text-zinc-950 shadow"
                          >
                            <Star className="w-3 h-3 fill-zinc-950" />
                          </span>
                        )}

                        {/* Trash Badge (ONLY in Mazání mode!) */}
                        {isTrashInDeleteMode && (
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute bottom-1.5 left-1.5 flex h-5 w-5 items-center justify-center rounded bg-rose-500 text-white shadow"
                          >
                            <Trash2 className="w-3 h-3" />
                          </span>
                        )}

                        {/* Series Membership Checkmark Only During Edit Mode */}
                        {isEditingSeries && isInActiveGroup && (
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 text-zinc-950 shadow"
                          >
                            <Check className="w-3 h-3 stroke-[3]" />
                          </span>
                        )}

                        {/* Bottom Filename Caption in Larger Zoom Levels */}
                        {zoomLevel >= 2 && (
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/35 to-transparent px-2 pt-4 pb-1 flex items-center justify-between gap-1">
                            <span className="text-[11px] font-medium text-zinc-200 truncate">
                              {shot.primary.name}
                            </span>
                            {shot.isPaired && (
                              <span className="font-mono text-[10px] text-amber-300 shrink-0">
                                {shot.formatSummary}
                              </span>
                            )}
                          </div>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        )}
      </div>
    </div>
  );
};

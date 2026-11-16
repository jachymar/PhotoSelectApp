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
  ListChecks,
  SlidersHorizontal,
  Star,
  Trash2,
  X,
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
  resolveFilmstripThumbnailUrl,
} from '../lib/rawParser';

interface SeriesScrubStripProps {
  workflowMode: WorkflowMode;
  allOrderedShots: PhotoShotItem[];
  seriesShotIds: Set<string>;
  burstGroupByShotId?: Map<string, PhotoBurstGroup>;
  activeShotId: string | null;
  selectStateByShotId: Record<string, SelectModeState>;
  deleteStateByShotId: Record<string, DeleteModeState>;
  autoDimmedShotIds: Set<string>;
  isEditingSeries: boolean;
  isMultiSelectMode: boolean;
  selectedMultiIds: Set<string>;
  accessToken?: string | null;
  tempPreviewMap: Record<string, string>;
  sharpMediaMap: Record<string, ResolvedPhotoMedia>;
  onSelectShot: (shotId: string) => void;
  onToggleShotInSeries: (shotId: string) => void;
  onToggleEditingSeries: () => void;
  onToggleMultiSelectMode: () => void;
  onToggleMultiSelectShot: (shotId: string) => void;
  onConfirmMultiSelect: () => void;
  onKeepEntireSeries?: () => void;
  onDeleteEntireSeries?: () => void;
  onCloseSeries: () => void;
}

const CONTEXT_NEIGHBOR_RADIUS = 8;
const THUMB_CONCURRENCY = 4;
const EDGE_AUTO_SCROLL_ZONE_PX = 48;

export const SeriesScrubStrip: React.FC<SeriesScrubStripProps> = ({
  workflowMode,
  allOrderedShots,
  seriesShotIds,
  burstGroupByShotId,
  activeShotId,
  selectStateByShotId,
  deleteStateByShotId,
  autoDimmedShotIds,
  isEditingSeries,
  isMultiSelectMode,
  selectedMultiIds,
  accessToken,
  tempPreviewMap,
  sharpMediaMap,
  onSelectShot,
  onToggleShotInSeries,
  onToggleEditingSeries,
  onToggleMultiSelectMode,
  onToggleMultiSelectShot,
  onConfirmMultiSelect,
  onKeepEntireSeries,
  onDeleteEntireSeries,
  onCloseSeries,
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const isScrubbingRef = useRef(false);
  const lastScrubShotIdRef = useRef<string | null>(null);
  const lastPointerClientXRef = useRef<number | null>(null);
  const autoScrollRafRef = useRef<number | null>(null);

  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;
  const failedIdsRef = useRef<Set<string>>(new Set());

  const isFreeScrollMode = isEditingSeries || isMultiSelectMode;
  const isDeleteMode = workflowMode === 'delete';

  // Extract active series shots (in Výběr keep all shots visible including grayed siblings;
  // in Mazání filter out already-trashed shots so user compares remaining candidates)
  const { seriesShots, displayShots } = useMemo(() => {
    const inSeries: PhotoShotItem[] = [];
    let minIdx = allOrderedShots.length;
    let maxIdx = -1;

    for (let i = 0; i < allOrderedShots.length; i++) {
      const s = allOrderedShots[i];
      if (seriesShotIds.has(s.id)) {
        const delState = deleteStateByShotId[s.id] || 'unrated';
        if (!isDeleteMode || delState !== 'trash') {
          inSeries.push(s);
        }
        if (i < minIdx) minIdx = i;
        if (i > maxIdx) maxIdx = i;
      }
    }

    if (!isEditingSeries || minIdx > maxIdx) {
      return {
        seriesShots: inSeries,
        displayShots: inSeries,
      };
    }

    let start = Math.max(0, minIdx - CONTEXT_NEIGHBOR_RADIUS);
    let end = Math.min(
      allOrderedShots.length - 1,
      maxIdx + CONTEXT_NEIGHBOR_RADIUS
    );

    if (burstGroupByShotId) {
      const startGroup = burstGroupByShotId.get(allOrderedShots[start].id);
      if (startGroup) {
        while (
          start > 0 &&
          burstGroupByShotId.get(allOrderedShots[start - 1].id)?.id ===
            startGroup.id
        ) {
          start--;
        }
      }
      const endGroup = burstGroupByShotId.get(allOrderedShots[end].id);
      if (endGroup) {
        while (
          end < allOrderedShots.length - 1 &&
          burstGroupByShotId.get(allOrderedShots[end + 1].id)?.id ===
            endGroup.id
        ) {
          end++;
        }
      }
    }

    const withContext: PhotoShotItem[] = [];
    for (let i = start; i <= end; i++) {
      const s = allOrderedShots[i];
      const delState = deleteStateByShotId[s.id] || 'unrated';
      if (!isDeleteMode || delState !== 'trash') {
        withContext.push(s);
      }
    }
    return {
      seriesShots: inSeries,
      displayShots: withContext,
    };
  }, [
    allOrderedShots,
    seriesShotIds,
    burstGroupByShotId,
    deleteStateByShotId,
    isDeleteMode,
    isEditingSeries,
  ]);

  const thumbTargetShots = useMemo(() => {
    return isEditingSeries ? displayShots : seriesShots;
  }, [isEditingSeries, displayShots, seriesShots]);

  useEffect(() => {
    if (thumbTargetShots.length === 0) return;

    const controller = new AbortController();
    const pending: PhotoShotItem[] = [];
    const syncHits: Record<string, string> = {};

    for (const shot of thumbTargetShots) {
      const file = shot.primary;
      if (
        thumbsRef.current[file.id] ||
        sharpMediaMap[file.id]?.url ||
        tempPreviewMap[file.id] ||
        failedIdsRef.current.has(file.id)
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
      pending.push(shot);
    }

    if (Object.keys(syncHits).length > 0) {
      setThumbs((prev) => ({ ...prev, ...syncHits }));
    }

    if (pending.length === 0) return;

    let cursor = 0;
    const batch: Record<string, string> = {};
    let flushTimer: number | null = null;

    const flush = () => {
      flushTimer = null;
      const keys = Object.keys(batch);
      if (keys.length === 0) return;
      const copy = { ...batch };
      for (const k of keys) delete batch[k];
      setThumbs((prev) => ({ ...prev, ...copy }));
    };

    const scheduleFlush = () => {
      if (flushTimer !== null) return;
      flushTimer = window.setTimeout(() => {
        if (!controller.signal.aborted) flush();
      }, 45);
    };

    const worker = async () => {
      while (!controller.signal.aborted && cursor < pending.length) {
        const shot = pending[cursor++];
        const url = await resolveFilmstripThumbnailUrl(
          accessToken,
          shot.primary,
          controller.signal
        );
        if (controller.signal.aborted) return;
        if (url) {
          batch[shot.primary.id] = url;
          if (Object.keys(batch).length >= 6) {
            flush();
          } else {
            scheduleFlush();
          }
        } else {
          failedIdsRef.current.add(shot.primary.id);
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
  }, [thumbTargetShots, accessToken, sharpMediaMap, tempPreviewMap]);

  useEffect(() => {
    if (!activeShotId || isScrubbingRef.current || isMultiSelectMode) return;
    const btn = itemRefs.current.get(activeShotId);
    if (btn) {
      btn.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      });
    }
  }, [activeShotId, displayShots.length, isMultiSelectMode]);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current !== null) {
      window.cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopAutoScroll();
  }, [stopAutoScroll]);

  const resolveSeriesShotAtClientX = useCallback(
    (clientX: number): PhotoShotItem | null => {
      if (seriesShots.length === 0) return null;
      let bestShot: PhotoShotItem | null = null;
      let bestDist = Infinity;

      for (const shot of seriesShots) {
        const el = itemRefs.current.get(shot.id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (clientX >= rect.left && clientX <= rect.right) {
          return shot;
        }
        const center = (rect.left + rect.right) / 2;
        const dist = Math.abs(clientX - center);
        if (dist < bestDist) {
          bestDist = dist;
          bestShot = shot;
        }
      }
      return bestShot;
    },
    [seriesShots]
  );

  const ensureEdgeAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current !== null) return;

    const tick = () => {
      const track = trackRef.current;
      const clientX = lastPointerClientXRef.current;
      if (
        !isScrubbingRef.current ||
        !track ||
        clientX === null ||
        isFreeScrollMode
      ) {
        autoScrollRafRef.current = null;
        return;
      }

      const rect = track.getBoundingClientRect();
      let delta = 0;
      if (clientX < rect.left + EDGE_AUTO_SCROLL_ZONE_PX && track.scrollLeft > 0) {
        const ratio = Math.min(
          1,
          Math.max(
            0.2,
            (rect.left + EDGE_AUTO_SCROLL_ZONE_PX - clientX) /
              EDGE_AUTO_SCROLL_ZONE_PX
          )
        );
        delta = -Math.round(4 + ratio * 13);
      } else if (
        clientX > rect.right - EDGE_AUTO_SCROLL_ZONE_PX &&
        track.scrollLeft + track.clientWidth < track.scrollWidth - 1
      ) {
        const ratio = Math.min(
          1,
          Math.max(
            0.2,
            (clientX - (rect.right - EDGE_AUTO_SCROLL_ZONE_PX)) /
              EDGE_AUTO_SCROLL_ZONE_PX
          )
        );
        delta = Math.round(4 + ratio * 13);
      }

      if (delta !== 0) {
        track.scrollLeft += delta;
        const hit = resolveSeriesShotAtClientX(clientX);
        if (hit && hit.id !== lastScrubShotIdRef.current) {
          lastScrubShotIdRef.current = hit.id;
          onSelectShot(hit.id);
        }
        autoScrollRafRef.current = window.requestAnimationFrame(tick);
      } else {
        autoScrollRafRef.current = null;
      }
    };

    autoScrollRafRef.current = window.requestAnimationFrame(tick);
  }, [isFreeScrollMode, resolveSeriesShotAtClientX, onSelectShot]);

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isFreeScrollMode) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    isScrubbingRef.current = true;
    lastPointerClientXRef.current = e.clientX;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore capture failure
    }

    const hit = resolveSeriesShotAtClientX(e.clientX);
    if (hit) {
      lastScrubShotIdRef.current = hit.id;
      if (hit.id !== activeShotId) {
        onSelectShot(hit.id);
      }
    }
    ensureEdgeAutoScroll();
  };

  const handleTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isScrubbingRef.current || isFreeScrollMode) return;
    lastPointerClientXRef.current = e.clientX;
    const hit = resolveSeriesShotAtClientX(e.clientX);
    if (hit && hit.id !== lastScrubShotIdRef.current) {
      lastScrubShotIdRef.current = hit.id;
      onSelectShot(hit.id);
    }
    ensureEdgeAutoScroll();
  };

  const handleTrackPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isScrubbingRef.current) return;
    const releasedShotId = lastScrubShotIdRef.current || activeShotId;
    isScrubbingRef.current = false;
    lastScrubShotIdRef.current = null;
    lastPointerClientXRef.current = null;
    stopAutoScroll();
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore release error
      }
    }
    if (releasedShotId) {
      const btn = itemRefs.current.get(releasedShotId);
      btn?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      });
    }
  };

  const activeIdxInSeries = activeShotId
    ? seriesShots.findIndex((s) => s.id === activeShotId)
    : -1;

  const selectedInActiveSeriesCount = useMemo(
    () => seriesShots.filter((s) => selectedMultiIds.has(s.id)).length,
    [seriesShots, selectedMultiIds]
  );

  const getShotThumbUrl = (shot: PhotoShotItem): string | null => {
    const fileId = shot.primary.id;
    return (
      thumbs[fileId] ||
      getCachedFilmstripThumbnailUrl(fileId) ||
      getFilmstripThumbnailUrl(shot.primary.thumbnailLink) ||
      tempPreviewMap[fileId] ||
      sharpMediaMap[fileId]?.url ||
      null
    );
  };

  return (
    <div
      aria-label="Otevřená série pro porovnání snímků"
      className={`shrink-0 w-full rounded-xl border-2 bg-[#0D0D10]/98 overflow-hidden select-none ${
        isMultiSelectMode
          ? 'border-emerald-400/80 shadow-[0_0_24px_rgba(16,185,129,0.16)]'
          : 'border-amber-400/75 shadow-[0_0_24px_rgba(245,158,11,0.12)]'
      }`}
    >
      {/* Top Bar of Open Series */}
      <div
        className={`flex items-center justify-between gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 border-b border-zinc-800/90 text-[11px] sm:text-xs ${
          isMultiSelectMode ? 'bg-emerald-500/12' : 'bg-amber-500/10'
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0 truncate tabular-nums">
          {isMultiSelectMode ? (
            <ListChecks
              className="w-3.5 h-3.5 text-emerald-400 shrink-0"
              aria-hidden="true"
            />
          ) : (
            <Layers
              className="w-3.5 h-3.5 text-amber-400 shrink-0"
              aria-hidden="true"
            />
          )}
          <span
            className={`font-semibold whitespace-nowrap ${
              isMultiSelectMode ? 'text-emerald-200' : 'text-amber-200'
            }`}
          >
            {isMultiSelectMode ? (
              <>
                <span className="sm:hidden">
                  {isDeleteMode ? 'Nemazat' : 'Vybráno'}{' '}
                  {selectedInActiveSeriesCount}/{seriesShots.length}
                </span>
                <span className="hidden sm:inline">
                  {isDeleteMode
                    ? `Nemazat · ${selectedInActiveSeriesCount}/${seriesShots.length} snímků`
                    : `Výběr ze série · ${selectedInActiveSeriesCount}/${seriesShots.length} vybráno`}
                </span>
              </>
            ) : isEditingSeries ? (
              seriesShots.length <= 1 ? (
                'Ruční série'
              ) : (
                `Úprava · ${seriesShots.length}`
              )
            ) : (
              <>
                <span className="sm:hidden">
                  Série ·{' '}
                  {activeIdxInSeries >= 0
                    ? `${activeIdxInSeries + 1}/${seriesShots.length}`
                    : `${seriesShots.length}`}
                </span>
                <span className="hidden sm:inline">
                  Otevřená série ·{' '}
                  {activeIdxInSeries >= 0
                    ? `${activeIdxInSeries + 1}/${seriesShots.length}`
                    : `${seriesShots.length}`}{' '}
                  snímků
                </span>
              </>
            )}
          </span>
          <span aria-hidden="true" className="hidden md:inline text-zinc-500">
            ·
          </span>
          <span className="hidden md:inline text-[11px] text-zinc-300 truncate">
            {isMultiSelectMode
              ? isDeleteMode
                ? 'Označte fotky, které nechcete smazat — ostatní fotky v této sérii se po potvrzení označí ke smazání'
                : 'Označte fotky k výběru ★ — ostatní fotky v sérii pouze zešednou a nemažou se'
              : isEditingSeries
                ? seriesShots.length <= 1
                  ? 'V okolí nebyly podobné fotky · klepnutím připojíte snímek nebo celou sérii'
                  : 'Klepnutím na vedlejší sérii ji připojíte celou · vybrané lze odebírat po jedné'
                : isDeleteMode
                  ? 'Vpravo nechá tuto fotku a ostatní v této sérii označí ke smazání · vlevo smaže aktuální snímek'
                  : 'Vpravo vybere tuto fotku ★ a ostatní v sérii zešednou (nemažou se)'}
          </span>
        </div>

        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          {isMultiSelectMode ? (
            <>
              <button
                type="button"
                onClick={onConfirmMultiSelect}
                disabled={selectedInActiveSeriesCount === 0}
                title={
                  selectedInActiveSeriesCount === 0
                    ? 'Nejprve označte alespoň jednu fotku v liště'
                    : isDeleteMode
                      ? `Nechat tyto ${selectedInActiveSeriesCount} fotky a zbytek série (${seriesShots.length - selectedInActiveSeriesCount}) označit ke smazání`
                      : `Vybrat ${selectedInActiveSeriesCount} fotek ★ (ostatní v sérii pouze zešednou)`
                }
                className="min-h-[32px] sm:min-h-[34px] inline-flex items-center gap-1 px-2.5 sm:px-3 py-1 rounded-md border border-emerald-400 bg-emerald-500 text-zinc-950 text-[11px] font-semibold hover:bg-emerald-400 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed tabular-nums"
              >
                <Check className="w-3.5 h-3.5 stroke-[2.75]" aria-hidden="true" />
                <span>
                  {isDeleteMode
                    ? `Nemazat tyto (${selectedInActiveSeriesCount})`
                    : `Vybrat (${selectedInActiveSeriesCount})`}
                </span>
              </button>

              <button
                type="button"
                onClick={onToggleMultiSelectMode}
                className="min-h-[32px] sm:min-h-[34px] inline-flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-md border border-zinc-700 bg-[#141417] text-[11px] font-medium text-zinc-200 hover:text-white hover:border-zinc-500 transition-colors cursor-pointer whitespace-nowrap"
              >
                <X className="w-3 h-3" aria-hidden="true" />
                <span>Zrušit</span>
              </button>
            </>
          ) : (
            <>
              {!isEditingSeries && (
                <>
                  {isDeleteMode && onDeleteEntireSeries && (
                    <button
                      type="button"
                      onClick={onDeleteEntireSeries}
                      disabled={seriesShots.length === 0}
                      aria-label={`Smazat celou sérii (${seriesShots.length} snímků)`}
                      title={`Smazat celou sérii (${seriesShots.length} snímků)`}
                      className="min-h-[30px] sm:min-h-[32px] inline-flex items-center gap-1 px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-md border border-rose-500/50 bg-rose-500/15 text-[11px] font-medium text-rose-200 hover:bg-rose-500/28 hover:border-rose-400/70 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40"
                    >
                      <Trash2
                        className="w-3.5 h-3.5 text-rose-300 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="hidden sm:inline">Smazat sérii</span>
                    </button>
                  )}

                  {!isDeleteMode && onKeepEntireSeries && seriesShots.length >= 2 && (
                    <button
                      type="button"
                      onClick={onKeepEntireSeries}
                      aria-label={`Vybrat celou sérii (${seriesShots.length} snímků)`}
                      title={`Vybrat celou sérii (${seriesShots.length} snímků)`}
                      className="min-h-[30px] sm:min-h-[32px] inline-flex items-center gap-1 px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-md border border-amber-500/50 bg-amber-500/15 text-[11px] font-medium text-amber-200 hover:bg-amber-500/28 hover:border-amber-400/70 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <CheckCheck
                        className="w-3.5 h-3.5 text-amber-300 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="hidden sm:inline">Vybrat sérii</span>
                    </button>
                  )}

                  {seriesShots.length >= 2 && (
                    <button
                      type="button"
                      onClick={onToggleMultiSelectMode}
                      aria-label={
                        isDeleteMode
                          ? 'Označit více fotek, které se nemají smazat'
                          : 'Vybrat více fotek v této sérii'
                      }
                      className="min-h-[30px] sm:min-h-[32px] inline-flex items-center gap-1 px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-md border border-zinc-700 bg-[#141417] text-[11px] font-medium text-emerald-200 hover:border-emerald-400/60 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <ListChecks
                        className="w-3 h-3 text-emerald-300 shrink-0"
                        aria-hidden="true"
                      />
                      <span>
                        {isDeleteMode ? (
                          <>
                            Nemazat<span className="hidden sm:inline"> více</span>
                          </>
                        ) : (
                          <>
                            Vybrat<span className="hidden sm:inline"> více</span>
                          </>
                        )}
                      </span>
                    </button>
                  )}
                </>
              )}

              <button
                type="button"
                onClick={onToggleEditingSeries}
                aria-label={
                  isEditingSeries ? 'Ukončit úpravu série' : 'Upravit členy série'
                }
                className={`min-h-[30px] sm:min-h-[32px] inline-flex items-center gap-1 px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-md border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  isEditingSeries
                    ? 'border-amber-400 bg-amber-500 text-zinc-950 font-semibold'
                    : 'border-zinc-700 bg-[#141417] text-zinc-200 hover:border-amber-400/60 hover:text-amber-200'
                }`}
              >
                <SlidersHorizontal className="w-3 h-3" aria-hidden="true" />
                <span>{isEditingSeries ? 'Hotovo' : 'Upravit'}</span>
              </button>

              <button
                type="button"
                onClick={onCloseSeries}
                aria-label="Zavřít sérii"
                className="min-h-[30px] sm:min-h-[32px] inline-flex items-center gap-1 px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-md border border-zinc-700 bg-[#141417] text-[11px] font-medium text-zinc-200 hover:text-white hover:border-zinc-500 transition-colors cursor-pointer whitespace-nowrap"
              >
                <X className="w-3 h-3" aria-hidden="true" />
                <span className="hidden sm:inline">Ukončit</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Scrubbing / Multi-Select / Editing Strip (2px inside series, 24px outside series) */}
      <div
        ref={trackRef}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={handleTrackPointerEnd}
        onPointerCancel={handleTrackPointerEnd}
        className={`relative w-full py-1.5 sm:py-2 overflow-x-auto no-scrollbar ${
          isFreeScrollMode ? 'touch-pan-x overscroll-x-contain' : 'touch-none'
        }`}
      >
        <div className="flex min-w-full w-max px-3">
          <div className="mx-auto flex items-center gap-[2px]">
            {displayShots.map((shot, idx) => {
              const isInSeries = seriesShotIds.has(shot.id);
              const isActive = shot.id === activeShotId;
              const isMultiSelected = selectedMultiIds.has(shot.id);

              const selectState: SelectModeState =
                selectStateByShotId[shot.id] || 'unrated';
              const isSelectedInSelectMode =
                !isDeleteMode && selectState === 'selected';
              const isDimmedInSelectMode =
                !isDeleteMode &&
                !isSelectedInSelectMode &&
                (selectState === 'dimmed' || autoDimmedShotIds.has(shot.id));

              const fileId = shot.primary.id;
              const thumbUrl = getShotThumbUrl(shot);
              const neighborGroup =
                isEditingSeries && !isInSeries
                  ? burstGroupByShotId?.get(shot.id)
                  : undefined;
              const isNeighborGroup = Boolean(
                neighborGroup && neighborGroup.shots.length > 1
              );

              const prevShot = idx > 0 ? displayShots[idx - 1] : null;
              const prevInSeries = prevShot
                ? seriesShotIds.has(prevShot.id)
                : false;
              const prevNeighborGroupId =
                prevShot && !prevInSeries
                  ? burstGroupByShotId?.get(prevShot.id)?.id || null
                  : null;
              const currNeighborGroupId =
                !isInSeries && isNeighborGroup
                  ? neighborGroup?.id || null
                  : null;

              const prevSameNeighborGroup =
                isNeighborGroup &&
                idx > 0 &&
                !prevInSeries &&
                prevNeighborGroupId === currNeighborGroupId;

              const sameClusterAsPrev =
                idx === 0 ||
                (isInSeries && prevInSeries) ||
                prevSameNeighborGroup;

              return (
                <button
                  key={shot.id}
                  ref={(el) => {
                    if (el) itemRefs.current.set(shot.id, el);
                    else itemRefs.current.delete(shot.id);
                  }}
                  type="button"
                  onClick={() => {
                    if (isMultiSelectMode) {
                      onToggleMultiSelectShot(shot.id);
                      onSelectShot(shot.id);
                    } else if (isEditingSeries) {
                      onToggleShotInSeries(shot.id);
                    } else {
                      onSelectShot(shot.id);
                    }
                  }}
                  aria-label={
                    isMultiSelectMode
                      ? isMultiSelected
                        ? `Zrušit označení snímku ${shot.primary.name}`
                        : `Označit snímek ${shot.primary.name}`
                      : isEditingSeries
                        ? isInSeries
                          ? `Odebrat ze série: ${shot.primary.name}`
                          : isNeighborGroup
                            ? `Připojit celou sérii (${neighborGroup!.shots.length} snímků): ${shot.primary.name}`
                            : `Zařadit do série: ${shot.primary.name}`
                        : `Porovnat snímek ${shot.primary.name}`
                  }
                  aria-pressed={
                    isMultiSelectMode
                      ? isMultiSelected
                      : isEditingSeries
                        ? isInSeries
                        : isActive
                  }
                  className={`relative h-[56px] sm:h-[74px] w-[58px] sm:w-[66px] shrink-0 overflow-hidden rounded-lg transition-all duration-100 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-400 ${
                    !sameClusterAsPrev ? 'ml-[22px]' : ''
                  } ${
                    isMultiSelectMode
                      ? isMultiSelected
                        ? `border-2 border-emerald-400 bg-zinc-900 opacity-100 shadow-[0_0_12px_rgba(16,185,129,0.28)] ${
                            isActive ? 'ring-1 ring-white/85' : ''
                          }`
                        : `border border-zinc-700/85 bg-zinc-900 opacity-65 hover:opacity-100 ${
                            isActive ? 'ring-1 ring-white/65 opacity-90' : ''
                          }`
                      : isEditingSeries
                        ? isInSeries
                          ? 'border-2 border-amber-400 bg-zinc-900 opacity-100 shadow-[0_0_12px_rgba(245,158,11,0.25)]'
                          : isNeighborGroup
                            ? 'border border-zinc-500/90 bg-zinc-900 opacity-75 hover:opacity-100 hover:border-amber-300/70'
                            : 'border border-zinc-700/80 bg-zinc-900 opacity-45 hover:opacity-80'
                        : isActive
                          ? 'ring-2 ring-white ring-offset-2 ring-offset-[#0D0D10] scale-[1.04] bg-zinc-900 z-10'
                          : isSelectedInSelectMode
                            ? 'border-2 border-amber-400 bg-zinc-900'
                            : 'border border-zinc-700 bg-zinc-900 opacity-85 hover:opacity-100'
                  }`}
                >
                  {thumbUrl ? (
                    <img
                      src={thumbUrl}
                      alt={shot.primary.name}
                      referrerPolicy="no-referrer"
                      draggable={false}
                      onError={() => {
                        setThumbs((prev) => {
                          if (!prev[fileId]) return prev;
                          const next = { ...prev };
                          delete next[fileId];
                          return next;
                        });
                      }}
                      className={`h-full w-full object-cover pointer-events-none ${
                        isDimmedInSelectMode ? 'opacity-35 grayscale' : ''
                      }`}
                    />
                  ) : (
                    <div className="h-full w-full flex flex-col items-center justify-center gap-0.5 text-zinc-600 pointer-events-none">
                      <ImageIcon className="w-3.5 h-3.5" aria-hidden="true" />
                      <span className="font-mono text-[9px] uppercase">
                        {shot.primary.fileExtension}
                      </span>
                    </div>
                  )}

                  {/* Neighbor Series Count Badge During Edit Mode */}
                  {isEditingSeries &&
                    isNeighborGroup &&
                    !prevSameNeighborGroup && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1 left-1 px-1 rounded bg-zinc-950/90 border border-zinc-600 text-[9px] font-mono font-semibold text-zinc-200 leading-tight tabular-nums"
                      >
                        +{neighborGroup!.shots.length}×
                      </span>
                    )}

                  {/* Selected Star Marker (ONLY in Výběr mode!) */}
                  {!isMultiSelectMode && isSelectedInSelectMode && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute bottom-1 left-1 flex h-4 w-4 items-center justify-center rounded bg-amber-400 text-zinc-950 shadow"
                    >
                      <Star className="w-2.5 h-2.5 fill-zinc-950" />
                    </span>
                  )}

                  {/* Multi-Select Checkbox Badge */}
                  {isMultiSelectMode && (
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full shadow transition-colors ${
                        isMultiSelected
                          ? 'bg-emerald-400 text-zinc-950'
                          : 'border-2 border-zinc-300/80 bg-black/55 text-transparent'
                      }`}
                    >
                      <Check className="w-3 h-3 stroke-[3]" />
                    </span>
                  )}

                  {/* Series Membership Checkmark Only During Edit Mode */}
                  {!isMultiSelectMode && isEditingSeries && isInSeries && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 text-zinc-950 shadow"
                    >
                      <Check className="w-3 h-3 stroke-[3]" />
                    </span>
                  )}

                  {/* Active Scrub Bottom Accent Bar */}
                  {!isEditingSeries && isActive && (
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute bottom-0 inset-x-0 h-1 ${
                        isMultiSelectMode ? 'bg-emerald-400' : 'bg-amber-400'
                      }`}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

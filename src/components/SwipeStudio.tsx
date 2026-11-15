import React, {
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  startTransition,
} from 'react';
import {
  motion,
  useMotionValue,
  useTransform,
  useReducedMotion,
  AnimatePresence,
  animate,
} from 'motion/react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Star,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Info,
  FolderOpen,
  Sparkles,
  ImageOff,
  CheckCircle2,
  Link2,
  RefreshCw,
  Layers,
  SlidersHorizontal,
  X,
  Clock,
  Eye,
  Smartphone,
  FolderCheck,
  LayoutGrid,
  Maximize2,
  Check,
  Trash2,
} from 'lucide-react';
import { AppMode } from '../lib/appMode';
import {
  AuthExpiredError,
  DriveFolder,
  DrivePhotoFile,
  LIKED_SUBFOLDER_NAME,
  formatBytes,
  getFileStem,
} from '../lib/driveApi';
import {
  ResolvedPhotoMedia,
  extractExifTimestampFromHeader,
  formatShutterSpeed,
  getFastPreviewThumbnailUrl,
  getUpgradeThumbnailUrl,
  preloadImageUrl,
  resolveFastTempRawPreview,
  resolvePhotoMedia,
} from '../lib/rawParser';
import {
  HIGH_MATCH_VISUAL_MAX_GAP_MS,
  PhotoBurstGroup,
  PhotoShotItem,
  STANDARD_VISUAL_MAX_GAP_MS,
  buildShotItems,
  groupShotsIntoSeries,
  orderShotsChronologically,
} from '../lib/burstGrouping';
import {
  CustomVisualCalibration,
  SimilaritySensitivity,
  VisualCalibrationExample,
  VisualFingerprint,
  areVisuallySimilar,
  computePhotoFingerprint,
} from '../lib/visualSimilarity';
import {
  FolderResumeTarget,
  PersistedDecisionEntry,
  PersistedFolderSummary,
  SelectionRating,
  ShardEntriesMap,
  resetFolderDecisions,
  saveFolderDecisionDeltas,
} from '../lib/cullPersistence';
import {
  clearLocalResumePosition,
  resetLocalFolderDecisions,
  saveLocalFolderDecisions,
  writeLocalResumePosition,
} from '../lib/localPersistence';
import {
  HapticIntensity,
  HapticSettings,
  isHapticsSupported,
  isIOSDevice,
  loadHapticSettings,
  saveHapticSettings,
  triggerHaptic,
} from '../lib/haptics';
import { Filmstrip } from './Filmstrip';
import { GalleryGridView } from './GalleryGridView';
import { SeriesCalibrationModal } from './SeriesCalibrationModal';
import { SeriesScrubStrip } from './SeriesScrubStrip';

export type FormatFilter = 'all' | 'raw' | 'standard';

interface UndoStep {
  files: DrivePhotoFile[];
  prevEntries: Record<string, PersistedDecisionEntry | null>;
  prevActiveShotId: string | null;
  removedFromSeriesShotId?: string;
  restoredSeriesShotIds?: string[];
  wasSeriesOpen?: boolean;
  wasManualSeriesPinned?: boolean;
}

interface SwipeStudioProps {
  appMode: AppMode;
  onSwitchAppMode: (mode: AppMode) => void;
  userId?: string | null;
  folder: DriveFolder;
  photos: DrivePhotoFile[];
  accessToken?: string | null;
  initialDecisions: Record<string, PersistedDecisionEntry>;
  initialShardMap: ShardEntriesMap;
  initialResumeTarget?: FolderResumeTarget | null;
  isDecisionsLoaded: boolean;
  isLoadingMore: boolean;
  loadMoreError: string | null;
  onRetryLoadMore: () => void;
  onBackToFolders: () => void;
  onAuthExpired: () => void;
  onRequestFinishSelection: (
    pickedFiles: DrivePhotoFile[],
    pickedShotCount: number,
    thumbnails: Record<string, string>
  ) => void;
  onRequestFinishTrash: (
    trashFiles: DrivePhotoFile[],
    trashShotCount: number,
    thumbnails: Record<string, string>
  ) => void;
  onSelectionUpdate?: (
    pickedFiles: DrivePhotoFile[],
    pickedShotCount: number,
    thumbnails: Record<string, string>,
    trashFiles: DrivePhotoFile[],
    trashShotCount: number
  ) => void;
  onUpdatePhotoTimestamps?: (
    updates: Record<string, { ms: number; label: string }>
  ) => void;
  onFolderSummaryChange?: (summary: PersistedFolderSummary | null) => void;
  movedOutIds: Set<string>;
  isFinishModalOpen: boolean;
  lastActionSummary: string | null;
}

export const SwipeStudio: React.FC<SwipeStudioProps> = ({
  appMode,
  onSwitchAppMode,
  userId,
  folder,
  photos,
  accessToken,
  initialDecisions,
  initialShardMap,
  initialResumeTarget = null,
  isDecisionsLoaded,
  isLoadingMore,
  loadMoreError,
  onRetryLoadMore,
  onBackToFolders,
  onAuthExpired,
  onRequestFinishSelection,
  onRequestFinishTrash,
  onSelectionUpdate,
  onUpdatePhotoTimestamps,
  onFolderSummaryChange,
  movedOutIds,
  isFinishModalOpen,
  lastActionSummary,
}) => {
  const isFrameCull = appMode === 'framecull';
  const isLocalSource = Boolean(
    folder.sourceKind && folder.sourceKind !== 'drive'
  );
  const [hapticSettings, setHapticSettings] = useState<HapticSettings>(() =>
    loadHapticSettings()
  );
  const hapticSettingsRef = useRef(hapticSettings);
  hapticSettingsRef.current = hapticSettings;
  const hapticsSupported = isHapticsSupported();
  const isIos = isIOSDevice();

  const updateHapticSettings = useCallback((next: HapticSettings) => {
    setHapticSettings(next);
    hapticSettingsRef.current = next;
    saveHapticSettings(next);
    if (next.enabled) {
      triggerHaptic('selection', next);
    }
  }, []);

  // Raw live photos (excluding any files permanently moved out to Liked)
  const activePhotos = useMemo(
    () => photos.filter((p) => !movedOutIds.has(p.id)),
    [photos, movedOutIds]
  );

  // Buffered settled photo snapshot prevents UI stutter when 10k+ Drive/local batches stream in
  const [settledPhotos, setSettledPhotos] = useState<DrivePhotoFile[]>(
    () => activePhotos
  );
  const activeBurstRef = useRef<boolean>(false);

  useEffect(() => {
    setSettledPhotos((prev) => {
      const next = prev.filter((p) => !movedOutIds.has(p.id));
      return next.length === prev.length ? prev : next;
    });
  }, [movedOutIds]);

  const photosById = useMemo(() => {
    const map = new Map<string, DrivePhotoFile>();
    for (const p of activePhotos) {
      map.set(p.id, p);
    }
    return map;
  }, [activePhotos]);

  // Selection ratings state: only 'pick' and 'reject' are stored; absent = 'unrated'
  const [ratingsMap, setRatingsMap] = useState<
    Record<string, PersistedDecisionEntry>
  >({});
  const [undoStack, setUndoStack] = useState<UndoStep[]>([]);
  const undoStackRef = useRef<UndoStep[]>(undoStack);
  undoStackRef.current = undoStack;
  const [ratingsHydrated, setRatingsHydrated] = useState(false);
  const [syncStatus, setSyncStatus] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const shardMapRef = useRef<ShardEntriesMap>(initialShardMap);
  const lastSavedEntriesRef =
    useRef<Record<string, PersistedDecisionEntry>>(initialDecisions);
  const syncTimerRef = useRef<number | null>(null);
  const cursorSyncTimerRef = useRef<number | null>(null);
  const inFlightSyncRef = useRef<Promise<void>>(Promise.resolve());

  // Exact resume position tracking (remember exact frame even when browsing without starring/rejecting)
  const [pendingResumeTarget, setPendingResumeTarget] =
    useState<FolderResumeTarget | null>(null);
  const resumeInitDoneRef = useRef(false);
  const [resumeImageReady, setResumeImageReady] = useState(false);
  const lastSavedResumeShotIdRef = useRef<string | null>(
    initialResumeTarget?.shotId ?? null
  );
  const currentResumeCursorRef = useRef<{
    shotId: string;
    fileName: string;
    stem: string;
  } | null>(null);

  const [formatFilter, setFormatFilter] = useState<FormatFilter>('all');
  const [pairSelectEnabled, setPairSelectEnabled] = useState(true);
  // Auto series discovery is ON by default; can be disabled in Settings for manual single-shot lookup
  const [autoSeriesEnabled, setAutoSeriesEnabled] = useState<boolean>(() => {
    try {
      const saved = window.localStorage.getItem('framecull_auto_series_enabled');
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  // Zoomed-out gallery always defaults to "Bez sérií" until user switches to "V sériích"
  const [gallerySeriesEnabled, setGallerySeriesEnabled] = useState(false);
  const [visualSimilarityEnabled, setVisualSimilarityEnabled] =
    useState<boolean>(() => {
      try {
        const saved = window.localStorage.getItem(
          'framecull_visual_series_enabled'
        );
        return saved === null ? true : saved === 'true';
      } catch {
        return true;
      }
    });
  const [similaritySensitivity, setSimilaritySensitivity] =
    useState<SimilaritySensitivity>(() => {
      try {
        const saved = window.localStorage.getItem(
          'framecull_visual_series_sensitivity_v2'
        );
        return saved === 'strict' || saved === 'loose' ? saved : 'balanced';
      } catch {
        return 'balanced';
      }
    });
  const [customCalibration, setCustomCalibration] =
    useState<CustomVisualCalibration | null>(() => {
      try {
        const raw = window.localStorage.getItem(
          'framecull_visual_calibration_v1'
        );
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CustomVisualCalibration;
        return typeof parsed?.minCenterColor === 'number' ? parsed : null;
      } catch {
        return null;
      }
    });
  const [calibrationExamples, setCalibrationExamples] = useState<
    VisualCalibrationExample[]
  >(() => {
    try {
      const raw = window.localStorage.getItem(
        'framecull_visual_calibration_examples_v1'
      );
      return raw ? (JSON.parse(raw) as VisualCalibrationExample[]) : [];
    } catch {
      return [];
    }
  });
  const [isCalibrationOpen, setIsCalibrationOpen] = useState(false);

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [pickedVisibleLimit, setPickedVisibleLimit] = useState(40);
  const [isEnrichingExif, setIsEnrichingExif] = useState(false);

  // Perceptual visual fingerprints cache keyed by primary file ID
  const [fingerprintsMap, setFingerprintsMap] = useState<
    Record<string, VisualFingerprint>
  >({});
  const fingerprintsRef = useRef(fingerprintsMap);
  fingerprintsRef.current = fingerprintsMap;
  const attemptedFingerprintIdsRef = useRef<Set<string>>(new Set());

  // Chronological active shot, gallery/detail mode & dynamic manual comparison pinning
  const prefersReducedMotion = useReducedMotion();
  const [studioMode, setStudioMode] = useState<'detail' | 'gallery'>('detail');
  const [galleryZoomLevel, setGalleryZoomLevel] = useState<number>(() => {
    try {
      const saved = Number(window.localStorage.getItem('framecull_gallery_zoom'));
      return Number.isFinite(saved) && saved >= 0 && saved <= 3 ? saved : 1;
    } catch {
      return 1;
    }
  });
  const [galleryToDetailAnim, setGalleryToDetailAnim] = useState<{
    offsetX: number;
    offsetY: number;
    startScale: number;
    seq: number;
  } | null>(null);
  const studioCanvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        'framecull_gallery_zoom',
        String(galleryZoomLevel)
      );
    } catch {
      // Ignore storage quota errors
    }
  }, [galleryZoomLevel]);

  const [activeShotId, setActiveShotId] = useState<string | null>(null);
  const [activeSeriesShotIds, setActiveSeriesShotIds] = useState<Set<string>>(
    () => new Set()
  );
  const [isSeriesOpen, setIsSeriesOpen] = useState(false);
  const [isEditingSeries, setIsEditingSeries] = useState(false);
  const [isSeriesMultiSelect, setIsSeriesMultiSelect] = useState(false);
  const [selectedSeriesMultiIds, setSelectedSeriesMultiIds] = useState<
    Set<string>
  >(() => new Set());
  const [isFindingSeries, setIsFindingSeries] = useState(false);

  // Two-stage progressive media maps: fast low-res preview vs sharp upgraded media
  const [tempPreviewMap, setTempPreviewMap] = useState<Record<string, string>>(
    {}
  );
  const tempPreviewMapRef = useRef(tempPreviewMap);
  tempPreviewMapRef.current = tempPreviewMap;
  const [sharpMediaMap, setSharpMediaMap] = useState<
    Record<string, ResolvedPhotoMedia>
  >({});
  const sharpMediaMapRef = useRef(sharpMediaMap);
  sharpMediaMapRef.current = sharpMediaMap;
  const [upgradingMap, setUpgradingMap] = useState<Record<string, boolean>>({});
  const [errorMap, setErrorMap] = useState<Record<string, string>>({});

  useEffect(() => {
    try {
      window.localStorage.setItem(
        'framecull_auto_series_enabled',
        String(autoSeriesEnabled)
      );
      window.localStorage.setItem(
        'framecull_visual_series_enabled',
        String(visualSimilarityEnabled)
      );
      window.localStorage.setItem(
        'framecull_visual_series_sensitivity_v2',
        similaritySensitivity
      );
      if (customCalibration) {
        window.localStorage.setItem(
          'framecull_visual_calibration_v1',
          JSON.stringify(customCalibration)
        );
      } else {
        window.localStorage.removeItem('framecull_visual_calibration_v1');
      }
      if (calibrationExamples.length > 0) {
        window.localStorage.setItem(
          'framecull_visual_calibration_examples_v1',
          JSON.stringify(calibrationExamples)
        );
      } else {
        window.localStorage.removeItem(
          'framecull_visual_calibration_examples_v1'
        );
      }
    } catch {
      // Ignore storage quota issues
    }
  }, [
    autoSeriesEnabled,
    visualSimilarityEnabled,
    similaritySensitivity,
    customCalibration,
    calibrationExamples,
  ]);

  const [isZoomed, setIsZoomed] = useState(false);
  const [isMultiTouchPinching, setIsMultiTouchPinching] = useState(false);
  const [showExifPanel, setShowExifPanel] = useState(false);
  const [exitingSwipeCard, setExitingSwipeCard] = useState<{
    key: string;
    url?: string;
    name: string;
    dir: 'left' | 'right';
    startX: number;
  } | null>(null);

  const [zoomContainerEl, setZoomContainerEl] = useState<HTMLDivElement | null>(
    null
  );
  const zoomContainerRef = useRef<HTMLDivElement | null>(null);
  const zoomLayerRef = useRef<HTMLDivElement | null>(null);
  const zoomImgRef = useRef<HTMLImageElement | null>(null);
  const zoomContainerOwnerRef = useRef<string | null>(null);
  const zoomLayerOwnerRef = useRef<string | null>(null);
  const zoomImgOwnerRef = useRef<string | null>(null);
  const zoomReadoutRef = useRef<HTMLSpanElement>(null);
  const zoomTransformRef = useRef<{ scale: number; tx: number; ty: number }>({
    scale: 1,
    tx: 0,
    ty: 0,
  });
  const zoomFocusNormRef = useRef<{ relX: number; relY: number }>({
    relX: 0.5,
    relY: 0.5,
  });
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(
    new Map()
  );
  const gestureStateRef = useRef<{
    mode: 'idle' | 'undecided' | 'swipe' | 'pan';
    startClientX: number;
    startClientY: number;
    lastClientX: number;
    lastClientY: number;
    startLocalX: number;
    startLocalY: number;
    lastMidX: number;
    lastMidY: number;
    lastMoveTime: number;
    velocityX: number;
    movedDistance: number;
    wasMultiTouch: boolean;
  }>({
    mode: 'idle',
    startClientX: 0,
    startClientY: 0,
    lastClientX: 0,
    lastClientY: 0,
    startLocalX: 0,
    startLocalY: 0,
    lastMidX: 0,
    lastMidY: 0,
    lastMoveTime: 0,
    velocityX: 0,
    movedDistance: 0,
    wasMultiTouch: false,
  });
  const suppressNextClickRef = useRef(false);
  const lastTouchTimeRef = useRef(0);
  const swipeAnimControlsRef = useRef<ReturnType<typeof animate> | null>(null);

  const dragX = useMotionValue(0);
  const cardRotate = useTransform(dragX, [-240, 0, 240], [-10, 0, 10]);
  const pickOpacity = useTransform(dragX, [35, 120], [0, 1]);
  const rejectOpacity = useTransform(dragX, [-35, -120], [0, 1]);
  const swipeThresholdSideRef = useRef<'pick' | 'reject' | null>(null);

  useEffect(() => {
    return dragX.on('change', (latestX) => {
      if (isZoomed) {
        swipeThresholdSideRef.current = null;
        return;
      }
      const nextSide: 'pick' | 'reject' | null =
        latestX > 105 ? 'pick' : latestX < -105 ? 'reject' : null;
      if (nextSide && nextSide !== swipeThresholdSideRef.current) {
        triggerHaptic('threshold', hapticSettingsRef.current);
      }
      swipeThresholdSideRef.current = nextSide;
    });
  }, [dragX, isZoomed]);

  // Hydrate persisted ratings and resume position once when loaded for this folder
  useEffect(() => {
    if (!isDecisionsLoaded || ratingsHydrated) return;
    shardMapRef.current = initialShardMap;
    lastSavedEntriesRef.current = initialDecisions;

    const cleaned: Record<string, PersistedDecisionEntry> = {};
    for (const [fileId, entry] of Object.entries(initialDecisions)) {
      if (movedOutIds.has(fileId)) continue;
      cleaned[fileId] = entry;
    }

    if (!resumeInitDoneRef.current) {
      resumeInitDoneRef.current = true;
      if (
        initialResumeTarget &&
        (initialResumeTarget.shotId ||
          initialResumeTarget.fileName ||
          initialResumeTarget.stem)
      ) {
        setPendingResumeTarget(initialResumeTarget);
        setResumeImageReady(false);
        lastSavedResumeShotIdRef.current =
          initialResumeTarget.shotId ?? null;
      }
    }

    setRatingsMap(cleaned);
    setRatingsHydrated(true);
    if (Object.keys(cleaned).length > 0) {
      setSyncStatus('saved');
    }
  }, [
    isDecisionsLoaded,
    ratingsHydrated,
    initialDecisions,
    initialShardMap,
    initialResumeTarget,
    movedOutIds,
  ]);

  // Prune entries that were moved out or deleted externally once streaming completes
  useEffect(() => {
    if (!ratingsHydrated) return;
    setRatingsMap((prev) => {
      let changed = false;
      const next: Record<string, PersistedDecisionEntry> = {};
      for (const [fileId, entry] of Object.entries(prev)) {
        if (movedOutIds.has(fileId)) {
          changed = true;
          continue;
        }
        if (!photosById.has(fileId) && !isLoadingMore && !loadMoreError) {
          // Wait: double check if placeholder had a different ext or file really no longer exists
          changed = true;
          continue;
        }
        next[fileId] = entry;
      }
      return changed ? next : prev;
    });
  }, [ratingsHydrated, photosById, movedOutIds, isLoadingMore, loadMoreError]);

  const desiredEntries = useMemo(() => {
    const map: Record<string, PersistedDecisionEntry> = {};
    for (const [fileId, entry] of Object.entries(ratingsMap)) {
      if (movedOutIds.has(fileId)) continue;
      map[fileId] = entry;
    }
    return map;
  }, [ratingsMap, movedOutIds]);

  const desiredEntriesRef = useRef(desiredEntries);
  desiredEntriesRef.current = desiredEntries;

  const flushPersistence = useCallback(async () => {
    if (!ratingsHydrated) return;
    if (!isLocalSource && !userId) return;
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    if (cursorSyncTimerRef.current !== null) {
      window.clearTimeout(cursorSyncTimerRef.current);
      cursorSyncTimerRef.current = null;
    }

    const runSync = async () => {
      const target = desiredEntriesRef.current;
      const prev = lastSavedEntriesRef.current;
      const upserts: Record<string, PersistedDecisionEntry> = {};
      const removals: string[] = [];

      for (const [id, entry] of Object.entries(target)) {
        const old = prev[id];
        if (
          !old ||
          old.decision !== entry.decision ||
          old.batchId !== entry.batchId ||
          old.pairedWith !== entry.pairedWith
        ) {
          upserts[id] = entry;
        }
      }
      for (const id of Object.keys(prev)) {
        if (!(id in target)) {
          removals.push(id);
        }
      }

      const cursorToSave = currentResumeCursorRef.current;
      const hasDecisionChanges =
        Object.keys(upserts).length > 0 || removals.length > 0;
      const hasCursorChange = Boolean(
        cursorToSave &&
          cursorToSave.shotId !== lastSavedResumeShotIdRef.current
      );

      if (!hasDecisionChanges && !hasCursorChange) {
        return;
      }

      setSyncStatus('saving');
      try {
        if (isLocalSource) {
          const summary = await saveLocalFolderDecisions({
            folderId: folder.id,
            folderName: folder.name,
            entries: target,
            lastShotId: cursorToSave?.shotId,
            lastShotName: cursorToSave?.fileName,
          });
          lastSavedEntriesRef.current = target;
          if (cursorToSave?.shotId) {
            lastSavedResumeShotIdRef.current = cursorToSave.shotId;
          }
          setSyncStatus('saved');
          onFolderSummaryChange?.(summary);
          return;
        }

        const nextShards = await saveFolderDecisionDeltas({
          userId: userId!,
          folderId: folder.id,
          folderName: folder.name,
          shardMap: shardMapRef.current,
          upserts,
          removals,
          lastShotId: cursorToSave?.shotId,
          lastShotName: cursorToSave?.fileName,
          forceFolderSummaryWrite: hasCursorChange,
        });
        shardMapRef.current = nextShards;
        lastSavedEntriesRef.current = target;
        if (cursorToSave?.shotId) {
          lastSavedResumeShotIdRef.current = cursorToSave.shotId;
        }
        setSyncStatus('saved');

        let pickCount = 0;
        let rejectCount = 0;
        for (const e of Object.values(target)) {
          if (e.decision === 'reject') rejectCount++;
          else pickCount++;
        }
        onFolderSummaryChange?.(
          pickCount + rejectCount > 0 || Boolean(cursorToSave?.shotId)
            ? {
                folderId: folder.id,
                folderName: folder.name,
                keepCount: pickCount,
                trashCount: rejectCount,
                ...(cursorToSave?.shotId
                  ? { lastShotId: cursorToSave.shotId }
                  : {}),
                ...(cursorToSave?.fileName
                  ? { lastShotName: cursorToSave.fileName }
                  : {}),
                updatedAtMs: Date.now(),
              }
            : null
        );
      } catch {
        setSyncStatus('error');
      }
    };

    inFlightSyncRef.current = inFlightSyncRef.current.then(runSync, runSync);
    return inFlightSyncRef.current;
  }, [
    ratingsHydrated,
    isLocalSource,
    userId,
    folder.id,
    folder.name,
    onFolderSummaryChange,
  ]);

  // Debounced incremental sync whenever ratings change
  useEffect(() => {
    if (!ratingsHydrated) return;
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
    }
    syncTimerRef.current = window.setTimeout(() => {
      void flushPersistence();
    }, 350);

    return () => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
  }, [desiredEntries, ratingsHydrated, flushPersistence]);

  // Flush saved progress + exact photo cursor when hiding tab, closing, or unmounting
  useEffect(() => {
    const handlePageHide = () => {
      void flushPersistence();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        void flushPersistence();
      }
    };
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (cursorSyncTimerRef.current !== null) {
        window.clearTimeout(cursorSyncTimerRef.current);
        cursorSyncTimerRef.current = null;
      }
      void flushPersistence();
    };
  }, [flushPersistence]);

  // Count paired JPG+RAW groups and format filter counts
  const { pairCount, filterCounts } = useMemo(() => {
    let rawCount = 0;
    let stdCount = 0;
    const byStem = new Map<string, DrivePhotoFile[]>();

    for (const p of activePhotos) {
      if (p.isRaw) rawCount++;
      else stdCount++;

      const list = byStem.get(p.stem);
      if (list) list.push(p);
      else byStem.set(p.stem, [p]);
    }

    let pairs = 0;
    for (const group of byStem.values()) {
      const hasRaw = group.some((g) => g.isRaw);
      const hasStd = group.some((g) => !g.isRaw);
      if (hasRaw && hasStd) pairs++;
    }

    return {
      pairCount: pairs,
      filterCounts: {
        all: activePhotos.length,
        raw: rawCount,
        standard: stdCount,
      },
    };
  }, [activePhotos]);

  // Build ALL shots in chronological order for continuous Filmstrip & non-destructive curation
  const allOrderedShots = useMemo(
    () =>
      orderShotsChronologically(
        buildShotItems(settledPhotos, {
          pairEnabled: pairSelectEnabled,
          formatFilter,
        })
      ),
    [settledPhotos, pairSelectEnabled, formatFilter]
  );

  // Buffer incoming Drive/local batches smoothly when zoomed or actively in a burst
  useEffect(() => {
    if (settledPhotos === activePhotos) return;
    if (
      settledPhotos.length === 0 ||
      !isLoadingMore ||
      (!activeBurstRef.current && !isZoomed)
    ) {
      startTransition(() => {
        setSettledPhotos(activePhotos);
      });
    }
  }, [activePhotos, settledPhotos, isLoadingMore, isZoomed]);

  const shotsById = useMemo(() => {
    const map = new Map<string, PhotoShotItem>();
    for (const s of allOrderedShots) {
      map.set(s.id, s);
    }
    return map;
  }, [allOrderedShots]);

  // Effective rating per shot: 'pick' takes priority over 'reject'; absent = 'unrated'
  const ratingsByShotId = useMemo(() => {
    const map: Record<string, SelectionRating> = {};
    for (const shot of allOrderedShots) {
      let hasPick = false;
      let hasReject = false;
      for (const f of shot.files) {
        const entry = ratingsMap[f.id];
        if (entry?.decision === 'pick') {
          hasPick = true;
          break;
        }
        if (entry?.decision === 'reject') {
          hasReject = true;
        }
      }
      map[shot.id] = hasPick ? 'pick' : hasReject ? 'reject' : 'unrated';
    }
    return map;
  }, [allOrderedShots, ratingsMap]);

  // Compute non-rejected shots for automatic burst grouping & chronological stepping
  const nonRejectedShots = useMemo(
    () =>
      allOrderedShots.filter(
        (s) => (ratingsByShotId[s.id] || 'unrated') !== 'reject'
      ),
    [allOrderedShots, ratingsByShotId]
  );

  // Picked & Trash files across the ENTIRE folder (including paired RAW files when pairing is enabled)
  const {
    pickedShotsList,
    pickedFiles,
    pickedBytes,
    trashShotsList,
    trashFiles,
    trashBytes,
    rejectedCount,
    unratedCount,
  } = useMemo(() => {
    const pickedStems = new Set<string>();
    const pickedFileIdSet = new Set<string>();
    const trashStems = new Set<string>();
    const trashFileIdSet = new Set<string>();

    for (const [id, entry] of Object.entries(ratingsMap)) {
      if (movedOutIds.has(id)) continue;
      const photo = photosById.get(id);
      const stem = photo ? photo.stem : getFileStem(entry.name);
      if (entry.decision === 'pick') {
        pickedFileIdSet.add(id);
        pickedStems.add(stem);
      } else if (entry.decision === 'reject') {
        trashFileIdSet.add(id);
        trashStems.add(stem);
      }
    }

    const pickedOut: DrivePhotoFile[] = [];
    let pickedSizeBytes = 0;
    const trashOut: DrivePhotoFile[] = [];
    let trashSizeBytes = 0;

    for (const p of activePhotos) {
      const isPicked =
        pickedFileIdSet.has(p.id) ||
        (pairSelectEnabled && pickedStems.has(p.stem));
      if (isPicked) {
        pickedOut.push(p);
        pickedSizeBytes += p.sizeBytes || 0;
        continue;
      }
      const isTrash =
        trashFileIdSet.has(p.id) ||
        (pairSelectEnabled && trashStems.has(p.stem));
      if (isTrash) {
        trashOut.push(p);
        trashSizeBytes += p.sizeBytes || 0;
      }
    }

    const pShots: PhotoShotItem[] = [];
    const tShots: PhotoShotItem[] = [];
    let uCount = 0;
    for (const s of allOrderedShots) {
      const r = ratingsByShotId[s.id] || 'unrated';
      if (r === 'pick') pShots.push(s);
      else if (r === 'reject') tShots.push(s);
      else uCount++;
    }

    return {
      pickedShotsList: pShots,
      pickedFiles: pickedOut,
      pickedBytes: pickedSizeBytes,
      trashShotsList: tShots,
      trashFiles: trashOut,
      trashBytes: trashSizeBytes,
      rejectedCount: tShots.length,
      unratedCount: uCount,
    };
  }, [
    ratingsMap,
    movedOutIds,
    photosById,
    activePhotos,
    pairSelectEnabled,
    allOrderedShots,
    ratingsByShotId,
  ]);

  // Match pending resume target across all streamed shots (by fileId, exact filename, or stem)
  const matchedResumeShot = useMemo(() => {
    if (!pendingResumeTarget || allOrderedShots.length === 0) return null;
    if (pendingResumeTarget.shotId) {
      const targetId = pendingResumeTarget.shotId;
      const byExact = allOrderedShots.find(
        (s) => s.id === targetId || s.files.some((f) => f.id === targetId)
      );
      if (byExact) return byExact;
    }
    if (pendingResumeTarget.fileName) {
      const lowerName = pendingResumeTarget.fileName.toLowerCase();
      const byName = allOrderedShots.find(
        (s) =>
          s.primary.name.toLowerCase() === lowerName ||
          s.files.some((f) => f.name.toLowerCase() === lowerName)
      );
      if (byName) return byName;
    }
    const targetStem =
      pendingResumeTarget.stem ||
      (pendingResumeTarget.fileName
        ? getFileStem(pendingResumeTarget.fileName)
        : '');
    if (targetStem) {
      const byStem = allOrderedShots.find((s) => s.stem === targetStem);
      if (byStem) return byStem;
    }
    return null;
  }, [pendingResumeTarget, allOrderedShots]);

  const handleSkipResume = useCallback(() => {
    setPendingResumeTarget(null);
    setResumeImageReady(false);
  }, []);

  // Resolve displayedShot cleanly without unexpected jumps as background batches arrive
  const displayedShot: PhotoShotItem | null = useMemo(() => {
    if (allOrderedShots.length === 0) return null;
    if (pendingResumeTarget) {
      return matchedResumeShot;
    }
    if (activeShotId) {
      const exact = shotsById.get(activeShotId);
      if (exact) return exact;
      // Fallback if pairing mode toggled: match by any file ID inside shot
      const byInnerFile = allOrderedShots.find((s) =>
        s.files.some((f) => f.id === activeShotId)
      );
      if (byInnerFile) return byInnerFile;
    }
    return nonRejectedShots[0] || allOrderedShots[0] || null;
  }, [
    allOrderedShots,
    pendingResumeTarget,
    matchedResumeShot,
    shotsById,
    activeShotId,
    nonRejectedShots,
  ]);

  // Synchronize initial activeShotId once shots appear — never jump to #1 while waiting on resume target
  useEffect(() => {
    if (!ratingsHydrated || allOrderedShots.length === 0) return;
    if (pendingResumeTarget) {
      if (matchedResumeShot && activeShotId !== matchedResumeShot.id) {
        setActiveShotId(matchedResumeShot.id);
      }
      return;
    }
    if (!activeShotId || !shotsById.has(activeShotId)) {
      const firstPreferred = nonRejectedShots[0] || allOrderedShots[0];
      if (firstPreferred) {
        setActiveShotId(firstPreferred.id);
      }
    }
  }, [
    ratingsHydrated,
    allOrderedShots,
    pendingResumeTarget,
    matchedResumeShot,
    shotsById,
    activeShotId,
    nonRejectedShots,
  ]);

  const displayedPhoto = displayedShot?.primary || null;

  const isAutoGroupingActive = autoSeriesEnabled || gallerySeriesEnabled;

  // Prioritize fingerprint scanning outward from currently opened displayedShot first
  // (pause fingerprinting while still locating/opening the saved resume target)
  const similarityScanLimit = 400;
  const analyzableShots = useMemo(() => {
    if (pendingResumeTarget || !displayedShot) return [];
    const n = nonRejectedShots.length;
    if (n === 0) return [];
    const idx = nonRejectedShots.findIndex((s) => s.id === displayedShot.id);
    const centerIdx = idx === -1 ? 0 : idx;
    const ordered: PhotoShotItem[] = [nonRejectedShots[centerIdx]];
    const limit = Math.min(n, similarityScanLimit);
    for (let offset = 1; ordered.length < limit; offset++) {
      const right = centerIdx + offset;
      if (right < n) ordered.push(nonRejectedShots[right]);
      if (ordered.length >= limit) break;
      const left = centerIdx - offset;
      if (left >= 0) ordered.push(nonRejectedShots[left]);
    }
    return ordered;
  }, [pendingResumeTarget, nonRejectedShots, displayedShot, similarityScanLimit]);

  // Compute perceptual visual fingerprints in paced background batches without blocking UI
  useEffect(() => {
    if (
      !isAutoGroupingActive ||
      !visualSimilarityEnabled ||
      analyzableShots.length < 2
    ) {
      return;
    }

    const controller = new AbortController();
    const pendingShots = analyzableShots.filter((shot) => {
      const id = shot.primary.id;
      if (fingerprintsRef.current[id]) return false;
      const localUrl =
        sharpMediaMapRef.current[id]?.url || tempPreviewMapRef.current[id];
      if (localUrl?.startsWith('blob:')) {
        return true;
      }
      return !attemptedFingerprintIdsRef.current.has(id);
    });

    if (pendingShots.length === 0) return;

    let cursor = 0;
    const bufferUpdates: Record<string, VisualFingerprint> = {};
    let flushScheduled = false;

    const flushBatch = () => {
      flushScheduled = false;
      const entries = Object.entries(bufferUpdates);
      if (entries.length === 0) return;
      const copy = { ...bufferUpdates };
      for (const k of Object.keys(bufferUpdates)) {
        delete bufferUpdates[k];
      }
      startTransition(() => {
        setFingerprintsMap((prev) => ({ ...prev, ...copy }));
      });
    };

    const scheduleFlush = () => {
      if (flushScheduled) return;
      flushScheduled = true;
      window.setTimeout(() => {
        if (!controller.signal.aborted) flushBatch();
      }, 160);
    };

    const runWorker = async () => {
      while (!controller.signal.aborted && cursor < pendingShots.length) {
        const idx = cursor++;
        const shot = pendingShots[idx];
        const file = shot.primary;
        if (fingerprintsRef.current[file.id]) continue;

        attemptedFingerprintIdsRef.current.add(file.id);
        const existingLocalUrl =
          sharpMediaMapRef.current[file.id]?.url ||
          tempPreviewMapRef.current[file.id];

        const fp = await computePhotoFingerprint(accessToken, file, {
          existingLocalUrl,
          signal: controller.signal,
        });

        if (controller.signal.aborted) return;
        if (fp) {
          bufferUpdates[file.id] = fp;
          if (Object.keys(bufferUpdates).length >= 8) {
            flushBatch();
          } else {
            scheduleFlush();
          }
        }
      }
    };

    const concurrency = 5;
    void Promise.all(
      Array.from({ length: Math.min(concurrency, pendingShots.length) }, () =>
        runWorker()
      )
    ).then(() => {
      if (!controller.signal.aborted) flushBatch();
    });

    return () => {
      controller.abort();
    };
  }, [
    isAutoGroupingActive,
    visualSimilarityEnabled,
    analyzableShots,
    accessToken,
  ]);

  const analyzedVisualCount = useMemo(() => {
    let count = 0;
    for (const s of analyzableShots) {
      if (fingerprintsMap[s.primary.id]) count++;
    }
    return count;
  }, [analyzableShots, fingerprintsMap]);

  // Group non-rejected chronological shots into series via appearance-first matching inside 1-3 minute window
  const burstGroups = useMemo(() => {
    if (!isAutoGroupingActive) return [];
    return groupShotsIntoSeries(nonRejectedShots, {
      maxGapMs: 3000,
      visualEnabled: visualSimilarityEnabled,
      fingerprints: fingerprintsMap,
      sensitivity: similaritySensitivity,
      calibration: customCalibration,
    });
  }, [
    nonRejectedShots,
    isAutoGroupingActive,
    visualSimilarityEnabled,
    fingerprintsMap,
    similaritySensitivity,
    customCalibration,
  ]);

  const burstGroupByShotId = useMemo(() => {
    const map = new Map<string, PhotoBurstGroup>();
    for (const g of burstGroups) {
      for (const shot of g.shots) {
        map.set(shot.id, g);
        for (const f of shot.files) {
          map.set(f.id, g);
        }
      }
    }
    return map;
  }, [burstGroups]);

  const activeBurstGroup: PhotoBurstGroup | null =
    autoSeriesEnabled && displayedShot
      ? burstGroupByShotId.get(displayedShot.id) || null
      : null;

  // Build activeComparisonShots: exclude rejected shots so eliminated frames vanish immediately from open series
  const activeComparisonShots: PhotoShotItem[] = useMemo(() => {
    const rawList =
      activeSeriesShotIds.size > 0
        ? allOrderedShots.filter((s) => activeSeriesShotIds.has(s.id))
        : activeBurstGroup
          ? activeBurstGroup.shots
          : [];
    return rawList.filter(
      (s) => (ratingsByShotId[s.id] || 'unrated') !== 'reject'
    );
  }, [activeSeriesShotIds, allOrderedShots, activeBurstGroup, ratingsByShotId]);

  const activeComparisonIds = useMemo(
    () => new Set(activeComparisonShots.map((s) => s.id)),
    [activeComparisonShots]
  );

  const isComparisonActive = isSeriesOpen && activeComparisonShots.length >= 1;
  activeBurstRef.current = isComparisonActive;

  // Also fingerprint the active displayed photo as soon as a local blob preview resolves
  useEffect(() => {
    if (!isAutoGroupingActive || !visualSimilarityEnabled || !displayedPhoto) return;
    if (fingerprintsRef.current[displayedPhoto.id]) return;
    const localUrl =
      sharpMediaMap[displayedPhoto.id]?.url ||
      tempPreviewMap[displayedPhoto.id];
    if (!localUrl?.startsWith('blob:')) return;

    let cancelled = false;
    void computePhotoFingerprint(accessToken, displayedPhoto, {
      existingLocalUrl: localUrl,
    }).then((fp) => {
      if (!cancelled && fp) {
        startTransition(() => {
          setFingerprintsMap((prev) =>
            prev[displayedPhoto.id] ? prev : { ...prev, [displayedPhoto.id]: fp }
          );
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    isAutoGroupingActive,
    visualSimilarityEnabled,
    displayedPhoto,
    sharpMediaMap,
    tempPreviewMap,
    accessToken,
  ]);

  // Determine the card visually peeking behind the active card
  const nextPeekShot: PhotoShotItem | null = useMemo(() => {
    if (!displayedShot) return null;
    if (isComparisonActive) {
      const idx = activeComparisonShots.findIndex(
        (s) => s.id === displayedShot.id
      );
      if (idx >= 0 && idx + 1 < activeComparisonShots.length) {
        return activeComparisonShots[idx + 1];
      }
    }
    const nonRejIdx = nonRejectedShots.findIndex(
      (s) => s.id === displayedShot.id
    );
    if (nonRejIdx >= 0 && nonRejIdx + 1 < nonRejectedShots.length) {
      return nonRejectedShots[nonRejIdx + 1];
    }
    return null;
  }, [
    displayedShot,
    isComparisonActive,
    activeComparisonShots,
    nonRejectedShots,
  ]);
  const nextPeekPhoto = nextPeekShot?.primary || null;

  const missingExifPhotos = useMemo(() => {
    const stemHasTime = new Set<string>();
    for (const p of activePhotos) {
      if (p.takenAtMs !== null) stemHasTime.add(p.stem);
    }
    return allOrderedShots
      .filter((s) => s.takenAtMs === null && !stemHasTime.has(s.stem))
      .map((s) => s.primary);
  }, [activePhotos, allOrderedShots]);

  const thumbnailUrlLookup = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [id, url] of Object.entries(tempPreviewMap)) {
      map[id] = url;
    }
    for (const [id, media] of Object.entries(sharpMediaMap)) {
      map[id] = media.url;
    }
    return map;
  }, [tempPreviewMap, sharpMediaMap]);

  useEffect(() => {
    if (onSelectionUpdate) {
      onSelectionUpdate(
        pickedFiles,
        pickedShotsList.length,
        thumbnailUrlLookup,
        trashFiles,
        trashShotsList.length
      );
    }
  }, [
    pickedFiles,
    pickedShotsList.length,
    thumbnailUrlLookup,
    trashFiles,
    trashShotsList.length,
    onSelectionUpdate,
  ]);

  const loadingRef = useRef(new Set<string>());

  /**
   * Two-stage progressive loader stabilized via sharpMediaMapRef so completed loads
   * never recreate this callback or re-trigger effects across the deck.
   */
  const loadPhotoProgressive = useCallback(
    async (file: DrivePhotoFile, forceRawDecode = false) => {
      const key = file.id;
      const lockKey = forceRawDecode ? `${key}:raw` : key;
      if (!forceRawDecode && sharpMediaMapRef.current[key]) return;
      if (loadingRef.current.has(lockKey)) return;

      loadingRef.current.add(lockKey);
      setUpgradingMap((prev) => ({ ...prev, [key]: true }));
      setErrorMap((prev) => {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });

      try {
        if (!forceRawDecode) {
          const fastThumb =
            !file.sourceKind || file.sourceKind === 'drive'
              ? getFastPreviewThumbnailUrl(file.thumbnailLink)
              : null;
          if (fastThumb) {
            setTempPreviewMap((prev) =>
              prev[key] ? prev : { ...prev, [key]: fastThumb }
            );
          } else if (file.isRaw) {
            resolveFastTempRawPreview(accessToken, file).then((tempUrl) => {
              if (tempUrl) {
                setTempPreviewMap((prev) =>
                  prev[key] ? prev : { ...prev, [key]: tempUrl }
                );
              }
            });
          }
        }

        if (
          !forceRawDecode &&
          file.thumbnailLink &&
          (!file.sourceKind || file.sourceKind === 'drive')
        ) {
          const sharpThumbUrl = getUpgradeThumbnailUrl(file.thumbnailLink);
          if (sharpThumbUrl) {
            try {
              await preloadImageUrl(sharpThumbUrl);
              const resolved = await resolvePhotoMedia(accessToken, file, {
                preferFullRawDecode: false,
              });
              setSharpMediaMap((prev) => ({ ...prev, [key]: resolved }));
              return;
            } catch {
              // Fall through to full RAW/media extraction
            }
          }
        }

        const resolved = await resolvePhotoMedia(accessToken, file, {
          preferFullRawDecode: !isLocalSource || forceRawDecode,
        });
        setSharpMediaMap((prev) => ({ ...prev, [key]: resolved }));
      } catch (err: unknown) {
        if (err instanceof AuthExpiredError) {
          onAuthExpired();
          return;
        }
        setErrorMap((prev) => ({
          ...prev,
          [key]:
            err instanceof Error
              ? err.message
              : 'Nepodařilo se načíst náhled fotografie.',
        }));
      } finally {
        loadingRef.current.delete(lockKey);
        setUpgradingMap((prev) => ({ ...prev, [key]: false }));
      }
    },
    [accessToken, isLocalSource, onAuthExpired]
  );

  // Zoom & Pan Engine (1:1 tap/click zoom 2.5x, 1-finger pan, 2-finger pinch up to 6x, wheel zoom)
  const CLICK_ZOOM_SCALE = 2.5;
  const MAX_ZOOM_SCALE = 6;
  const MIN_PINCH_EXIT_SCALE = 1.05;

  const toLocalPoint = useCallback(
    (clientX: number, clientY: number, containerEl: HTMLDivElement) => {
      const rect = containerEl.getBoundingClientRect();
      const cw = containerEl.clientWidth;
      const ch = containerEl.clientHeight;
      const scaleX = rect.width > 0 && cw > 0 ? cw / rect.width : 1;
      const scaleY = rect.height > 0 && ch > 0 ? ch / rect.height : 1;
      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY,
      };
    },
    []
  );

  const getBaseImageMetrics = useCallback(() => {
    const containerEl = zoomContainerRef.current;
    if (!containerEl) return null;
    const cw = containerEl.clientWidth;
    const ch = containerEl.clientHeight;
    if (cw <= 0 || ch <= 0) {
      return null;
    }

    const imgEl =
      zoomImgRef.current ||
      (zoomLayerRef.current?.querySelector(
        'img[data-zoom-img="true"]'
      ) as HTMLImageElement | null);
    if (!imgEl) {
      return { cw, ch, imgLeft0: 0, imgTop0: 0, imgW0: cw, imgH0: ch };
    }

    // Use layout offset coordinates inside zoomLayerRef (position: relative),
    // which are 100% invariant under CSS transforms on zoomLayerRef and parent cards.
    const boxLeft0 = imgEl.offsetLeft;
    const boxTop0 = imgEl.offsetTop;
    const boxW = imgEl.offsetWidth;
    const boxH = imgEl.offsetHeight;
    if (boxW <= 0 || boxH <= 0) {
      return { cw, ch, imgLeft0: 0, imgTop0: 0, imgW0: cw, imgH0: ch };
    }

    const nw = imgEl.naturalWidth;
    const nh = imgEl.naturalHeight;
    if (nw <= 0 || nh <= 0) {
      return { cw, ch, imgLeft0: boxLeft0, imgTop0: boxTop0, imgW0: boxW, imgH0: boxH };
    }

    const naturalRatio = nw / nh;
    const boxRatio = boxW / boxH;
    let imgW0 = boxW;
    let imgH0 = boxH;
    let imgLeft0 = boxLeft0;
    let imgTop0 = boxTop0;

    if (naturalRatio > boxRatio) {
      imgH0 = boxW / naturalRatio;
      imgTop0 += (boxH - imgH0) / 2;
    } else {
      imgW0 = boxH * naturalRatio;
      imgLeft0 += (boxW - imgW0) / 2;
    }

    return { cw, ch, imgLeft0, imgTop0, imgW0, imgH0 };
  }, []);

  const clampZoomTransform = useCallback(
    (
      rawTx: number,
      rawTy: number,
      rawScale: number,
      metrics: {
        cw: number;
        ch: number;
        imgLeft0: number;
        imgTop0: number;
        imgW0: number;
        imgH0: number;
      }
    ) => {
      const s = Math.max(1, Math.min(MAX_ZOOM_SCALE, rawScale));
      if (s <= 1.001) {
        return { scale: 1, tx: 0, ty: 0 };
      }

      const { cw, ch, imgLeft0, imgTop0, imgW0, imgH0 } = metrics;

      // Allow any point inside the image (corners, edges, portrait or landscape)
      // to be brought cleanly to the geometric center (cw/2, ch/2) of the viewport.
      const minTx = cw / 2 - (imgLeft0 + imgW0) * s;
      const maxTx = cw / 2 - imgLeft0 * s;
      const minTy = ch / 2 - (imgTop0 + imgH0) * s;
      const maxTy = ch / 2 - imgTop0 * s;

      const tx = Math.max(minTx, Math.min(maxTx, rawTx));
      const ty = Math.max(minTy, Math.min(maxTy, rawTy));

      return { scale: s, tx, ty };
    },
    []
  );

  const applyZoomTransformDom = useCallback(
    (
      next: { scale: number; tx: number; ty: number },
      metrics?: {
        cw: number;
        ch: number;
        imgLeft0: number;
        imgTop0: number;
        imgW0: number;
        imgH0: number;
      } | null
    ) => {
      zoomTransformRef.current = next;
      if (zoomLayerRef.current) {
        zoomLayerRef.current.style.transform = `translate3d(${next.tx}px, ${next.ty}px, 0) scale(${next.scale})`;
      }
      if (zoomReadoutRef.current) {
        zoomReadoutRef.current.textContent = `${next.scale.toFixed(1)}×`;
      }
      if (metrics && next.scale > 1.001) {
        const centerX0 = (metrics.cw / 2 - next.tx) / next.scale;
        const centerY0 = (metrics.ch / 2 - next.ty) / next.scale;
        zoomFocusNormRef.current = {
          relX: Math.max(
            0,
            Math.min(1, (centerX0 - metrics.imgLeft0) / Math.max(1, metrics.imgW0))
          ),
          relY: Math.max(
            0,
            Math.min(1, (centerY0 - metrics.imgTop0) / Math.max(1, metrics.imgH0))
          ),
        };
      }
    },
    []
  );

  const resetZoom = useCallback(() => {
    activePointersRef.current.clear();
    suppressNextClickRef.current = false;
    setIsMultiTouchPinching(false);
    zoomFocusNormRef.current = { relX: 0.5, relY: 0.5 };
    applyZoomTransformDom({ scale: 1, tx: 0, ty: 0 });
    setIsZoomed(false);
  }, [applyZoomTransformDom]);

  const zoomAtPoint = useCallback(
    (clientX: number, clientY: number, targetScale = CLICK_ZOOM_SCALE) => {
      swipeAnimControlsRef.current?.stop();
      swipeAnimControlsRef.current = null;
      dragX.set(0);
      const containerEl = zoomContainerRef.current;
      const metrics = getBaseImageMetrics();
      if (!containerEl || !metrics) {
        return;
      }

      const local = toLocalPoint(clientX, clientY, containerEl);
      const anchorX = Math.max(
        metrics.imgLeft0,
        Math.min(metrics.imgLeft0 + metrics.imgW0, local.x)
      );
      const anchorY = Math.max(
        metrics.imgTop0,
        Math.min(metrics.imgTop0 + metrics.imgH0, local.y)
      );

      // Center the exact clicked/tapped spot in the middle of the viewport
      const rawTx = metrics.cw / 2 - anchorX * targetScale;
      const rawTy = metrics.ch / 2 - anchorY * targetScale;
      const next = clampZoomTransform(rawTx, rawTy, targetScale, metrics);
      applyZoomTransformDom(next, metrics);
      setIsZoomed(next.scale > 1.001);
    },
    [
      getBaseImageMetrics,
      toLocalPoint,
      clampZoomTransform,
      applyZoomTransformDom,
      dragX,
    ]
  );

  const toggleCenterZoom = useCallback(() => {
    if (zoomTransformRef.current.scale > 1.001) {
      resetZoom();
      return;
    }
    const containerEl = zoomContainerRef.current;
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    zoomAtPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      CLICK_ZOOM_SCALE
    );
  }, [resetZoom, zoomAtPoint]);

  const handlePhotoViewportClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!currentDisplayUrl) return;
    if (Date.now() - lastTouchTimeRef.current < 700) {
      return;
    }
    if (
      e.target instanceof Element &&
      e.target.closest('button')
    ) {
      return;
    }
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    if (zoomTransformRef.current.scale > 1.001) {
      resetZoom();
      return;
    }
    zoomAtPoint(e.clientX, e.clientY, CLICK_ZOOM_SCALE);
  };

  // Desktop mouse/pen interaction: click-drag at 1x swipes horizontally; click without drag zooms at point; drag when zoomed pans.
  const handleZoomPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    if (Date.now() - lastTouchTimeRef.current < 700) return;
    if (!currentDisplayUrl) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    const containerEl = zoomContainerRef.current;
    if (!containerEl) return;

    swipeAnimControlsRef.current?.stop();
    swipeAnimControlsRef.current = null;
    activePointersRef.current.clear();

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore capture error
    }

    const pt = toLocalPoint(e.clientX, e.clientY, containerEl);
    activePointersRef.current.set(e.pointerId, pt);
    const currentlyZoomed = zoomTransformRef.current.scale > 1.001;
    gestureStateRef.current = {
      mode: currentlyZoomed ? 'pan' : 'undecided',
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      startLocalX: pt.x,
      startLocalY: pt.y,
      lastMidX: pt.x,
      lastMidY: pt.y,
      lastMoveTime: performance.now(),
      velocityX: 0,
      movedDistance: 0,
      wasMultiTouch: false,
    };
  };

  const handleZoomPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    if (!activePointersRef.current.has(e.pointerId)) return;
    const containerEl = zoomContainerRef.current;
    if (!containerEl) return;

    const curr = zoomTransformRef.current;
    const g = gestureStateRef.current;
    // Screen coordinates stay immune to dragX transform on containerEl (prevents jitter oscillation)
    const clientDx = e.clientX - g.lastClientX;
    const clientDy = e.clientY - g.lastClientY;
    g.movedDistance += Math.hypot(clientDx, clientDy);

    const now = performance.now();
    const dt = Math.max(4, now - g.lastMoveTime);
    const instVx = (clientDx / dt) * 1000;
    g.velocityX = g.velocityX * 0.45 + instVx * 0.55;
    g.lastMoveTime = now;
    g.lastClientX = e.clientX;
    g.lastClientY = e.clientY;

    if (curr.scale > 1.001) {
      g.mode = 'pan';
      const pt = toLocalPoint(e.clientX, e.clientY, containerEl);
      activePointersRef.current.set(e.pointerId, pt);
      const dx = pt.x - g.lastMidX;
      const dy = pt.y - g.lastMidY;
      g.lastMidX = pt.x;
      g.lastMidY = pt.y;
      const metrics = getBaseImageMetrics();
      if (metrics) {
        const next = clampZoomTransform(
          curr.tx + dx,
          curr.ty + dy,
          curr.scale,
          metrics
        );
        applyZoomTransformDom(next, metrics);
      }
      return;
    }

    const totalDx = e.clientX - g.startClientX;
    const totalDy = e.clientY - g.startClientY;
    if (
      g.mode === 'undecided' &&
      Math.abs(totalDx) > 8 &&
      Math.abs(totalDx) > Math.abs(totalDy) * 1.05
    ) {
      g.mode = 'swipe';
    }
    if (g.mode === 'swipe') {
      dragX.set(totalDx);
    }
  };

  const handleZoomPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore release errors
      }
    }

    activePointersRef.current.delete(e.pointerId);
    const g = gestureStateRef.current;

    if (g.mode === 'swipe') {
      suppressNextClickRef.current = true;
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 120);

      const offsetX = dragX.get();
      if (
        e.type === 'pointerup' &&
        displayedShot &&
        zoomTransformRef.current.scale <= 1.001
      ) {
        if (offsetX > 95 || (offsetX > 30 && g.velocityX > 420)) {
          handlePrimaryRightActionRef.current('swipe', offsetX);
        } else if (offsetX < -95 || (offsetX < -30 && g.velocityX < -420)) {
          handlePrimaryLeftActionRef.current('swipe', offsetX);
        } else {
          swipeAnimControlsRef.current = animate(dragX, 0, {
            type: 'spring',
            stiffness: 460,
            damping: 34,
          });
        }
      } else {
        swipeAnimControlsRef.current = animate(dragX, 0, {
          type: 'spring',
          stiffness: 460,
          damping: 34,
        });
      }
    } else if (g.movedDistance > 6) {
      suppressNextClickRef.current = true;
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 80);
    }
    g.mode = 'idle';
  };

  const displayedShotRef = useRef<PhotoShotItem | null>(null);
  const currentDisplayUrlRef = useRef<string | undefined>(undefined);
  const handlePrimaryLeftActionRef = useRef<
    (source: 'swipe' | 'click' | 'key', startX?: number) => void
  >(() => {});
  const handlePrimaryRightActionRef = useRef<
    (source: 'swipe' | 'click' | 'key', startX?: number) => void
  >(() => {});

  // Owner-guarded callback refs prevent an exiting AnimatePresence card from clearing the active card's refs
  const stagePhotoId = displayedPhoto?.id ?? null;
  const zoomContainerRefCallback = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) {
        zoomContainerOwnerRef.current = stagePhotoId;
        if (zoomContainerRef.current !== el) {
          zoomContainerRef.current = el;
          setZoomContainerEl(el);
        }
      } else if (zoomContainerOwnerRef.current === stagePhotoId) {
        zoomContainerRef.current = null;
        setZoomContainerEl(null);
      }
    },
    [stagePhotoId]
  );

  const zoomLayerRefCallback = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) {
        zoomLayerOwnerRef.current = stagePhotoId;
        zoomLayerRef.current = el;
      } else if (zoomLayerOwnerRef.current === stagePhotoId) {
        zoomLayerRef.current = null;
      }
    },
    [stagePhotoId]
  );

  const zoomImgRefCallback = useCallback(
    (el: HTMLImageElement | null) => {
      if (el) {
        zoomImgOwnerRef.current = stagePhotoId;
        zoomImgRef.current = el;
      } else if (zoomImgOwnerRef.current === stagePhotoId) {
        zoomImgRef.current = null;
      }
    },
    [stagePhotoId]
  );

  // Native non-passive touch, Safari gesture, and wheel zoom/pinch/pan/swipe engine for iOS/Android PWA & mobile browsers
  useEffect(() => {
    const containerEl = zoomContainerEl;
    if (!containerEl) return;

    type TouchGesture = {
      mode: 'idle' | 'undecided' | 'swipe' | 'pan' | 'pinch';
      hadMultiTouch: boolean;
      startClientX: number;
      startClientY: number;
      lastClientX: number;
      lastClientY: number;
      startLocalX: number;
      startLocalY: number;
      lastLocalX: number;
      lastLocalY: number;
      lastMidX: number;
      lastMidY: number;
      lastPinchDist: number;
      movedDistance: number;
      lastMoveTime: number;
      velocityX: number;
    };

    let activeGesture: TouchGesture | null = null;

    const initPinchFromTouches = (touches: TouchList) => {
      swipeAnimControlsRef.current?.stop();
      swipeAnimControlsRef.current = null;
      dragX.jump(0);
      setIsMultiTouchPinching(true);

      const t0 = touches[0];
      const t1 = touches[1];
      const p0 = toLocalPoint(t0.clientX, t0.clientY, containerEl);
      const p1 = toLocalPoint(t1.clientX, t1.clientY, containerEl);
      const midX = (p0.x + p1.x) / 2;
      const midY = (p0.y + p1.y) / 2;
      const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);

      activeGesture = {
        mode: 'pinch',
        hadMultiTouch: true,
        startClientX: t0.clientX,
        startClientY: t0.clientY,
        lastClientX: t0.clientX,
        lastClientY: t0.clientY,
        startLocalX: midX,
        startLocalY: midY,
        lastLocalX: midX,
        lastLocalY: midY,
        lastMidX: midX,
        lastMidY: midY,
        lastPinchDist: dist,
        movedDistance: 999,
        lastMoveTime: performance.now(),
        velocityX: 0,
      };
    };

    const onTouchStart = (e: TouchEvent) => {
      if (!currentDisplayUrlRef.current) return;
      if (e.target instanceof Element && e.target.closest('button')) return;
      if (e.cancelable) {
        e.preventDefault();
      }
      lastTouchTimeRef.current = Date.now();
      swipeAnimControlsRef.current?.stop();
      swipeAnimControlsRef.current = null;

      if (e.touches.length >= 2) {
        initPinchFromTouches(e.touches);
        return;
      }

      if (e.touches.length === 1) {
        const t = e.touches[0];
        const pt = toLocalPoint(t.clientX, t.clientY, containerEl);
        const zoomed = zoomTransformRef.current.scale > 1.001;
        activeGesture = {
          mode: zoomed ? 'pan' : 'undecided',
          hadMultiTouch: false,
          startClientX: t.clientX,
          startClientY: t.clientY,
          lastClientX: t.clientX,
          lastClientY: t.clientY,
          startLocalX: pt.x,
          startLocalY: pt.y,
          lastLocalX: pt.x,
          lastLocalY: pt.y,
          lastMidX: pt.x,
          lastMidY: pt.y,
          lastPinchDist: 0,
          movedDistance: 0,
          lastMoveTime: performance.now(),
          velocityX: 0,
        };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!currentDisplayUrlRef.current || !activeGesture) return;
      if (e.cancelable) {
        e.preventDefault();
      }
      lastTouchTimeRef.current = Date.now();

      if (e.touches.length >= 2) {
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const p0 = toLocalPoint(t0.clientX, t0.clientY, containerEl);
        const p1 = toLocalPoint(t1.clientX, t1.clientY, containerEl);
        const midX = (p0.x + p1.x) / 2;
        const midY = (p0.y + p1.y) / 2;
        const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);

        if (activeGesture.mode !== 'pinch') {
          initPinchFromTouches(e.touches);
          return;
        }

        const curr = zoomTransformRef.current;
        const metrics = getBaseImageMetrics();
        if (metrics && activeGesture.lastPinchDist > 6 && dist > 6) {
          const ratio = dist / activeGesture.lastPinchDist;
          const targetScale = Math.max(
            1,
            Math.min(MAX_ZOOM_SCALE, curr.scale * ratio)
          );
          const scaleFactor = targetScale / curr.scale;
          const rawTx = midX - (activeGesture.lastMidX - curr.tx) * scaleFactor;
          const rawTy = midY - (activeGesture.lastMidY - curr.ty) * scaleFactor;
          const next = clampZoomTransform(rawTx, rawTy, targetScale, metrics);
          applyZoomTransformDom(next, metrics);
          setIsZoomed(next.scale > 1.001);
        }

        activeGesture.lastMidX = midX;
        activeGesture.lastMidY = midY;
        activeGesture.lastPinchDist = dist;
        activeGesture.hadMultiTouch = true;
        return;
      }

      if (e.touches.length === 1) {
        const t = e.touches[0];
        // Use screen clientX/clientY for swipe tracking so card transform never causes feedback jitter
        const clientDx = t.clientX - activeGesture.lastClientX;
        const clientDy = t.clientY - activeGesture.lastClientY;
        activeGesture.movedDistance += Math.hypot(clientDx, clientDy);

        const now = performance.now();
        const dt = Math.max(4, now - activeGesture.lastMoveTime);
        const instVx = (clientDx / dt) * 1000;
        activeGesture.velocityX =
          activeGesture.velocityX * 0.45 + instVx * 0.55;
        activeGesture.lastMoveTime = now;
        activeGesture.lastClientX = t.clientX;
        activeGesture.lastClientY = t.clientY;

        if (activeGesture.mode === 'pinch') {
          setIsMultiTouchPinching(false);
          const pt = toLocalPoint(t.clientX, t.clientY, containerEl);
          activeGesture.mode =
            zoomTransformRef.current.scale > 1.001 ? 'pan' : 'idle';
          activeGesture.lastLocalX = pt.x;
          activeGesture.lastLocalY = pt.y;
          activeGesture.startLocalX = pt.x;
          activeGesture.startLocalY = pt.y;
          return;
        }

        const curr = zoomTransformRef.current;
        if (curr.scale > 1.001) {
          activeGesture.mode = 'pan';
          const pt = toLocalPoint(t.clientX, t.clientY, containerEl);
          const dx = pt.x - activeGesture.lastLocalX;
          const dy = pt.y - activeGesture.lastLocalY;
          activeGesture.lastLocalX = pt.x;
          activeGesture.lastLocalY = pt.y;
          const metrics = getBaseImageMetrics();
          if (metrics) {
            const next = clampZoomTransform(
              curr.tx + dx,
              curr.ty + dy,
              curr.scale,
              metrics
            );
            applyZoomTransformDom(next, metrics);
          }
          return;
        }

        const totalDx = t.clientX - activeGesture.startClientX;
        const totalDy = t.clientY - activeGesture.startClientY;
        if (
          activeGesture.mode === 'undecided' &&
          Math.abs(totalDx) > 8 &&
          Math.abs(totalDx) > Math.abs(totalDy) * 1.05
        ) {
          activeGesture.mode = 'swipe';
        }
        if (activeGesture.mode === 'swipe') {
          dragX.set(totalDx);
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      lastTouchTimeRef.current = Date.now();
      const g = activeGesture;
      if (!g) {
        setIsMultiTouchPinching(false);
        return;
      }

      if (e.touches.length >= 2) {
        initPinchFromTouches(e.touches);
        return;
      }

      if (e.touches.length === 1) {
        setIsMultiTouchPinching(false);
        const remaining = toLocalPoint(
          e.touches[0].clientX,
          e.touches[0].clientY,
          containerEl
        );
        g.lastClientX = e.touches[0].clientX;
        g.lastClientY = e.touches[0].clientY;
        g.startClientX = e.touches[0].clientX;
        g.startClientY = e.touches[0].clientY;
        g.lastLocalX = remaining.x;
        g.lastLocalY = remaining.y;
        g.startLocalX = remaining.x;
        g.startLocalY = remaining.y;
        g.lastPinchDist = 0;
        g.mode = zoomTransformRef.current.scale > 1.001 ? 'pan' : 'idle';
        return;
      }

      setIsMultiTouchPinching(false);
      activeGesture = null;

      if (e.type === 'touchend') {
        if (g.mode === 'swipe' && !g.hadMultiTouch) {
          const offsetX = dragX.get();
          const shot = displayedShotRef.current;
          if (shot && zoomTransformRef.current.scale <= 1.001) {
            if (offsetX > 95 || (offsetX > 30 && g.velocityX > 420)) {
              handlePrimaryRightActionRef.current('swipe', offsetX);
              return;
            }
            if (offsetX < -95 || (offsetX < -30 && g.velocityX < -420)) {
              handlePrimaryLeftActionRef.current('swipe', offsetX);
              return;
            }
          }
          swipeAnimControlsRef.current = animate(dragX, 0, {
            type: 'spring',
            stiffness: 460,
            damping: 34,
          });
          return;
        }

        if (!g.hadMultiTouch && g.movedDistance <= 10) {
          // Tap-to-zoom at exact tapped screen coordinate (never wait for synthetic click)
          if (zoomTransformRef.current.scale > 1.001) {
            resetZoom();
          } else {
            zoomAtPoint(g.startClientX, g.startClientY, CLICK_ZOOM_SCALE);
          }
          return;
        }
      }

      if (g.mode === 'swipe') {
        swipeAnimControlsRef.current = animate(dragX, 0, {
          type: 'spring',
          stiffness: 460,
          damping: 34,
        });
      }

      if (
        zoomTransformRef.current.scale > 1.001 &&
        zoomTransformRef.current.scale <= MIN_PINCH_EXIT_SCALE
      ) {
        resetZoom();
      }
    };

    const onSafariGesture = (e: Event) => {
      if (e.cancelable) {
        e.preventDefault();
      }
    };

    const onWheel = (e: WheelEvent) => {
      const curr = zoomTransformRef.current;
      // Allow zooming in directly with mouse wheel (up) or trackpad pinch (ctrlKey),
      // and zooming deeper or back out when already zoomed.
      if (curr.scale <= 1.001 && !e.ctrlKey && e.deltaY >= 0) return;
      const metrics = getBaseImageMetrics();
      if (!metrics) return;

      e.preventDefault();
      const pt = toLocalPoint(e.clientX, e.clientY, containerEl);

      const zoomFactor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
      const targetScale = Math.max(
        1,
        Math.min(MAX_ZOOM_SCALE, curr.scale * zoomFactor)
      );

      if (targetScale <= MIN_PINCH_EXIT_SCALE && zoomFactor < 1) {
        applyZoomTransformDom({ scale: 1, tx: 0, ty: 0 });
        setIsZoomed(false);
        return;
      }

      const scaleFactor = targetScale / curr.scale;
      const rawTx = pt.x - (pt.x - curr.tx) * scaleFactor;
      const rawTy = pt.y - (pt.y - curr.ty) * scaleFactor;
      const next = clampZoomTransform(rawTx, rawTy, targetScale, metrics);
      applyZoomTransformDom(next, metrics);
      setIsZoomed(next.scale > 1.001);
    };

    containerEl.addEventListener('touchstart', onTouchStart, { passive: false });
    containerEl.addEventListener('touchmove', onTouchMove, { passive: false });
    containerEl.addEventListener('touchend', onTouchEnd, { passive: false });
    containerEl.addEventListener('touchcancel', onTouchEnd, { passive: false });
    containerEl.addEventListener('gesturestart', onSafariGesture, {
      passive: false,
    });
    containerEl.addEventListener('gesturechange', onSafariGesture, {
      passive: false,
    });
    containerEl.addEventListener('gestureend', onSafariGesture, {
      passive: false,
    });
    containerEl.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      containerEl.removeEventListener('touchstart', onTouchStart);
      containerEl.removeEventListener('touchmove', onTouchMove);
      containerEl.removeEventListener('touchend', onTouchEnd);
      containerEl.removeEventListener('touchcancel', onTouchEnd);
      containerEl.removeEventListener('gesturestart', onSafariGesture);
      containerEl.removeEventListener('gesturechange', onSafariGesture);
      containerEl.removeEventListener('gestureend', onSafariGesture);
      containerEl.removeEventListener('wheel', onWheel);
    };
  }, [
    zoomContainerEl,
    getBaseImageMetrics,
    toLocalPoint,
    clampZoomTransform,
    applyZoomTransformDom,
    zoomAtPoint,
    resetZoom,
    dragX,
  ]);

  // Reset zoom ONLY when switching to a different photo (outside active comparison group)
  // or switching comparison groups — never on background fingerprint/series recalculations.
  const prevZoomPhotoIdRef = useRef<string | null>(null);
  const prevComparisonKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const photoId = displayedPhoto?.id ?? null;
    const photoChanged = prevZoomPhotoIdRef.current !== photoId;
    prevZoomPhotoIdRef.current = photoId;

    if (photoChanged) {
      swipeAnimControlsRef.current?.stop();
      swipeAnimControlsRef.current = null;
      dragX.jump(0);
    }

    const groupKey = isComparisonActive
      ? activeBurstGroup?.id ||
        `series:${activeComparisonShots.map((s) => s.id).join(',')}`
      : null;
    const prevGroupKey = prevComparisonKeyRef.current;
    prevComparisonKeyRef.current = groupKey;

    if (isComparisonActive) {
      if (prevGroupKey !== groupKey) {
        resetZoom();
      }
    } else if (photoChanged || prevGroupKey !== null) {
      resetZoom();
    }
  }, [
    displayedPhoto?.id,
    isComparisonActive,
    activeBurstGroup?.id,
    activeComparisonShots,
    dragX,
    resetZoom,
  ]);

  // Preload surrounding photos outward (+1, -1, +2, -2, ...) ONLY after resume gate completes
  // so the last opened shot opens cleanly first and then its surrounding neighborhood preloads
  useEffect(() => {
    if (!ratingsHydrated || pendingResumeTarget || !displayedShot) return;

    const queue: DrivePhotoFile[] = [displayedShot.primary];
    const queuedIds = new Set<string>([displayedShot.primary.id]);
    const enqueueShot = (shot: PhotoShotItem | undefined) => {
      if (!shot) return;
      if (!queuedIds.has(shot.primary.id)) {
        queuedIds.add(shot.primary.id);
        queue.push(shot.primary);
      }
    };

    const allIdx = allOrderedShots.findIndex((s) => s.id === displayedShot.id);
    if (allIdx !== -1) {
      for (let offset = 1; offset <= 6; offset++) {
        if (allIdx + offset < allOrderedShots.length) {
          enqueueShot(allOrderedShots[allIdx + offset]);
        }
        if (allIdx - offset >= 0) {
          enqueueShot(allOrderedShots[allIdx - offset]);
        }
      }
    }

    const nonRejIdx = nonRejectedShots.findIndex(
      (s) => s.id === displayedShot.id
    );
    if (nonRejIdx !== -1) {
      for (let offset = 1; offset <= 4; offset++) {
        if (nonRejIdx + offset < nonRejectedShots.length) {
          enqueueShot(nonRejectedShots[nonRejIdx + offset]);
        }
        if (nonRejIdx - offset >= 0) {
          enqueueShot(nonRejectedShots[nonRejIdx - offset]);
        }
      }
    }

    if (isComparisonActive) {
      for (const shot of activeComparisonShots.slice(0, 24)) {
        enqueueShot(shot);
      }
    }

    let cancelled = false;
    let cursor = 0;

    const runWorker = async () => {
      while (!cancelled && cursor < queue.length) {
        const file = queue[cursor++];
        if (!sharpMediaMapRef.current[file.id]) {
          await loadPhotoProgressive(file, false);
        }
      }
    };

    const concurrency = 2;
    void Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, () =>
        runWorker()
      )
    );

    return () => {
      cancelled = true;
    };
  }, [
    ratingsHydrated,
    pendingResumeTarget,
    displayedShot,
    allOrderedShots,
    nonRejectedShots,
    isComparisonActive,
    activeComparisonShots,
    loadPhotoProgressive,
  ]);

  // Resolve and complete resume gate: wait until saved shot arrives in stream AND its image loads
  const resumeTargetFile = matchedResumeShot?.primary || null;
  const resumeDisplayUrl = resumeTargetFile
    ? sharpMediaMap[resumeTargetFile.id]?.url || tempPreviewMap[resumeTargetFile.id]
    : undefined;
  const resumeFatalError = resumeTargetFile
    ? Boolean(errorMap[resumeTargetFile.id] && !resumeDisplayUrl)
    : false;

  useEffect(() => {
    setResumeImageReady(false);
  }, [resumeTargetFile?.id]);

  // Off-DOM preload of the resumed target photo so it is decoded before opening the studio card
  useEffect(() => {
    if (!pendingResumeTarget || !matchedResumeShot || !resumeDisplayUrl) {
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    const markReady = () => {
      if (!cancelled) {
        setResumeImageReady(true);
      }
    };
    img.onload = markReady;
    img.onerror = () => {
      if (cancelled) return;
      const file = matchedResumeShot.primary;
      const sharp = sharpMediaMapRef.current[file.id];
      if (!sharp || sharp.source === 'drive-thumbnail') {
        void loadPhotoProgressive(file, true);
      } else {
        setErrorMap((prev) => ({
          ...prev,
          [file.id]: `Prohlížeč nemohl zobrazit formát .${file.fileExtension.toUpperCase()}.`,
        }));
      }
    };
    img.src = resumeDisplayUrl;
    if (img.complete && img.naturalWidth > 0) {
      markReady();
    }
    return () => {
      cancelled = true;
    };
  }, [
    pendingResumeTarget,
    matchedResumeShot,
    resumeDisplayUrl,
    loadPhotoProgressive,
  ]);

  useEffect(() => {
    if (!pendingResumeTarget || !ratingsHydrated) return;

    if (matchedResumeShot) {
      if (resumeImageReady || resumeFatalError) {
        setActiveShotId(matchedResumeShot.id);
        setPendingResumeTarget(null);
        return;
      }
      void loadPhotoProgressive(matchedResumeShot.primary, false);
      return;
    }

    // Saved photo doesn't exist anywhere in folder after full stream finished and settled
    if (
      !isLoadingMore &&
      !loadMoreError &&
      settledPhotos.length > 0 &&
      settledPhotos.length === activePhotos.length
    ) {
      setPendingResumeTarget(null);
    }
  }, [
    pendingResumeTarget,
    ratingsHydrated,
    matchedResumeShot,
    resumeImageReady,
    resumeFatalError,
    isLoadingMore,
    loadMoreError,
    settledPhotos.length,
    activePhotos.length,
    loadPhotoProgressive,
  ]);

  // Persist exact last viewed photo immediately to localStorage and debounced to Firestore/IndexedDB
  useEffect(() => {
    if (!ratingsHydrated || pendingResumeTarget || !displayedShot) return;

    const nextCursor = {
      shotId: displayedShot.primary.id,
      fileName: displayedShot.primary.name,
      stem: displayedShot.stem,
    };
    const prev = currentResumeCursorRef.current;
    if (
      prev &&
      prev.shotId === nextCursor.shotId &&
      prev.fileName === nextCursor.fileName
    ) {
      return;
    }

    currentResumeCursorRef.current = nextCursor;
    writeLocalResumePosition(folder.id, {
      ...nextCursor,
      updatedAtMs: Date.now(),
    });

    if (cursorSyncTimerRef.current !== null) {
      window.clearTimeout(cursorSyncTimerRef.current);
    }
    cursorSyncTimerRef.current = window.setTimeout(() => {
      cursorSyncTimerRef.current = null;
      void flushPersistence();
    }, 900);
  }, [
    ratingsHydrated,
    pendingResumeTarget,
    displayedShot,
    folder.id,
    flushPersistence,
  ]);

  const handleImageElementError = (file: DrivePhotoFile) => {
    const sharp = sharpMediaMap[file.id];
    if (!sharp || sharp.source === 'drive-thumbnail') {
      void loadPhotoProgressive(file, true);
    } else {
      setErrorMap((prev) => ({
        ...prev,
        [file.id]: `Prohlížeč nemohl zobrazit formát .${file.fileExtension.toUpperCase()}.`,
      }));
    }
  };

  // Find next non-rejected shot to advance to after swiping/rating
  const findNextAfterRating = useCallback(
    (ratedShotId: string, nextRating: SelectionRating): string | null => {
      // Check inside active comparison group first if comparing >= 2 shots
      if (isComparisonActive) {
        const compIdx = activeComparisonShots.findIndex(
          (s) => s.id === ratedShotId
        );
        if (compIdx !== -1) {
          for (let i = compIdx + 1; i < activeComparisonShots.length; i++) {
            const candidate = activeComparisonShots[i];
            if ((ratingsByShotId[candidate.id] || 'unrated') !== 'reject') {
              return candidate.id;
            }
          }
          for (let i = compIdx - 1; i >= 0; i--) {
            const candidate = activeComparisonShots[i];
            if ((ratingsByShotId[candidate.id] || 'unrated') !== 'reject') {
              return candidate.id;
            }
          }
        }
      }

      const idx = allOrderedShots.findIndex((s) => s.id === ratedShotId);
      if (idx === -1) return null;

      for (let i = idx + 1; i < allOrderedShots.length; i++) {
        const candidate = allOrderedShots[i];
        if ((ratingsByShotId[candidate.id] || 'unrated') !== 'reject') {
          return candidate.id;
        }
      }
      for (let i = idx - 1; i >= 0; i--) {
        const candidate = allOrderedShots[i];
        if ((ratingsByShotId[candidate.id] || 'unrated') !== 'reject') {
          return candidate.id;
        }
      }
      return nextRating === 'reject' ? ratedShotId : ratedShotId;
    },
    [
      isComparisonActive,
      activeComparisonShots,
      allOrderedShots,
      ratingsByShotId,
    ]
  );

  const triggerCardExitGhost = useCallback(
    (dir: 'left' | 'right' | null, explicitStartX?: number) => {
      swipeAnimControlsRef.current?.stop();
      swipeAnimControlsRef.current = null;
      const startX =
        typeof explicitStartX === 'number' ? explicitStartX : dragX.get();
      dragX.jump(0);

      if (!dir || prefersReducedMotion || !displayedPhoto) {
        setExitingSwipeCard(null);
        return;
      }

      const url =
        sharpMediaMapRef.current[displayedPhoto.id]?.url ||
        tempPreviewMapRef.current[displayedPhoto.id];
      setExitingSwipeCard({
        key: `${displayedPhoto.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        url,
        name: displayedPhoto.name,
        dir,
        startX,
      });
    },
    [dragX, prefersReducedMotion, displayedPhoto]
  );

  // Set rating ('unrated' | 'pick' | 'reject') on a shot (and all its paired files)
  const applyShotRating = useCallback(
    (
      shot: PhotoShotItem,
      rating: SelectionRating,
      options: {
        advance?: boolean;
        swipeExit?: 'left' | 'right' | null;
        startX?: number;
      } = {}
    ) => {
      const { advance = true, swipeExit = null, startX } = options;

      if (rating === 'pick') {
        triggerHaptic('keep', hapticSettingsRef.current);
      } else if (rating === 'reject') {
        triggerHaptic('trash', hapticSettingsRef.current);
      } else {
        triggerHaptic('selection', hapticSettingsRef.current);
      }

      if (swipeExit) {
        triggerCardExitGhost(swipeExit, startX);
      } else if (advance && rating !== 'unrated') {
        triggerCardExitGhost(rating === 'pick' ? 'right' : 'left', startX);
      } else {
        setExitingSwipeCard(null);
        dragX.jump(0);
      }

      const nextId = advance ? findNextAfterRating(shot.id, rating) : null;
      const wasInActiveSeries =
        isSeriesOpen || activeComparisonIds.has(shot.id);
      const removedFromSeriesShotId =
        rating === 'reject' && wasInActiveSeries ? shot.id : undefined;

      const prevSnapshot: Record<string, PersistedDecisionEntry | null> = {};
      for (const f of shot.files) {
        prevSnapshot[f.id] = ratingsMap[f.id] ?? null;
      }

      setUndoStack((prev) => [
        ...prev.slice(-79),
        {
          files: shot.files,
          prevEntries: prevSnapshot,
          prevActiveShotId: displayedShot?.id || shot.id,
          ...(removedFromSeriesShotId
            ? { removedFromSeriesShotId, wasSeriesOpen: isSeriesOpen }
            : {}),
        },
      ]);

      const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const pairLabel = shot.files.length > 1 ? shot.formatSummary : undefined;
      const nowMs = Date.now();

      setRatingsMap((prev) => {
        const next = { ...prev };
        for (const f of shot.files) {
          if (rating === 'unrated') {
            delete next[f.id];
          } else {
            next[f.id] = {
              decision: rating,
              name: f.name,
              ext: f.fileExtension,
              sizeBytes: f.sizeBytes || 0,
              batchId,
              ...(pairLabel ? { pairedWith: pairLabel } : {}),
              updatedAtMs: nowMs,
            };
          }
        }
        return next;
      });

      if (removedFromSeriesShotId) {
        setSelectedSeriesMultiIds((curr) => {
          if (!curr.has(shot.id)) return curr;
          const next = new Set(curr);
          next.delete(shot.id);
          return next;
        });

        const remainingIds = activeComparisonShots
          .filter(
            (s) =>
              s.id !== shot.id &&
              (ratingsByShotId[s.id] || 'unrated') !== 'reject'
          )
          .map((s) => s.id);
        if (remainingIds.length === 0) {
          setActiveSeriesShotIds(new Set());
          setIsSeriesOpen(false);
          setIsEditingSeries(false);
          setIsSeriesMultiSelect(false);
        } else if (isSeriesOpen || activeSeriesShotIds.size > 0) {
          setActiveSeriesShotIds(new Set(remainingIds));
        }
      }

      if (advance && nextId && nextId !== shot.id) {
        if (
          !isSeriesOpen &&
          !isEditingSeries &&
          activeSeriesShotIds.size > 0 &&
          !activeSeriesShotIds.has(nextId)
        ) {
          setActiveSeriesShotIds(new Set());
        }
        setActiveShotId(nextId);
      }
    },
    [
      ratingsMap,
      ratingsByShotId,
      displayedShot?.id,
      findNextAfterRating,
      isSeriesOpen,
      isEditingSeries,
      activeSeriesShotIds.size,
      activeComparisonIds,
      activeComparisonShots,
      triggerCardExitGhost,
      dragX,
    ]
  );

  // Batch series actions: keep only 1 shot (reject rest), delete whole series, or confirm custom subset
  const resolveSeriesWithDecisions = useCallback(
    (
      keepShotIds: Set<string>,
      exitDir: 'left' | 'right',
      startX?: number
    ) => {
      if (!displayedShot || activeComparisonShots.length === 0) return;

      const targetShots = activeComparisonShots;
      const targetShotIds = new Set(targetShots.map((s) => s.id));
      const allTargetFiles: DrivePhotoFile[] = [];
      const prevSnapshot: Record<string, PersistedDecisionEntry | null> = {};

      for (const s of targetShots) {
        for (const f of s.files) {
          allTargetFiles.push(f);
          prevSnapshot[f.id] = ratingsMap[f.id] ?? null;
        }
      }

      triggerHaptic(exitDir === 'left' ? 'trash' : 'keep', hapticSettingsRef.current);
      triggerCardExitGhost(exitDir, startX);

      setUndoStack((prev) => [
        ...prev.slice(-79),
        {
          files: allTargetFiles,
          prevEntries: prevSnapshot,
          prevActiveShotId: displayedShot.id,
          restoredSeriesShotIds: targetShots.map((s) => s.id),
          wasSeriesOpen: isSeriesOpen,
          wasManualSeriesPinned: activeSeriesShotIds.size > 0,
        },
      ]);

      const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const nowMs = Date.now();

      setRatingsMap((prev) => {
        const next = { ...prev };
        for (const s of targetShots) {
          const decision: 'pick' | 'reject' = keepShotIds.has(s.id)
            ? 'pick'
            : 'reject';
          const pairLabel = s.files.length > 1 ? s.formatSummary : undefined;
          for (const f of s.files) {
            next[f.id] = {
              decision,
              name: f.name,
              ext: f.fileExtension,
              sizeBytes: f.sizeBytes || 0,
              batchId,
              ...(pairLabel ? { pairedWith: pairLabel } : {}),
              updatedAtMs: nowMs,
            };
          }
        }
        return next;
      });

      // Find next non-rejected shot outside this resolved series
      let minSeriesIdx = allOrderedShots.length;
      let maxSeriesIdx = -1;
      for (let i = 0; i < allOrderedShots.length; i++) {
        if (targetShotIds.has(allOrderedShots[i].id)) {
          if (i < minSeriesIdx) minSeriesIdx = i;
          if (i > maxSeriesIdx) maxSeriesIdx = i;
        }
      }

      let nextOutsideId: string | null = null;
      for (let i = maxSeriesIdx + 1; i < allOrderedShots.length; i++) {
        const cand = allOrderedShots[i];
        if (
          !targetShotIds.has(cand.id) &&
          (ratingsByShotId[cand.id] || 'unrated') !== 'reject'
        ) {
          nextOutsideId = cand.id;
          break;
        }
      }
      if (!nextOutsideId) {
        for (let i = minSeriesIdx - 1; i >= 0; i--) {
          const cand = allOrderedShots[i];
          if (
            !targetShotIds.has(cand.id) &&
            (ratingsByShotId[cand.id] || 'unrated') !== 'reject'
          ) {
            nextOutsideId = cand.id;
            break;
          }
        }
      }

      setActiveSeriesShotIds(new Set());
      setIsSeriesOpen(false);
      setIsEditingSeries(false);
      setIsSeriesMultiSelect(false);
      setSelectedSeriesMultiIds(new Set());
      if (nextOutsideId) {
        setActiveShotId(nextOutsideId);
      }
    },
    [
      displayedShot,
      activeComparisonShots,
      activeSeriesShotIds.size,
      ratingsMap,
      isSeriesOpen,
      allOrderedShots,
      ratingsByShotId,
      triggerCardExitGhost,
    ]
  );

  const applySeriesBatchAction = useCallback(
    (action: 'keep-one' | 'reject-all' | 'keep-all', startX?: number) => {
      if (!displayedShot || activeComparisonShots.length === 0) return;
      if (action === 'reject-all') {
        resolveSeriesWithDecisions(new Set(), 'left', startX);
      } else if (action === 'keep-all') {
        resolveSeriesWithDecisions(
          new Set(activeComparisonShots.map((s) => s.id)),
          'right',
          startX
        );
      } else {
        resolveSeriesWithDecisions(new Set([displayedShot.id]), 'right', startX);
      }
    },
    [displayedShot, activeComparisonShots, resolveSeriesWithDecisions]
  );

  const handleToggleSeriesMultiSelectMode = useCallback(() => {
    triggerHaptic('selection', hapticSettingsRef.current);
    setIsEditingSeries(false);
    setIsSeriesMultiSelect((prev) => {
      const next = !prev;
      if (next) {
        // Pre-seed with any frames already picked inside the series (if none, starts empty for fresh tapping)
        const prePicked = new Set<string>();
        for (const s of activeComparisonShots) {
          if (ratingsByShotId[s.id] === 'pick') {
            prePicked.add(s.id);
          }
        }
        setSelectedSeriesMultiIds(prePicked);
      } else {
        setSelectedSeriesMultiIds(new Set());
      }
      return next;
    });
  }, [activeComparisonShots, ratingsByShotId]);

  const handleToggleMultiSelectShot = useCallback((shotId: string) => {
    triggerHaptic('selection', hapticSettingsRef.current);
    setSelectedSeriesMultiIds((prev) => {
      const next = new Set(prev);
      if (next.has(shotId)) {
        next.delete(shotId);
      } else {
        next.add(shotId);
      }
      return next;
    });
  }, []);

  const handleConfirmSeriesMultiSelect = useCallback(() => {
    const validSelected = new Set(
      activeComparisonShots
        .filter((s) => selectedSeriesMultiIds.has(s.id))
        .map((s) => s.id)
    );
    if (validSelected.size === 0) return;
    resolveSeriesWithDecisions(validSelected, 'right');
  }, [activeComparisonShots, selectedSeriesMultiIds, resolveSeriesWithDecisions]);

  // Unified primary Left/Right actions (shared by swipe gestures, bottom buttons, and keyboard shortcuts):
  // - Inside an open series (both Selectra & FrameCull):
  //   * Left removes ONLY this 1 shot from series (leaving even a final 1 shot open for manual decision).
  //   * Right keeps ONLY this 1 shot and rejects all other remaining shots in the series, then closes series.
  // - Outside an open series: standard single-shot reject/pick behavior.
  const handlePrimaryLeftAction = useCallback(
    (source: 'swipe' | 'click' | 'key', startX?: number) => {
      if (!displayedShot) return;
      if (isSeriesOpen && activeComparisonShots.length >= 1) {
        applyShotRating(displayedShot, 'reject', {
          advance: true,
          swipeExit: 'left',
          startX,
        });
        return;
      }
      const curr = ratingsByShotId[displayedShot.id] || 'unrated';
      const isRejected = curr === 'reject';
      if (source === 'swipe') {
        applyShotRating(displayedShot, 'reject', {
          advance: true,
          swipeExit: 'left',
          startX,
        });
      } else {
        applyShotRating(displayedShot, isRejected ? 'unrated' : 'reject', {
          advance: !isRejected,
          swipeExit: isRejected ? null : 'left',
          startX,
        });
      }
    },
    [
      displayedShot,
      isSeriesOpen,
      activeComparisonShots.length,
      applyShotRating,
      ratingsByShotId,
    ]
  );

  const handlePrimaryRightAction = useCallback(
    (source: 'swipe' | 'click' | 'key', startX?: number) => {
      if (!displayedShot) return;
      if (isSeriesOpen && activeComparisonShots.length >= 1) {
        applySeriesBatchAction('keep-one', startX);
        return;
      }
      const curr = ratingsByShotId[displayedShot.id] || 'unrated';
      const isPicked = curr === 'pick';
      if (source === 'swipe') {
        applyShotRating(displayedShot, 'pick', {
          advance: true,
          swipeExit: 'right',
          startX,
        });
      } else {
        applyShotRating(displayedShot, isPicked ? 'unrated' : 'pick', {
          advance: !isPicked,
          swipeExit: isPicked ? null : 'right',
          startX,
        });
      }
    },
    [
      displayedShot,
      isSeriesOpen,
      activeComparisonShots.length,
      applySeriesBatchAction,
      applyShotRating,
      ratingsByShotId,
    ]
  );

  handlePrimaryLeftActionRef.current = handlePrimaryLeftAction;
  handlePrimaryRightActionRef.current = handlePrimaryRightAction;

  // Navigate chronologically or inside active comparison set WITHOUT changing ratings
  const stepShot = useCallback(
    (delta: number) => {
      if (!displayedShot) return;

      if (isComparisonActive) {
        const idx = activeComparisonShots.findIndex(
          (s) => s.id === displayedShot.id
        );
        if (idx !== -1) {
          const nextIdx = Math.max(
            0,
            Math.min(activeComparisonShots.length - 1, idx + delta)
          );
          if (nextIdx !== idx) {
            triggerHaptic('selection', hapticSettingsRef.current);
            setExitingSwipeCard(null);
            dragX.jump(0);
            setActiveShotId(activeComparisonShots[nextIdx].id);
          }
          return;
        }
      }

      // Chronological navigation skipping 'reject' shots
      const currentIdx = allOrderedShots.findIndex(
        (s) => s.id === displayedShot.id
      );
      if (currentIdx === -1) return;

      const step = delta > 0 ? 1 : -1;
      for (
        let i = currentIdx + step;
        i >= 0 && i < allOrderedShots.length;
        i += step
      ) {
        const candidate = allOrderedShots[i];
        if ((ratingsByShotId[candidate.id] || 'unrated') !== 'reject') {
          triggerHaptic('selection', hapticSettingsRef.current);
          setExitingSwipeCard(null);
          dragX.jump(0);
          if (
            !isSeriesOpen &&
            !isEditingSeries &&
            activeSeriesShotIds.size > 0 &&
            !activeSeriesShotIds.has(candidate.id)
          ) {
            setActiveSeriesShotIds(new Set());
          }
          setActiveShotId(candidate.id);
          return;
        }
      }
    },
    [
      displayedShot,
      isComparisonActive,
      isSeriesOpen,
      isEditingSeries,
      activeSeriesShotIds,
      activeComparisonShots,
      allOrderedShots,
      ratingsByShotId,
      dragX,
    ]
  );

  // Filmstrip or ScrubStrip direct click/glide
  const handleSelectShotFromStrip = useCallback(
    (shotId: string) => {
      triggerHaptic('selection', hapticSettingsRef.current);
      setExitingSwipeCard(null);
      dragX.jump(0);
      if (
        !isSeriesOpen &&
        !isEditingSeries &&
        activeSeriesShotIds.size > 0 &&
        !activeSeriesShotIds.has(shotId)
      ) {
        setActiveSeriesShotIds(new Set());
      }
      setActiveShotId(shotId);
    },
    [isSeriesOpen, isEditingSeries, activeSeriesShotIds, dragX]
  );

  // Turn on series around currently displayed photo ONLY (never enables folder-wide auto-series when disabled in Settings)
  const handleFindSeriesAroundCurrent = useCallback(async () => {
    if (!displayedShot || isFindingSeries) return;
    triggerHaptic('selection', hapticSettingsRef.current);
    setIsFindingSeries(true);

    try {
      const idx = nonRejectedShots.findIndex((s) => s.id === displayedShot.id);
      const centerIdx = idx === -1 ? 0 : idx;
      const windowStart = Math.max(0, centerIdx - 15);
      const windowEnd = Math.min(nonRejectedShots.length, centerIdx + 16);
      const nearbyShots = nonRejectedShots.slice(windowStart, windowEnd);

      const fpSnapshot: Record<string, VisualFingerprint> = {
        ...fingerprintsRef.current,
      };
      const missingForWindow = nearbyShots.filter(
        (s) => !fpSnapshot[s.primary.id]
      );

      if (missingForWindow.length > 0) {
        const computed: Record<string, VisualFingerprint> = {};
        let cursor = 0;
        const worker = async () => {
          while (!studioUnmountedRef.current && cursor < missingForWindow.length) {
            const shot = missingForWindow[cursor++];
            const id = shot.primary.id;
            const localUrl =
              sharpMediaMapRef.current[id]?.url || tempPreviewMapRef.current[id];
            const fp = await computePhotoFingerprint(accessToken, shot.primary, {
              existingLocalUrl: localUrl,
            });
            if (fp) {
              fpSnapshot[id] = fp;
              computed[id] = fp;
            }
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(5, missingForWindow.length) },
            () => worker()
          )
        );
        if (!studioUnmountedRef.current && Object.keys(computed).length > 0) {
          startTransition(() => {
            setFingerprintsMap((prev) => ({ ...prev, ...computed }));
          });
        }
      }

      if (studioUnmountedRef.current) return;

      const discoveredIds = new Set<string>([displayedShot.id]);
      const anchorFp = fpSnapshot[displayedShot.primary.id];

      // 1. Check strict 1-3 minute appearance-first grouping around the current shot
      const localGroups = groupShotsIntoSeries(nearbyShots, {
        maxGapMs: 3000,
        visualEnabled: true,
        fingerprints: fpSnapshot,
        sensitivity: similaritySensitivity,
        calibration: customCalibration,
      });
      for (const g of localGroups) {
        if (g.shots.some((s) => s.id === displayedShot.id)) {
          for (const s of g.shots) {
            if (s.id === displayedShot.id) continue;
            const timeDiff =
              displayedShot.takenAtMs !== null && s.takenAtMs !== null
                ? Math.abs(s.takenAtMs - displayedShot.takenAtMs)
                : 0;
            if (timeDiff > HIGH_MATCH_VISUAL_MAX_GAP_MS) continue;
            const candFp = fpSnapshot[s.primary.id];
            if (
              !anchorFp ||
              !candFp ||
              areVisuallySimilar(anchorFp, candFp, similaritySensitivity, {
                requireHighMatch: timeDiff > STANDARD_VISUAL_MAX_GAP_MS,
                calibration: customCalibration,
              })
            ) {
              discoveredIds.add(s.id);
            }
          }
          break;
        }
      }

      // 2. Include visually similar shots inside strict 1 min (standard) / 3 min (high match) window
      if (anchorFp) {
        for (const candidate of nearbyShots) {
          if (discoveredIds.has(candidate.id)) continue;
          const timeDiff =
            displayedShot.takenAtMs !== null && candidate.takenAtMs !== null
              ? Math.abs(candidate.takenAtMs - displayedShot.takenAtMs)
              : 0;
          if (timeDiff > HIGH_MATCH_VISUAL_MAX_GAP_MS) continue;
          const candFp = fpSnapshot[candidate.primary.id];
          if (
            candFp &&
            areVisuallySimilar(anchorFp, candFp, similaritySensitivity, {
              requireHighMatch: timeDiff > STANDARD_VISUAL_MAX_GAP_MS,
              calibration: customCalibration,
            })
          ) {
            discoveredIds.add(candidate.id);
          }
        }
      }

      setActiveSeriesShotIds(discoveredIds);
      setIsSeriesOpen(false);
      setIsEditingSeries(false);
      setIsSeriesMultiSelect(false);
      setSelectedSeriesMultiIds(new Set());
    } finally {
      if (!studioUnmountedRef.current) {
        setIsFindingSeries(false);
      }
    }
  }, [
    displayedShot,
    isFindingSeries,
    nonRejectedShots,
    accessToken,
    similaritySensitivity,
    customCalibration,
  ]);

  // Toggle shots in or out of the editable active series:
  // clicking an outside frame belonging to another series attaches that entire neighboring series at once,
  // while clicking a frame already inside the active series removes only that individual frame.
  const handleToggleShotInSeries = useCallback(
    (shotId: string) => {
      triggerHaptic('selection', hapticSettingsRef.current);
      setActiveSeriesShotIds((prev) => {
        const base =
          prev.size > 0
            ? new Set(prev)
            : activeBurstGroup
              ? new Set(activeBurstGroup.shots.map((s) => s.id))
              : displayedShot
                ? new Set([displayedShot.id])
                : new Set<string>();

        if (base.has(shotId)) {
          base.delete(shotId);
        } else {
          const neighborSeries = burstGroupByShotId.get(shotId);
          if (neighborSeries && neighborSeries.shots.length > 1) {
            let addedCount = 0;
            for (const member of neighborSeries.shots) {
              if ((ratingsByShotId[member.id] || 'unrated') !== 'reject') {
                base.add(member.id);
                addedCount++;
              }
            }
            if (addedCount === 0) {
              base.add(shotId);
            }
          } else {
            base.add(shotId);
          }
        }
        if (base.size === 0) {
          setIsSeriesOpen(false);
          setIsEditingSeries(false);
          setIsSeriesMultiSelect(false);
          setSelectedSeriesMultiIds(new Set());
        }
        return base;
      });
    },
    [activeBurstGroup, displayedShot, burstGroupByShotId, ratingsByShotId]
  );

  const handleToggleEditingSeries = useCallback(() => {
    triggerHaptic('selection', hapticSettingsRef.current);
    setIsSeriesMultiSelect(false);
    setSelectedSeriesMultiIds(new Set());
    setActiveSeriesShotIds((prev) => {
      if (prev.size > 0) return prev;
      if (activeBurstGroup) {
        return new Set(activeBurstGroup.shots.map((s) => s.id));
      }
      return displayedShot ? new Set([displayedShot.id]) : prev;
    });
    setIsEditingSeries((v) => !v);
  }, [activeBurstGroup, displayedShot]);

  const handleOpenSeries = useCallback(() => {
    triggerHaptic('selection', hapticSettingsRef.current);
    const seedIds =
      activeSeriesShotIds.size > 0
        ? new Set(activeSeriesShotIds)
        : activeBurstGroup
          ? new Set(activeBurstGroup.shots.map((s) => s.id))
          : displayedShot
            ? new Set([displayedShot.id])
            : new Set<string>();

    if (seedIds.size === 0) return;

    setActiveSeriesShotIds(seedIds);
    setIsEditingSeries(false);
    setIsSeriesMultiSelect(false);
    setSelectedSeriesMultiIds(new Set());
    setIsSeriesOpen(true);
    setStudioMode('detail');

    if (displayedShot && !seedIds.has(displayedShot.id)) {
      const firstInSeries = allOrderedShots.find((s) => seedIds.has(s.id));
      if (firstInSeries) {
        setActiveShotId(firstInSeries.id);
      }
    }
  }, [activeSeriesShotIds, activeBurstGroup, displayedShot, allOrderedShots]);

  const handleCloseSeries = useCallback(() => {
    triggerHaptic('selection', hapticSettingsRef.current);
    setActiveSeriesShotIds(new Set());
    setIsSeriesOpen(false);
    setIsEditingSeries(false);
    setIsSeriesMultiSelect(false);
    setSelectedSeriesMultiIds(new Set());
  }, []);

  const handleToggleGallerySeriesEnabled = useCallback((nextEnabled: boolean) => {
    triggerHaptic('selection', hapticSettingsRef.current);
    setGallerySeriesEnabled(nextEnabled);
    setIsSeriesOpen(false);
    setIsEditingSeries(false);
    setIsSeriesMultiSelect(false);
    setSelectedSeriesMultiIds(new Set());
    if (!nextEnabled) {
      setActiveSeriesShotIds(new Set());
    }
  }, []);

  // Open a photo from Full Gallery into Detail + Filmstrip view with slide-down choreography
  const handleOpenShotFromGallery = useCallback(
    (shotId: string, sourceRect?: DOMRect) => {
      triggerHaptic('selection', hapticSettingsRef.current);
      setExitingSwipeCard(null);
      dragX.jump(0);

      const canvasRect = studioCanvasRef.current?.getBoundingClientRect();
      if (sourceRect && canvasRect && !prefersReducedMotion) {
        const targetCenterX = canvasRect.left + canvasRect.width / 2;
        const targetCenterY =
          canvasRect.top + Math.max(120, (canvasRect.height - 170) / 2);
        const tileCenterX = sourceRect.left + sourceRect.width / 2;
        const tileCenterY = sourceRect.top + sourceRect.height / 2;
        const startScale = Math.max(
          0.18,
          Math.min(0.65, sourceRect.width / Math.max(240, canvasRect.width))
        );
        setGalleryToDetailAnim({
          offsetX: tileCenterX - targetCenterX,
          offsetY: tileCenterY - targetCenterY,
          startScale,
          seq: Date.now(),
        });
      } else {
        setGalleryToDetailAnim(null);
      }

      setActiveShotId(shotId);
      setStudioMode('detail');
    },
    [prefersReducedMotion, dragX]
  );

  const handleSwitchStudioMode = useCallback(
    (nextMode: 'detail' | 'gallery') => {
      if (nextMode === studioMode) return;
      triggerHaptic('selection', hapticSettingsRef.current);
      setGalleryToDetailAnim(null);
      if (nextMode === 'gallery' && isZoomed) {
        resetZoom();
      }
      setStudioMode(nextMode);
    },
    [studioMode, isZoomed, resetZoom]
  );

  const handleUndo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const last = stack[stack.length - 1];
    triggerHaptic('undo', hapticSettingsRef.current);
    setExitingSwipeCard(null);
    dragX.jump(0);
    setIsSeriesMultiSelect(false);
    setSelectedSeriesMultiIds(new Set());

    setUndoStack((prev) => prev.slice(0, -1));

    setRatingsMap((curr) => {
      const next = { ...curr };
      for (const f of last.files) {
        const oldEntry = last.prevEntries[f.id];
        if (oldEntry) {
          next[f.id] = oldEntry;
        } else {
          delete next[f.id];
        }
      }
      return next;
    });

    if (last.restoredSeriesShotIds && last.restoredSeriesShotIds.length > 0) {
      if (last.wasSeriesOpen) {
        setIsSeriesOpen(true);
      }
      if (last.wasSeriesOpen || last.wasManualSeriesPinned) {
        setActiveSeriesShotIds(new Set(last.restoredSeriesShotIds));
      } else {
        setActiveSeriesShotIds(new Set());
      }
    } else if (last.removedFromSeriesShotId) {
      const restoredId = last.removedFromSeriesShotId;
      if (last.wasSeriesOpen) {
        setIsSeriesOpen(true);
      }
      setActiveSeriesShotIds((currIds) => {
        const nextIds = new Set(currIds);
        nextIds.add(restoredId);
        return nextIds;
      });
    }

    if (last.prevActiveShotId) {
      setActiveShotId(last.prevActiveShotId);
    }
  }, [dragX]);

  const handleResetFolderSession = async () => {
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    if (cursorSyncTimerRef.current !== null) {
      window.clearTimeout(cursorSyncTimerRef.current);
      cursorSyncTimerRef.current = null;
    }
    const hadCloudDoc =
      Object.keys(shardMapRef.current).length > 0 ||
      Boolean(lastSavedResumeShotIdRef.current);
    clearLocalResumePosition(folder.id);
    currentResumeCursorRef.current = null;
    lastSavedResumeShotIdRef.current = null;
    setPendingResumeTarget(null);
    setResumeImageReady(false);
    setRatingsMap({});
    setUndoStack([]);
    setIsZoomed(false);
    setShowExifPanel(false);
    setExitingSwipeCard(null);
    dragX.jump(0);
    setActiveSeriesShotIds(new Set());
    setIsSeriesOpen(false);
    setIsEditingSeries(false);
    setIsSeriesMultiSelect(false);
    setSelectedSeriesMultiIds(new Set());
    lastSavedEntriesRef.current = {};
    const existingShards = shardMapRef.current;
    shardMapRef.current = {};
    const firstShot = allOrderedShots[0];
    if (firstShot) {
      setActiveShotId(firstShot.id);
    }
    if (isLocalSource) {
      setSyncStatus('saving');
      try {
        await resetLocalFolderDecisions(folder.id);
        setSyncStatus('idle');
        onFolderSummaryChange?.(null);
      } catch {
        setSyncStatus('error');
      }
      return;
    }
    if (userId && hadCloudDoc) {
      setSyncStatus('saving');
      try {
        await resetFolderDecisions(userId, folder.id, existingShards);
        setSyncStatus('idle');
        onFolderSummaryChange?.(null);
      } catch {
        setSyncStatus('error');
      }
    } else {
      setSyncStatus('idle');
      onFolderSummaryChange?.(null);
    }
  };

  displayedShotRef.current = displayedShot;

  const enrichedAttemptedIdsRef = useRef<Set<string>>(new Set());
  const localExifRunningRef = useRef(false);
  const missingExifPhotosRef = useRef<DrivePhotoFile[]>(missingExifPhotos);
  missingExifPhotosRef.current = missingExifPhotos;
  const studioUnmountedRef = useRef(false);

  useEffect(() => {
    studioUnmountedRef.current = false;
    return () => {
      studioUnmountedRef.current = true;
      localExifRunningRef.current = false;
    };
  }, []);

  // Incrementally enrich EXIF timestamps for local/SD card photos across all streamed batches
  useEffect(() => {
    if (
      !isLocalSource ||
      !isDecisionsLoaded ||
      !onUpdatePhotoTimestamps ||
      localExifRunningRef.current
    ) {
      return;
    }

    const hasPending = missingExifPhotos.some(
      (f) => !enrichedAttemptedIdsRef.current.has(f.id)
    );
    if (!hasPending) return;

    localExifRunningRef.current = true;
    setIsEnrichingExif(true);

    void (async () => {
      try {
        const batchSize = 4;
        while (!studioUnmountedRef.current) {
          const nextBatch = missingExifPhotosRef.current
            .filter((f) => !enrichedAttemptedIdsRef.current.has(f.id))
            .slice(0, batchSize);
          if (nextBatch.length === 0) break;

          const chunkUpdates: Record<string, { ms: number; label: string }> =
            {};
          await Promise.all(
            nextBatch.map(async (file) => {
              enrichedAttemptedIdsRef.current.add(file.id);
              try {
                const parsed = await extractExifTimestampFromHeader(
                  accessToken,
                  file
                );
                if (parsed) {
                  chunkUpdates[file.id] = parsed;
                }
              } catch {
                // Ignore header read error
              }
            })
          );

          if (
            !studioUnmountedRef.current &&
            Object.keys(chunkUpdates).length > 0
          ) {
            onUpdatePhotoTimestamps(chunkUpdates);
          }

          if (!studioUnmountedRef.current) {
            await new Promise((r) => window.setTimeout(r, 25));
          }
        }
      } finally {
        localExifRunningRef.current = false;
        if (!studioUnmountedRef.current) {
          setIsEnrichingExif(false);
        }
      }
    })();
  }, [
    isLocalSource,
    isDecisionsLoaded,
    missingExifPhotos,
    onUpdatePhotoTimestamps,
    accessToken,
  ]);

  const handleEnrichMissingExif = useCallback(async () => {
    if (
      isEnrichingExif ||
      missingExifPhotos.length === 0 ||
      !onUpdatePhotoTimestamps
    ) {
      return;
    }
    setIsEnrichingExif(true);
    try {
      const target = missingExifPhotos.slice(0, 120);
      const updates: Record<string, { ms: number; label: string }> = {};
      const batchSize = 4;
      for (let i = 0; i < target.length; i += batchSize) {
        const chunk = target.slice(i, i + batchSize);
        await Promise.all(
          chunk.map(async (file) => {
            enrichedAttemptedIdsRef.current.add(file.id);
            const parsed = await extractExifTimestampFromHeader(
              accessToken,
              file
            );
            if (parsed) {
              updates[file.id] = parsed;
            }
          })
        );
      }
      if (Object.keys(updates).length > 0) {
        onUpdatePhotoTimestamps(updates);
      }
    } finally {
      setIsEnrichingExif(false);
    }
  }, [
    isEnrichingExif,
    missingExifPhotos,
    onUpdatePhotoTimestamps,
    accessToken,
  ]);

  // Keyboard shortcuts: Arrows = browse only, P = pick, X = reject, U = unrated, Z = undo, Space/L = zoom, E = EXIF
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isFinishModalOpen) return;
      if (e.key === 'Escape' && isDrawerOpen) {
        e.preventDefault();
        setIsDrawerOpen(false);
        return;
      }
      if (isDrawerOpen) return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        handleSwitchStudioMode(studioMode === 'gallery' ? 'detail' : 'gallery');
        return;
      }

      if (studioMode === 'gallery') {
        if (e.key === 'Escape') {
          e.preventDefault();
          handleSwitchStudioMode('detail');
        }
        return;
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepShot(1);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepShot(-1);
        return;
      }

      if (displayedShot) {
        if (e.key === 'p' || e.key === 'P' || e.key === 's' || e.key === 'S') {
          e.preventDefault();
          handlePrimaryRightAction('key');
          return;
        }
        if (e.key === 'x' || e.key === 'X' || e.key === 'Delete') {
          e.preventDefault();
          handlePrimaryLeftAction('key');
          return;
        }
        if (e.key === 'u' || e.key === 'U' || e.key === '0') {
          e.preventDefault();
          applyShotRating(displayedShot, 'unrated', { advance: false });
          return;
        }
      }

      if (e.key === 'z' || e.key === 'Z' || e.key === 'Backspace') {
        e.preventDefault();
        handleUndo();
      } else if (e.key === 'l' || e.key === 'L' || e.key === ' ') {
        if (displayedPhoto) {
          e.preventDefault();
          toggleCenterZoom();
        }
      } else if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        setShowExifPanel((s) => !s);
      } else if (e.key === 'Escape') {
        if (showExifPanel) setShowExifPanel(false);
        else if (isZoomed) resetZoom();
        else if (isSeriesOpen) handleCloseSeries();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    isFinishModalOpen,
    isDrawerOpen,
    studioMode,
    handleSwitchStudioMode,
    displayedShot,
    displayedPhoto,
    stepShot,
    applyShotRating,
    handlePrimaryLeftAction,
    handlePrimaryRightAction,
    handleUndo,
    showExifPanel,
    isZoomed,
    toggleCenterZoom,
    resetZoom,
    isSeriesOpen,
    handleCloseSeries,
  ]);

  const currentSharp = displayedPhoto
    ? sharpMediaMap[displayedPhoto.id]
    : undefined;
  const currentTempUrl = displayedPhoto
    ? tempPreviewMap[displayedPhoto.id]
    : undefined;
  const currentDisplayUrl = currentSharp?.url || currentTempUrl;
  currentDisplayUrlRef.current = currentDisplayUrl;
  const isShowingTempOnly = Boolean(currentTempUrl && !currentSharp?.url);
  const currentUpgrading = displayedPhoto
    ? upgradingMap[displayedPhoto.id]
    : false;
  const currentError = displayedPhoto
    ? errorMap[displayedPhoto.id]
    : undefined;
  const displayedRating: SelectionRating = displayedShot
    ? ratingsByShotId[displayedShot.id] || 'unrated'
    : 'unrated';

  const nextDisplayUrl = nextPeekPhoto
    ? sharpMediaMap[nextPeekPhoto.id]?.url || tempPreviewMap[nextPeekPhoto.id]
    : undefined;

  // Keep zoomed focal crop synchronized ONLY when switching frames inside comparison or upgrading sharpness
  const prevZoomedSrcKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const srcKey = `${displayedPhoto?.id ?? ''}|${currentDisplayUrl ?? ''}`;
    if (prevZoomedSrcKeyRef.current === srcKey) return;
    prevZoomedSrcKeyRef.current = srcKey;

    const curr = zoomTransformRef.current;
    if (curr.scale <= 1.001) return;

    const metrics = getBaseImageMetrics();
    if (!metrics) return;
    const focus = zoomFocusNormRef.current;
    const focusX0 = metrics.imgLeft0 + focus.relX * metrics.imgW0;
    const focusY0 = metrics.imgTop0 + focus.relY * metrics.imgH0;
    const rawTx = metrics.cw / 2 - focusX0 * curr.scale;
    const rawTy = metrics.ch / 2 - focusY0 * curr.scale;
    const next = clampZoomTransform(rawTx, rawTy, curr.scale, metrics);
    applyZoomTransformDom(next, metrics);
  }, [
    displayedPhoto?.id,
    currentDisplayUrl,
    getBaseImageMetrics,
    clampZoomTransform,
    applyZoomTransformDom,
  ]);

  const activeShotIndex = displayedShot
    ? allOrderedShots.findIndex((s) => s.id === displayedShot.id)
    : -1;
  const comparisonIndex =
    isComparisonActive && displayedShot
      ? activeComparisonShots.findIndex((s) => s.id === displayedShot.id)
      : -1;

  const canStepPrev = isComparisonActive
    ? comparisonIndex > 0
    : activeShotIndex > 0 &&
      allOrderedShots
        .slice(0, activeShotIndex)
        .some((s) => (ratingsByShotId[s.id] || 'unrated') !== 'reject');

  const canStepNext = isComparisonActive
    ? comparisonIndex >= 0 &&
      comparisonIndex < activeComparisonShots.length - 1
    : activeShotIndex >= 0 &&
      allOrderedShots
        .slice(activeShotIndex + 1)
        .some((s) => (ratingsByShotId[s.id] || 'unrated') !== 'reject');

  const renderExifLine = (
    shot: PhotoShotItem,
    media?: ResolvedPhotoMedia,
    tempOnly?: boolean
  ) => {
    const exif = media?.exif;
    const parts: string[] = [
      shot.formatSummary,
      formatBytes(shot.totalBytes),
    ];
    if (exif?.model) parts.push(exif.model);
    if (exif?.focalLength) parts.push(`${Math.round(exif.focalLength)}mm`);
    if (exif?.aperture) parts.push(`f/${exif.aperture}`);
    const shutter = formatShutterSpeed(exif?.exposureTime);
    if (shutter) parts.push(shutter);
    if (exif?.iso) parts.push(`ISO ${exif.iso}`);
    if (tempOnly) {
      parts.push('Dočasný náhled · doostřuji');
    } else if (media?.source === 'raw-embedded') {
      parts.push('RAW náhled');
    }
    return parts.join(' · ');
  };

  const visiblePickedFiles = pickedFiles.slice(0, pickedVisibleLimit);
  const hiddenPickedCount = Math.max(
    0,
    pickedFiles.length - pickedVisibleLimit
  );

  const renderPhotoStage = () => {
    if (!displayedShot || !displayedPhoto) return null;
    return (
      <div className="flex-1 min-h-0 w-full relative select-none overflow-hidden">
        {/* Underlying Next Card Preview */}
        {nextPeekPhoto && (
          <div
            aria-hidden="true"
            className="absolute inset-0 rounded-2xl border border-zinc-800/70 bg-[#121215] scale-[0.97] translate-y-1.5 opacity-60 overflow-hidden flex items-center justify-center pointer-events-none p-2 sm:p-4"
          >
            {nextDisplayUrl ? (
              <img
                src={nextDisplayUrl}
                alt=""
                referrerPolicy="no-referrer"
                className="h-full w-full object-contain opacity-45"
              />
            ) : (
              <span className="text-xs text-zinc-600 font-mono">
                {nextPeekPhoto.name}
              </span>
            )}
          </div>
        )}

        {/* Active Photo Card (decoupled from exiting fly-out overlay to eliminate dragX glitching) */}
        <div className="relative h-full w-full">
          <motion.div
            key={displayedPhoto.id}
            style={{
              x: isZoomed || isMultiTouchPinching ? 0 : dragX,
              rotate: isZoomed || isMultiTouchPinching ? 0 : cardRotate,
              touchAction: 'none',
              willChange: 'transform',
            }}
            className={`relative h-full w-full rounded-2xl border bg-[#0D0D10] shadow-2xl overflow-hidden ${
              displayedRating === 'pick'
                ? isFrameCull
                  ? 'border-emerald-400/75 shadow-[0_0_24px_rgba(16,185,129,0.14)]'
                  : 'border-amber-400/80 shadow-[0_0_24px_rgba(245,158,11,0.16)]'
                : displayedRating === 'reject' && isFrameCull
                  ? 'border-rose-500/80 shadow-[0_0_24px_rgba(244,63,94,0.16)]'
                  : 'border-zinc-800'
            } ${
              isZoomed
                ? 'cursor-zoom-out'
                : 'cursor-grab active:cursor-grabbing'
            }`}
          >
            {/* Top Status Indicators */}
            {!isZoomed && (
              <div className="pointer-events-none absolute top-3.5 left-3.5 right-3.5 z-20 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {displayedRating === 'pick' &&
                    (isFrameCull ? (
                      <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-2.5 py-1 text-xs font-bold text-zinc-950 shadow-lg">
                        <Check className="w-3.5 h-3.5 stroke-[3]" />
                        <span>PONECHÁNO</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-2.5 py-1 text-xs font-bold text-zinc-950 shadow-lg">
                        <Star className="w-3.5 h-3.5 fill-zinc-950" />
                        <span>VYBRÁNO</span>
                      </span>
                    ))}
                  {displayedRating === 'reject' &&
                    (isFrameCull ? (
                      <span className="inline-flex items-center gap-1.5 rounded-lg bg-rose-500 px-2.5 py-1 text-xs font-bold text-white shadow-lg">
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>KE SMAZÁNÍ</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900/90 border border-zinc-700 px-2.5 py-1 text-xs font-semibold text-zinc-400 shadow-lg">
                        <X className="w-3.5 h-3.5" />
                        <span>ZAHOZENO</span>
                      </span>
                    ))}
                </div>

                {(isSeriesOpen || isEditingSeries) &&
                  activeComparisonIds.size > 0 &&
                  displayedShot && (
                    <div className="pointer-events-auto flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleShotInSeries(displayedShot.id);
                        }}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors ${
                          activeComparisonIds.has(displayedShot.id)
                            ? 'bg-amber-500/20 border-amber-400/70 text-amber-200 hover:bg-amber-500/30'
                            : 'bg-black/80 border-zinc-700 text-zinc-200 hover:border-amber-400/60 hover:text-amber-200'
                        }`}
                      >
                        {activeComparisonIds.has(displayedShot.id) && (
                          <Check className="w-3 h-3" />
                        )}
                        <span>
                          {activeComparisonIds.has(displayedShot.id)
                            ? 'V sérii'
                            : 'Zařadit do série'}
                        </span>
                      </button>
                    </div>
                  )}
              </div>
            )}

            {/* Directional Swipe Stamps */}
            {!isZoomed && (
              <>
                <motion.div
                  style={{ opacity: pickOpacity }}
                  className={`pointer-events-none absolute top-14 left-5 z-20 flex items-center gap-2 rounded-xl border-2 px-4 py-2 shadow-lg ${
                    isFrameCull || isSeriesOpen
                      ? 'border-emerald-400 bg-emerald-950/90 text-emerald-300'
                      : 'border-amber-400 bg-amber-950/90 text-amber-300'
                  }`}
                >
                  {isFrameCull || isSeriesOpen ? (
                    <Check className="w-5 h-5 text-emerald-400 stroke-[3]" />
                  ) : (
                    <Star className="w-5 h-5 fill-amber-400 text-amber-400" />
                  )}
                  <span className="font-display text-sm sm:text-base font-bold tracking-wide">
                    {isSeriesOpen
                      ? activeComparisonShots.length > 1
                        ? 'JEN TENTO ✓'
                        : isFrameCull
                          ? 'PONECHAT ✓'
                          : 'VYBRAT ★'
                      : isFrameCull
                        ? 'PONECHAT ✓'
                        : 'VYBRAT ★'}
                  </span>
                </motion.div>

                <motion.div
                  style={{ opacity: rejectOpacity }}
                  className={`pointer-events-none absolute top-14 right-5 z-20 flex items-center gap-2 rounded-xl border-2 px-4 py-2 shadow-lg ${
                    isFrameCull || isSeriesOpen
                      ? 'border-rose-500 bg-rose-950/90 text-rose-200'
                      : 'border-zinc-500 bg-zinc-950/90 text-zinc-300'
                  }`}
                >
                  {isFrameCull || isSeriesOpen ? (
                    <Trash2 className="w-5 h-5 text-rose-400" />
                  ) : (
                    <X className="w-5 h-5" />
                  )}
                  <span className="font-display text-sm sm:text-base font-bold tracking-wide">
                    {isSeriesOpen
                      ? 'VYŘADIT ZE SÉRIE'
                      : isFrameCull
                        ? 'SMAZAT'
                        : 'ZAHODIT'}
                  </span>
                </motion.div>
              </>
            )}

            {/* Photo Viewport (transform-based 1:1 anchor zoom + 1-finger pan + 2-finger pinch up to 6x) */}
            <div
              ref={zoomContainerRefCallback}
              onClick={handlePhotoViewportClick}
              onPointerDown={handleZoomPointerDown}
              onPointerMove={handleZoomPointerMove}
              onPointerUp={handleZoomPointerEnd}
              onPointerCancel={handleZoomPointerEnd}
              className="relative h-full w-full overflow-hidden select-none touch-none"
            >
              <div
                ref={zoomLayerRefCallback}
                style={{
                  transformOrigin: '0 0',
                  transform: `translate3d(${zoomTransformRef.current.tx}px, ${zoomTransformRef.current.ty}px, 0) scale(${zoomTransformRef.current.scale})`,
                }}
                className="relative h-full w-full flex items-center justify-center p-1.5 sm:p-4 will-change-transform"
              >
                {currentError && !currentDisplayUrl ? (
                  <div className="max-w-sm text-center space-y-3 p-6 mx-auto">
                    <ImageOff className="w-8 h-8 text-zinc-500 mx-auto" />
                    <p className="text-sm text-zinc-300">{currentError}</p>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void loadPhotoProgressive(displayedPhoto, true);
                      }}
                      className="px-4 py-2 rounded-lg bg-zinc-800 text-xs font-medium text-zinc-100 hover:bg-zinc-700 cursor-pointer"
                    >
                      Zkusit znovu dekódovat RAW
                    </button>
                  </div>
                ) : currentDisplayUrl ? (
                  <img
                    ref={zoomImgRefCallback}
                    data-zoom-img="true"
                    src={currentDisplayUrl}
                    alt={displayedPhoto.name}
                    referrerPolicy="no-referrer"
                    draggable={false}
                    decoding="sync"
                    onLoad={() => {
                      const curr = zoomTransformRef.current;
                      if (curr.scale > 1.001) {
                        const metrics = getBaseImageMetrics();
                        if (metrics) {
                          const focus = zoomFocusNormRef.current;
                          const focusX0 =
                            metrics.imgLeft0 + focus.relX * metrics.imgW0;
                          const focusY0 =
                            metrics.imgTop0 + focus.relY * metrics.imgH0;
                          const rawTx = metrics.cw / 2 - focusX0 * curr.scale;
                          const rawTy = metrics.ch / 2 - focusY0 * curr.scale;
                          const next = clampZoomTransform(
                            rawTx,
                            rawTy,
                            curr.scale,
                            metrics
                          );
                          applyZoomTransformDom(next, metrics);
                        }
                      }
                    }}
                    onError={() => handleImageElementError(displayedPhoto)}
                    className={`w-full h-full object-contain select-none rounded-lg pointer-events-none transition-opacity ${
                      displayedRating === 'reject' ? 'opacity-45 grayscale' : ''
                    }`}
                  />
                ) : (
                  <div className="flex flex-col items-center gap-3 text-zinc-400">
                    <div className="h-8 w-8 rounded-full border-2 border-zinc-700 border-t-amber-400 animate-spin" />
                    <p className="text-xs sm:text-sm">
                      {displayedPhoto.isRaw
                        ? `Načítám rychlý náhled ${displayedPhoto.fileExtension.toUpperCase()}…`
                        : 'Načítám rychlý náhled…'}
                    </p>
                  </div>
                )}
              </div>

              {isZoomed && (
                <span
                  ref={zoomReadoutRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute top-2.5 right-3 z-20 font-mono text-xs font-semibold text-amber-300 tabular-nums drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]"
                >
                  {zoomTransformRef.current.scale.toFixed(1)}×
                </span>
              )}
            </div>

            {/* Frame Stepping Overlay Arrows (browse series/comparison or folder chronologically) */}
            {!isZoomed && canStepPrev && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  stepShot(-1);
                }}
                aria-label="Předchozí snímek (←)"
                className="absolute left-1.5 sm:left-2.5 top-1/2 -translate-y-1/2 z-20 min-h-[38px] min-w-[38px] sm:min-h-[44px] sm:min-w-[44px] inline-flex items-center justify-center rounded-full bg-black/65 border border-zinc-700 text-zinc-100 hover:bg-black/85 cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>
            )}

            {!isZoomed && canStepNext && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  stepShot(1);
                }}
                aria-label="Další snímek (→)"
                className="absolute right-1.5 sm:right-2.5 top-1/2 -translate-y-1/2 z-20 min-h-[38px] min-w-[38px] sm:min-h-[44px] sm:min-w-[44px] inline-flex items-center justify-center rounded-full bg-black/65 border border-zinc-700 text-zinc-100 hover:bg-black/85 cursor-pointer"
              >
                <ArrowRight className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>
            )}

            {/* Subtle Scrim Metadata Overlay at Bottom of Card */}
            {!isZoomed && !showExifPanel && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3.5 sm:px-5 pt-8 pb-2.5 sm:pb-3.5 flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs sm:text-sm font-semibold text-zinc-100 truncate flex items-center gap-2">
                    <span className="truncate">
                      {isComparisonActive && comparisonIndex >= 0
                        ? `Série ${comparisonIndex + 1}/${activeComparisonShots.length}${
                            activeBurstGroup?.matchReason === 'visual'
                              ? ' · podobný vzhled'
                              : activeBurstGroup?.matchReason === 'mixed'
                                ? ' · čas i vzhled'
                                : ''
                          } · `
                        : activeShotIndex >= 0
                          ? `#${activeShotIndex + 1}/${allOrderedShots.length} · `
                          : ''}
                      {displayedShot.primary.name}
                    </span>
                    {displayedShot.isPaired && (
                      <span className="shrink-0 inline-flex items-center gap-1 text-xs font-medium text-amber-300">
                        <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                        Pár: {displayedShot.formatSummary}
                      </span>
                    )}
                  </p>
                  <p className="font-mono text-[11px] sm:text-xs text-zinc-300/90 truncate tabular-nums">
                    {renderExifLine(
                      displayedShot,
                      currentSharp,
                      isShowingTempOnly
                    )}
                  </p>
                </div>

                {currentSharp?.source === 'drive-thumbnail' &&
                  displayedPhoto.isRaw && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void loadPhotoProgressive(displayedPhoto, true);
                      }}
                      disabled={currentUpgrading}
                      className="pointer-events-auto shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-black/75 border border-zinc-700 text-[11px] font-medium text-amber-300 hover:bg-zinc-900 cursor-pointer"
                    >
                      <Sparkles className="w-3 h-3" />
                      <span className="hidden sm:inline">
                        {currentUpgrading ? 'Dekóduji RAW…' : 'Načíst RAW náhled'}
                      </span>
                      <span className="sm:hidden">RAW</span>
                    </button>
                  )}
              </div>
            )}

            {/* Floating EXIF Overlay Inside Card */}
            {showExifPanel && !isZoomed && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute inset-x-2.5 sm:inset-x-4 bottom-2.5 sm:bottom-4 z-30 rounded-xl border border-zinc-700/80 bg-black/90 backdrop-blur-md p-3.5 shadow-2xl"
              >
                <div className="flex items-center justify-between gap-2 mb-2.5">
                  <span className="text-xs font-semibold text-zinc-200 truncate">
                    {displayedShot.primary.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowExifPanel(false)}
                    aria-label="Zavřít EXIF detaily"
                    className="h-7 w-7 inline-flex items-center justify-center rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                  <div>
                    <p className="text-zinc-500">Fotoaparát</p>
                    <p className="mt-0.5 font-medium text-zinc-200 truncate">
                      {currentSharp?.exif?.model || 'Neuvedeno'}
                    </p>
                  </div>
                  <div>
                    <p className="text-zinc-500">Objektiv</p>
                    <p className="mt-0.5 font-medium text-zinc-200 truncate">
                      {currentSharp?.exif?.lens || 'Neuvedeno'}
                    </p>
                  </div>
                  <div>
                    <p className="text-zinc-500">Expozice</p>
                    <p className="mt-0.5 font-mono text-zinc-200 tabular-nums">
                      {[
                        currentSharp?.exif?.aperture
                          ? `f/${currentSharp.exif.aperture}`
                          : null,
                        formatShutterSpeed(currentSharp?.exif?.exposureTime),
                        currentSharp?.exif?.iso
                          ? `ISO ${currentSharp.exif.iso}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Neuvedeno'}
                    </p>
                  </div>
                  <div>
                    <p className="text-zinc-500">Zdroj náhledu</p>
                    <p className="mt-0.5 font-medium text-zinc-200">
                      {isShowingTempOnly
                        ? 'Dočasný náhled'
                        : currentSharp?.source === 'raw-embedded'
                          ? `Extrahováno z ${displayedPhoto.fileExtension.toUpperCase()}`
                          : currentSharp?.source === 'local-media'
                            ? 'Lokální soubor'
                            : currentSharp?.source === 'drive-media'
                              ? 'Plný soubor'
                              : 'Ostrý náhled Drive'}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </motion.div>

          {/* Exiting Swipe Fly-Out Ghost (isolated from live dragX so incoming card never flickers) */}
          {exitingSwipeCard && (
            <motion.div
              key={exitingSwipeCard.key}
              initial={{
                x: exitingSwipeCard.startX,
                rotate: Math.max(
                  -12,
                  Math.min(12, exitingSwipeCard.startX / 24)
                ),
                opacity: 1,
              }}
              animate={{
                x: exitingSwipeCard.dir === 'right' ? 440 : -440,
                rotate: exitingSwipeCard.dir === 'right' ? 14 : -14,
                opacity: 0,
              }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              onAnimationComplete={() => {
                setExitingSwipeCard((curr) =>
                  curr?.key === exitingSwipeCard.key ? null : curr
                );
              }}
              className={`pointer-events-none absolute inset-0 z-30 rounded-2xl border bg-[#0D0D10] shadow-2xl overflow-hidden flex items-center justify-center p-1.5 sm:p-4 ${
                exitingSwipeCard.dir === 'right'
                  ? 'border-emerald-400/75'
                  : 'border-rose-500/75'
              }`}
            >
              {exitingSwipeCard.url && (
                <img
                  src={exitingSwipeCard.url}
                  alt={exitingSwipeCard.name}
                  referrerPolicy="no-referrer"
                  draggable={false}
                  decoding="sync"
                  className="w-full h-full object-contain rounded-lg"
                />
              )}
            </motion.div>
          )}
        </div>
      </div>
    );
  };

  const renderActionControls = () => {
    if (!displayedShot) return null;
    const isPicked = displayedRating === 'pick';
    const isRejected = displayedRating === 'reject';
    const seriesCount = activeComparisonShots.length;
    const inOpenSeries = isSeriesOpen && seriesCount >= 1;

    return (
      <div className="shrink-0 w-full flex items-center justify-between md:grid md:grid-cols-[1fr_auto_1fr] gap-1.5 sm:gap-2 min-h-[44px]">
        {/* Left: Direct Click Equivalent of Swipe LEFT */}
        <div className="flex items-center justify-start shrink-0">
          <button
            type="button"
            onClick={() => handlePrimaryLeftAction('click')}
            aria-label={
              inOpenSeries
                ? 'Vyřadit tento snímek ze série (ekvivalent swipu doleva)'
                : isRejected
                  ? isFrameCull
                    ? 'Zrušit označení ke smazání'
                    : 'Zrušit zahození'
                  : isFrameCull
                    ? 'Smazat tento snímek (X nebo swipe vlevo)'
                    : 'Zahodit snímek (X nebo swipe vlevo)'
            }
            title={
              inOpenSeries
                ? 'Vyřadit tento snímek ze série (ekvivalent swipu doleva)'
                : isRejected
                  ? 'Zrušit označení'
                  : isFrameCull
                    ? 'Smazat tento snímek (X nebo swipe vlevo)'
                    : 'Zahodit / skrýt (X nebo swipe vlevo)'
            }
            className={`min-h-[44px] min-w-[44px] px-2.5 sm:px-3.5 inline-flex items-center justify-center gap-1.5 rounded-xl border text-xs sm:text-sm font-semibold transition-colors cursor-pointer ${
              inOpenSeries || isFrameCull
                ? !inOpenSeries && isRejected
                  ? 'border-rose-400 bg-rose-500 text-white hover:bg-rose-400'
                  : 'border-rose-500/50 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 hover:text-rose-200'
                : isRejected
                  ? 'border-zinc-600 bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                  : 'border-zinc-700/80 bg-[#141417] text-zinc-300 hover:border-rose-500/50 hover:text-rose-200 hover:bg-rose-500/10'
            }`}
          >
            {inOpenSeries || isFrameCull ? (
              <Trash2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            ) : (
              <X className="w-4 h-4 shrink-0" aria-hidden="true" />
            )}
            <span className="hidden sm:inline whitespace-nowrap">
              {inOpenSeries
                ? 'Vyřadit'
                : isRejected
                  ? 'Zrušit'
                  : isFrameCull
                    ? 'Smazat'
                    : 'Zahodit'}
            </span>
          </button>
        </div>

        {/* Center: Step Prev + Undo + Zoom + EXIF + Step Next */}
        <div className="flex items-center justify-center gap-1 sm:gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => stepShot(-1)}
            disabled={!canStepPrev}
            title="Předchozí snímek (←)"
            aria-label="Předchozí snímek"
            className="hidden md:inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            title="Krok zpět (Z)"
            aria-label="Krok zpět"
            className="min-h-[44px] min-w-[40px] sm:min-w-[44px] inline-flex items-center justify-center rounded-xl border border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={toggleCenterZoom}
            disabled={!currentDisplayUrl}
            title="Lupa 2,5× (L nebo Mezerník)"
            aria-label={isZoomed ? 'Oddálit' : 'Přiblížit lupou'}
            className={`min-h-[44px] min-w-[40px] sm:min-w-[44px] inline-flex items-center justify-center rounded-xl border transition-colors cursor-pointer disabled:opacity-35 ${
              isZoomed
                ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                : 'border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700'
            }`}
          >
            {isZoomed ? (
              <ZoomOut className="w-4 h-4" />
            ) : (
              <ZoomIn className="w-4 h-4" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setShowExifPanel((s) => !s)}
            title="Detaily snímku (E)"
            aria-label="Zobrazit EXIF detaily"
            className={`min-h-[44px] min-w-[40px] sm:min-w-[44px] inline-flex items-center justify-center rounded-xl border transition-colors cursor-pointer ${
              showExifPanel
                ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                : 'border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700'
            }`}
          >
            <Info className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => stepShot(1)}
            disabled={!canStepNext}
            title="Další snímek (→)"
            aria-label="Další snímek"
            className="hidden md:inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Right: Direct Click Equivalent of Swipe RIGHT */}
        <div className="flex items-center justify-end shrink-0">
          <button
            type="button"
            onClick={() => handlePrimaryRightAction('click')}
            aria-label={
              inOpenSeries
                ? seriesCount >= 2
                  ? `Vybrat jen tento 1 snímek a zbylých ${seriesCount - 1} ze série smazat (ekvivalent swipu doprava)`
                  : 'Vybrat a ponechat tento poslední snímek série (ekvivalent swipu doprava)'
                : isPicked
                  ? isFrameCull
                    ? 'Zrušit ponechání snímku'
                    : 'Odebrat z výběru'
                  : isFrameCull
                    ? 'Ponechat tento snímek (P nebo swipe vpravo)'
                    : 'Vybrat do Liked (P nebo swipe vpravo)'
            }
            title={
              inOpenSeries
                ? seriesCount >= 2
                  ? `Vybrat jen tento 1 snímek a zbylých ${seriesCount - 1} ze série smazat (ekvivalent swipu doprava)`
                  : 'Ponechat tento snímek a uzavřít sérii'
                : isFrameCull
                  ? 'Ponechat tento snímek (P nebo swipe vpravo)'
                  : 'Vybrat do Liked (P nebo swipe vpravo)'
            }
            className={`min-h-[44px] min-w-[44px] px-2.5 sm:px-3.5 inline-flex items-center justify-center gap-1.5 rounded-xl border text-xs sm:text-sm font-semibold transition-colors cursor-pointer ${
              inOpenSeries || isFrameCull
                ? !inOpenSeries && isPicked
                  ? 'border-emerald-400 bg-emerald-500 text-zinc-950 hover:bg-emerald-400'
                  : 'border-emerald-500/50 bg-emerald-500/18 text-emerald-300 hover:bg-emerald-500/28 hover:text-emerald-200'
                : isPicked
                  ? 'border-amber-400 bg-amber-500 text-zinc-950 hover:bg-amber-400'
                  : 'border-amber-500/50 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 hover:text-amber-200'
            }`}
          >
            {inOpenSeries ? (
              <>
                {seriesCount >= 2 && (
                  <span className="font-mono text-[11px] font-bold leading-none tabular-nums">
                    1
                  </span>
                )}
                <Check className="w-4 h-4 stroke-[2.75] shrink-0" aria-hidden="true" />
                <span className="hidden sm:inline whitespace-nowrap">
                  {seriesCount >= 2 ? 'Jen tento' : 'Ponechat'}
                </span>
              </>
            ) : isFrameCull ? (
              <>
                <Check className="w-4 h-4 stroke-[2.75] shrink-0" aria-hidden="true" />
                <span className="hidden sm:inline whitespace-nowrap">
                  {isPicked ? 'Ponecháno' : 'Ponechat'}
                </span>
              </>
            ) : (
              <>
                <Star
                  className={`w-4 h-4 shrink-0 ${
                    isPicked ? 'fill-zinc-950' : 'fill-amber-400/30'
                  }`}
                  aria-hidden="true"
                />
                <span className="hidden sm:inline whitespace-nowrap">
                  {isPicked ? 'Vybráno' : 'Vybrat'}
                </span>
              </>
            )}
          </button>
        </div>
      </div>
    );
  };

  return (
    <section className="h-full w-full flex flex-col min-h-0 overflow-hidden overscroll-none max-w-7xl mx-auto px-2 sm:px-5 pt-[max(0.375rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))] gap-1.5 sm:gap-2">
      {/* Compact Modular Studio Top Bar (2 clean tiers on mobile/tablet, 1 row on lg+) */}
      <div className="shrink-0 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-1.5 lg:gap-2 pb-1.5 sm:pb-2 border-b border-zinc-800/80">
        {/* Tier 1: Back + Generous Folder Name & Counter + Mobile Primary Export/Filters */}
        <div className="flex items-center justify-between gap-2 min-w-0 lg:flex-1">
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0 flex-1">
            <button
              type="button"
              onClick={() => {
                void flushPersistence();
                onBackToFolders();
              }}
              aria-label="Zpět na seznam složek"
              className="inline-flex items-center gap-1.5 min-h-[38px] min-w-[38px] lg:min-h-[40px] justify-center px-2 sm:px-3 py-1.5 rounded-lg border border-zinc-800 bg-[#141417] text-xs font-medium text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors shrink-0 cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
              <span className="hidden lg:inline">Složky</span>
            </button>

            <div className="min-w-0 flex-1">
              <h1 className="font-display text-sm sm:text-base font-semibold text-zinc-100 truncate">
                {folder.name}
              </h1>
              <div className="flex items-center gap-1.5 font-mono text-[11px] sm:text-xs text-zinc-400 tabular-nums truncate">
                {isFrameCull ? (
                  <span className="text-rose-300 font-medium whitespace-nowrap">
                    Smazat {trashShotsList.length.toLocaleString('cs-CZ')}
                  </span>
                ) : (
                  <span className="text-amber-300 font-medium whitespace-nowrap">
                    ★ {pickedShotsList.length.toLocaleString('cs-CZ')}
                  </span>
                )}
                <span className="whitespace-nowrap">
                  / {allOrderedShots.length.toLocaleString('cs-CZ')}
                </span>
                {syncStatus === 'saving' && (
                  <span className="hidden sm:inline text-amber-300">
                    · Ukládám…
                  </span>
                )}
                {syncStatus === 'saved' && (
                  <span className="hidden sm:inline text-emerald-400/90">
                    {isLocalSource ? '· Uloženo lokálně' : '· Uloženo v cloudu'}
                  </span>
                )}
                {syncStatus === 'error' && (
                  <span className="text-rose-400">· Čeká na sync</span>
                )}
                {isLoadingMore && (
                  <span className="text-amber-400">
                    · <span className="hidden sm:inline">Načteno </span>
                    {activePhotos.length.toLocaleString('cs-CZ')}…
                  </span>
                )}
                {loadMoreError && (
                  <button
                    type="button"
                    onClick={onRetryLoadMore}
                    className="inline-flex items-center gap-1 text-rose-400 hover:text-rose-300 underline cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Obnovit
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Mobile/Tablet Primary Quick Controls (Filters + Finish CTA) */}
          <div className="flex lg:hidden items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setIsDrawerOpen(true)}
              aria-expanded={isDrawerOpen}
              aria-label="Otevřít filtry, nastavení a vybrané snímky"
              className={`min-h-[38px] min-w-[38px] inline-flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap cursor-pointer ${
                formatFilter !== 'all' ||
                pickedShotsList.length > 0 ||
                trashShotsList.length > 0
                  ? 'border-zinc-700 bg-zinc-800/80 text-zinc-100'
                  : 'border-zinc-800 bg-[#141417] text-zinc-300'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Filtry</span>
            </button>

            {isFrameCull ? (
              <button
                type="button"
                disabled={trashFiles.length === 0}
                onClick={() =>
                  onRequestFinishTrash(
                    trashFiles,
                    trashShotsList.length,
                    thumbnailUrlLookup
                  )
                }
                className="min-h-[38px] inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg bg-rose-500 text-white text-xs font-semibold hover:bg-rose-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed tabular-nums"
              >
                <Trash2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Smazat</span>
                <span>({trashShotsList.length.toLocaleString('cs-CZ')})</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={pickedFiles.length === 0}
                onClick={() =>
                  onRequestFinishSelection(
                    pickedFiles,
                    pickedShotsList.length,
                    thumbnailUrlLookup
                  )
                }
                className="min-h-[38px] inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg bg-amber-500 text-zinc-950 text-xs font-semibold hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed tabular-nums"
              >
                <FolderCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Liked</span>
                <span>({pickedShotsList.length.toLocaleString('cs-CZ')})</span>
              </button>
            )}
          </div>
        </div>

        {/* Tier 2 on Mobile/Tablet (scroll-safe horizontal strip) / Right Unified Row on Desktop */}
        <div className="flex items-center lg:justify-end gap-1.5 sm:gap-2 w-full lg:w-auto min-w-0 overflow-x-auto no-scrollbar">
          {/* Compact Icon App Mode Switcher: Selectra (Green Check) vs FrameCull (Red Trash) */}
          <div
            className="flex items-center p-0.5 rounded-lg border border-zinc-800 bg-[#09090B] shrink-0"
            role="group"
            aria-label="Přepnout režim výběr nebo mazání"
          >
            <button
              type="button"
              onClick={() => onSwitchAppMode('selectra')}
              aria-pressed={appMode === 'selectra'}
              aria-label="Režim výběru fotek (Selectra)"
              title="Režim výběru fotek (Selectra)"
              className={`min-h-[30px] lg:min-h-[36px] min-w-[30px] lg:min-w-[36px] inline-flex items-center justify-center rounded-md transition-colors shrink-0 cursor-pointer ${
                appMode === 'selectra'
                  ? 'bg-emerald-500 text-zinc-950'
                  : 'text-emerald-400/75 hover:text-emerald-300'
              }`}
            >
              <Check className="w-4 h-4 stroke-[2.5]" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onSwitchAppMode('framecull')}
              aria-pressed={appMode === 'framecull'}
              aria-label="Režim mazání fotek (FrameCull)"
              title="Režim mazání fotek (FrameCull)"
              className={`min-h-[30px] lg:min-h-[36px] min-w-[30px] lg:min-w-[36px] inline-flex items-center justify-center rounded-md transition-colors shrink-0 cursor-pointer ${
                appMode === 'framecull'
                  ? 'bg-rose-500 text-white'
                  : 'text-rose-400/75 hover:text-rose-300'
              }`}
            >
              <Trash2 className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>

          {/* Detail vs Full Gallery View Segmented Switcher */}
          {allOrderedShots.length > 0 && (
            <div
              className="flex items-center p-0.5 rounded-lg border border-zinc-800 bg-[#09090B] shrink-0"
              role="group"
              aria-label="Režim zobrazení studia"
            >
              <button
                type="button"
                onClick={() => handleSwitchStudioMode('detail')}
                title="Detailní porovnání a lišta (G)"
                className={`min-h-[30px] lg:min-h-[36px] inline-flex items-center gap-1 px-2 sm:px-2.5 py-0.5 lg:py-1 text-[11px] sm:text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  studioMode === 'detail'
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Detail</span>
              </button>
              <button
                type="button"
                onClick={() => handleSwitchStudioMode('gallery')}
                title="Celá galerie složky s úrovněmi přiblížení (G)"
                className={`min-h-[30px] lg:min-h-[36px] inline-flex items-center gap-1 px-2 sm:px-2.5 py-0.5 lg:py-1 text-[11px] sm:text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  studioMode === 'gallery'
                    ? 'bg-amber-500 text-zinc-950 font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Galerie</span>
              </button>
            </div>
          )}

          <div className="flex items-center gap-1 shrink-0">
            {activeComparisonShots.length > 0 &&
              (!isSeriesOpen || studioMode === 'gallery') && (
                <button
                  type="button"
                  onClick={handleOpenSeries}
                  className="min-h-[32px] lg:min-h-[38px] inline-flex items-center gap-1.5 px-2 sm:px-3 py-1 text-[11px] sm:text-xs font-medium rounded-lg border border-amber-500/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums"
                >
                  <Layers className="w-3.5 h-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Otevřít sérii</span>
                  <span className="sm:hidden">Série</span>
                  <span>({activeComparisonShots.length})</span>
                </button>
              )}

            {(isSeriesOpen || activeSeriesShotIds.size > 0) && (
              <button
                type="button"
                onClick={handleCloseSeries}
                title="Ukončit nebo zrušit výběr série (Esc)"
                className={`min-h-[32px] lg:min-h-[38px] inline-flex items-center gap-1 px-2 sm:px-3 py-1 text-[11px] sm:text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                  isSeriesOpen && studioMode === 'detail'
                    ? 'border-amber-400 bg-amber-500 text-zinc-950 font-semibold hover:bg-amber-400'
                    : 'border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700'
                }`}
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">
                  {isSeriesOpen ? 'Ukončit sérii' : 'Zrušit sérii'}
                </span>
                <span className="sm:hidden">
                  {isSeriesOpen ? 'Ukončit' : 'Zrušit'}
                </span>
                {isSeriesOpen && studioMode === 'detail' && (
                  <span>({activeComparisonShots.length})</span>
                )}
              </button>
            )}

            {(activeComparisonShots.length === 0 ||
              (displayedShot && !activeComparisonIds.has(displayedShot.id))) && (
              <button
                type="button"
                onClick={() => void handleFindSeriesAroundCurrent()}
                disabled={!displayedShot || isFindingSeries}
                title="Najít podobné okolní fotky kolem této jedné fotky"
                className="min-h-[32px] lg:min-h-[38px] inline-flex items-center gap-1 px-2 sm:px-3 py-1 text-[11px] sm:text-xs font-medium rounded-lg border border-zinc-800 bg-[#141417] text-zinc-300 hover:text-amber-200 hover:border-amber-500/50 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-300" aria-hidden="true" />
                <span className="hidden sm:inline">
                  {isFindingSeries ? 'Hledám sérii…' : 'Najít sérii'}
                </span>
                <span className="sm:hidden">
                  {isFindingSeries ? 'Hledám…' : 'Najít'}
                </span>
              </button>
            )}
          </div>

          {/* Desktop Filters & Finish CTA */}
          <div className="hidden lg:flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setIsDrawerOpen(true)}
              aria-expanded={isDrawerOpen}
              aria-label="Otevřít filtry, nastavení a vybrané snímky"
              className={`min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap cursor-pointer tabular-nums ${
                formatFilter !== 'all' ||
                pickedShotsList.length > 0 ||
                trashShotsList.length > 0
                  ? 'border-zinc-700 bg-zinc-800/80 text-zinc-100 hover:border-zinc-600'
                  : 'border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Filtry</span>
            </button>

            {isFrameCull ? (
              <button
                type="button"
                disabled={trashFiles.length === 0}
                onClick={() =>
                  onRequestFinishTrash(
                    trashFiles,
                    trashShotsList.length,
                    thumbnailUrlLookup
                  )
                }
                className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500 text-white text-xs font-semibold hover:bg-rose-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed tabular-nums"
              >
                <Trash2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Smazat vybrané</span>
                <span>({trashShotsList.length.toLocaleString('cs-CZ')})</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={pickedFiles.length === 0}
                onClick={() =>
                  onRequestFinishSelection(
                    pickedFiles,
                    pickedShotsList.length,
                    thumbnailUrlLookup
                  )
                }
                className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 text-zinc-950 text-xs font-semibold hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed tabular-nums"
              >
                <FolderCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Dokončit výběr</span>
                <span>({pickedShotsList.length.toLocaleString('cs-CZ')})</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Feedback Banner after successful Liked export */}
      {lastActionSummary && (
        <div className="shrink-0 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1.5 text-xs text-emerald-200">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="truncate">{lastActionSummary}</span>
        </div>
      )}

      {/* Main Scroll-Locked Studio Canvas + Continuous Bottom Filmstrip / Full Gallery */}
      <div
        ref={studioCanvasRef}
        className="relative flex-1 min-h-0 flex flex-col overflow-hidden"
      >
        {!isDecisionsLoaded || !ratingsHydrated ? (
          <div className="flex-1 flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-[#141417] p-8 sm:p-10 text-center space-y-3">
              <div className="mx-auto h-8 w-8 rounded-full border-2 border-zinc-700 border-t-amber-400 animate-spin" />
              <p className="text-sm text-zinc-300">
                Načítám uloženou pozici a výběr fotografií…
              </p>
            </div>
          </div>
        ) : activePhotos.length === 0 ? (
          <div className="flex-1 min-h-0 w-full flex items-center justify-center overflow-y-auto p-2">
            <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-[#141417] p-8 sm:p-10 text-center space-y-4">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-800 text-zinc-400">
                <FolderOpen className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h2 className="font-display text-lg font-semibold text-zinc-100">
                  Složka neobsahuje žádné podporované fotografie
                </h2>
                <p className="text-sm text-zinc-400 max-w-md mx-auto">
                  V této složce nebyly nalezeny obrázky ani RAW soubory (CR3,
                  CR2, NEF, ARW, DNG, JPG, PNG, HEIC). Videa se záměrně
                  přeskakují.
                </p>
              </div>
              <button
                type="button"
                onClick={onBackToFolders}
                className="min-h-[44px] px-5 py-2 rounded-lg bg-zinc-100 text-zinc-950 text-sm font-semibold hover:bg-white transition-colors cursor-pointer"
              >
                Vybrat jinou složku
              </button>
            </div>
          </div>
        ) : pendingResumeTarget ? (
          <div className="flex-1 min-h-0 w-full flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-[#141417] p-6 sm:p-8 text-center space-y-4 shadow-2xl">
              <div className="mx-auto h-9 w-9 rounded-full border-2 border-zinc-700 border-t-amber-400 animate-spin" />
              <div className="space-y-1.5">
                <h2 className="font-display text-base sm:text-lg font-semibold text-zinc-100">
                  {matchedResumeShot
                    ? 'Načítám fotku, kde jste skončil…'
                    : 'Hledám fotku, kde jste skončil…'}
                </h2>
                {(pendingResumeTarget.fileName ||
                  matchedResumeShot?.primary.name) && (
                  <p className="font-mono text-xs text-amber-300 truncate px-2">
                    {matchedResumeShot?.primary.name ||
                      pendingResumeTarget.fileName}
                  </p>
                )}
                <p className="text-xs text-zinc-400 tabular-nums">
                  {matchedResumeShot
                    ? matchedResumeShot.primary.isRaw
                      ? 'Připravuji náhled RAW snímku před zobrazením…'
                      : 'Čekám na dokončení načtení správné fotky…'
                    : loadMoreError
                      ? loadMoreError
                      : `Načteno ${activePhotos.length.toLocaleString('cs-CZ')} snímků ze složky…`}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                {loadMoreError && (
                  <button
                    type="button"
                    onClick={onRetryLoadMore}
                    className="min-h-[38px] inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-amber-500 text-zinc-950 text-xs font-semibold hover:bg-amber-400 transition-colors cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Zkusit načíst znovu
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleSkipResume}
                  className="min-h-[38px] px-3.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 text-xs font-medium text-zinc-300 hover:text-white hover:border-zinc-600 transition-colors cursor-pointer"
                >
                  Začít od první fotky
                </button>
              </div>
            </div>
          </div>
        ) : allOrderedShots.length === 0 || !displayedShot || !displayedPhoto ? (
          <div className="flex-1 min-h-0 w-full flex items-center justify-center overflow-y-auto p-2">
            <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-[#141417] p-8 text-center space-y-4">
              <p className="text-sm text-zinc-300">
                Pro aktivní filtr ({formatFilter === 'raw' ? 'Jen RAW' : 'Jen JPG/PNG'}) nebyly nalezeny žádné soubory.
              </p>
              <button
                type="button"
                onClick={() => setFormatFilter('all')}
                className="min-h-[42px] px-4 py-2 rounded-lg bg-amber-500 text-zinc-950 text-xs font-semibold hover:bg-amber-400 cursor-pointer"
              >
                Zobrazit všechny formáty
              </button>
            </div>
          </div>
        ) : (
          <AnimatePresence mode="sync" initial={false}>
            {studioMode === 'gallery' ? (
              <motion.div
                key="gallery-view"
                initial={
                  prefersReducedMotion
                    ? { opacity: 0 }
                    : { y: 84, scale: 0.97, opacity: 0 }
                }
                animate={{ y: 0, scale: 1, opacity: 1 }}
                exit={
                  prefersReducedMotion
                    ? { opacity: 0 }
                    : { y: 150, scale: 0.94, opacity: 0 }
                }
                transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                className="absolute inset-0 z-10 flex flex-col min-h-0 overflow-hidden bg-[#09090B]"
              >
                <GalleryGridView
                  appMode={appMode}
                  shots={allOrderedShots}
                  activeShotId={displayedShot.id}
                  ratingsByShotId={ratingsByShotId}
                  burstGroupByShotId={burstGroupByShotId}
                  seriesEnabled={gallerySeriesEnabled}
                  activeComparisonIds={activeComparisonIds}
                  isEditingSeries={isEditingSeries}
                  isFindingSeries={isFindingSeries}
                  zoomLevel={galleryZoomLevel}
                  accessToken={accessToken}
                  tempPreviewMap={tempPreviewMap}
                  sharpMediaMap={sharpMediaMap}
                  onChangeZoomLevel={setGalleryZoomLevel}
                  onToggleSeriesEnabled={handleToggleGallerySeriesEnabled}
                  onSelectShot={handleSelectShotFromStrip}
                  onOpenShotDetail={handleOpenShotFromGallery}
                  onToggleShotInSeries={handleToggleShotInSeries}
                  onToggleEditingSeries={handleToggleEditingSeries}
                  onOpenSeries={handleOpenSeries}
                  onFindSeries={() => void handleFindSeriesAroundCurrent()}
                />
              </motion.div>
            ) : (
              <motion.div
                key="detail-view"
                className="absolute inset-0 flex flex-col items-center justify-between gap-1.5 sm:gap-2 overflow-hidden"
              >
                <motion.div
                  key={`stage-${galleryToDetailAnim?.seq ?? 0}`}
                  initial={
                    prefersReducedMotion || !galleryToDetailAnim
                      ? { opacity: 0.92 }
                      : {
                          x: galleryToDetailAnim.offsetX,
                          y: galleryToDetailAnim.offsetY,
                          scale: galleryToDetailAnim.startScale,
                          opacity: 0.55,
                        }
                  }
                  animate={{ x: 0, y: 0, scale: 1, opacity: 1 }}
                  transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                  className="flex-1 min-h-0 w-full flex flex-col overflow-hidden"
                >
                  {renderPhotoStage()}
                </motion.div>

                <motion.div
                  key={`dock-${galleryToDetailAnim?.seq ?? 0}`}
                  initial={
                    prefersReducedMotion
                      ? false
                      : galleryToDetailAnim
                        ? { y: -115, opacity: 0.15, scale: 0.98 }
                        : { y: 20, opacity: 0 }
                  }
                  animate={{ y: 0, opacity: 1, scale: 1 }}
                  transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
                  className="w-full shrink-0 flex flex-col gap-1.5 sm:gap-2"
                >
                  <div className="w-full shrink-0">{renderActionControls()}</div>

                  {isSeriesOpen && activeComparisonIds.size > 0 ? (
                    <SeriesScrubStrip
                      appMode={appMode}
                      allOrderedShots={allOrderedShots}
                      seriesShotIds={activeComparisonIds}
                      burstGroupByShotId={burstGroupByShotId}
                      activeShotId={displayedShot.id}
                      ratingsByShotId={ratingsByShotId}
                      isEditingSeries={isEditingSeries}
                      isMultiSelectMode={isSeriesMultiSelect}
                      selectedMultiIds={selectedSeriesMultiIds}
                      accessToken={accessToken}
                      tempPreviewMap={tempPreviewMap}
                      sharpMediaMap={sharpMediaMap}
                      onSelectShot={handleSelectShotFromStrip}
                      onToggleShotInSeries={handleToggleShotInSeries}
                      onToggleEditingSeries={handleToggleEditingSeries}
                      onToggleMultiSelectMode={handleToggleSeriesMultiSelectMode}
                      onToggleMultiSelectShot={handleToggleMultiSelectShot}
                      onConfirmMultiSelect={handleConfirmSeriesMultiSelect}
                      onKeepEntireSeries={() =>
                        applySeriesBatchAction('keep-all')
                      }
                      onDeleteEntireSeries={() =>
                        applySeriesBatchAction('reject-all')
                      }
                      onCloseSeries={handleCloseSeries}
                    />
                  ) : (
                    <Filmstrip
                      appMode={appMode}
                      shots={allOrderedShots}
                      activeShotId={displayedShot.id}
                      ratingsByShotId={ratingsByShotId}
                      burstGroupByShotId={burstGroupByShotId}
                      seriesEnabled={autoSeriesEnabled}
                      activeComparisonIds={activeComparisonIds}
                      isEditingSeries={isEditingSeries}
                      isFindingSeries={isFindingSeries}
                      accessToken={accessToken}
                      tempPreviewMap={tempPreviewMap}
                      sharpMediaMap={sharpMediaMap}
                      onSelectShot={handleSelectShotFromStrip}
                      onToggleShotInSeries={handleToggleShotInSeries}
                      onToggleEditingSeries={handleToggleEditingSeries}
                      onOpenSeries={handleOpenSeries}
                      onFindSeries={() => void handleFindSeriesAroundCurrent()}
                      onKeepEntireSeries={() =>
                        applySeriesBatchAction('keep-all')
                      }
                      onRejectEntireSeries={() =>
                        applySeriesBatchAction('reject-all')
                      }
                    />
                  )}
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </div>

      {/* Slide-Over Drawer: Filters, Series, Haptics & Picked List */}
      {isDrawerOpen && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div
            onClick={() => setIsDrawerOpen(false)}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Nastavení, výběr a ovládání"
            className="relative z-10 w-full sm:max-w-md h-full bg-[#141417] border-l border-zinc-800 flex flex-col overflow-hidden shadow-2xl"
          >
            <div className="shrink-0 px-5 py-4 border-b border-zinc-800 flex items-center justify-between gap-3">
              <h2 className="font-display text-base font-semibold text-zinc-100">
                Nastavení, výběr a ovládání
              </h2>
              <button
                type="button"
                onClick={() => setIsDrawerOpen(false)}
                aria-label="Zavřít panel"
                className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-lg border border-zinc-800 bg-[#09090B] text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto overscroll-contain p-5 space-y-6">
              {/* Session Counters */}
              <div>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                    Stav výběru
                  </h3>
                  {Object.keys(ratingsMap).length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setIsDrawerOpen(false);
                        void handleResetFolderSession();
                      }}
                      className="text-xs font-medium text-zinc-400 hover:text-amber-300 transition-colors cursor-pointer"
                      title="Vymazat hodnocení pro tuto složku a začít znovu"
                    >
                      Resetovat výběr
                    </button>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-[#09090B] border border-zinc-800/80 p-2.5">
                    <p className="font-mono text-lg font-semibold text-zinc-100 tabular-nums">
                      {unratedCount.toLocaleString('cs-CZ')}
                    </p>
                    <p className="text-[11px] text-zinc-500">Nehodnoceno</p>
                  </div>
                  <div
                    className={`rounded-lg bg-[#09090B] border p-2.5 ${
                      isFrameCull
                        ? 'border-emerald-500/30'
                        : 'border-amber-500/30'
                    }`}
                  >
                    <p
                      className={`font-mono text-lg font-semibold tabular-nums ${
                        isFrameCull ? 'text-emerald-400' : 'text-amber-400'
                      }`}
                    >
                      {pickedShotsList.length.toLocaleString('cs-CZ')}
                    </p>
                    <p className="text-[11px] text-zinc-400">
                      {isFrameCull ? 'Ponecháno ✓' : 'Vybráno ★'}
                    </p>
                  </div>
                  <div
                    className={`rounded-lg bg-[#09090B] border p-2.5 ${
                      isFrameCull
                        ? 'border-rose-500/40'
                        : 'border-zinc-800/80'
                    }`}
                  >
                    <p
                      className={`font-mono text-lg font-semibold tabular-nums ${
                        isFrameCull ? 'text-rose-400' : 'text-zinc-400'
                      }`}
                    >
                      {rejectedCount.toLocaleString('cs-CZ')}
                    </p>
                    <p
                      className={`text-[11px] ${
                        isFrameCull ? 'text-rose-200/80' : 'text-zinc-500'
                      }`}
                    >
                      {isFrameCull ? 'Ke smazání' : 'Zahozeno'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Format Filter */}
              <div className="border-t border-zinc-800/80 pt-5 space-y-2.5">
                <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                  Filtr formátů
                </h3>
                <div
                  className="grid grid-cols-3 gap-1 p-1 bg-[#09090B] border border-zinc-800 rounded-lg"
                  role="group"
                  aria-label="Filtr formátů"
                >
                  <button
                    type="button"
                    onClick={() => setFormatFilter('all')}
                    className={`min-h-[38px] px-2 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer tabular-nums ${
                      formatFilter === 'all'
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    Vše ({filterCounts.all.toLocaleString('cs-CZ')})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormatFilter('raw')}
                    className={`min-h-[38px] px-2 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer tabular-nums ${
                      formatFilter === 'raw'
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    RAW ({filterCounts.raw.toLocaleString('cs-CZ')})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormatFilter('standard')}
                    className={`min-h-[38px] px-2 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer tabular-nums ${
                      formatFilter === 'standard'
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    JPG ({filterCounts.standard.toLocaleString('cs-CZ')})
                  </button>
                </div>
              </div>

              {/* Behavior Toggles */}
              <div className="border-t border-zinc-800/80 pt-5 space-y-3">
                <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                  Série &amp; nastavení
                </h3>

                <button
                  type="button"
                  onClick={() => {
                    setAutoSeriesEnabled((prev) => {
                      const next = !prev;
                      if (!next) {
                        setActiveSeriesShotIds(new Set());
                        setIsSeriesOpen(false);
                        setIsEditingSeries(false);
                      }
                      return next;
                    });
                  }}
                  aria-pressed={autoSeriesEnabled}
                  className={`w-full min-h-[44px] flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border text-left text-xs transition-colors cursor-pointer ${
                    autoSeriesEnabled
                      ? 'border-amber-500/60 bg-amber-500/10 text-amber-200'
                      : 'border-zinc-800 bg-[#09090B] text-zinc-300 hover:border-zinc-700'
                  }`}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <Layers className="w-4 h-4 shrink-0" />
                    <span>Automatické hledání sérií</span>
                  </span>
                  <span className="font-mono text-[11px]">
                    {autoSeriesEnabled ? 'Zapnuto' : 'Vypnuto'}
                  </span>
                </button>

                {!autoSeriesEnabled && (
                  <p className="text-[11px] text-zinc-400 leading-relaxed px-1">
                    Hledání sérií pro celou složku je vypnuté — u každé fotky
                    zůstává tlačítko Najít sérii pro vyhledání jen kolem tohoto
                    snímku.
                  </p>
                )}

                {isAutoGroupingActive && (
                  <div className="space-y-2.5">
                    <button
                      type="button"
                      onClick={() => setVisualSimilarityEnabled((v) => !v)}
                      aria-pressed={visualSimilarityEnabled}
                      className={`w-full min-h-[44px] flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border text-left text-xs transition-colors cursor-pointer ${
                        visualSimilarityEnabled
                          ? 'border-amber-500/60 bg-amber-500/10 text-amber-200'
                          : 'border-zinc-800 bg-[#09090B] text-zinc-300 hover:border-zinc-700'
                      }`}
                    >
                      <span className="flex items-center gap-2 font-medium">
                        <Eye className="w-4 h-4 shrink-0" />
                        <span>Porovnávat podle vzhledu</span>
                      </span>
                      <span className="font-mono text-[11px] tabular-nums">
                        {visualSimilarityEnabled
                          ? analyzableShots.length > 0
                            ? `${analyzedVisualCount}/${analyzableShots.length}`
                            : 'Zapnuto'
                          : 'Vypnuto'}
                      </span>
                    </button>

                    {visualSimilarityEnabled && (
                      <>
                        <p className="text-[11px] text-zinc-400 leading-relaxed px-1">
                          Časové okno: běžná shoda do 1 min · vysoká shoda do 3 min
                        </p>

                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-[11px] text-zinc-400">
                              Citlivost rozlišení vzhledu
                            </p>
                            {customCalibration && (
                              <button
                                type="button"
                                onClick={() => setCustomCalibration(null)}
                                className="text-[11px] text-amber-300 hover:text-amber-200 underline underline-offset-2 cursor-pointer"
                              >
                                Zrušit kalibraci
                              </button>
                            )}
                          </div>
                          <div
                            className="grid grid-cols-3 gap-1 p-1 bg-[#09090B] border border-zinc-800 rounded-lg"
                            role="group"
                            aria-label="Citlivost rozlišení vzhledu"
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setCustomCalibration(null);
                                setSimilaritySensitivity('strict');
                              }}
                              title="Nejcitlivější na rozdíly — oddělí i drobné změny scény nebo záběru"
                              className={`min-h-[38px] px-2 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                                !customCalibration &&
                                similaritySensitivity === 'strict'
                                  ? 'bg-zinc-800 text-zinc-100'
                                  : 'text-zinc-400 hover:text-zinc-200'
                              }`}
                            >
                              Přísnější
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setCustomCalibration(null);
                                setSimilaritySensitivity('balanced');
                              }}
                              title="Střední citlivost — spolehlivě odděluje odlišné scény a motivy"
                              className={`min-h-[38px] px-2 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                                !customCalibration &&
                                similaritySensitivity === 'balanced'
                                  ? 'bg-zinc-800 text-zinc-100'
                                  : 'text-zinc-400 hover:text-zinc-200'
                              }`}
                            >
                              Střední
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setCustomCalibration(null);
                                setSimilaritySensitivity('loose');
                              }}
                              title="Méně citlivá na změny — spojí i lehce posunuté záběry téže scény"
                              className={`min-h-[38px] px-2 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                                !customCalibration &&
                                similaritySensitivity === 'loose'
                                  ? 'bg-zinc-800 text-zinc-100'
                                  : 'text-zinc-400 hover:text-zinc-200'
                              }`}
                            >
                              Volnější
                            </button>
                          </div>
                          <p className="text-[11px] text-zinc-500 leading-relaxed px-0.5 tabular-nums">
                            {customCalibration
                              ? `Aktivní vlastní kalibrace (${customCalibration.sameCount}× stejná, ${customCalibration.differentCount}× jiná · práh ${Math.round(customCalibration.minScore * 100)} %).`
                              : similaritySensitivity === 'strict'
                                ? 'Citlivější: spojí jen téměř totožné záběry se stejným motivem, barvami a hranami.'
                                : similaritySensitivity === 'loose'
                                  ? 'Méně citlivá: spojí i volnější variace stejné scény při posunu fotoaparátu.'
                                  : 'Doporučený střed: porovnává tvary, střed záběru, hrany i rozložení barev.'}
                          </p>
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            setIsDrawerOpen(false);
                            setIsCalibrationOpen(true);
                          }}
                          disabled={nonRejectedShots.length < 2}
                          className="w-full min-h-[42px] flex items-center justify-between gap-3 px-3.5 py-2 rounded-xl border border-amber-500/45 bg-amber-500/10 text-left text-xs text-amber-200 hover:bg-amber-500/20 transition-colors cursor-pointer disabled:opacity-45"
                        >
                          <span className="flex items-center gap-2 font-medium">
                            <SlidersHorizontal className="w-4 h-4 shrink-0" />
                            <span>Kalibrovat série na ukázkách</span>
                          </span>
                          <span className="font-mono text-[11px] tabular-nums">
                            {customCalibration
                              ? `${customCalibration.accuracyPct} %`
                              : 'Spustit'}
                          </span>
                        </button>
                      </>
                    )}

                    {missingExifPhotos.length > 0 && (
                      <button
                        type="button"
                        onClick={() => void handleEnrichMissingExif()}
                        disabled={isEnrichingExif}
                        className="w-full min-h-[42px] flex items-center justify-between gap-3 px-3.5 py-2 rounded-xl border border-zinc-800 bg-[#09090B] text-left text-xs text-amber-300 hover:border-amber-500/50 transition-colors cursor-pointer disabled:opacity-50"
                      >
                        <span className="flex items-center gap-2 font-medium">
                          <Clock className="w-4 h-4 shrink-0" />
                          <span>
                            {isEnrichingExif
                              ? 'Čtu EXIF časy z hlaviček…'
                              : 'Dočíst EXIF časy pro série'}
                          </span>
                        </span>
                        <span className="font-mono text-[11px] tabular-nums">
                          {Math.min(120, missingExifPhotos.length)}
                        </span>
                      </button>
                    )}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setPairSelectEnabled((v) => !v)}
                  aria-pressed={pairSelectEnabled}
                  className={`w-full min-h-[44px] flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border text-left text-xs transition-colors cursor-pointer tabular-nums ${
                    pairSelectEnabled
                      ? 'border-amber-500/60 bg-amber-500/10 text-amber-200'
                      : 'border-zinc-800 bg-[#09090B] text-zinc-300 hover:border-zinc-700'
                  }`}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <Link2 className="w-4 h-4 shrink-0" />
                    <span>Párově JPG+RAW ({pairCount})</span>
                  </span>
                  <span className="font-mono text-[11px]">
                    {pairSelectEnabled ? 'Zapnuto' : 'Vypnuto'}
                  </span>
                </button>

                {/* Haptic Feedback Settings */}
                <div className="pt-2 space-y-2">
                  <button
                    type="button"
                    onClick={() =>
                      updateHapticSettings({
                        ...hapticSettings,
                        enabled: !hapticSettings.enabled,
                      })
                    }
                    aria-pressed={hapticSettings.enabled}
                    className={`w-full min-h-[44px] flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border text-left text-xs transition-colors cursor-pointer ${
                      hapticSettings.enabled
                        ? 'border-amber-500/60 bg-amber-500/10 text-amber-200'
                        : 'border-zinc-800 bg-[#09090B] text-zinc-300 hover:border-zinc-700'
                    }`}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <Smartphone className="w-4 h-4 shrink-0" />
                      <span>Haptická odezva</span>
                    </span>
                    <span className="font-mono text-[11px]">
                      {hapticSettings.enabled ? 'Zapnuto' : 'Vypnuto'}
                    </span>
                  </button>

                  {hapticSettings.enabled && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] text-zinc-400">
                        Intenzita vibrací
                      </p>
                      <div
                        className="grid grid-cols-3 gap-1 p-1 bg-[#09090B] border border-zinc-800 rounded-lg"
                        role="group"
                        aria-label="Intenzita haptické odezvy"
                      >
                        {(
                          [
                            { id: 'light', label: 'Jemná' },
                            { id: 'medium', label: 'Střední' },
                            { id: 'heavy', label: 'Silná' },
                          ] as { id: HapticIntensity; label: string }[]
                        ).map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() =>
                              updateHapticSettings({
                                ...hapticSettings,
                                intensity: opt.id,
                              })
                            }
                            className={`min-h-[40px] px-2 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                              hapticSettings.intensity === opt.id
                                ? 'bg-zinc-800 text-zinc-100'
                                : 'text-zinc-400 hover:text-zinc-200'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {!hapticsSupported && (
                    <p className="text-[11px] text-zinc-500 leading-relaxed">
                      {isIos
                        ? 'iOS Safari blokuje webové vibrace (funguje v Chrome na Androidu nebo v nativní aplikaci).'
                        : 'Toto zařízení nebo prohlížeč nepodporuje webové vibrace.'}
                    </p>
                  )}
                </div>
              </div>

              {/* Active Mode Queue List: Picked/Liked (Selectra) or Trash Queue (FrameCull) */}
              {isFrameCull ? (
                <div className="border-t border-zinc-800/80 pt-5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                      Fronta ke smazání
                    </h3>
                    <span className="font-mono text-xs text-rose-300 tabular-nums">
                      {formatBytes(trashBytes)}
                    </span>
                  </div>

                  {trashFiles.length === 0 ? (
                    <p className="mt-3 text-xs text-zinc-500 leading-relaxed">
                      Tažením doleva nebo tlačítkem „Smazat“ zařadíte nepovedené
                      snímky do fronty. Na konci zvolíte přesun do koše nebo
                      trvalé smazání.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-3">
                      <ul className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
                        {trashFiles.slice(0, pickedVisibleLimit).map((file) => {
                          const thumb =
                            thumbnailUrlLookup[file.id] ||
                            getFastPreviewThumbnailUrl(file.thumbnailLink);
                          return (
                            <li
                              key={file.id}
                              className="flex items-center justify-between gap-2.5 rounded-lg bg-[#09090B] border border-rose-500/25 p-2"
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  const matchedShot = allOrderedShots.find((s) =>
                                    s.files.some((f) => f.id === file.id)
                                  );
                                  if (matchedShot) {
                                    setActiveShotId(matchedShot.id);
                                    setIsDrawerOpen(false);
                                  }
                                }}
                                className="flex items-center gap-2.5 min-w-0 text-left flex-1 cursor-pointer"
                              >
                                <div className="h-9 w-11 shrink-0 overflow-hidden rounded bg-zinc-900 flex items-center justify-center">
                                  {thumb ? (
                                    <img
                                      src={thumb}
                                      alt={file.name}
                                      referrerPolicy="no-referrer"
                                      loading="lazy"
                                      className="h-full w-full object-cover"
                                    />
                                  ) : (
                                    <span className="font-mono text-[10px] text-zinc-500">
                                      {file.fileExtension.toUpperCase()}
                                    </span>
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <p className="text-xs font-medium text-zinc-200 truncate">
                                    {file.name}
                                  </p>
                                  <p className="font-mono text-[11px] text-zinc-500 truncate tabular-nums">
                                    {file.fileExtension.toUpperCase()} ·{' '}
                                    {formatBytes(file.sizeBytes)}
                                  </p>
                                </div>
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  setRatingsMap((prev) => {
                                    const next = { ...prev };
                                    if (pairSelectEnabled) {
                                      for (const p of activePhotos) {
                                        if (p.stem === file.stem) {
                                          delete next[p.id];
                                        }
                                      }
                                    } else {
                                      delete next[file.id];
                                    }
                                    return next;
                                  });
                                }}
                                className="shrink-0 px-2 py-1 text-[11px] font-medium text-zinc-400 hover:text-rose-300 cursor-pointer"
                                title="Odebrat z fronty mazání"
                              >
                                Odebrat
                              </button>
                            </li>
                          );
                        })}
                      </ul>

                      {trashFiles.length > pickedVisibleLimit && (
                        <button
                          type="button"
                          onClick={() => setPickedVisibleLimit((l) => l + 50)}
                          className="w-full py-1.5 text-xs text-rose-400 hover:text-rose-300 cursor-pointer tabular-nums"
                        >
                          Zobrazit dalších{' '}
                          {Math.min(50, trashFiles.length - pickedVisibleLimit)}{' '}
                          (zbývá{' '}
                          {(
                            trashFiles.length - pickedVisibleLimit
                          ).toLocaleString('cs-CZ')}
                          )
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => {
                          setIsDrawerOpen(false);
                          onRequestFinishTrash(
                            trashFiles,
                            trashShotsList.length,
                            thumbnailUrlLookup
                          );
                        }}
                        className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-rose-500 text-white text-sm font-semibold hover:bg-rose-400 transition-colors cursor-pointer tabular-nums"
                      >
                        Smazat vybrané (
                        {trashShotsList.length.toLocaleString('cs-CZ')} snímků /{' '}
                        {trashFiles.length.toLocaleString('cs-CZ')} souborů)
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="border-t border-zinc-800/80 pt-5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                      Vybrané do „{LIKED_SUBFOLDER_NAME}“
                    </h3>
                    <span className="font-mono text-xs text-zinc-500 tabular-nums">
                      {formatBytes(pickedBytes)}
                    </span>
                  </div>

                  {pickedFiles.length === 0 ? (
                    <p className="mt-3 text-xs text-zinc-500 leading-relaxed">
                      Tažením doprava nebo tlačítkem „Vybrat ★“ označíte snímky do
                      výběru. Na konci je zkopírujete nebo přesunete do podsložky
                      „{LIKED_SUBFOLDER_NAME}“.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-3">
                      <ul className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
                        {visiblePickedFiles.map((file) => {
                          const thumb =
                            thumbnailUrlLookup[file.id] ||
                            getFastPreviewThumbnailUrl(file.thumbnailLink);
                          return (
                            <li
                              key={file.id}
                              className="flex items-center justify-between gap-2.5 rounded-lg bg-[#09090B] border border-zinc-800/80 p-2"
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  const matchedShot = allOrderedShots.find((s) =>
                                    s.files.some((f) => f.id === file.id)
                                  );
                                  if (matchedShot) {
                                    setActiveShotId(matchedShot.id);
                                    setIsDrawerOpen(false);
                                  }
                                }}
                                className="flex items-center gap-2.5 min-w-0 text-left flex-1 cursor-pointer"
                              >
                                <div className="h-9 w-11 shrink-0 overflow-hidden rounded bg-zinc-900 flex items-center justify-center">
                                  {thumb ? (
                                    <img
                                      src={thumb}
                                      alt={file.name}
                                      referrerPolicy="no-referrer"
                                      loading="lazy"
                                      className="h-full w-full object-cover"
                                    />
                                  ) : (
                                    <span className="font-mono text-[10px] text-zinc-500">
                                      {file.fileExtension.toUpperCase()}
                                    </span>
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <p className="text-xs font-medium text-zinc-200 truncate">
                                    {file.name}
                                  </p>
                                  <p className="font-mono text-[11px] text-zinc-500 truncate tabular-nums">
                                    {file.fileExtension.toUpperCase()} ·{' '}
                                    {formatBytes(file.sizeBytes)}
                                  </p>
                                </div>
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  setRatingsMap((prev) => {
                                    const next = { ...prev };
                                    if (pairSelectEnabled) {
                                      for (const p of activePhotos) {
                                        if (p.stem === file.stem) {
                                          delete next[p.id];
                                        }
                                      }
                                    } else {
                                      delete next[file.id];
                                    }
                                    return next;
                                  });
                                }}
                                className="shrink-0 px-2 py-1 text-[11px] font-medium text-zinc-400 hover:text-amber-300 cursor-pointer"
                                title="Odebrat z výběru"
                              >
                                Odebrat
                              </button>
                            </li>
                          );
                        })}
                      </ul>

                      {hiddenPickedCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setPickedVisibleLimit((l) => l + 50)}
                          className="w-full py-1.5 text-xs text-amber-400 hover:text-amber-300 cursor-pointer tabular-nums"
                        >
                          Zobrazit dalších {Math.min(50, hiddenPickedCount)} (zbývá{' '}
                          {hiddenPickedCount.toLocaleString('cs-CZ')})
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => {
                          setIsDrawerOpen(false);
                          onRequestFinishSelection(
                            pickedFiles,
                            pickedShotsList.length,
                            thumbnailUrlLookup
                          );
                        }}
                        className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-amber-500 text-zinc-950 text-sm font-semibold hover:bg-amber-400 transition-colors cursor-pointer tabular-nums"
                      >
                        Dokončit výběr ({pickedShotsList.length.toLocaleString('cs-CZ')}{' '}
                        snímků / {pickedFiles.length.toLocaleString('cs-CZ')} souborů)
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* PC Controls Help Section */}
              <div className="border-t border-zinc-800/80 pt-5 space-y-3.5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                    Ovládání na počítači
                  </h3>
                  <span className="font-mono text-[11px] text-zinc-500">
                    Klávesnice &amp; myš
                  </span>
                </div>

                <div className="rounded-xl border border-zinc-800/90 bg-[#09090B] divide-y divide-zinc-800/70">
                  <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <span className="text-zinc-300">
                      Listování snímky bez hodnocení
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <kbd className="font-mono text-[11px] font-medium text-zinc-200 bg-[#141417] border border-zinc-700/90 rounded px-1.5 py-0.5 whitespace-nowrap">
                        ←
                      </kbd>
                      <kbd className="font-mono text-[11px] font-medium text-zinc-200 bg-[#141417] border border-zinc-700/90 rounded px-1.5 py-0.5 whitespace-nowrap">
                        →
                      </kbd>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <span className="text-zinc-300">
                      {isFrameCull
                        ? 'Ponechat snímek ✓ (v sérii jen tento 1)'
                        : 'Vybrat snímek ★ (v sérii jen tento 1)'}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <kbd className="font-mono text-[11px] font-medium text-emerald-300 bg-[#141417] border border-emerald-500/40 rounded px-1.5 py-0.5 whitespace-nowrap">
                        P
                      </kbd>
                      <span className="text-[11px] text-zinc-500">nebo</span>
                      <kbd className="font-mono text-[11px] font-medium text-emerald-300 bg-[#141417] border border-emerald-500/40 rounded px-1.5 py-0.5 whitespace-nowrap">
                        S
                      </kbd>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <span className="text-zinc-300">
                      {isFrameCull
                        ? 'Smazat snímek (v sérii vyřadí ze série)'
                        : 'Zahodit snímek (v sérii vyřadí ze série)'}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <kbd className="font-mono text-[11px] font-medium text-rose-300 bg-[#141417] border border-rose-500/40 rounded px-1.5 py-0.5 whitespace-nowrap">
                        X
                      </kbd>
                      <span className="text-[11px] text-zinc-500">nebo</span>
                      <kbd className="font-mono text-[11px] font-medium text-rose-300 bg-[#141417] border border-rose-500/40 rounded px-1.5 py-0.5 whitespace-nowrap">
                        Delete
                      </kbd>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <span className="text-zinc-300">
                      Vrátit hodnocení na nehodnoceno
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <kbd className="font-mono text-[11px] font-medium text-zinc-200 bg-[#141417] border border-zinc-700/90 rounded px-1.5 py-0.5 whitespace-nowrap">
                        U
                      </kbd>
                      <span className="text-[11px] text-zinc-500">nebo</span>
                      <kbd className="font-mono text-[11px] font-medium text-zinc-200 bg-[#141417] border border-zinc-700/90 rounded px-1.5 py-0.5 whitespace-nowrap">
                        0
                      </kbd>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <span className="text-zinc-300">
                      Krok zpět (vrátí i hromadnou akci série)
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <kbd className="font-mono text-[11px] font-medium text-amber-200 bg-[#141417] border border-amber-500/40 rounded px-1.5 py-0.5 whitespace-nowrap">
                        Z
                      </kbd>
                      <span className="text-[11px] text-zinc-500">nebo</span>
                      <kbd className="font-mono text-[11px] font-medium text-amber-200 bg-[#141417] border border-amber-500/40 rounded px-1.5 py-0.5 whitespace-nowrap">
                        Backspace
                      </kbd>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <span className="text-zinc-300">
                      Lupa (přiblížení pro kontrolu ostrosti)
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <kbd className="font-mono text-[11px] font-medium text-zinc-200 bg-[#141417] border border-zinc-700/90 rounded px-1.5 py-0.5 whitespace-nowrap">
                        Mezerník
                      </kbd>
                      <span className="text-[11px] text-zinc-500">nebo</span>
                      <kbd className="font-mono text-[11px] font-medium text-zinc-200 bg-[#141417] border border-zinc-700/90 rounded px-1.5 py-0.5 whitespace-nowrap">
                        L
                      </kbd>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <span className="text-zinc-300">
                      Přepnutí Detail / Celá galerie složky
                    </span>
                    <kbd className="font-mono text-[11px] font-medium text-zinc-200 bg-[#141417] border border-zinc-700/90 rounded px-1.5 py-0.5 shrink-0 whitespace-nowrap">
                      G
                    </kbd>
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <span className="text-zinc-300">
                      Zobrazení EXIF parametrů fotky
                    </span>
                    <kbd className="font-mono text-[11px] font-medium text-zinc-200 bg-[#141417] border border-zinc-700/90 rounded px-1.5 py-0.5 shrink-0 whitespace-nowrap">
                      E
                    </kbd>
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <span className="text-zinc-300">
                      Zavřít EXIF, lupu, sérii nebo panel
                    </span>
                    <kbd className="font-mono text-[11px] font-medium text-zinc-200 bg-[#141417] border border-zinc-700/90 rounded px-1.5 py-0.5 shrink-0 whitespace-nowrap">
                      Esc
                    </kbd>
                  </div>
                </div>

                <div className="rounded-xl border border-zinc-800/90 bg-[#09090B] p-3 space-y-2 text-[11px] text-zinc-400 leading-relaxed">
                  <p className="text-xs font-medium text-zinc-200">
                    Myš, kolečko a práce se sériemi
                  </p>
                  <p>
                    <strong className="text-zinc-200 font-medium">
                      Tažení fotky myší:
                    </strong>{' '}
                    Přetažením snímku doprava jej ponecháte / vyberete, doleva jej
                    smažete / zahodíte (stejně fungují i dvě hlavní tlačítka pod
                    fotkou).
                  </p>
                  <p>
                    <strong className="text-zinc-200 font-medium">
                      Lupa a posun výřezu:
                    </strong>{' '}
                    Kliknutím do fotky nebo otočením kolečka myši přiblížíte místo
                    pod kurzorem (až 6×); tažením myší pak posouváte detail.
                  </p>
                  <p>
                    <strong className="text-zinc-200 font-medium">
                      Dolní lišta a série:
                    </strong>{' '}
                    Kolečkem nebo tažením v dolní liště plynule projíždíte snímky.
                    Pokud aktuální fotka patří do série, můžete přímo v liště
                    tlačítky{' '}
                    <span className="text-emerald-300 font-medium">
                      {isFrameCull ? 'Ponechat sérii' : 'Vybrat sérii'}
                    </span>{' '}
                    nebo{' '}
                    <span className="text-rose-300 font-medium">
                      {isFrameCull ? 'Smazat sérii' : 'Zahodit sérii'}
                    </span>{' '}
                    vyřešit celou její sérii najednou, případně sérii otevřít a
                    naklikat více snímků přes{' '}
                    <span className="text-zinc-200 font-medium">Vybrat více</span>.
                  </p>
                </div>
              </div>
            </div>
          </aside>
        </div>
      )}

      <SeriesCalibrationModal
        isOpen={isCalibrationOpen}
        shots={nonRejectedShots}
        activeShotId={displayedShot?.id || activeShotId}
        accessToken={accessToken}
        fingerprintsMap={fingerprintsMap}
        onAddFingerprints={(updates) => {
          startTransition(() => {
            setFingerprintsMap((prev) => ({ ...prev, ...updates }));
          });
        }}
        sharpMediaMap={sharpMediaMap}
        tempPreviewMap={tempPreviewMap}
        baseSensitivity={similaritySensitivity}
        currentCalibration={customCalibration}
        savedExamples={calibrationExamples}
        onApplyCalibration={(cal, examples) => {
          setCustomCalibration(cal);
          setCalibrationExamples(examples);
        }}
        onResetCalibration={() => {
          setCustomCalibration(null);
          setCalibrationExamples([]);
        }}
        onClose={() => setIsCalibrationOpen(false)}
      />
    </section>
  );
};

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
  Download,
  Square,
} from 'lucide-react';
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
  getCachedFilmstripThumbnailUrl,
  getCachedMediaSnapshot,
  getFastPreviewThumbnailUrl,
  getSeriesHighQualityThumbnailUrl,
  getUpgradeThumbnailUrl,
  invalidateThumbnailCache,
  predecodeAndRetainImage,
  preloadImageUrl,
  resolveFastTempRawPreview,
  resolveFilmstripThumbnailUrl,
  resolvePhotoMedia,
  setRetainedMediaFileIds,
  setSeriesCacheBudget,
  subscribeMediaCacheEviction,
  trimMediaMemoryCache,
} from '../lib/rawParser';
import {
  RememberedAutoSeriesEntry,
  deleteCachedDetailPreviewsForFile,
  loadFolderSeriesMemory,
  loadMicroThumbUrlsForFolder,
  saveFolderSeriesMemory,
  syncFolderCulledStatus,
  syncPhotosCulledState,
  updatePhotosCulledStateIncremental,
} from '../lib/previewCacheDb';
import {
  beginForegroundPhotoLoad,
  markInteractionActive,
  setOpenSeriesPriority,
  waitForBackgroundSlot,
} from '../lib/interactionGate';
import {
  FolderCacheCoverage,
  FolderPreloadProgress,
  checkFolderPreviewCoverage,
  preloadAndConvertFolderPreviews,
} from '../lib/folderPreviewPreloader';
import {
  ManualLockedSeries,
  PhotoBurstGroup,
  PhotoShotItem,
  buildShotItems,
  groupShotsIntoSeries,
  mergeManualAndAutoSeries,
  orderShotsChronologically,
} from '../lib/burstGrouping';
import {
  CustomVisualCalibration,
  SimilaritySensitivity,
  VisualCalibrationExample,
  VisualFingerprint,
  computePhotoFingerprint,
  computeVisualSimilarity,
} from '../lib/visualSimilarity';
import { GlobalCalibrationState } from '../lib/appSettings';
import {
  DeleteModeState,
  FolderResumeTarget,
  PARTIAL_RESET_OPTIONS,
  PartialResetScope,
  PersistedDecisionEntry,
  PersistedFolderSummary,
  SelectModeState,
  ShardEntriesMap,
  WorkflowMode,
  applyPartialResetToEntries,
  resolveEntryStates,
  saveFolderDecisionDeltas,
} from '../lib/cullPersistence';
import {
  clearLocalResumePosition,
  saveLocalFolderDecisions,
  writeLocalResumePosition,
} from '../lib/localPersistence';
import {
  HapticIntensity,
  HapticSettings,
  isHapticsSupported,
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

function buildUpdatedEntry(
  existing: PersistedDecisionEntry | undefined,
  file: DrivePhotoFile,
  patch: { selectState?: SelectModeState; deleteState?: DeleteModeState },
  batchId: string,
  pairLabel?: string,
  nowMs = Date.now()
): PersistedDecisionEntry | null {
  const prev = resolveEntryStates(existing);
  const nextSelect = patch.selectState ?? prev.selectState;
  const nextDelete = patch.deleteState ?? prev.deleteState;
  if (nextSelect === 'unrated' && nextDelete === 'unrated') {
    return null;
  }
  return {
    decision: nextSelect === 'selected' ? 'pick' : 'reject',
    ...(nextSelect !== 'unrated' ? { selectState: nextSelect } : {}),
    ...(nextDelete !== 'unrated' ? { deleteState: nextDelete } : {}),
    name: file.name,
    ext: file.fileExtension,
    sizeBytes: file.sizeBytes || 0,
    batchId,
    ...(pairLabel ? { pairedWith: pairLabel } : {}),
    updatedAtMs: nowMs,
  };
}

interface SwipeStudioProps {
  workflowMode: WorkflowMode;
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
  onPersistedStateChange?: (
    entries: Record<string, PersistedDecisionEntry>,
    shardMap: ShardEntriesMap,
    resumeTarget?: FolderResumeTarget
  ) => void;
  onUpdatePhotoTimestamps?: (
    updates: Record<string, { ms: number; label: string }>
  ) => void;
  onFolderSummaryChange?: (summary: PersistedFolderSummary | null) => void;
  movedOutIds: Set<string>;
  isFinishModalOpen: boolean;
  lastActionSummary: string | null;
  filmstripSeriesEnabled: boolean;
  onToggleFilmstripSeriesEnabled: (enabled: boolean) => void;
  initialManualSeries: ManualLockedSeries[];
  onManualSeriesChange: (nextSeries: ManualLockedSeries[]) => void;
  globalCalibrationState: GlobalCalibrationState;
  onUpdateGlobalCalibration: (patch: {
    baseSensitivity?: SimilaritySensitivity;
    calibration?: CustomVisualCalibration | null;
    examples?: VisualCalibrationExample[];
  }) => void;
  onAppendCalibrationFeedback: (
    newExamples: VisualCalibrationExample[],
    baseSensitivityOverride?: SimilaritySensitivity
  ) => void;
}

export const SwipeStudio: React.FC<SwipeStudioProps> = ({
  workflowMode,
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
  onPersistedStateChange,
  onUpdatePhotoTimestamps,
  onFolderSummaryChange,
  movedOutIds,
  isFinishModalOpen,
  lastActionSummary,
  filmstripSeriesEnabled,
  onToggleFilmstripSeriesEnabled,
  initialManualSeries,
  onManualSeriesChange,
  globalCalibrationState,
  onUpdateGlobalCalibration,
  onAppendCalibrationFeedback,
}) => {
  const autoSeriesEnabled = filmstripSeriesEnabled;
  const isDeleteMode = workflowMode === 'delete';
  const isLocalSource = Boolean(
    folder.sourceKind && folder.sourceKind !== 'drive'
  );
  const [hapticSettings, setHapticSettings] = useState<HapticSettings>(() =>
    loadHapticSettings()
  );
  const hapticSettingsRef = useRef(hapticSettings);
  hapticSettingsRef.current = hapticSettings;
  const hapticsSupported = isHapticsSupported();

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
  // Gallery defaults to grouped series view ("V sériích")
  const [gallerySeriesEnabled, setGallerySeriesEnabled] = useState(true);
  const [galleryOnlySeriesFilter, setGalleryOnlySeriesFilter] = useState(false);
  const [isScanningAllSeries, setIsScanningAllSeries] = useState(false);
  const [seriesScanProgress, setSeriesScanProgress] = useState<{
    processed: number;
    total: number;
    foundCount: number;
  } | null>(null);
  const fullScanAbortRef = useRef<AbortController | null>(null);

  const [manualSeries, setManualSeries] = useState<ManualLockedSeries[]>(
    () => initialManualSeries
  );
  const manualSeriesRef = useRef<ManualLockedSeries[]>(manualSeries);
  manualSeriesRef.current = manualSeries;
  const manualSeriesLocalDirtyRef = useRef(false);

  useEffect(() => {
    if (initialManualSeries.length === 0 && !manualSeriesLocalDirtyRef.current) {
      return;
    }
    setManualSeries((prev) => {
      if (!manualSeriesLocalDirtyRef.current) {
        return initialManualSeries;
      }
      const byId = new Map<string, ManualLockedSeries>();
      for (const item of [...initialManualSeries, ...prev]) {
        const existing = byId.get(item.id);
        if (!existing || (item.updatedAtMs || 0) >= (existing.updatedAtMs || 0)) {
          byId.set(item.id, item);
        }
      }
      return Array.from(byId.values());
    });
  }, [initialManualSeries]);

  const commitManualSeries = useCallback(
    (
      updater:
        | ManualLockedSeries[]
        | ((prev: ManualLockedSeries[]) => ManualLockedSeries[])
    ) => {
      manualSeriesLocalDirtyRef.current = true;
      const next =
        typeof updater === 'function' ? updater(manualSeriesRef.current) : updater;
      manualSeriesRef.current = next;
      setManualSeries(next);
      onManualSeriesChange(next);
    },
    [onManualSeriesChange]
  );

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
  const similaritySensitivity = globalCalibrationState.baseSensitivity;
  const customCalibration = globalCalibrationState.calibration;
  const calibrationExamples = globalCalibrationState.examples;
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

  // Two-stage progressive media maps: fast low-res preview vs sharp upgraded media
  const [tempPreviewMap, setTempPreviewMap] = useState<Record<string, string>>(
    {}
  );
  const tempPreviewMapRef = useRef(tempPreviewMap);
  tempPreviewMapRef.current = tempPreviewMap;
  const [sharpMediaMap, setSharpMediaMap] = useState<
    Record<string, ResolvedPhotoMedia>
  >(() => getCachedMediaSnapshot());
  const sharpMediaMapRef = useRef(sharpMediaMap);
  sharpMediaMapRef.current = sharpMediaMap;
  const [microThumbsMap, setMicroThumbsMap] = useState<Record<string, string>>(
    {}
  );
  const [rememberedAutoSeries, setRememberedAutoSeries] = useState<
    RememberedAutoSeriesEntry[]
  >([]);
  const rememberedTimestampsRef = useRef<
    Record<string, { ms: number; label: string }>
  >({});
  const culledFileIdsRef = useRef<Set<string>>(new Set());
  const [upgradingMap, setUpgradingMap] = useState<Record<string, boolean>>({});
  const [errorMap, setErrorMap] = useState<Record<string, string>>({});

  // Whole-folder preview download & conversion state + open-series high-quality loader status
  const [folderCacheCoverage, setFolderCacheCoverage] =
    useState<FolderCacheCoverage | null>(null);
  const [folderPreloadProgress, setFolderPreloadProgress] =
    useState<FolderPreloadProgress | null>(null);
  const folderPreloadAbortRef = useRef<AbortController | null>(null);
  const [seriesPreloadStatus, setSeriesPreloadStatus] = useState<{
    ready: number;
    total: number;
  } | null>(null);

  const microThumbsMapRef = useRef(microThumbsMap);
  microThumbsMapRef.current = microThumbsMap;

  // Hydrate persistent gallery micro-thumbnails and remembered folder series/fingerprints on folder open
  useEffect(() => {
    let cancelled = false;

    const ramSnap = getCachedMediaSnapshot();
    if (Object.keys(ramSnap).length > 0) {
      setSharpMediaMap((prev) => ({ ...ramSnap, ...prev }));
    }

    void loadMicroThumbUrlsForFolder(folder.id).then((urls) => {
      if (!cancelled && Object.keys(urls).length > 0) {
        setMicroThumbsMap((prev) => ({ ...urls, ...prev }));
      }
    });

    void loadFolderSeriesMemory(folder.id).then((mem) => {
      if (cancelled || !mem) return;
      if (Object.keys(mem.fingerprints).length > 0) {
        startTransition(() => {
          setFingerprintsMap((prev) => ({ ...mem.fingerprints, ...prev }));
        });
      }
      if (Object.keys(mem.enrichedTimestamps).length > 0) {
        rememberedTimestampsRef.current = mem.enrichedTimestamps;
        onUpdatePhotoTimestamps?.(mem.enrichedTimestamps);
      }
      if (mem.autoSeries.length > 0) {
        setRememberedAutoSeries(mem.autoSeries);
        setGallerySeriesEnabled(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [folder.id, onUpdatePhotoTimestamps]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        'framecull_visual_series_enabled',
        String(visualSimilarityEnabled)
      );
    } catch {
      // Ignore storage quota issues
    }
  }, [visualSimilarityEnabled]);

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

  useEffect(() => {
    if (!ratingsHydrated || !onPersistedStateChange) return;
    const cursor = currentResumeCursorRef.current;
    onPersistedStateChange(
      desiredEntries,
      shardMapRef.current,
      cursor ? { ...cursor, updatedAtMs: Date.now() } : undefined
    );
  }, [desiredEntries, ratingsHydrated, onPersistedStateChange]);

  const flushPersistence = useCallback(async () => {
    if (!ratingsHydrated) return;
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
          old.selectState !== entry.selectState ||
          old.deleteState !== entry.deleteState ||
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
        if (isLocalSource || !userId) {
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
          userId,
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
        onPersistedStateChange?.(
          target,
          nextShards,
          cursorToSave ? { ...cursorToSave, updatedAtMs: Date.now() } : undefined
        );

        let pickCount = 0;
        let trashCount = 0;
        for (const e of Object.values(target)) {
          const resolved = resolveEntryStates(e);
          if (resolved.selectState === 'selected') pickCount++;
          if (resolved.deleteState === 'trash') trashCount++;
        }
        onFolderSummaryChange?.(
          Object.keys(target).length > 0 || Boolean(cursorToSave?.shotId)
            ? {
                folderId: folder.id,
                folderName: folder.name,
                keepCount: pickCount,
                trashCount,
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
    onPersistedStateChange,
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

  // Buffer incoming Drive/local batches smoothly so background streaming never stutters active swipes or series comparison
  useEffect(() => {
    if (settledPhotos === activePhotos) return;
    if (settledPhotos.length === 0 || (!isLoadingMore && !activeBurstRef.current && !isZoomed)) {
      startTransition(() => {
        setSettledPhotos(activePhotos);
      });
      return;
    }
    if (activeBurstRef.current || isZoomed) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (!activeBurstRef.current) {
        startTransition(() => {
          setSettledPhotos(activePhotos);
        });
      }
    }, 260);
    return () => {
      window.clearTimeout(timer);
    };
  }, [activePhotos, settledPhotos, isLoadingMore, isZoomed]);

  const shotsById = useMemo(() => {
    const map = new Map<string, PhotoShotItem>();
    for (const s of allOrderedShots) {
      map.set(s.id, s);
    }
    return map;
  }, [allOrderedShots]);

  // Orthogonal Select vs Delete states per shot
  const { selectStateByShotId, deleteStateByShotId } = useMemo(() => {
    const selMap: Record<string, SelectModeState> = {};
    const delMap: Record<string, DeleteModeState> = {};
    for (const shot of allOrderedShots) {
      let hasSelected = false;
      let hasDimmed = false;
      let hasTrash = false;
      let hasSpared = false;
      for (const f of shot.files) {
        const resolved = resolveEntryStates(ratingsMap[f.id]);
        if (resolved.selectState === 'selected') hasSelected = true;
        else if (resolved.selectState === 'dimmed') hasDimmed = true;
        if (resolved.deleteState === 'trash') hasTrash = true;
        else if (resolved.deleteState === 'spared') hasSpared = true;
      }
      selMap[shot.id] = hasSelected
        ? 'selected'
        : hasDimmed
          ? 'dimmed'
          : 'unrated';
      delMap[shot.id] = hasTrash ? 'trash' : hasSpared ? 'spared' : 'unrated';
    }
    return { selectStateByShotId: selMap, deleteStateByShotId: delMap };
  }, [allOrderedShots, ratingsMap]);

  // Browsable shots for stepping in the active workflow mode
  const browsableShots = useMemo(
    () =>
      isDeleteMode
        ? allOrderedShots.filter(
            (s) => (deleteStateByShotId[s.id] || 'unrated') !== 'trash'
          )
        : allOrderedShots,
    [allOrderedShots, isDeleteMode, deleteStateByShotId]
  );

  // Picked (ONLY selectState === 'selected') & Trash (ONLY deleteState === 'trash') files across the ENTIRE folder
  const {
    pickedShotsList,
    pickedFiles,
    pickedBytes,
    trashShotsList,
    trashFiles,
    trashBytes,
    dimmedCount,
    sparedCount,
    unratedSelectCount,
    unratedDeleteCount,
  } = useMemo(() => {
    const pickedStems = new Set<string>();
    const pickedFileIdSet = new Set<string>();
    const trashStems = new Set<string>();
    const trashFileIdSet = new Set<string>();

    for (const [id, entry] of Object.entries(ratingsMap)) {
      if (movedOutIds.has(id)) continue;
      const photo = photosById.get(id);
      const stem = photo ? photo.stem : getFileStem(entry.name);
      const resolved = resolveEntryStates(entry);
      if (resolved.selectState === 'selected') {
        pickedFileIdSet.add(id);
        pickedStems.add(stem);
      }
      if (resolved.deleteState === 'trash') {
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
    let dCount = 0;
    let spCount = 0;
    let uSelect = 0;
    let uDelete = 0;

    for (const s of allOrderedShots) {
      const sel = selectStateByShotId[s.id] || 'unrated';
      if (sel === 'selected') pShots.push(s);
      else if (sel === 'dimmed') dCount++;
      else uSelect++;

      const del = deleteStateByShotId[s.id] || 'unrated';
      if (del === 'trash') tShots.push(s);
      else if (del === 'spared') spCount++;
      else uDelete++;
    }

    return {
      pickedShotsList: pShots,
      pickedFiles: pickedOut,
      pickedBytes: pickedSizeBytes,
      trashShotsList: tShots,
      trashFiles: trashOut,
      trashBytes: trashSizeBytes,
      dimmedCount: dCount,
      sparedCount: spCount,
      unratedSelectCount: uSelect,
      unratedDeleteCount: uDelete,
    };
  }, [
    ratingsMap,
    movedOutIds,
    photosById,
    activePhotos,
    pairSelectEnabled,
    allOrderedShots,
    selectStateByShotId,
    deleteStateByShotId,
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
      const byInnerFile = allOrderedShots.find((s) =>
        s.files.some((f) => f.id === activeShotId)
      );
      if (byInnerFile) return byInnerFile;
    }
    return browsableShots[0] || allOrderedShots[0] || null;
  }, [
    allOrderedShots,
    pendingResumeTarget,
    matchedResumeShot,
    shotsById,
    activeShotId,
    browsableShots,
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
      const firstPreferred = browsableShots[0] || allOrderedShots[0];
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
    browsableShots,
  ]);

  const displayedPhoto = displayedShot?.primary || null;
  const allOrderedShotsRef = useRef(allOrderedShots);
  allOrderedShotsRef.current = allOrderedShots;

  const isAutoGroupingActive =
    autoSeriesEnabled || gallerySeriesEnabled || isScanningAllSeries;

  // Continuous forward-first visual fingerprint scanner:
  // pauses automatically whenever an explicit series is open so 100% of CPU/I/O goes to the series.
  useEffect(() => {
    if (
      isSeriesOpen ||
      isScanningAllSeries ||
      !isAutoGroupingActive ||
      !visualSimilarityEnabled ||
      pendingResumeTarget ||
      allOrderedShots.length < 2
    ) {
      return;
    }

    const controller = new AbortController();
    const bufferUpdates: Record<string, VisualFingerprint> = {};
    let flushTimer: number | null = null;

    const flushBatch = () => {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      const keys = Object.keys(bufferUpdates);
      if (keys.length === 0) return;
      const copy = { ...bufferUpdates };
      for (const k of keys) {
        delete bufferUpdates[k];
      }
      startTransition(() => {
        setFingerprintsMap((prev) => ({ ...prev, ...copy }));
      });
    };

    const scheduleFlush = () => {
      if (flushTimer !== null) return;
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        if (!controller.signal.aborted) flushBatch();
      }, 240);
    };

    const isEligible = (shot: PhotoShotItem): boolean => {
      const id = shot.primary.id;
      if (fingerprintsRef.current[id] || bufferUpdates[id]) return false;
      const localUrl =
        sharpMediaMapRef.current[id]?.url || tempPreviewMapRef.current[id];
      if (localUrl?.startsWith('blob:')) return true;
      return !attemptedFingerprintIdsRef.current.has(id);
    };

    const pickNextChunk = (maxChunk: number): PhotoShotItem[] => {
      const shots = allOrderedShotsRef.current;
      const n = shots.length;
      if (n < 2) return [];
      const activeId = displayedShotRef.current?.id;
      const foundIdx = activeId
        ? shots.findIndex((s) => s.id === activeId)
        : 0;
      const centerIdx = foundIdx === -1 ? 0 : foundIdx;

      const picked: PhotoShotItem[] = [];
      const seen = new Set<string>();
      const tryAdd = (shot: PhotoShotItem | undefined) => {
        if (!shot || seen.has(shot.id) || picked.length >= maxChunk) return;
        if (!isEligible(shot)) return;
        seen.add(shot.id);
        picked.push(shot);
      };

      // 1) Immediate neighborhood around current shot (current + 24 ahead + 4 behind)
      tryAdd(shots[centerIdx]);
      for (let i = centerIdx + 1; i < Math.min(n, centerIdx + 25); i++) {
        tryAdd(shots[i]);
      }
      for (let i = centerIdx - 1; i >= Math.max(0, centerIdx - 4); i--) {
        tryAdd(shots[i]);
      }

      // 2) Continuous forward wave toward end of folder
      for (let i = centerIdx + 25; i < n && picked.length < maxChunk; i++) {
        tryAdd(shots[i]);
      }

      // 3) Remaining earlier shots in folder
      for (let i = centerIdx - 5; i >= 0 && picked.length < maxChunk; i--) {
        tryAdd(shots[i]);
      }

      return picked;
    };

    let running = true;
    void (async () => {
      try {
        while (running && !controller.signal.aborted && !studioUnmountedRef.current) {
          const chunk = pickNextChunk(12);
          if (chunk.length === 0) break;

          let cursor = 0;
          const runWorker = async () => {
            while (!controller.signal.aborted && cursor < chunk.length) {
              await waitForBackgroundSlot(controller.signal);
              if (controller.signal.aborted || studioUnmountedRef.current) {
                return;
              }
              const shot = chunk[cursor++];
              const file = shot.primary;
              if (fingerprintsRef.current[file.id] || bufferUpdates[file.id]) {
                continue;
              }

              // Let the currently displayed foreground photo get its preview URL first
              if (
                displayedShotRef.current &&
                !currentDisplayUrlRef.current &&
                file.id !== displayedShotRef.current.primary.id
              ) {
                await new Promise<void>((r) => window.setTimeout(r, 120));
                if (controller.signal.aborted) return;
              }

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
                if (Object.keys(bufferUpdates).length >= 10) {
                  flushBatch();
                } else {
                  scheduleFlush();
                }
              }
            }
          };

          const concurrency = 2;
          await Promise.all(
            Array.from(
              { length: Math.min(concurrency, chunk.length) },
              () => runWorker()
            )
          );

          if (!controller.signal.aborted) {
            flushBatch();
            await new Promise<void>((r) => window.setTimeout(r, 40));
          }
        }
      } finally {
        running = false;
        if (!controller.signal.aborted) {
          flushBatch();
        }
      }
    })();

    return () => {
      running = false;
      controller.abort();
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
    };
  }, [
    isSeriesOpen,
    isScanningAllSeries,
    isAutoGroupingActive,
    visualSimilarityEnabled,
    pendingResumeTarget,
    allOrderedShots.length,
    accessToken,
  ]);

  const analyzedVisualCount = useMemo(() => {
    let count = 0;
    for (const s of allOrderedShots) {
      if (fingerprintsMap[s.primary.id]) count++;
    }
    return count;
  }, [allOrderedShots, fingerprintsMap]);

  // Compute automatic burst groups only when filmstrip auto-series, gallery series, or full scan is active
  const autoBurstGroups = useMemo(() => {
    if (!isAutoGroupingActive) return [];
    const liveGroups = groupShotsIntoSeries(allOrderedShots, {
      maxGapMs: 3000,
      visualEnabled: visualSimilarityEnabled,
      fingerprints: fingerprintsMap,
      sensitivity: similaritySensitivity,
      calibration: customCalibration,
    });
    if (rememberedAutoSeries.length === 0) return liveGroups;

    const coveredShotIds = new Set<string>();
    for (const g of liveGroups) {
      for (const s of g.shots) coveredShotIds.add(s.id);
    }
    const merged = [...liveGroups];
    for (const rem of rememberedAutoSeries) {
      const matchedShots = rem.shotIds
        .map((id) => shotsById.get(id))
        .filter((s): s is PhotoShotItem => Boolean(s));
      if (
        matchedShots.length >= 2 &&
        matchedShots.every((s) => !coveredShotIds.has(s.id))
      ) {
        for (const s of matchedShots) coveredShotIds.add(s.id);
        merged.push({
          id: rem.id,
          shots: matchedShots,
          startTimeMs: rem.startTimeMs,
          endTimeMs: rem.endTimeMs,
          durationSec: rem.durationSec,
          timeLabel: rem.timeLabel,
          matchReason: rem.matchReason,
        });
      }
    }
    return merged;
  }, [
    allOrderedShots,
    shotsById,
    isAutoGroupingActive,
    visualSimilarityEnabled,
    fingerprintsMap,
    similaritySensitivity,
    customCalibration,
    rememberedAutoSeries,
  ]);

  // Locked manual series ALWAYS resolve first and stay intact even when auto-series on the filmstrip is OFF
  const burstGroups = useMemo(
    () =>
      mergeManualAndAutoSeries(
        allOrderedShots,
        manualSeries,
        autoBurstGroups,
        { includeAuto: isAutoGroupingActive }
      ),
    [allOrderedShots, manualSeries, autoBurstGroups, isAutoGroupingActive]
  );

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

  // In Výběr ('select'), whenever ≥1 photo in a series is selected, unselected siblings automatically dim gray (never condemned to deletion!)
  const autoDimmedShotIds = useMemo(() => {
    const dimmed = new Set<string>();
    if (isDeleteMode) return dimmed;
    for (const g of burstGroups) {
      if (g.shots.some((s) => selectStateByShotId[s.id] === 'selected')) {
        for (const s of g.shots) {
          if (selectStateByShotId[s.id] !== 'selected') {
            dimmed.add(s.id);
          }
        }
      }
    }
    if (activeSeriesShotIds.size >= 2) {
      let anyPinnedSelected = false;
      for (const id of activeSeriesShotIds) {
        if (selectStateByShotId[id] === 'selected') {
          anyPinnedSelected = true;
          break;
        }
      }
      if (anyPinnedSelected) {
        for (const id of activeSeriesShotIds) {
          if (selectStateByShotId[id] !== 'selected') {
            dimmed.add(id);
          }
        }
      }
    }
    return dimmed;
  }, [isDeleteMode, burstGroups, selectStateByShotId, activeSeriesShotIds]);

  // Track culled file IDs and whether the entire folder is culled for 24h/7d retention & preload suppression
  const { culledFileIds, isFolderFullyCulled } = useMemo(() => {
    const culled = new Set<string>(movedOutIds);
    let unculledShots = 0;

    for (const shot of allOrderedShots) {
      const isUnculled = isDeleteMode
        ? (deleteStateByShotId[shot.id] || 'unrated') === 'unrated'
        : (selectStateByShotId[shot.id] || 'unrated') === 'unrated' &&
          !autoDimmedShotIds.has(shot.id);
      if (isUnculled) {
        unculledShots++;
      } else {
        for (const f of shot.files) {
          culled.add(f.id);
        }
      }
    }

    const fullyCulled =
      ratingsHydrated &&
      !isLoadingMore &&
      !loadMoreError &&
      allOrderedShots.length > 0 &&
      unculledShots === 0;

    return { culledFileIds: culled, isFolderFullyCulled: fullyCulled };
  }, [
    movedOutIds,
    allOrderedShots,
    isDeleteMode,
    deleteStateByShotId,
    selectStateByShotId,
    autoDimmedShotIds,
    ratingsHydrated,
    isLoadingMore,
    loadMoreError,
  ]);
  culledFileIdsRef.current = culledFileIds;

  // Apply any remembered enriched timestamps as additional photo batches arrive
  useEffect(() => {
    const rememberedTs = rememberedTimestampsRef.current;
    if (!onUpdatePhotoTimestamps || Object.keys(rememberedTs).length === 0) {
      return;
    }
    const patch: Record<string, { ms: number; label: string }> = {};
    for (const p of activePhotos) {
      if (p.takenAtMs === null && rememberedTs[p.id]) {
        patch[p.id] = rememberedTs[p.id];
      }
    }
    if (Object.keys(patch).length > 0) {
      onUpdatePhotoTimestamps(patch);
    }
  }, [activePhotos, onUpdatePhotoTimestamps]);

  // Incremental 24h/7d IndexedDB culling timestamps (never pins entire unculled folder in RAM or re-scans all IDB rows per swipe)
  const prevCulledFileIdsRef = useRef<Set<string> | null>(null);
  const prevFolderFullyCulledRef = useRef<boolean | null>(null);

  useEffect(() => {
    prevCulledFileIdsRef.current = null;
    prevFolderFullyCulledRef.current = null;
  }, [folder.id]);

  useEffect(() => {
    if (!ratingsHydrated || allOrderedShots.length === 0) return;

    const prevCulled = prevCulledFileIdsRef.current;
    const prevFolderCulled = prevFolderFullyCulledRef.current;

    const timer = window.setTimeout(() => {
      if (prevCulled === null) {
        void syncPhotosCulledState(folder.id, culledFileIds);
      } else {
        const newlyCulled: string[] = [];
        const newlyUnculled: string[] = [];
        for (const id of culledFileIds) {
          if (!prevCulled.has(id)) newlyCulled.push(id);
        }
        for (const id of prevCulled) {
          if (!culledFileIds.has(id)) newlyUnculled.push(id);
        }
        if (newlyCulled.length > 0 || newlyUnculled.length > 0) {
          void updatePhotosCulledStateIncremental(newlyCulled, newlyUnculled);
        }
      }
      prevCulledFileIdsRef.current = new Set(culledFileIds);

      if (prevFolderCulled !== isFolderFullyCulled) {
        prevFolderFullyCulledRef.current = isFolderFullyCulled;
        void syncFolderCulledStatus(folder.id, isFolderFullyCulled);
      }
    }, 650);

    return () => window.clearTimeout(timer);
  }, [
    ratingsHydrated,
    folder.id,
    allOrderedShots.length,
    culledFileIds,
    isFolderFullyCulled,
  ]);

  // Persist detected series groupings & perceptual fingerprints per folder (kept 7 days after culling)
  useEffect(() => {
    if (!ratingsHydrated || allOrderedShots.length === 0) return;
    const fpCount = Object.keys(fingerprintsMap).length;
    if (autoBurstGroups.length === 0 && fpCount === 0) return;

    const timer = window.setTimeout(() => {
      const serializedAuto: RememberedAutoSeriesEntry[] = autoBurstGroups.map(
        (g) => ({
          id: g.id,
          shotIds: g.shots.map((s) => s.id),
          stems: g.shots.map((s) => s.stem),
          startTimeMs: g.startTimeMs,
          endTimeMs: g.endTimeMs,
          durationSec: g.durationSec,
          timeLabel: g.timeLabel,
          matchReason: g.matchReason,
        })
      );
      const timestampsToSave: Record<string, { ms: number; label: string }> = {
        ...rememberedTimestampsRef.current,
      };
      for (const s of allOrderedShots) {
        if (s.takenAtMs !== null && s.takenAtLabel) {
          timestampsToSave[s.primary.id] = {
            ms: s.takenAtMs,
            label: s.takenAtLabel,
          };
        }
      }
      rememberedTimestampsRef.current = timestampsToSave;
      void saveFolderSeriesMemory({
        folderId: folder.id,
        folderName: folder.name,
        autoSeries: serializedAuto,
        fingerprints: fingerprintsMap,
        enrichedTimestamps: timestampsToSave,
        sensitivity: similaritySensitivity,
        visualEnabled: visualSimilarityEnabled,
        isFolderCulled: isFolderFullyCulled,
        totalShotsCount: allOrderedShots.length,
      });
    }, 2500);

    return () => window.clearTimeout(timer);
  }, [
    ratingsHydrated,
    folder.id,
    folder.name,
    allOrderedShots,
    autoBurstGroups,
    fingerprintsMap,
    similaritySensitivity,
    visualSimilarityEnabled,
    isFolderFullyCulled,
  ]);

  const underlyingBurstGroup: PhotoBurstGroup | null = useMemo(() => {
    if (!displayedShot) return null;
    return burstGroupByShotId.get(displayedShot.id) || null;
  }, [displayedShot, burstGroupByShotId]);

  const activeBurstGroup: PhotoBurstGroup | null = useMemo(() => {
    if (!underlyingBurstGroup) return null;
    if (studioMode === 'gallery') {
      return gallerySeriesEnabled || underlyingBurstGroup.isManual
        ? underlyingBurstGroup
        : null;
    }
    // When filmstrip series toggle (autoSeriesEnabled) is OFF in detail view,
    // show zero series on the strip unless the user explicitly opened/pinned this photo's series.
    if (autoSeriesEnabled || isSeriesOpen || activeSeriesShotIds.size > 0) {
      return underlyingBurstGroup;
    }
    return null;
  }, [
    underlyingBurstGroup,
    studioMode,
    gallerySeriesEnabled,
    autoSeriesEnabled,
    isSeriesOpen,
    activeSeriesShotIds.size,
  ]);

  const activeBurstSeriesIndex = useMemo(() => {
    if (burstGroups.length === 0) return -1;
    if (activeBurstGroup) {
      const idx = burstGroups.findIndex((g) => g.id === activeBurstGroup.id);
      if (idx !== -1) return idx;
    }
    if (displayedShot) {
      const idx = burstGroups.findIndex((g) =>
        g.shots.some((s) => s.id === displayedShot.id)
      );
      if (idx !== -1) return idx;
    }
    if (activeSeriesShotIds.size > 0) {
      const idx = burstGroups.findIndex((g) =>
        g.shots.some((s) => activeSeriesShotIds.has(s.id))
      );
      if (idx !== -1) return idx;
    }
    return -1;
  }, [burstGroups, activeBurstGroup, displayedShot, activeSeriesShotIds]);

  // Build activeComparisonShots: in Výběr keep all frames in series; in Mazání hide already-trashed frames
  const activeComparisonShots: PhotoShotItem[] = useMemo(() => {
    const rawList =
      activeSeriesShotIds.size > 0
        ? allOrderedShots.filter((s) => activeSeriesShotIds.has(s.id))
        : activeBurstGroup
          ? activeBurstGroup.shots
          : [];
    if (!isDeleteMode) return rawList;
    return rawList.filter(
      (s) => (deleteStateByShotId[s.id] || 'unrated') !== 'trash'
    );
  }, [
    activeSeriesShotIds,
    allOrderedShots,
    activeBurstGroup,
    isDeleteMode,
    deleteStateByShotId,
  ]);

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
    const browseIdx = browsableShots.findIndex(
      (s) => s.id === displayedShot.id
    );
    if (browseIdx >= 0 && browseIdx + 1 < browsableShots.length) {
      return browsableShots[browseIdx + 1];
    }
    return null;
  }, [
    displayedShot,
    isComparisonActive,
    activeComparisonShots,
    browsableShots,
  ]);
  const nextPeekPhoto = nextPeekShot?.primary || null;
  const activeComparisonIdsRef = useRef(activeComparisonIds);
  activeComparisonIdsRef.current = activeComparisonIds;
  const nextPeekPhotoIdRef = useRef<string | null>(nextPeekPhoto?.id ?? null);
  nextPeekPhotoIdRef.current = nextPeekPhoto?.id ?? null;

  // Prioritize missing EXIF timestamps forward-first from the currently displayed photo (with 4-left cushion)
  const missingExifPhotos = useMemo(() => {
    const stemHasTime = new Set<string>();
    for (const p of activePhotos) {
      if (p.takenAtMs !== null) stemHasTime.add(p.stem);
    }
    const missingEntries: { file: DrivePhotoFile; dist: number }[] = [];
    const centerIdx = displayedShot
      ? Math.max(
          0,
          allOrderedShots.findIndex((s) => s.id === displayedShot.id)
        )
      : 0;
    for (let i = 0; i < allOrderedShots.length; i++) {
      const s = allOrderedShots[i];
      if (s.takenAtMs === null && !stemHasTime.has(s.stem)) {
        const dist =
          i >= centerIdx
            ? i - centerIdx
            : centerIdx - i <= 4
              ? 50 + (centerIdx - i)
              : 100000 + (centerIdx - i);
        missingEntries.push({
          file: s.primary,
          dist,
        });
      }
    }
    missingEntries.sort((a, b) => a.dist - b.dist);
    return missingEntries.map((e) => e.file);
  }, [activePhotos, allOrderedShots, displayedShot]);

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

  const thumbnailUrlLookupRef = useRef(thumbnailUrlLookup);
  thumbnailUrlLookupRef.current = thumbnailUrlLookup;

  useEffect(() => {
    if (onSelectionUpdate) {
      onSelectionUpdate(
        pickedFiles,
        pickedShotsList.length,
        thumbnailUrlLookupRef.current,
        trashFiles,
        trashShotsList.length
      );
    }
  }, [
    pickedFiles,
    pickedShotsList.length,
    trashFiles,
    trashShotsList.length,
    onSelectionUpdate,
  ]);

  const loadingRef = useRef(new Set<string>());
  const inFlightLoadsRef = useRef<Map<string, Promise<void>>>(new Map());
  const bgSharpBufferRef = useRef<Record<string, ResolvedPhotoMedia>>({});
  const bgSharpFlushTimerRef = useRef<number | null>(null);

  // Exclusive open-series priority mode: pause unrelated folder-wide background tasks & scale VRAM/RAM budget to fit the open series
  useEffect(() => {
    setOpenSeriesPriority(isComparisonActive);
    setSeriesCacheBudget(
      isComparisonActive ? activeComparisonShots.length : 0
    );
    return () => {
      setOpenSeriesPriority(false);
      setSeriesCacheBudget(0);
    };
  }, [isComparisonActive, activeComparisonShots.length]);

  // Keep a tight working window in RAM & VRAM (or the full open series when comparing) and prune stale React map entries
  useEffect(() => {
    const retained = new Set<string>();
    const vramTargets = new Set<string>();

    if (displayedPhoto) {
      retained.add(displayedPhoto.id);
      vramTargets.add(displayedPhoto.id);
    }
    if (nextPeekPhoto) {
      retained.add(nextPeekPhoto.id);
      vramTargets.add(nextPeekPhoto.id);
    }

    if (isComparisonActive) {
      for (const s of activeComparisonShots) {
        retained.add(s.primary.id);
        vramTargets.add(s.primary.id);
      }
    } else if (displayedShot && allOrderedShots.length > 0) {
      const idx = allOrderedShots.findIndex((s) => s.id === displayedShot.id);
      if (idx !== -1) {
        const from = Math.max(0, idx - 2);
        const to = Math.min(allOrderedShots.length - 1, idx + 3);
        for (let i = from; i <= to; i++) {
          retained.add(allOrderedShots[i].primary.id);
        }
        // Only pre-decode immediate ±1 neighbor in normal browsing so GPU VRAM stays crisp and small
        if (idx - 1 >= 0) vramTargets.add(allOrderedShots[idx - 1].primary.id);
        if (idx + 1 < allOrderedShots.length) {
          vramTargets.add(allOrderedShots[idx + 1].primary.id);
        }
      }
    }

    setRetainedMediaFileIds(retained);

    // Immediately release non-series RAM/VRAM when entering an open series or when cache exceeds tight ceiling
    const maxReactMapSize = isComparisonActive
      ? Math.max(24, activeComparisonShots.length + 10)
      : 24;
    if (
      isComparisonActive ||
      Object.keys(sharpMediaMapRef.current).length > maxReactMapSize
    ) {
      trimMediaMemoryCache(retained);
    }

    // Prune React media state maps outside the retained window so component state never balloons over long sessions
    if (Object.keys(sharpMediaMapRef.current).length > maxReactMapSize) {
      setSharpMediaMap((prev) => {
        const keys = Object.keys(prev);
        if (keys.length <= maxReactMapSize) return prev;
        const next: Record<string, ResolvedPhotoMedia> = {};
        let keptNonRetained = 0;
        const maxExtra = 8;
        for (let i = keys.length - 1; i >= 0; i--) {
          const k = keys[i];
          if (retained.has(k)) {
            next[k] = prev[k];
          } else if (keptNonRetained < maxExtra) {
            next[k] = prev[k];
            keptNonRetained++;
          }
        }
        return next;
      });
    }

    if (Object.keys(tempPreviewMapRef.current).length > maxReactMapSize + 12) {
      setTempPreviewMap((prev) => {
        const keys = Object.keys(prev);
        if (keys.length <= maxReactMapSize + 12) return prev;
        const next: Record<string, string> = {};
        let keptNonRetained = 0;
        for (let i = keys.length - 1; i >= 0; i--) {
          const k = keys[i];
          if (retained.has(k)) {
            next[k] = prev[k];
          } else if (keptNonRetained < 10) {
            next[k] = prev[k];
            keptNonRetained++;
          }
        }
        return next;
      });
    }

    // Pre-decode and lock GPU textures only for VRAM targets (all open-series frames OR active + next + ±1)
    for (const fileId of vramTargets) {
      const sharpUrl = sharpMediaMapRef.current[fileId]?.url;
      const tempUrl = tempPreviewMapRef.current[fileId];
      if (sharpUrl) predecodeAndRetainImage(sharpUrl, 12_000, true);
      else if (tempUrl) predecodeAndRetainImage(tempUrl, 12_000, true);
    }
  }, [
    displayedPhoto,
    nextPeekPhoto,
    isComparisonActive,
    activeComparisonShots,
    displayedShot,
    allOrderedShots,
    sharpMediaMap,
    tempPreviewMap,
  ]);

  useEffect(() => {
    return () => {
      setRetainedMediaFileIds([]);
      setOpenSeriesPriority(false);
      setSeriesCacheBudget(0);
    };
  }, []);

  // Purge any evicted ObjectURLs from local component maps so an <img> never points to a revoked blob URL
  useEffect(() => {
    return subscribeMediaCacheEviction((fileId, evictedUrl) => {
      if (bgSharpBufferRef.current[fileId]?.url === evictedUrl) {
        delete bgSharpBufferRef.current[fileId];
      }
      if (sharpMediaMapRef.current[fileId]?.url === evictedUrl) {
        setSharpMediaMap((prev) => {
          if (prev[fileId]?.url !== evictedUrl) return prev;
          const next = { ...prev };
          delete next[fileId];
          return next;
        });
      }
      if (tempPreviewMapRef.current[fileId] === evictedUrl) {
        setTempPreviewMap((prev) => {
          if (prev[fileId] !== evictedUrl) return prev;
          const next = { ...prev };
          delete next[fileId];
          return next;
        });
      }
    });
  }, []);

  const commitSharpMedia = useCallback(
    (key: string, resolved: ResolvedPhotoMedia, immediate: boolean) => {
      if (immediate) {
        delete bgSharpBufferRef.current[key];
        setSharpMediaMap((prev) => ({ ...prev, [key]: resolved }));
        return;
      }
      bgSharpBufferRef.current[key] = resolved;
      const pendingKeys = Object.keys(bgSharpBufferRef.current);
      if (pendingKeys.length >= 6) {
        if (bgSharpFlushTimerRef.current !== null) {
          window.clearTimeout(bgSharpFlushTimerRef.current);
          bgSharpFlushTimerRef.current = null;
        }
        const copy = { ...bgSharpBufferRef.current };
        bgSharpBufferRef.current = {};
        startTransition(() => {
          setSharpMediaMap((prev) => ({ ...prev, ...copy }));
        });
      } else if (bgSharpFlushTimerRef.current === null) {
        bgSharpFlushTimerRef.current = window.setTimeout(() => {
          bgSharpFlushTimerRef.current = null;
          const copy = { ...bgSharpBufferRef.current };
          if (Object.keys(copy).length === 0) return;
          bgSharpBufferRef.current = {};
          startTransition(() => {
            setSharpMediaMap((prev) => ({ ...prev, ...copy }));
          });
        }, 280);
      }
    },
    []
  );

  /**
   * Two-stage progressive loader stabilized via sharpMediaMapRef so completed loads
   * never recreate this callback or re-trigger effects across the deck.
   * Foreground P0 loads hold priority via beginForegroundPhotoLoad() and recover cleanly
   * even if an earlier background preload failed or was still in flight.
   */
  const loadPhotoProgressive = useCallback(
    async (
      file: DrivePhotoFile,
      forceOrOptions:
        | boolean
        | {
            forceRawDecode?: boolean;
            background?: boolean;
            highQualitySeries?: boolean;
          } = false
    ) => {
      const forceRawDecode =
        typeof forceOrOptions === 'boolean'
          ? forceOrOptions
          : Boolean(forceOrOptions.forceRawDecode);
      const isBackground =
        typeof forceOrOptions === 'boolean'
          ? false
          : Boolean(forceOrOptions.background);
      const highQualitySeries =
        typeof forceOrOptions === 'boolean'
          ? false
          : Boolean(forceOrOptions.highQualitySeries);

      const key = file.id;
      const existingSharp =
        sharpMediaMapRef.current[key] || bgSharpBufferRef.current[key];
      const needsSeriesUpgrade =
        highQualitySeries &&
        existingSharp &&
        ((file.isRaw && existingSharp.source === 'drive-thumbnail') ||
          (!file.isRaw &&
            existingSharp.source === 'drive-thumbnail' &&
            !existingSharp.url.includes('=s2400')));
      const effectiveForceRaw =
        forceRawDecode || (highQualitySeries && file.isRaw);
      const lockKey = effectiveForceRaw
        ? `${key}:raw`
        : highQualitySeries
          ? `${key}:hq`
          : key;

      if (!effectiveForceRaw && !needsSeriesUpgrade) {
        if (sharpMediaMapRef.current[key]) return;
        const buffered = bgSharpBufferRef.current[key];
        if (buffered) {
          if (!isBackground) {
            commitSharpMedia(key, buffered, true);
          }
          return;
        }
      } else if (
        highQualitySeries &&
        existingSharp &&
        !needsSeriesUpgrade &&
        (!file.isRaw || existingSharp.source !== 'drive-thumbnail')
      ) {
        if (bgSharpBufferRef.current[key] && !sharpMediaMapRef.current[key]) {
          commitSharpMedia(key, existingSharp, true);
        }
        return;
      }

      const existingInFlight = inFlightLoadsRef.current.get(lockKey);
      if (existingInFlight) {
        if (isBackground) return;
        const releaseJoinFg = beginForegroundPhotoLoad();
        setUpgradingMap((prev) => ({ ...prev, [key]: true }));
        try {
          await existingInFlight;
        } finally {
          releaseJoinFg();
          setUpgradingMap((prev) => ({ ...prev, [key]: false }));
        }
        if (!effectiveForceRaw && !needsSeriesUpgrade) {
          const bufferedAfter = bgSharpBufferRef.current[key];
          if (bufferedAfter) {
            commitSharpMedia(key, bufferedAfter, true);
            return;
          }
          if (sharpMediaMapRef.current[key]) {
            return;
          }
        }
      }

      if (loadingRef.current.has(lockKey)) return;
      loadingRef.current.add(lockKey);

      const releaseFg = !isBackground ? beginForegroundPhotoLoad() : null;
      if (!isBackground) {
        setUpgradingMap((prev) => ({ ...prev, [key]: true }));
        setErrorMap((prev) => {
          if (!prev[key]) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }

      const task = (async () => {
        try {
          const isHotVisible = () =>
            !isBackground ||
            highQualitySeries ||
            displayedShotRef.current?.primary.id === key ||
            nextPeekPhotoIdRef.current === key ||
            activeComparisonIdsRef.current.has(key);

          if (!forceRawDecode && isHotVisible()) {
            const instantCachedThumb =
              (!file.sourceKind || file.sourceKind === 'drive'
                ? getFastPreviewThumbnailUrl(file.thumbnailLink)
                : null) ||
              getCachedFilmstripThumbnailUrl(key) ||
              microThumbsMapRef.current[key] ||
              null;
            if (instantCachedThumb) {
              setTempPreviewMap((prev) =>
                prev[key] ? prev : { ...prev, [key]: instantCachedThumb }
              );
            }
            if (file.isRaw && (!instantCachedThumb || isLocalSource)) {
              resolveFastTempRawPreview(accessToken, file)
                .then((tempUrl) => {
                  if (tempUrl) {
                    setTempPreviewMap((prev) =>
                      prev[key] ? prev : { ...prev, [key]: tempUrl }
                    );
                  }
                })
                .catch(() => {});
            }
          }

          if (
            !effectiveForceRaw &&
            file.thumbnailLink &&
            (!file.sourceKind || file.sourceKind === 'drive')
          ) {
            const sharpThumbUrl = highQualitySeries
              ? getSeriesHighQualityThumbnailUrl(file.thumbnailLink)
              : getUpgradeThumbnailUrl(file.thumbnailLink);
            if (sharpThumbUrl) {
              try {
                await preloadImageUrl(sharpThumbUrl);
                const resolved = await resolvePhotoMedia(accessToken, file, {
                  preferFullRawDecode: false,
                  folderId: folder.id,
                  isCulled: culledFileIdsRef.current.has(file.id),
                  highQualitySeries,
                  isBackground,
                });
                commitSharpMedia(key, resolved, isHotVisible());
                if (highQualitySeries) {
                  predecodeAndRetainImage(resolved.url, 12_000, true);
                }
                return;
              } catch {
                // Fall through to full RAW/media extraction
              }
            }
          }

          const resolved = await resolvePhotoMedia(accessToken, file, {
            preferFullRawDecode: !isLocalSource || effectiveForceRaw,
            folderId: folder.id,
            isCulled: culledFileIdsRef.current.has(file.id),
            highQualitySeries,
            isBackground,
          });
          commitSharpMedia(key, resolved, isHotVisible());
          if (highQualitySeries) {
            predecodeAndRetainImage(resolved.url, 12_000, true);
          }
        } catch (err: unknown) {
          if (err instanceof AuthExpiredError) {
            onAuthExpired();
            return;
          }
          if (!isBackground || displayedShotRef.current?.primary.id === key) {
            setErrorMap((prev) => ({
              ...prev,
              [key]:
                err instanceof Error
                  ? err.message
                  : 'Nepodařilo se načíst náhled fotografie.',
            }));
          }
        } finally {
          loadingRef.current.delete(lockKey);
          inFlightLoadsRef.current.delete(lockKey);
          releaseFg?.();
          if (!isBackground || displayedShotRef.current?.primary.id === key) {
            setUpgradingMap((prev) => ({ ...prev, [key]: false }));
          }
        }
      })();

      inFlightLoadsRef.current.set(lockKey, task);
      await task;
    },
    [accessToken, folder.id, isLocalSource, onAuthExpired, commitSharpMedia]
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

  const displayedShotRef = useRef<PhotoShotItem | null>(null);
  const currentDisplayUrlRef = useRef<string | undefined>(undefined);
  const handlePrimaryLeftActionRef = useRef<
    (source: 'swipe' | 'tap', startX?: number) => void
  >(() => {});
  const handlePrimaryRightActionRef = useRef<
    (source: 'swipe' | 'tap', startX?: number) => void
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

  // Native non-passive touch zoom/pinch/pan/swipe engine for Android APK
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
      markInteractionActive(260);
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
      markInteractionActive(260);

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

    containerEl.addEventListener('touchstart', onTouchStart, { passive: false });
    containerEl.addEventListener('touchmove', onTouchMove, { passive: false });
    containerEl.addEventListener('touchend', onTouchEnd, { passive: false });
    containerEl.addEventListener('touchcancel', onTouchEnd, { passive: false });

    return () => {
      containerEl.removeEventListener('touchstart', onTouchStart);
      containerEl.removeEventListener('touchmove', onTouchMove);
      containerEl.removeEventListener('touchend', onTouchEnd);
      containerEl.removeEventListener('touchcancel', onTouchEnd);
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

  // Dedicated Maximum-Performance Open-Series Quality Loader:
  // When a series is explicitly open, devotes full concurrency (3) exclusively to loading & GPU-locking
  // every frame of the open series at high quality (embedded RAW / =s2400 / crisp 2048px local JPEG)
  // ordered outward from the currently focused frame for 0ms lag-free switching and sharp zoom.
  useEffect(() => {
    if (
      !isComparisonActive ||
      !ratingsHydrated ||
      pendingResumeTarget ||
      activeComparisonShots.length === 0
    ) {
      setSeriesPreloadStatus(null);
      return;
    }

    const total = activeComparisonShots.length;
    const focusIdx = displayedShot
      ? Math.max(
          0,
          activeComparisonShots.findIndex((s) => s.id === displayedShot.id)
        )
      : 0;

    // Order outward from active frame: active, +1, -1, +2, -2, ...
    const orderedSeries = activeComparisonShots
      .map((shot, idx) => ({ shot, dist: Math.abs(idx - focusIdx), idx }))
      .sort((a, b) => a.dist - b.dist || a.idx - b.idx)
      .map((entry) => entry.shot);

    const isFrameHighQualityReady = (shot: PhotoShotItem): boolean => {
      const existing = sharpMediaMapRef.current[shot.primary.id];
      if (!existing) return false;
      if (shot.primary.isRaw && existing.source === 'drive-thumbnail') {
        return false;
      }
      if (
        !shot.primary.isRaw &&
        existing.source === 'drive-thumbnail' &&
        !existing.url.includes('=s2400')
      ) {
        return false;
      }
      return true;
    };

    const initialReady = orderedSeries.filter(isFrameHighQualityReady).length;
    if (initialReady >= total) {
      for (const shot of orderedSeries) {
        const url = sharpMediaMapRef.current[shot.primary.id]?.url;
        if (url) predecodeAndRetainImage(url, 12_000, true);
      }
      setSeriesPreloadStatus(null);
      return;
    }

    let cancelled = false;
    let readyCount = initialReady;
    setSeriesPreloadStatus({ ready: readyCount, total });

    const pending = orderedSeries.filter((s) => !isFrameHighQualityReady(s));
    let cursor = 0;

    const runSeriesWorker = async () => {
      while (!cancelled && cursor < pending.length) {
        const shot = pending[cursor++];
        await loadPhotoProgressive(shot.primary, {
          background: false,
          highQualitySeries: true,
          forceRawDecode: shot.primary.isRaw,
        });
        if (cancelled) return;
        const resolvedUrl = sharpMediaMapRef.current[shot.primary.id]?.url;
        if (resolvedUrl) {
          predecodeAndRetainImage(resolvedUrl, 12_000, true);
        }
        readyCount = Math.min(total, readyCount + 1);
        if (readyCount >= total) {
          setSeriesPreloadStatus(null);
        } else {
          setSeriesPreloadStatus({ ready: readyCount, total });
        }
      }
    };

    const concurrency = Math.min(3, pending.length);
    void Promise.all(
      Array.from({ length: concurrency }, () => runSeriesWorker())
    ).then(() => {
      if (!cancelled) {
        setSeriesPreloadStatus(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    isComparisonActive,
    ratingsHydrated,
    pendingResumeTarget,
    activeComparisonShots,
    displayedShot,
    loadPhotoProgressive,
  ]);

  // Tight, RAM-friendly normal-mode preloader:
  // Keeps only the active frame + next peek + 3 ahead + 1 behind ready (never 120 ahead!),
  // and yields completely when an explicit series is open.
  useEffect(() => {
    if (
      !ratingsHydrated ||
      pendingResumeTarget ||
      !displayedShot ||
      isComparisonActive
    ) {
      return;
    }

    const queue: DrivePhotoFile[] = [displayedShot.primary];
    const queuedIds = new Set<string>([displayedShot.primary.id]);
    const enqueueShot = (
      shot: PhotoShotItem | undefined | null,
      requireUnculled = false
    ) => {
      if (!shot) return;
      if (requireUnculled && culledFileIdsRef.current.has(shot.primary.id)) {
        return;
      }
      if (!queuedIds.has(shot.primary.id)) {
        queuedIds.add(shot.primary.id);
        queue.push(shot.primary);
      }
    };

    if (!isFolderFullyCulled) {
      // 1. Immediate next card peeking behind current card
      enqueueShot(nextPeekShot, false);

      // 2. Up to 3 unculled shots ahead in browsable timeline
      const browseIdx = browsableShots.findIndex(
        (s) => s.id === displayedShot.id
      );
      let addedAhead = 0;
      if (browseIdx !== -1) {
        for (
          let i = browseIdx + 1;
          i < browsableShots.length && addedAhead < 3;
          i++
        ) {
          const candidate = browsableShots[i];
          if (!culledFileIdsRef.current.has(candidate.primary.id)) {
            enqueueShot(candidate, true);
            addedAhead++;
          }
        }
      }

      // 3. Fill up to 3 ahead from chronological order if browsable list had fewer, plus 1 behind for instant Undo
      const allIdx = allOrderedShots.findIndex((s) => s.id === displayedShot.id);
      if (allIdx !== -1) {
        for (
          let i = allIdx + 1;
          i < allOrderedShots.length && addedAhead < 3;
          i++
        ) {
          const candidate = allOrderedShots[i];
          if (!culledFileIdsRef.current.has(candidate.primary.id)) {
            enqueueShot(candidate, true);
            addedAhead++;
          }
        }
        if (allIdx - 1 >= 0) {
          enqueueShot(allOrderedShots[allIdx - 1], false);
        }
      }
    }

    let cancelled = false;

    void (async () => {
      for (let itemIdx = 0; itemIdx < queue.length; itemIdx++) {
        if (cancelled) return;
        const file = queue[itemIdx];
        const isForeground =
          itemIdx === 0 || file.id === displayedShot.primary.id;
        if (!isForeground) {
          await waitForBackgroundSlot();
          if (cancelled) return;
        }
        if (!sharpMediaMapRef.current[file.id]) {
          await loadPhotoProgressive(file, {
            background: !isForeground,
          });
          if (!cancelled && !isForeground) {
            await new Promise<void>((r) => window.setTimeout(r, 24));
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    ratingsHydrated,
    pendingResumeTarget,
    displayedShot,
    nextPeekShot,
    allOrderedShots,
    browsableShots,
    isComparisonActive,
    isFolderFullyCulled,
    loadPhotoProgressive,
  ]);

  // Pre-warm the 8 bottom-filmstrip thumbnails to the LEFT (+4 right) as soon as a resume target matches,
  // so reopening a folder on a mid-folder photo displays a clean populated filmstrip immediately.
  useEffect(() => {
    if (!pendingResumeTarget || !matchedResumeShot || allOrderedShots.length === 0) {
      return;
    }
    const resumeIdx = allOrderedShots.findIndex(
      (s) => s.id === matchedResumeShot.id
    );
    if (resumeIdx === -1) return;

    const controller = new AbortController();
    const stripTargets: PhotoShotItem[] = [];
    for (let i = Math.max(0, resumeIdx - 8); i <= Math.min(allOrderedShots.length - 1, resumeIdx + 4); i++) {
      stripTargets.push(allOrderedShots[i]);
    }
    // Order closest to left-context of resumeIdx first
    stripTargets.sort((a, b) => {
      const ia = allOrderedShots.indexOf(a);
      const ib = allOrderedShots.indexOf(b);
      return Math.abs(ia - resumeIdx) - Math.abs(ib - resumeIdx);
    });

    let cursor = 0;
    const warmWorker = async () => {
      while (!controller.signal.aborted && cursor < stripTargets.length) {
        const item = stripTargets[cursor++];
        await resolveFilmstripThumbnailUrl(
          accessToken,
          item.primary,
          controller.signal,
          {
            folderId: folder.id,
            preferMicroOnly: isFolderFullyCulled,
          }
        ).catch(() => null);
      }
    };

    void Promise.all(
      Array.from({ length: Math.min(3, stripTargets.length) }, () =>
        warmWorker()
      )
    );

    return () => {
      controller.abort();
    };
  }, [
    pendingResumeTarget,
    matchedResumeShot,
    allOrderedShots,
    accessToken,
    folder.id,
    isFolderFullyCulled,
  ]);

  // Resolve and complete resume gate quickly: show studio as soon as any cached/micro preview or 1.2s window elapses
  const resumeTargetFile = matchedResumeShot?.primary || null;
  const resumeDisplayUrl = resumeTargetFile
    ? sharpMediaMap[resumeTargetFile.id]?.url ||
      tempPreviewMap[resumeTargetFile.id] ||
      microThumbsMap[resumeTargetFile.id] ||
      getCachedFilmstripThumbnailUrl(resumeTargetFile.id) ||
      (!resumeTargetFile.sourceKind || resumeTargetFile.sourceKind === 'drive'
        ? getFastPreviewThumbnailUrl(resumeTargetFile.thumbnailLink)
        : undefined)
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
    const targetFile = matchedResumeShot.primary;
    setTempPreviewMap((prev) =>
      prev[targetFile.id] ? prev : { ...prev, [targetFile.id]: resumeDisplayUrl }
    );
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
      invalidateThumbnailCache(targetFile.id);
      void deleteCachedDetailPreviewsForFile(targetFile.id);
      void loadPhotoProgressive(targetFile, {
        forceRawDecode: targetFile.isRaw,
        background: false,
      });
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
      // Never block folder opening for more than 1.2s once the resume shot is found — open onto it and sharpen in place
      const fallbackOpenTimer = window.setTimeout(() => {
        setActiveShotId(matchedResumeShot.id);
        setPendingResumeTarget(null);
      }, 1200);
      return () => {
        window.clearTimeout(fallbackOpenTimer);
      };
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

  // Persist exact last viewed photo with a short debounce so scrubbing through series never stalls on synchronous localStorage
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
    const localTimer = window.setTimeout(() => {
      const resumeObj = {
        ...nextCursor,
        updatedAtMs: Date.now(),
      };
      writeLocalResumePosition(folder.id, resumeObj);
      onPersistedStateChange?.(
        desiredEntriesRef.current,
        shardMapRef.current,
        resumeObj
      );
    }, 180);

    if (cursorSyncTimerRef.current !== null) {
      window.clearTimeout(cursorSyncTimerRef.current);
    }
    cursorSyncTimerRef.current = window.setTimeout(() => {
      cursorSyncTimerRef.current = null;
      void flushPersistence();
    }, 900);

    return () => {
      window.clearTimeout(localTimer);
    };
  }, [
    ratingsHydrated,
    pendingResumeTarget,
    displayedShot,
    folder.id,
    flushPersistence,
    onPersistedStateChange,
  ]);

  const detailErrorRetryRef = useRef<Record<string, number>>({});
  const handleImageElementError = useCallback(
    (file: DrivePhotoFile) => {
      invalidateThumbnailCache(file.id);
      void deleteCachedDetailPreviewsForFile(file.id);
      delete bgSharpBufferRef.current[file.id];

      const attempt = (detailErrorRetryRef.current[file.id] || 0) + 1;
      detailErrorRetryRef.current[file.id] = attempt;

      if (attempt <= 2) {
        setSharpMediaMap((prev) => {
          if (!prev[file.id]) return prev;
          const next = { ...prev };
          delete next[file.id];
          return next;
        });
        setTempPreviewMap((prev) => {
          if (!prev[file.id]) return prev;
          const next = { ...prev };
          delete next[file.id];
          return next;
        });
        loadingRef.current.delete(file.id);
        loadingRef.current.delete(`${file.id}:raw`);
        inFlightLoadsRef.current.delete(file.id);
        inFlightLoadsRef.current.delete(`${file.id}:raw`);
        void loadPhotoProgressive(file, {
          forceRawDecode: file.isRaw || attempt >= 2,
          background: false,
        });
      } else {
        setErrorMap((prev) => ({
          ...prev,
          [file.id]: `Aplikace nemohla zobrazit formát .${file.fileExtension.toUpperCase()}.`,
        }));
      }
    },
    [loadPhotoProgressive]
  );

  // Foreground P0 watchdog: guarantees the currently open photo ALWAYS starts loading immediately
  // and automatically self-heals if a background decode stalled or yielded an empty URL.
  const activeDisplayedUrl = displayedPhoto
    ? sharpMediaMap[displayedPhoto.id]?.url || tempPreviewMap[displayedPhoto.id]
    : undefined;
  const activeDisplayedError = displayedPhoto
    ? errorMap[displayedPhoto.id]
    : undefined;

  useEffect(() => {
    if (
      !ratingsHydrated ||
      pendingResumeTarget ||
      !displayedPhoto ||
      activeDisplayedUrl ||
      activeDisplayedError
    ) {
      return;
    }

    void loadPhotoProgressive(displayedPhoto, false);

    const targetFile = displayedPhoto;
    const watchdogTimer = window.setTimeout(() => {
      if (studioUnmountedRef.current) return;
      if (displayedShotRef.current?.primary.id !== targetFile.id) return;
      if (
        sharpMediaMapRef.current[targetFile.id]?.url ||
        tempPreviewMapRef.current[targetFile.id]
      ) {
        return;
      }
      invalidateThumbnailCache(targetFile.id);
      void deleteCachedDetailPreviewsForFile(targetFile.id);
      loadingRef.current.delete(targetFile.id);
      loadingRef.current.delete(`${targetFile.id}:raw`);
      inFlightLoadsRef.current.delete(targetFile.id);
      inFlightLoadsRef.current.delete(`${targetFile.id}:raw`);
      void loadPhotoProgressive(targetFile, {
        forceRawDecode: targetFile.isRaw,
        background: false,
      });
    }, 4500);

    return () => {
      window.clearTimeout(watchdogTimer);
    };
  }, [
    ratingsHydrated,
    pendingResumeTarget,
    displayedPhoto,
    activeDisplayedUrl,
    activeDisplayedError,
    loadPhotoProgressive,
  ]);

  // Build complete set of shot IDs belonging to the series being exited/skipped so we never land inside the same burst
  const buildFullSeriesSkipSet = useCallback(
    (
      explicitShots?: PhotoShotItem[],
      anchorShotId?: string
    ): Set<string> | undefined => {
      if (!explicitShots || explicitShots.length === 0) return undefined;
      const ids = new Set<string>();
      for (const s of explicitShots) {
        ids.add(s.id);
      }
      if (isSeriesOpen || activeSeriesShotIds.size > 0) {
        for (const id of activeSeriesShotIds) {
          ids.add(id);
        }
        for (const s of activeComparisonShots) {
          ids.add(s.id);
        }
      }
      const lookupId = anchorShotId || displayedShot?.id;
      if (lookupId) {
        const bg = burstGroupByShotId.get(lookupId);
        if (bg && (autoSeriesEnabled || bg.isManual)) {
          for (const s of bg.shots) {
            ids.add(s.id);
          }
        }
      }
      return ids;
    },
    [
      isSeriesOpen,
      activeSeriesShotIds,
      activeComparisonShots,
      displayedShot?.id,
      burstGroupByShotId,
      autoSeriesEnabled,
    ]
  );

  // Find next shot to advance to in the active workflow mode:
  // strictly jumps forward to the immediately following UNCULLED photo or series!
  const findNextAfterModeAction = useCallback(
    (actedShotId: string, skipShotIds?: Set<string>): string | null => {
      const isUnculledCandidate = (candidate: PhotoShotItem): boolean => {
        if (skipShotIds?.has(candidate.id)) return false;
        if (isDeleteMode) {
          return (deleteStateByShotId[candidate.id] || 'unrated') === 'unrated';
        }
        const sel = selectStateByShotId[candidate.id] || 'unrated';
        return sel === 'unrated' && !autoDimmedShotIds.has(candidate.id);
      };

      const canLandFallback = (candidate: PhotoShotItem): boolean => {
        if (skipShotIds?.has(candidate.id)) return false;
        if (isDeleteMode) {
          return (deleteStateByShotId[candidate.id] || 'unrated') !== 'trash';
        }
        const sel = selectStateByShotId[candidate.id] || 'unrated';
        return sel !== 'dimmed' && !autoDimmedShotIds.has(candidate.id);
      };

      if (isComparisonActive && !skipShotIds) {
        const compIdx = activeComparisonShots.findIndex(
          (s) => s.id === actedShotId
        );
        if (compIdx !== -1) {
          for (let i = compIdx + 1; i < activeComparisonShots.length; i++) {
            const candidate = activeComparisonShots[i];
            if (isUnculledCandidate(candidate)) return candidate.id;
          }
          for (let i = compIdx - 1; i >= 0; i--) {
            const candidate = activeComparisonShots[i];
            if (isUnculledCandidate(candidate)) return candidate.id;
          }
          for (let i = compIdx + 1; i < activeComparisonShots.length; i++) {
            const candidate = activeComparisonShots[i];
            if (canLandFallback(candidate)) return candidate.id;
          }
          for (let i = compIdx - 1; i >= 0; i--) {
            const candidate = activeComparisonShots[i];
            if (canLandFallback(candidate)) return candidate.id;
          }
        }
      }

      const startIdx = allOrderedShots.findIndex((s) => s.id === actedShotId);
      if (startIdx === -1) return null;

      if (skipShotIds && skipShotIds.size > 0) {
        let maxSkipIdx = startIdx;
        let minSkipIdx = startIdx;
        for (let i = 0; i < allOrderedShots.length; i++) {
          if (skipShotIds.has(allOrderedShots[i].id)) {
            if (i > maxSkipIdx) maxSkipIdx = i;
            if (i < minSkipIdx) minSkipIdx = i;
          }
        }
        // 1) Immediately following unculled photo or unculled series forward
        for (let i = maxSkipIdx + 1; i < allOrderedShots.length; i++) {
          if (isUnculledCandidate(allOrderedShots[i])) {
            return allOrderedShots[i].id;
          }
        }
        // 2) Any remaining unculled photo earlier in the folder
        for (let i = minSkipIdx - 1; i >= 0; i--) {
          if (isUnculledCandidate(allOrderedShots[i])) {
            return allOrderedShots[i].id;
          }
        }
        // 3) Fallback if entire folder is already culled: immediate next non-skipped shot forward
        for (let i = maxSkipIdx + 1; i < allOrderedShots.length; i++) {
          if (canLandFallback(allOrderedShots[i])) return allOrderedShots[i].id;
        }
        for (let i = maxSkipIdx + 1; i < allOrderedShots.length; i++) {
          const cand = allOrderedShots[i];
          if (
            !skipShotIds.has(cand.id) &&
            (!isDeleteMode ||
              (deleteStateByShotId[cand.id] || 'unrated') !== 'trash')
          ) {
            return cand.id;
          }
        }
        for (let i = minSkipIdx - 1; i >= 0; i--) {
          const cand = allOrderedShots[i];
          if (
            !skipShotIds.has(cand.id) &&
            (!isDeleteMode ||
              (deleteStateByShotId[cand.id] || 'unrated') !== 'trash')
          ) {
            return cand.id;
          }
        }
        return actedShotId;
      }

      // Standalone single-shot action: jump to immediately following unculled photo/series forward
      for (let i = startIdx + 1; i < allOrderedShots.length; i++) {
        if (isUnculledCandidate(allOrderedShots[i])) {
          return allOrderedShots[i].id;
        }
      }
      for (let i = startIdx - 1; i >= 0; i--) {
        if (isUnculledCandidate(allOrderedShots[i])) {
          return allOrderedShots[i].id;
        }
      }
      for (let i = startIdx + 1; i < allOrderedShots.length; i++) {
        if (canLandFallback(allOrderedShots[i])) return allOrderedShots[i].id;
      }
      if (!isDeleteMode && startIdx + 1 < allOrderedShots.length) {
        return allOrderedShots[startIdx + 1].id;
      }
      for (let i = startIdx - 1; i >= 0; i--) {
        if (canLandFallback(allOrderedShots[i])) return allOrderedShots[i].id;
      }
      return actedShotId;
    },
    [
      isDeleteMode,
      deleteStateByShotId,
      selectStateByShotId,
      autoDimmedShotIds,
      isComparisonActive,
      activeComparisonShots,
      allOrderedShots,
    ]
  );

  const triggerCardExitGhost = useCallback(
    (dir: 'left' | 'right' | null, explicitStartX?: number) => {
      markInteractionActive(260);
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

  // Update ONLY the current mode's state on a single shot (preserving the other mode's state!)
  const applyShotModePatch = useCallback(
    (
      shot: PhotoShotItem,
      patch: { selectState?: SelectModeState; deleteState?: DeleteModeState },
      options: {
        advance?: boolean;
        skipSeriesShots?: PhotoShotItem[];
        closeOpenSeries?: boolean;
        swipeExit?: 'left' | 'right' | null;
        startX?: number;
      } = {}
    ) => {
      const {
        advance = true,
        skipSeriesShots,
        closeOpenSeries = false,
        swipeExit = null,
        startX,
      } = options;

      if (patch.selectState === 'selected' || patch.deleteState === 'spared') {
        triggerHaptic('keep', hapticSettingsRef.current);
      } else if (patch.deleteState === 'trash') {
        triggerHaptic('trash', hapticSettingsRef.current);
      } else {
        triggerHaptic('selection', hapticSettingsRef.current);
      }

      if (swipeExit) {
        triggerCardExitGhost(swipeExit, startX);
      } else {
        setExitingSwipeCard(null);
        dragX.jump(0);
      }

      const skipSet = buildFullSeriesSkipSet(skipSeriesShots, shot.id);
      const nextId = advance
        ? findNextAfterModeAction(shot.id, skipSet)
        : null;

      const wasInActiveSeries =
        isSeriesOpen || activeComparisonIds.has(shot.id);
      const removedFromSeriesShotId =
        isDeleteMode && patch.deleteState === 'trash' && wasInActiveSeries
          ? shot.id
          : undefined;

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
          ...(closeOpenSeries && activeComparisonShots.length > 0
            ? {
                restoredSeriesShotIds: activeComparisonShots.map((s) => s.id),
                wasSeriesOpen: isSeriesOpen,
                wasManualSeriesPinned: activeSeriesShotIds.size > 0,
              }
            : removedFromSeriesShotId
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
          const updated = buildUpdatedEntry(
            prev[f.id],
            f,
            patch,
            batchId,
            pairLabel,
            nowMs
          );
          if (updated) next[f.id] = updated;
          else delete next[f.id];
        }
        return next;
      });

      if (closeOpenSeries) {
        setActiveSeriesShotIds(new Set());
        setIsSeriesOpen(false);
        setIsEditingSeries(false);
        setIsSeriesMultiSelect(false);
        setSelectedSeriesMultiIds(new Set());
      } else if (removedFromSeriesShotId) {
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
              (deleteStateByShotId[s.id] || 'unrated') !== 'trash'
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
      isDeleteMode,
      deleteStateByShotId,
      displayedShot?.id,
      buildFullSeriesSkipSet,
      findNextAfterModeAction,
      isSeriesOpen,
      isEditingSeries,
      activeSeriesShotIds,
      activeComparisonIds,
      activeComparisonShots,
      triggerCardExitGhost,
      dragX,
    ]
  );

  // Batch series actions strictly scoped to active workflowMode:
  // - Výběr ('select'): marks positiveIds as selectState='selected', leaves unchecked siblings unrated (so autoDimmedShotIds grays them without condemning to trash!)
  // - Mazání ('delete'): marks positiveIds as deleteState='spared' (never 'selected'!), marks all other shots in targetShots as deleteState='trash'
  const resolveSeriesWithDecisions = useCallback(
    (
      targetShots: PhotoShotItem[],
      positiveIds: Set<string>,
      exitDir: 'left' | 'right',
      options: { preserveExistingSpared?: boolean; startX?: number } = {}
    ) => {
      if (!displayedShot || targetShots.length === 0) return;
      const { preserveExistingSpared = false, startX } = options;

      const targetShotIds =
        buildFullSeriesSkipSet(targetShots, displayedShot.id) ||
        new Set(targetShots.map((s) => s.id));
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
          const isPositive = positiveIds.has(s.id);
          const pairLabel = s.files.length > 1 ? s.formatSummary : undefined;

          let patch: {
            selectState?: SelectModeState;
            deleteState?: DeleteModeState;
          };
          if (isDeleteMode) {
            const alreadySpared =
              preserveExistingSpared && deleteStateByShotId[s.id] === 'spared';
            patch = {
              deleteState: isPositive || alreadySpared ? 'spared' : 'trash',
            };
          } else {
            patch = {
              selectState: isPositive ? 'selected' : 'unrated',
            };
          }

          for (const f of s.files) {
            const updated = buildUpdatedEntry(
              prev[f.id],
              f,
              patch,
              batchId,
              pairLabel,
              nowMs
            );
            if (updated) next[f.id] = updated;
            else delete next[f.id];
          }
        }
        return next;
      });

      const nextOutsideId = findNextAfterModeAction(
        displayedShot.id,
        targetShotIds
      );

      setActiveSeriesShotIds(new Set());
      setIsSeriesOpen(false);
      setIsEditingSeries(false);
      setIsSeriesMultiSelect(false);
      setSelectedSeriesMultiIds(new Set());
      if (nextOutsideId && nextOutsideId !== displayedShot.id) {
        setActiveShotId(nextOutsideId);
      }

      // Continuous subtle calibration reinforcement ONLY when user explicitly selects/keeps >=2 frames together in a series.
      // Never marks unselected siblings as 'different' because rejected frames in a burst are usually the same scene.
      if (positiveIds.size >= 2) {
        const positiveList = targetShots.filter((s) => positiveIds.has(s.id));
        const anchorShot = positiveList[0];
        const anchorFp = anchorShot
          ? fingerprintsRef.current[anchorShot.primary.id]
          : undefined;
        if (anchorShot && anchorFp) {
          const sameExamples: VisualCalibrationExample[] = [];
          for (let i = 1; i < positiveList.length && sameExamples.length < 3; i++) {
            const other = positiveList[i];
            const otherFp = fingerprintsRef.current[other.primary.id];
            if (!otherFp) continue;
            const metrics = computeVisualSimilarity(anchorFp, otherFp);
            if (!metrics.incompatible) {
              sameExamples.push({
                pairKey: `${anchorShot.primary.id}__${other.primary.id}`,
                idA: anchorShot.primary.id,
                idB: other.primary.id,
                label: 'same',
                metrics,
              });
            }
          }
          if (sameExamples.length > 0) {
            onAppendCalibrationFeedback(sameExamples, similaritySensitivity);
          }
        }
      }
    },
    [
      displayedShot,
      activeSeriesShotIds.size,
      ratingsMap,
      isSeriesOpen,
      isDeleteMode,
      deleteStateByShotId,
      buildFullSeriesSkipSet,
      findNextAfterModeAction,
      triggerCardExitGhost,
      onAppendCalibrationFeedback,
      similaritySensitivity,
    ]
  );

  const applySeriesBatchAction = useCallback(
    (action: 'keep-one' | 'reject-all' | 'skip-series', startX?: number) => {
      if (!displayedShot || activeComparisonShots.length === 0) return;
      if (action === 'reject-all') {
        if (!isDeleteMode) return;
        resolveSeriesWithDecisions(activeComparisonShots, new Set(), 'left', {
          startX,
        });
      } else if (action === 'skip-series') {
        if (isDeleteMode) return;
        const targetShotIds =
          buildFullSeriesSkipSet(activeComparisonShots, displayedShot.id) ||
          new Set(activeComparisonShots.map((s) => s.id));
        const targetShots = allOrderedShots.filter((s) =>
          targetShotIds.has(s.id)
        );
        const allTargetFiles: DrivePhotoFile[] = [];
        const prevSnapshot: Record<string, PersistedDecisionEntry | null> = {};
        for (const s of targetShots) {
          for (const f of s.files) {
            allTargetFiles.push(f);
            prevSnapshot[f.id] = ratingsMap[f.id] ?? null;
          }
        }

        triggerHaptic('selection', hapticSettingsRef.current);
        triggerCardExitGhost('left', startX);

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
            const pairLabel = s.files.length > 1 ? s.formatSummary : undefined;
            for (const f of s.files) {
              const updated = buildUpdatedEntry(
                prev[f.id],
                f,
                { selectState: 'dimmed' },
                batchId,
                pairLabel,
                nowMs
              );
              if (updated) next[f.id] = updated;
              else delete next[f.id];
            }
          }
          return next;
        });

        const nextOutsideId = findNextAfterModeAction(
          displayedShot.id,
          targetShotIds
        );
        setActiveSeriesShotIds(new Set());
        setIsSeriesOpen(false);
        setIsEditingSeries(false);
        setIsSeriesMultiSelect(false);
        setSelectedSeriesMultiIds(new Set());
        if (nextOutsideId && nextOutsideId !== displayedShot.id) {
          setActiveShotId(nextOutsideId);
        }
      } else {
        if (isDeleteMode) {
          resolveSeriesWithDecisions(
            activeComparisonShots,
            new Set([displayedShot.id]),
            'right',
            { preserveExistingSpared: !isSeriesOpen, startX }
          );
        } else {
          // In Výběr ('select'), selecting 1 shot in a series ONLY selects that shot; siblings automatically dim gray via autoDimmedShotIds!
          applyShotModePatch(
            displayedShot,
            { selectState: 'selected' },
            {
              advance: true,
              skipSeriesShots: activeComparisonShots,
              closeOpenSeries: true,
              swipeExit: 'right',
              startX,
            }
          );
        }
      }
    },
    [
      displayedShot,
      activeComparisonShots,
      allOrderedShots,
      isDeleteMode,
      isSeriesOpen,
      activeSeriesShotIds.size,
      ratingsMap,
      buildFullSeriesSkipSet,
      findNextAfterModeAction,
      triggerCardExitGhost,
      resolveSeriesWithDecisions,
      applyShotModePatch,
    ]
  );

  const handleToggleSeriesMultiSelectMode = useCallback(() => {
    triggerHaptic('selection', hapticSettingsRef.current);
    setIsEditingSeries(false);
    setIsSeriesMultiSelect((prev) => {
      const next = !prev;
      if (next) {
        const preSeeded = new Set<string>();
        for (const s of activeComparisonShots) {
          if (
            isDeleteMode
              ? deleteStateByShotId[s.id] === 'spared'
              : selectStateByShotId[s.id] === 'selected'
          ) {
            preSeeded.add(s.id);
          }
        }
        setSelectedSeriesMultiIds(preSeeded);
      } else {
        setSelectedSeriesMultiIds(new Set());
      }
      return next;
    });
  }, [
    activeComparisonShots,
    isDeleteMode,
    deleteStateByShotId,
    selectStateByShotId,
  ]);

  const handleEnterSeriesMultiSelectWithShot = useCallback(
    (shotId: string) => {
      triggerHaptic('selection', hapticSettingsRef.current);
      setIsEditingSeries(false);
      setIsSeriesMultiSelect(true);
      setSelectedSeriesMultiIds(() => {
        const preSeeded = new Set<string>();
        for (const s of activeComparisonShots) {
          if (
            isDeleteMode
              ? deleteStateByShotId[s.id] === 'spared'
              : selectStateByShotId[s.id] === 'selected'
          ) {
            preSeeded.add(s.id);
          }
        }
        preSeeded.add(shotId);
        return preSeeded;
      });
    },
    [
      activeComparisonShots,
      isDeleteMode,
      deleteStateByShotId,
      selectStateByShotId,
    ]
  );

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
    resolveSeriesWithDecisions(activeComparisonShots, validSelected, 'right');
  }, [
    activeComparisonShots,
    selectedSeriesMultiIds,
    resolveSeriesWithDecisions,
  ]);

  // Unified primary Left/Right actions strictly separated by workflowMode ('select' vs 'delete'):
  // - Výběr ('select'):
  //   * Right = select photo (selectState='selected'); if in a series, siblings automatically dim gray (never deleted!) and viewer steps past series.
  //   * Left = skip/dim photo (selectState='dimmed', never deleted!).
  // - Mazání ('delete'):
  //   * Right = spare photo (deleteState='spared', never selected!); if in a series, all other non-spared photos in that series are marked deleteState='trash' and viewer steps past series.
  //   * Left = mark photo for deletion (deleteState='trash').
  const handlePrimaryLeftAction = useCallback(
    (source: 'swipe' | 'tap', startX?: number) => {
      if (!displayedShot) return;

      if (isDeleteMode) {
        if (isSeriesOpen && activeComparisonShots.length >= 1) {
          applyShotModePatch(
            displayedShot,
            { deleteState: 'trash' },
            { advance: true, swipeExit: 'left', startX }
          );
          return;
        }
        const isAlreadyTrash =
          (deleteStateByShotId[displayedShot.id] || 'unrated') === 'trash';
        if (source === 'swipe' || !isAlreadyTrash) {
          applyShotModePatch(
            displayedShot,
            { deleteState: 'trash' },
            { advance: true, swipeExit: 'left', startX }
          );
        } else {
          applyShotModePatch(
            displayedShot,
            { deleteState: 'unrated' },
            { advance: false, swipeExit: null }
          );
        }
        return;
      }

      // Výběr ('select') mode: Left only dims/skips (never deletes!)
      const isAlreadyDimmed =
        (selectStateByShotId[displayedShot.id] || 'unrated') === 'dimmed';
      if (source === 'swipe' || isSeriesOpen || !isAlreadyDimmed) {
        applyShotModePatch(
          displayedShot,
          { selectState: 'dimmed' },
          { advance: true, swipeExit: 'left', startX }
        );
      } else {
        applyShotModePatch(
          displayedShot,
          { selectState: 'unrated' },
          { advance: false, swipeExit: null }
        );
      }
    },
    [
      displayedShot,
      isDeleteMode,
      isSeriesOpen,
      activeComparisonShots.length,
      deleteStateByShotId,
      selectStateByShotId,
      applyShotModePatch,
    ]
  );

  const handlePrimaryRightAction = useCallback(
    (source: 'swipe' | 'tap', startX?: number) => {
      if (!displayedShot) return;

      if (isDeleteMode) {
        // Mazání ('delete'): Right means "Nemazat" — inside ANY multi-photo series (open or auto-detected), spares this photo and marks the rest of that series for deletion!
        const seriesCandidates =
          isSeriesOpen && activeComparisonShots.length >= 2
            ? activeComparisonShots
            : (autoSeriesEnabled || activeBurstGroup?.isManual) &&
                activeBurstGroup &&
                activeBurstGroup.shots.length >= 2
              ? activeBurstGroup.shots
              : null;

        if (seriesCandidates && seriesCandidates.length >= 2) {
          resolveSeriesWithDecisions(
            seriesCandidates,
            new Set([displayedShot.id]),
            'right',
            { preserveExistingSpared: !isSeriesOpen, startX }
          );
          return;
        }

        const currDel = deleteStateByShotId[displayedShot.id] || 'unrated';
        if (source !== 'swipe' && !isSeriesOpen && currDel === 'spared') {
          applyShotModePatch(
            displayedShot,
            { deleteState: 'unrated' },
            { advance: false, swipeExit: null }
          );
          return;
        }

        applyShotModePatch(
          displayedShot,
          { deleteState: 'spared' },
          {
            advance: true,
            closeOpenSeries: isSeriesOpen,
            swipeExit: 'right',
            startX,
          }
        );
        return;
      }

      // Výběr ('select'): Right selects this photo; if in a series, siblings dim automatically via autoDimmedShotIds and viewer jumps past series!
      const currSel = selectStateByShotId[displayedShot.id] || 'unrated';
      const isAlreadySelected = currSel === 'selected';

      if (source !== 'swipe' && !isSeriesOpen && isAlreadySelected) {
        applyShotModePatch(
          displayedShot,
          { selectState: 'unrated' },
          { advance: false, swipeExit: null }
        );
        return;
      }

      const seriesToAdvancePast =
        isSeriesOpen && activeComparisonShots.length >= 1
          ? activeComparisonShots
          : (autoSeriesEnabled || activeBurstGroup?.isManual) &&
              activeBurstGroup &&
              activeBurstGroup.shots.length >= 2
            ? activeBurstGroup.shots
            : undefined;

      applyShotModePatch(
        displayedShot,
        { selectState: 'selected' },
        {
          advance: true,
          skipSeriesShots: seriesToAdvancePast,
          closeOpenSeries: isSeriesOpen,
          swipeExit: 'right',
          startX,
        }
      );
    },
    [
      displayedShot,
      isDeleteMode,
      isSeriesOpen,
      activeComparisonShots,
      autoSeriesEnabled,
      activeBurstGroup,
      deleteStateByShotId,
      selectStateByShotId,
      resolveSeriesWithDecisions,
      applyShotModePatch,
    ]
  );

  handlePrimaryLeftActionRef.current = handlePrimaryLeftAction;
  handlePrimaryRightActionRef.current = handlePrimaryRightAction;

  // Navigate chronologically or inside active comparison set WITHOUT changing ratings
  const stepShot = useCallback(
    (delta: number) => {
      if (!displayedShot) return;
      markInteractionActive(240);

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

      // Chronological navigation (in Mazání skips already-trashed shots; in Výběr steps across all shots)
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
        if (
          !isDeleteMode ||
          (deleteStateByShotId[candidate.id] || 'unrated') !== 'trash'
        ) {
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
      isDeleteMode,
      deleteStateByShotId,
      dragX,
    ]
  );

  // Filmstrip or ScrubStrip direct click/glide
  const handleSelectShotFromStrip = useCallback(
    (shotId: string) => {
      markInteractionActive(240);
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

  // Create a manual editable series starting with the currently focused standalone shot (used from Gallery)
  const handleCreateSeriesAroundCurrent = useCallback(() => {
    if (!displayedShot) return;
    triggerHaptic('selection', hapticSettingsRef.current);
    setGallerySeriesEnabled(true);
    setActiveSeriesShotIds(new Set([displayedShot.id]));
    setIsSeriesOpen(false);
    setIsSeriesMultiSelect(false);
    setSelectedSeriesMultiIds(new Set());
    setIsEditingSeries(true);
  }, [displayedShot]);

  // Continuous adaptive learning when user adds or removes a shot from a series
  const learnFromManualSeriesEdit = useCallback(
    async (
      anchorShot: PhotoShotItem | null | undefined,
      editedShots: PhotoShotItem[],
      label: 'same' | 'different'
    ) => {
      if (!anchorShot || editedShots.length === 0) return;
      const getOrComputeFp = async (
        shot: PhotoShotItem
      ): Promise<VisualFingerprint | null> => {
        const cached = fingerprintsRef.current[shot.primary.id];
        if (cached) return cached;
        const localUrl =
          sharpMediaMapRef.current[shot.primary.id]?.url ||
          tempPreviewMapRef.current[shot.primary.id];
        const fp = await computePhotoFingerprint(accessToken, shot.primary, {
          existingLocalUrl: localUrl,
        });
        if (fp && !studioUnmountedRef.current) {
          startTransition(() => {
            setFingerprintsMap((prev) =>
              prev[shot.primary.id] ? prev : { ...prev, [shot.primary.id]: fp }
            );
          });
        }
        return fp;
      };

      const anchorFp = await getOrComputeFp(anchorShot);
      if (!anchorFp || studioUnmountedRef.current) return;

      const pairsToLearn: VisualCalibrationExample[] = [];
      for (const other of editedShots.slice(0, 3)) {
        if (other.id === anchorShot.id || other.stem === anchorShot.stem) {
          continue;
        }
        const otherFp = await getOrComputeFp(other);
        if (!otherFp || studioUnmountedRef.current) continue;
        const metrics = computeVisualSimilarity(anchorFp, otherFp);
        if (metrics.incompatible) continue;
        pairsToLearn.push({
          pairKey: `${anchorShot.primary.id}__${other.primary.id}`,
          idA: anchorShot.primary.id,
          idB: other.primary.id,
          label,
          metrics,
        });
      }

      if (pairsToLearn.length > 0 && !studioUnmountedRef.current) {
        onAppendCalibrationFeedback(pairsToLearn, similaritySensitivity);
      }
    },
    [accessToken, onAppendCalibrationFeedback, similaritySensitivity]
  );

  // Toggle shots in or out of the editable active series, immediately locking it as an immutable ManualLockedSeries and learning calibration
  const handleToggleShotInSeries = useCallback(
    (shotId: string) => {
      triggerHaptic('selection', hapticSettingsRef.current);
      const base =
        activeSeriesShotIds.size > 0
          ? new Set(activeSeriesShotIds)
          : activeBurstGroup
            ? new Set(activeBurstGroup.shots.map((s) => s.id))
            : displayedShot
              ? new Set([displayedShot.id])
              : new Set<string>();

      const next = new Set(base);
      const wasInSeries = next.has(shotId);
      const addedShots: PhotoShotItem[] = [];
      const removedShots: PhotoShotItem[] = [];

      if (wasInSeries) {
        next.delete(shotId);
        const removed = shotsById.get(shotId);
        if (removed) removedShots.push(removed);
      } else {
        const neighborSeries = burstGroupByShotId.get(shotId);
        if (neighborSeries && neighborSeries.shots.length > 1) {
          let addedCount = 0;
          for (const member of neighborSeries.shots) {
            if (
              !isDeleteMode ||
              (deleteStateByShotId[member.id] || 'unrated') !== 'trash'
            ) {
              if (!next.has(member.id)) {
                next.add(member.id);
                addedShots.push(member);
              }
              addedCount++;
            }
          }
          if (addedCount === 0) {
            next.add(shotId);
            const single = shotsById.get(shotId);
            if (single) addedShots.push(single);
          }
        } else {
          next.add(shotId);
          const single = shotsById.get(shotId);
          if (single) addedShots.push(single);
        }
      }

      setActiveSeriesShotIds(next);
      if (next.size === 0) {
        setIsSeriesOpen(false);
        setIsEditingSeries(false);
        setIsSeriesMultiSelect(false);
        setSelectedSeriesMultiIds(new Set());
      }

      const orderedNextShots = allOrderedShots.filter((s) => next.has(s.id));
      const anchorShot =
        (displayedShot && next.has(displayedShot.id) ? displayedShot : null) ||
        orderedNextShots[0] ||
        displayedShot;

      // Persist immutable locked manual series whenever series is edited
      const touchSet = new Set<string>([...base, ...next]);
      const existingMatch = manualSeriesRef.current.find((ms) =>
        ms.shotIds.some((id) => touchSet.has(id))
      );
      const remainingManual = manualSeriesRef.current.filter(
        (ms) => !ms.shotIds.some((id) => touchSet.has(id))
      );
      const distinctStems = Array.from(
        new Set(orderedNextShots.map((s) => s.stem))
      );
      if (orderedNextShots.length >= 2 && distinctStems.length >= 2) {
        const lockedId =
          existingMatch?.id ||
          `manual-${orderedNextShots[0].id}-${Date.now()}`;
        commitManualSeries([
          ...remainingManual,
          {
            id: lockedId,
            shotIds: orderedNextShots.map((s) => s.id),
            stems: distinctStems,
            updatedAtMs: Date.now(),
          },
        ]);
      } else {
        commitManualSeries(remainingManual);
      }

      if (addedShots.length > 0 && anchorShot) {
        void learnFromManualSeriesEdit(anchorShot, addedShots, 'same');
      } else if (removedShots.length > 0 && anchorShot) {
        void learnFromManualSeriesEdit(anchorShot, removedShots, 'different');
      }
    },
    [
      activeSeriesShotIds,
      activeBurstGroup,
      displayedShot,
      shotsById,
      burstGroupByShotId,
      isDeleteMode,
      deleteStateByShotId,
      allOrderedShots,
      commitManualSeries,
      learnFromManualSeriesEdit,
    ]
  );

  const handleToggleEditingSeries = useCallback(() => {
    triggerHaptic('selection', hapticSettingsRef.current);
    setIsSeriesMultiSelect(false);
    setSelectedSeriesMultiIds(new Set());
    setIsEditingSeries((wasEditing) => {
      if (wasEditing) {
        setActiveSeriesShotIds((curr) =>
          curr.size <= 1 && !activeBurstGroup ? new Set() : curr
        );
        return false;
      }
      setActiveSeriesShotIds((prev) => {
        if (prev.size > 0) return prev;
        if (activeBurstGroup) {
          return new Set(activeBurstGroup.shots.map((s) => s.id));
        }
        return displayedShot ? new Set([displayedShot.id]) : prev;
      });
      return true;
    });
  }, [activeBurstGroup, displayedShot]);

  const handleOpenSeries = useCallback(() => {
    triggerHaptic('selection', hapticSettingsRef.current);
    const groupCandidate = activeBurstGroup || underlyingBurstGroup;
    const seedIds =
      activeSeriesShotIds.size > 0
        ? new Set(activeSeriesShotIds)
        : groupCandidate
          ? new Set(groupCandidate.shots.map((s) => s.id))
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
  }, [
    activeSeriesShotIds,
    activeBurstGroup,
    underlyingBurstGroup,
    displayedShot,
    allOrderedShots,
  ]);

  // Immediately reveal ONLY the currently displayed photo's already-detected series when filmstrip series is OFF
  const handleRevealSinglePhotoSeries = useCallback(() => {
    if (!displayedShot || !underlyingBurstGroup) return;
    if (underlyingBurstGroup.shots.length < 2) return;
    triggerHaptic('selection', hapticSettingsRef.current);
    const seedIds = new Set(underlyingBurstGroup.shots.map((s) => s.id));
    setActiveSeriesShotIds(seedIds);
    setIsEditingSeries(false);
    setIsSeriesMultiSelect(false);
    setSelectedSeriesMultiIds(new Set());
    setIsSeriesOpen(true);
    setStudioMode('detail');
  }, [displayedShot, underlyingBurstGroup]);

  // Second click on an already-centered thumbnail in the main bottom Filmstrip:
  // opens the series if part of a series, or directly selects/marks the standalone photo!
  const handleActivateCurrentShotFromFilmstrip = useCallback(
    (shotId: string) => {
      if (!displayedShot || displayedShot.id !== shotId) {
        handleSelectShotFromStrip(shotId);
        return;
      }
      if (
        activeComparisonShots.length >= 2 ||
        (activeBurstGroup && activeBurstGroup.shots.length >= 2)
      ) {
        handleOpenSeries();
        return;
      }
      if (isDeleteMode) {
        handlePrimaryLeftAction('tap');
      } else {
        handlePrimaryRightAction('tap');
      }
    },
    [
      displayedShot,
      handleSelectShotFromStrip,
      activeComparisonShots.length,
      activeBurstGroup,
      handleOpenSeries,
      isDeleteMode,
      handlePrimaryLeftAction,
      handlePrimaryRightAction,
    ]
  );

  const handleStepSeries = useCallback(
    (delta: -1 | 1) => {
      if (burstGroups.length === 0) return;
      const baseIdx = activeBurstSeriesIndex >= 0 ? activeBurstSeriesIndex : 0;
      const targetIdx = baseIdx + delta;
      if (targetIdx < 0 || targetIdx >= burstGroups.length) return;
      const targetGroup = burstGroups[targetIdx];
      const targetShots = isDeleteMode
        ? targetGroup.shots.filter(
            (s) => (deleteStateByShotId[s.id] || 'unrated') !== 'trash'
          )
        : targetGroup.shots;
      const resolvedShots = targetShots.length > 0 ? targetShots : targetGroup.shots;
      if (resolvedShots.length === 0) return;

      triggerHaptic('selection', hapticSettingsRef.current);
      setExitingSwipeCard(null);
      dragX.jump(0);
      setActiveSeriesShotIds(new Set(resolvedShots.map((s) => s.id)));
      setIsSeriesOpen(true);
      setIsEditingSeries(false);
      setIsSeriesMultiSelect(false);
      setSelectedSeriesMultiIds(new Set());
      setActiveShotId(resolvedShots[0].id);
    },
    [
      burstGroups,
      activeBurstSeriesIndex,
      isDeleteMode,
      deleteStateByShotId,
      dragX,
    ]
  );

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
      setGalleryOnlySeriesFilter(false);
    }
  }, []);

  const handleCancelScanAllSeries = useCallback(() => {
    if (fullScanAbortRef.current) {
      fullScanAbortRef.current.abort();
      fullScanAbortRef.current = null;
    }
    setIsScanningAllSeries(false);
    setSeriesScanProgress(null);
  }, []);

  // Full-folder scan in Gallery: scans ALL shots (EXIF timestamps + visual fingerprints) with live progress & cancel
  const handleScanAllSeriesInFolder = useCallback(async () => {
    if (isScanningAllSeries || allOrderedShots.length < 2) return;
    triggerHaptic('selection', hapticSettingsRef.current);
    setGallerySeriesEnabled(true);

    fullScanAbortRef.current?.abort();
    const controller = new AbortController();
    fullScanAbortRef.current = controller;
    setIsScanningAllSeries(true);

    const scanShots = [...allOrderedShots];
    const total = scanShots.length;
    setSeriesScanProgress({
      processed: 0,
      total,
      foundCount: burstGroups.length,
    });

    const fpSnapshot: Record<string, VisualFingerprint> = {
      ...fingerprintsRef.current,
    };
    const tsPatchedShots = [...scanShots];

    try {
      const BATCH_SIZE = 16;
      for (let start = 0; start < scanShots.length; start += BATCH_SIZE) {
        if (controller.signal.aborted || studioUnmountedRef.current) break;
        const batch = scanShots.slice(start, start + BATCH_SIZE);

        // 1) Read any missing EXIF capture times for the batch
        const missingTimeShots = batch.filter((s) => s.takenAtMs === null);
        if (missingTimeShots.length > 0 && onUpdatePhotoTimestamps) {
          const tsUpdates: Record<string, { ms: number; label: string }> = {};
          let tIdx = 0;
          const timeWorker = async () => {
            while (
              !controller.signal.aborted &&
              !studioUnmountedRef.current &&
              tIdx < missingTimeShots.length
            ) {
              const s = missingTimeShots[tIdx++];
              enrichedAttemptedIdsRef.current.add(s.primary.id);
              try {
                const parsed = await extractExifTimestampFromHeader(
                  accessToken,
                  s.primary
                );
                if (parsed) {
                  tsUpdates[s.primary.id] = parsed;
                }
              } catch {
                // Ignore header read error
              }
            }
          };
          await Promise.all(
            Array.from(
              { length: Math.min(4, missingTimeShots.length) },
              () => timeWorker()
            )
          );
          if (
            !controller.signal.aborted &&
            !studioUnmountedRef.current &&
            Object.keys(tsUpdates).length > 0
          ) {
            onUpdatePhotoTimestamps(tsUpdates);
            for (let k = start; k < Math.min(scanShots.length, start + BATCH_SIZE); k++) {
              const p = tsUpdates[tsPatchedShots[k].primary.id];
              if (p) {
                tsPatchedShots[k] = { ...tsPatchedShots[k], takenAtMs: p.ms };
              }
            }
          }
        }

        if (controller.signal.aborted || studioUnmountedRef.current) break;

        // 2) Compute perceptual visual fingerprints for the batch
        const missingFpShots = batch.filter(
          (s) => !fpSnapshot[s.primary.id]
        );
        if (missingFpShots.length > 0) {
          const fpUpdates: Record<string, VisualFingerprint> = {};
          let fIdx = 0;
          const fpWorker = async () => {
            while (
              !controller.signal.aborted &&
              !studioUnmountedRef.current &&
              fIdx < missingFpShots.length
            ) {
              const s = missingFpShots[fIdx++];
              const id = s.primary.id;
              if (fpSnapshot[id]) continue;
              attemptedFingerprintIdsRef.current.add(id);
              const existingLocalUrl =
                sharpMediaMapRef.current[id]?.url ||
                tempPreviewMapRef.current[id];
              const fp = await computePhotoFingerprint(accessToken, s.primary, {
                existingLocalUrl,
                signal: controller.signal,
              });
              if (fp) {
                fpSnapshot[id] = fp;
                fpUpdates[id] = fp;
              }
            }
          };
          await Promise.all(
            Array.from(
              { length: Math.min(5, missingFpShots.length) },
              () => fpWorker()
            )
          );
          if (
            !controller.signal.aborted &&
            !studioUnmountedRef.current &&
            Object.keys(fpUpdates).length > 0
          ) {
            startTransition(() => {
              setFingerprintsMap((prev) => ({ ...prev, ...fpUpdates }));
            });
          }
        }

        if (controller.signal.aborted || studioUnmountedRef.current) break;

        const currentMerged = mergeManualAndAutoSeries(
          tsPatchedShots,
          manualSeriesRef.current,
          groupShotsIntoSeries(tsPatchedShots, {
            maxGapMs: 3000,
            visualEnabled: true,
            fingerprints: fpSnapshot,
            sensitivity: similaritySensitivity,
            calibration: customCalibration,
          }),
          { includeAuto: true }
        );

        setSeriesScanProgress({
          processed: Math.min(total, start + batch.length),
          total,
          foundCount: currentMerged.length,
        });

        await new Promise((r) => window.setTimeout(r, 8));
      }
    } finally {
      if (fullScanAbortRef.current === controller) {
        fullScanAbortRef.current = null;
      }
      if (!studioUnmountedRef.current) {
        setIsScanningAllSeries(false);
        setSeriesScanProgress(null);
      }
    }
  }, [
    isScanningAllSeries,
    allOrderedShots,
    burstGroups.length,
    onUpdatePhotoTimestamps,
    accessToken,
    similaritySensitivity,
    customCalibration,
  ]);

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

  // Reset ONLY the active workflowMode ('select' or 'delete') without wiping the other mode!
  const handleResetFolderSession = useCallback(() => {
    clearLocalResumePosition(folder.id);
    currentResumeCursorRef.current = null;
    lastSavedResumeShotIdRef.current = null;
    setPendingResumeTarget(null);
    setResumeImageReady(false);
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

    const batchId = `reset-${Date.now()}`;
    const nowMs = Date.now();
    setRatingsMap((prev) => {
      const next: Record<string, PersistedDecisionEntry> = {};
      for (const [fileId, entry] of Object.entries(prev)) {
        const photo = photosById.get(fileId);
        const fileStub: DrivePhotoFile = photo || {
          id: fileId,
          name: entry.name,
          stem: getFileStem(entry.name),
          mimeType: 'image/jpeg',
          fileExtension: entry.ext,
          sizeBytes: entry.sizeBytes,
          isRaw: false,
          takenAtMs: null,
          takenAtLabel: undefined,
        };
        const updated = buildUpdatedEntry(
          entry,
          fileStub,
          isDeleteMode ? { deleteState: 'unrated' } : { selectState: 'unrated' },
          batchId,
          entry.pairedWith,
          nowMs
        );
        if (updated) {
          next[fileId] = updated;
        }
      }
      return next;
    });

    const firstShot = allOrderedShots[0];
    if (firstShot) {
      setActiveShotId(firstShot.id);
    }
  }, [folder.id, dragX, photosById, isDeleteMode, allOrderedShots]);

  const [resetScopeNotice, setResetScopeNotice] = useState<string | null>(null);
  const handlePartialResetScope = useCallback(
    (scope: PartialResetScope) => {
      triggerHaptic('undo', hapticSettingsRef.current);
      setUndoStack([]);
      setExitingSwipeCard(null);
      dragX.jump(0);

      if (scope === 'manual-series' || scope === 'everything') {
        commitManualSeries([]);
        setActiveSeriesShotIds(new Set());
        setIsSeriesOpen(false);
        setIsEditingSeries(false);
        setIsSeriesMultiSelect(false);
        setSelectedSeriesMultiIds(new Set());
      }

      if (scope === 'everything') {
        clearLocalResumePosition(folder.id);
        currentResumeCursorRef.current = null;
        lastSavedResumeShotIdRef.current = null;
        setPendingResumeTarget(null);
        setResumeImageReady(false);
        setIsZoomed(false);
        setShowExifPanel(false);
        const firstShot = allOrderedShots[0];
        if (firstShot) {
          setActiveShotId(firstShot.id);
        }
      }

      if (scope !== 'manual-series') {
        setRatingsMap((prev) => {
          const { nextEntries } = applyPartialResetToEntries(prev, scope);
          return nextEntries;
        });
      }

      const matchedOption = PARTIAL_RESET_OPTIONS.find((o) => o.scope === scope);
      setResetScopeNotice(
        matchedOption
          ? `Hotovo: ${matchedOption.label}`
          : 'Vybraná část postupu byla vyresetována.'
      );
      window.setTimeout(() => {
        setResetScopeNotice((curr) =>
          curr && matchedOption && curr.includes(matchedOption.label)
            ? null
            : curr
        );
      }, 3200);
    },
    [folder.id, dragX, commitManualSeries, allOrderedShots]
  );

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
      fullScanAbortRef.current?.abort();
      folderPreloadAbortRef.current?.abort();
    };
  }, []);

  // Whole-folder preview cache coverage check & explicit download/conversion controls
  const refreshFolderCacheCoverage = useCallback(async () => {
    if (allOrderedShotsRef.current.length === 0) {
      setFolderCacheCoverage(null);
      return;
    }
    const cov = await checkFolderPreviewCoverage(
      folder.id,
      allOrderedShotsRef.current
    );
    if (!studioUnmountedRef.current) {
      setFolderCacheCoverage(cov);
    }
  }, [folder.id]);

  useEffect(() => {
    folderPreloadAbortRef.current?.abort();
    folderPreloadAbortRef.current = null;
    setFolderPreloadProgress(null);
    setFolderCacheCoverage(null);
  }, [folder.id]);

  useEffect(() => {
    if (allOrderedShots.length === 0) return;
    const timer = window.setTimeout(() => {
      void refreshFolderCacheCoverage();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [folder.id, allOrderedShots.length, refreshFolderCacheCoverage]);

  const handleCancelFolderPreviewPreload = useCallback(() => {
    folderPreloadAbortRef.current?.abort();
  }, []);

  const handleStartFolderPreviewPreload = useCallback(async () => {
    if (allOrderedShotsRef.current.length === 0) return;
    if (
      folderPreloadProgress &&
      (folderPreloadProgress.status === 'running' ||
        folderPreloadProgress.status === 'paused-series')
    ) {
      return;
    }

    folderPreloadAbortRef.current?.abort();
    const controller = new AbortController();
    folderPreloadAbortRef.current = controller;

    try {
      const finalProgress = await preloadAndConvertFolderPreviews({
        folderId: folder.id,
        shots: allOrderedShotsRef.current,
        accessToken,
        culledFileIds: culledFileIdsRef.current,
        isFolderFullyCulled,
        signal: controller.signal,
        onProgress: (p) => {
          if (!studioUnmountedRef.current) {
            setFolderPreloadProgress(p);
          }
        },
      });
      if (!studioUnmountedRef.current) {
        setFolderPreloadProgress(finalProgress);
        void refreshFolderCacheCoverage();
      }
    } catch (err: unknown) {
      if (err instanceof AuthExpiredError) {
        onAuthExpired();
        return;
      }
      if (!studioUnmountedRef.current) {
        setFolderPreloadProgress((prev) =>
          prev
            ? {
                ...prev,
                status: 'error',
                errorMessage:
                  err instanceof Error
                    ? err.message
                    : 'Při přípravě náhledů došlo k chybě.',
              }
            : null
        );
      }
    } finally {
      if (folderPreloadAbortRef.current === controller) {
        folderPreloadAbortRef.current = null;
      }
    }
  }, [
    accessToken,
    folder.id,
    folderPreloadProgress,
    isFolderFullyCulled,
    onAuthExpired,
    refreshFolderCacheCoverage,
  ]);

  // Incrementally enrich EXIF timestamps for local/SD card photos outward from active photo (pauses when a series is open)
  useEffect(() => {
    if (
      isComparisonActive ||
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
        const batchSize = 10;
        while (!studioUnmountedRef.current && !activeBurstRef.current) {
          await waitForBackgroundSlot();
          if (studioUnmountedRef.current || activeBurstRef.current) break;

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
            await new Promise((r) => window.setTimeout(r, 60));
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
    isComparisonActive,
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
      const batchSize = 6;
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
  const displayedSelectState: SelectModeState = displayedShot
    ? selectStateByShotId[displayedShot.id] || 'unrated'
    : 'unrated';
  const displayedDeleteState: DeleteModeState = displayedShot
    ? deleteStateByShotId[displayedShot.id] || 'unrated'
    : 'unrated';
  const isDisplayedAutoDimmed = displayedShot
    ? autoDimmedShotIds.has(displayedShot.id)
    : false;

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
      (!isDeleteMode ||
        allOrderedShots
          .slice(0, activeShotIndex)
          .some((s) => (deleteStateByShotId[s.id] || 'unrated') !== 'trash'));

  const canStepNext = isComparisonActive
    ? comparisonIndex >= 0 &&
      comparisonIndex < activeComparisonShots.length - 1
    : activeShotIndex >= 0 &&
      (!isDeleteMode
        ? activeShotIndex < allOrderedShots.length - 1
        : allOrderedShots
            .slice(activeShotIndex + 1)
            .some(
              (s) => (deleteStateByShotId[s.id] || 'unrated') !== 'trash'
            ));

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
              isDeleteMode
                ? displayedDeleteState === 'trash'
                  ? 'border-rose-500/80 shadow-[0_0_24px_rgba(244,63,94,0.16)]'
                  : 'border-zinc-800'
                : displayedSelectState === 'selected'
                  ? 'border-amber-400/80 shadow-[0_0_24px_rgba(245,158,11,0.16)]'
                  : 'border-zinc-800'
            }`}
          >
            {/* Top Status Indicators */}
            {!isZoomed && (
              <div className="pointer-events-none absolute top-3.5 left-3.5 right-3.5 z-20 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {isDeleteMode ? (
                    displayedDeleteState === 'trash' && (
                      <span className="inline-flex items-center gap-1.5 rounded-lg bg-rose-500 px-2.5 py-1 text-xs font-bold text-white shadow-lg">
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>KE SMAZÁNÍ</span>
                      </span>
                    )
                  ) : displayedSelectState === 'selected' ? (
                    <span className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-2.5 py-1 text-xs font-bold text-zinc-950 shadow-lg">
                      <Star className="w-3.5 h-3.5 fill-zinc-950" />
                      <span>VYBRÁNO</span>
                    </span>
                  ) : displayedSelectState === 'dimmed' ? (
                    <span className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900/90 border border-zinc-700 px-2.5 py-1 text-xs font-semibold text-zinc-400 shadow-lg">
                      <X className="w-3.5 h-3.5" />
                      <span>PŘESKOČENO</span>
                    </span>
                  ) : isDisplayedAutoDimmed ? (
                    <span className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900/90 border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-400 shadow-lg">
                      <span>NEVYBRÁNO V SÉRII</span>
                    </span>
                  ) : null}
                </div>

                {(isSeriesOpen || isEditingSeries) &&
                  activeComparisonIds.size > 0 &&
                  displayedShot && (
                    <div className="pointer-events-auto flex items-center gap-1.5">
                      {isComparisonActive &&
                        seriesPreloadStatus &&
                        seriesPreloadStatus.ready <
                          seriesPreloadStatus.total && (
                          <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-black/80 px-2 py-1 font-mono text-[11px] font-medium text-amber-200 tabular-nums">
                            <span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-amber-400/35 border-t-amber-300 animate-spin" />
                            <span>
                              Kvalita série {seriesPreloadStatus.ready}/
                              {seriesPreloadStatus.total}
                            </span>
                          </span>
                        )}
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
                    isDeleteMode
                      ? 'border-zinc-400 bg-zinc-950/90 text-zinc-200'
                      : 'border-amber-400 bg-amber-950/90 text-amber-300'
                  }`}
                >
                  {isDeleteMode ? (
                    <Check className="w-5 h-5 text-zinc-200 stroke-[2.75]" />
                  ) : (
                    <Star className="w-5 h-5 fill-amber-400 text-amber-400" />
                  )}
                  <span className="font-display text-sm sm:text-base font-bold tracking-wide">
                    {isDeleteMode
                      ? isSeriesOpen && activeComparisonShots.length > 1
                        ? 'NEMAZAT (OSTATNÍ V SÉRII SMAZAT)'
                        : 'NEMAZAT'
                      : isSeriesOpen && activeComparisonShots.length > 1
                        ? 'VYBRAT ★ (OSTATNÍ ZEŠEDNOU)'
                        : 'VYBRAT ★'}
                  </span>
                </motion.div>

                <motion.div
                  style={{ opacity: rejectOpacity }}
                  className={`pointer-events-none absolute top-14 right-5 z-20 flex items-center gap-2 rounded-xl border-2 px-4 py-2 shadow-lg ${
                    isDeleteMode
                      ? 'border-rose-500 bg-rose-950/90 text-rose-200'
                      : 'border-zinc-500 bg-zinc-950/90 text-zinc-300'
                  }`}
                >
                  {isDeleteMode ? (
                    <Trash2 className="w-5 h-5 text-rose-400" />
                  ) : (
                    <X className="w-5 h-5" />
                  )}
                  <span className="font-display text-sm sm:text-base font-bold tracking-wide">
                    {isDeleteMode ? 'SMAZAT' : 'PŘESKOČIT'}
                  </span>
                </motion.div>
              </>
            )}

            {/* Photo Viewport (transform-based 1:1 anchor zoom + 1-finger pan + 2-finger pinch up to 6x) */}
            <div
              ref={zoomContainerRefCallback}
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
                    decoding="async"
                    onLoad={() => {
                      detailErrorRetryRef.current[displayedPhoto.id] = 0;
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
                      isDeleteMode && displayedDeleteState === 'trash'
                        ? 'opacity-45 grayscale'
                        : ''
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
                aria-label="Předchozí snímek"
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
                aria-label="Další snímek"
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
                        ? `${comparisonIndex + 1}/${activeComparisonShots.length}${
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
                  ? isDeleteMode
                    ? 'border-zinc-500/80'
                    : 'border-amber-400/75'
                  : isDeleteMode
                    ? 'border-rose-500/75'
                    : 'border-zinc-600/80'
              }`}
            >
              {exitingSwipeCard.url && (
                <img
                  src={exitingSwipeCard.url}
                  alt={exitingSwipeCard.name}
                  referrerPolicy="no-referrer"
                  draggable={false}
                  decoding="async"
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
    const isSelected = displayedSelectState === 'selected';
    const isDimmed = displayedSelectState === 'dimmed';
    const isTrashed = displayedDeleteState === 'trash';
    const isSpared = displayedDeleteState === 'spared';
    const seriesCount = activeComparisonShots.length;
    const inOpenSeries = isSeriesOpen && seriesCount >= 1;

    return (
      <div className="shrink-0 w-full flex items-center justify-between md:grid md:grid-cols-[1fr_auto_1fr] gap-1.5 sm:gap-2 min-h-[44px]">
        {/* Left: Direct Click Equivalent of Swipe LEFT */}
        <div className="flex items-center justify-start shrink-0">
          <button
            type="button"
            onClick={() => handlePrimaryLeftAction('tap')}
            aria-label={
              isDeleteMode
                ? inOpenSeries
                  ? 'Označit tento snímek ze série ke smazání (swipe doleva)'
                  : isTrashed
                    ? 'Zrušit označení ke smazání'
                    : 'Smazat tento snímek (swipe vlevo)'
                : inOpenSeries
                  ? 'Přeskočit tento snímek v sérii (zešedne, nesmaže se)'
                  : isDimmed
                    ? 'Zrušit zešednutí snímku'
                    : 'Přeskočit snímek bez výběru (swipe vlevo)'
            }
            title={
              isDeleteMode
                ? isTrashed
                  ? 'Zrušit označení ke smazání'
                  : 'Smazat tento snímek (swipe vlevo)'
                : isDimmed
                  ? 'Zrušit zešednutí'
                  : 'Přeskočit bez výběru — fotka jen zešedne, nesmaže se (swipe vlevo)'
            }
            className={`min-h-[44px] min-w-[44px] px-2.5 sm:px-3.5 inline-flex items-center justify-center gap-1.5 rounded-xl border text-xs sm:text-sm font-semibold transition-colors cursor-pointer ${
              isDeleteMode
                ? !inOpenSeries && isTrashed
                  ? 'border-rose-400 bg-rose-500 text-white hover:bg-rose-400'
                  : 'border-rose-500/50 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 hover:text-rose-200'
                : !inOpenSeries && isDimmed
                  ? 'border-zinc-600 bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                  : 'border-zinc-700/80 bg-[#141417] text-zinc-300 hover:border-zinc-600 hover:text-zinc-100 hover:bg-zinc-800/80'
            }`}
          >
            {isDeleteMode ? (
              <Trash2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            ) : (
              <X className="w-4 h-4 shrink-0" aria-hidden="true" />
            )}
            <span className="hidden sm:inline whitespace-nowrap">
              {isDeleteMode
                ? !inOpenSeries && isTrashed
                  ? 'Zrušit smazání'
                  : 'Smazat'
                : !inOpenSeries && isDimmed
                  ? 'Zrušit'
                  : 'Přeskočit'}
            </span>
          </button>
        </div>

        {/* Center: Step Prev + Undo + Zoom + EXIF + Step Next */}
        <div className="flex items-center justify-center gap-1 sm:gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => stepShot(-1)}
            disabled={!canStepPrev}
            title="Předchozí snímek"
            aria-label="Předchozí snímek"
            className="hidden md:inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            title="Krok zpět"
            aria-label="Krok zpět"
            className="min-h-[44px] min-w-[40px] sm:min-w-[44px] inline-flex items-center justify-center rounded-xl border border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={toggleCenterZoom}
            disabled={!currentDisplayUrl}
            title="Lupa 2,5×"
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
            title="Detaily snímku"
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
            title="Další snímek"
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
            onClick={() => handlePrimaryRightAction('tap')}
            aria-label={
              isDeleteMode
                ? inOpenSeries && seriesCount >= 2
                  ? `Nemazat tento 1 snímek a ostatních ${seriesCount - 1} v této sérii označit ke smazání`
                  : 'Nemazat tento snímek (neznamená vybrání do Liked)'
                : inOpenSeries && seriesCount >= 2
                  ? `Vybrat tento snímek ★ (ostatní v sérii jen zešednou, nesmažou se)`
                  : isSelected
                    ? 'Odebrat z výběru'
                    : 'Vybrat snímek do Liked (swipe vpravo)'
            }
            title={
              isDeleteMode
                ? inOpenSeries && seriesCount >= 2
                  ? `Nemazat tuto fotku — ostatních ${seriesCount - 1} v této sérii se označí ke smazání`
                  : 'Nemazat tuto fotku (nepřidává ji do výběru Liked)'
                : inOpenSeries && seriesCount >= 2
                  ? 'Vybrat tuto fotku ★ — ostatní v sérii jen zešednou, nesmažou se'
                  : 'Vybrat do Liked (swipe vpravo)'
            }
            className={`min-h-[44px] min-w-[44px] px-2.5 sm:px-3.5 inline-flex items-center justify-center gap-1.5 rounded-xl border text-xs sm:text-sm font-semibold transition-colors cursor-pointer ${
              isDeleteMode
                ? !inOpenSeries && isSpared
                  ? 'border-zinc-500 bg-zinc-800 text-zinc-100 hover:bg-zinc-700'
                  : 'border-zinc-700 bg-[#141417] text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800/90 hover:text-white'
                : !inOpenSeries && isSelected
                  ? 'border-amber-400 bg-amber-500 text-zinc-950 hover:bg-amber-400'
                  : 'border-amber-500/50 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 hover:text-amber-200'
            }`}
          >
            {isDeleteMode ? (
              <>
                {inOpenSeries && seriesCount >= 2 && (
                  <span className="font-mono text-[11px] font-bold leading-none tabular-nums">
                    1
                  </span>
                )}
                <Check className="w-4 h-4 stroke-[2.5] shrink-0" aria-hidden="true" />
                <span className="hidden sm:inline whitespace-nowrap">
                  {inOpenSeries && seriesCount >= 2 ? 'Nemazat 1' : 'Nemazat'}
                </span>
              </>
            ) : (
              <>
                <Star
                  className={`w-4 h-4 shrink-0 ${
                    !inOpenSeries && isSelected
                      ? 'fill-zinc-950'
                      : 'fill-amber-400/30'
                  }`}
                  aria-hidden="true"
                />
                <span className="hidden sm:inline whitespace-nowrap">
                  {inOpenSeries && seriesCount >= 2
                    ? 'Vybrat 1'
                    : isSelected
                      ? 'Vybráno'
                      : 'Vybrat'}
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
                {isDeleteMode ? (
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
                {folderPreloadProgress &&
                  (folderPreloadProgress.status === 'running' ||
                    folderPreloadProgress.status === 'paused-series') && (
                    <button
                      type="button"
                      onClick={() => setIsDrawerOpen(true)}
                      title="Zobrazit postup přípravy náhledů složky"
                      className="inline-flex items-center gap-1 text-amber-300 hover:text-amber-200 cursor-pointer whitespace-nowrap"
                    >
                      <span>
                        ·{' '}
                        {folderPreloadProgress.status === 'paused-series'
                          ? 'Náhledy pozastaveny'
                          : `Náhledy ${folderPreloadProgress.processed}/${folderPreloadProgress.total}`}
                      </span>
                    </button>
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
                (isDeleteMode
                  ? trashShotsList.length > 0
                  : pickedShotsList.length > 0)
                  ? 'border-zinc-700 bg-zinc-800/80 text-zinc-100'
                  : 'border-zinc-800 bg-[#141417] text-zinc-300'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Filtry</span>
            </button>

            {isDeleteMode ? (
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
          {/* Non-interactive Workspace Indicator (strictly separated Výběr vs Mazání — no switcher inside studio) */}
          <span
            className={`min-h-[32px] lg:min-h-[38px] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] sm:text-xs font-semibold whitespace-nowrap shrink-0 select-none ${
              isDeleteMode
                ? 'border-rose-500/40 bg-rose-500/12 text-rose-300'
                : 'border-amber-500/40 bg-amber-500/12 text-amber-300'
            }`}
          >
            {isDeleteMode ? (
              <>
                <Trash2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Mazání</span>
              </>
            ) : (
              <>
                <Star
                  className="w-3.5 h-3.5 fill-amber-400/35 shrink-0"
                  aria-hidden="true"
                />
                <span>Výběr</span>
              </>
            )}
          </span>

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
                title="Detailní porovnání a lišta"
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
                title="Celá galerie složky s úrovněmi přiblížení"
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
            (!isSeriesOpen || studioMode === 'gallery') ? (
              <button
                type="button"
                onClick={handleOpenSeries}
                className="min-h-[32px] lg:min-h-[38px] inline-flex items-center gap-1.5 px-2 sm:px-3 py-1 text-[11px] sm:text-xs font-medium rounded-lg border border-amber-500/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums"
              >
                <Layers className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Otevřít ({activeComparisonShots.length})</span>
              </button>
            ) : !autoSeriesEnabled &&
              !isSeriesOpen &&
              studioMode === 'detail' &&
              underlyingBurstGroup &&
              underlyingBurstGroup.shots.length >= 2 ? (
              <button
                type="button"
                onClick={handleRevealSinglePhotoSeries}
                title="Okamžitě ukáže již nalezenou sérii pouze u této fotky"
                className="min-h-[32px] lg:min-h-[38px] inline-flex items-center gap-1.5 px-2 sm:px-3 py-1 text-[11px] sm:text-xs font-medium rounded-lg border border-amber-500/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums"
              >
                <Layers className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Zobrazit sérii ({underlyingBurstGroup.shots.length})</span>
              </button>
            ) : null}

            {(isSeriesOpen || activeSeriesShotIds.size > 0) && (
              <button
                type="button"
                onClick={handleCloseSeries}
                title="Ukončit nebo zrušit výběr"
                className={`min-h-[32px] lg:min-h-[38px] inline-flex items-center gap-1 px-2 sm:px-3 py-1 text-[11px] sm:text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                  isSeriesOpen && studioMode === 'detail'
                    ? 'border-amber-400 bg-amber-500 text-zinc-950 font-semibold hover:bg-amber-400'
                    : 'border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700'
                }`}
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{isSeriesOpen ? 'Ukončit' : 'Zrušit'}</span>
                {isSeriesOpen && studioMode === 'detail' && (
                  <span>({activeComparisonShots.length})</span>
                )}
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
                (isDeleteMode
                  ? trashShotsList.length > 0
                  : pickedShotsList.length > 0)
                  ? 'border-zinc-700 bg-zinc-800/80 text-zinc-100 hover:border-zinc-600'
                  : 'border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Filtry</span>
            </button>

            {isDeleteMode ? (
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
                  workflowMode={workflowMode}
                  folderId={folder.id}
                  shots={allOrderedShots}
                  activeShotId={displayedShot.id}
                  selectStateByShotId={selectStateByShotId}
                  deleteStateByShotId={deleteStateByShotId}
                  autoDimmedShotIds={autoDimmedShotIds}
                  burstGroupByShotId={burstGroupByShotId}
                  seriesEnabled={gallerySeriesEnabled}
                  onlySeriesFilter={galleryOnlySeriesFilter}
                  isScanningAllSeries={isScanningAllSeries}
                  seriesScanProgress={seriesScanProgress}
                  activeComparisonIds={activeComparisonIds}
                  isEditingSeries={isEditingSeries}
                  isFolderFullyCulled={isFolderFullyCulled}
                  zoomLevel={galleryZoomLevel}
                  accessToken={accessToken}
                  tempPreviewMap={tempPreviewMap}
                  sharpMediaMap={sharpMediaMap}
                  microThumbsMap={microThumbsMap}
                  onChangeZoomLevel={setGalleryZoomLevel}
                  onToggleSeriesEnabled={handleToggleGallerySeriesEnabled}
                  onToggleOnlySeriesFilter={setGalleryOnlySeriesFilter}
                  onScanAllSeries={() => void handleScanAllSeriesInFolder()}
                  onCancelScanAllSeries={handleCancelScanAllSeries}
                  onSelectShot={handleSelectShotFromStrip}
                  onOpenShotDetail={handleOpenShotFromGallery}
                  onToggleShotInSeries={handleToggleShotInSeries}
                  onToggleEditingSeries={handleToggleEditingSeries}
                  onOpenSeries={handleOpenSeries}
                  onCreateSeries={handleCreateSeriesAroundCurrent}
                  folderPreloadProgress={folderPreloadProgress}
                  folderCacheCoverage={folderCacheCoverage}
                  onStartFolderPreviewPreload={() =>
                    void handleStartFolderPreviewPreload()
                  }
                  onCancelFolderPreviewPreload={
                    handleCancelFolderPreviewPreload
                  }
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
                      workflowMode={workflowMode}
                      allOrderedShots={allOrderedShots}
                      seriesShotIds={activeComparisonIds}
                      burstGroupByShotId={burstGroupByShotId}
                      activeShotId={displayedShot.id}
                      selectStateByShotId={selectStateByShotId}
                      deleteStateByShotId={deleteStateByShotId}
                      autoDimmedShotIds={autoDimmedShotIds}
                      isEditingSeries={isEditingSeries}
                      isMultiSelectMode={isSeriesMultiSelect}
                      isLockedManual={Boolean(
                        activeBurstGroup?.isManual ||
                          (activeBurstSeriesIndex >= 0 &&
                            burstGroups[activeBurstSeriesIndex]?.isManual)
                      )}
                      seriesPositionLabel={
                        activeBurstSeriesIndex >= 0
                          ? `${activeBurstSeriesIndex + 1}/${burstGroups.length}`
                          : undefined
                      }
                      hasPrevSeries={activeBurstSeriesIndex > 0}
                      hasNextSeries={
                        activeBurstSeriesIndex >= 0 &&
                        activeBurstSeriesIndex < burstGroups.length - 1
                      }
                      selectedMultiIds={selectedSeriesMultiIds}
                      accessToken={accessToken}
                      tempPreviewMap={tempPreviewMap}
                      sharpMediaMap={sharpMediaMap}
                      onSelectShot={handleSelectShotFromStrip}
                      onToggleShotInSeries={handleToggleShotInSeries}
                      onToggleEditingSeries={handleToggleEditingSeries}
                      onToggleMultiSelectMode={handleToggleSeriesMultiSelectMode}
                      onEnterMultiSelectWithShot={
                        handleEnterSeriesMultiSelectWithShot
                      }
                      onToggleMultiSelectShot={handleToggleMultiSelectShot}
                      onConfirmMultiSelect={handleConfirmSeriesMultiSelect}
                      onSkipEntireSeries={() =>
                        applySeriesBatchAction('skip-series')
                      }
                      onDeleteEntireSeries={() =>
                        applySeriesBatchAction('reject-all')
                      }
                      onPrevSeries={() => handleStepSeries(-1)}
                      onNextSeries={() => handleStepSeries(1)}
                      onCloseSeries={handleCloseSeries}
                    />
                  ) : (
                    <Filmstrip
                      workflowMode={workflowMode}
                      folderId={folder.id}
                      shots={allOrderedShots}
                      activeShotId={displayedShot.id}
                      selectStateByShotId={selectStateByShotId}
                      deleteStateByShotId={deleteStateByShotId}
                      autoDimmedShotIds={autoDimmedShotIds}
                      burstGroupByShotId={burstGroupByShotId}
                      seriesEnabled={autoSeriesEnabled}
                      activeComparisonIds={activeComparisonIds}
                      isEditingSeries={isEditingSeries}
                      isFolderFullyCulled={isFolderFullyCulled}
                      resumeLeftContextCount={8}
                      accessToken={accessToken}
                      tempPreviewMap={tempPreviewMap}
                      sharpMediaMap={sharpMediaMap}
                      microThumbsMap={microThumbsMap}
                      singlePhotoSeriesCount={
                        !autoSeriesEnabled &&
                        !isSeriesOpen &&
                        underlyingBurstGroup &&
                        underlyingBurstGroup.shots.length >= 2
                          ? underlyingBurstGroup.shots.length
                          : 0
                      }
                      onRevealSinglePhotoSeries={handleRevealSinglePhotoSeries}
                      onSelectShot={handleSelectShotFromStrip}
                      onActivateCurrentShot={
                        handleActivateCurrentShotFromFilmstrip
                      }
                      onToggleShotInSeries={handleToggleShotInSeries}
                      onToggleEditingSeries={handleToggleEditingSeries}
                      onOpenSeries={handleOpenSeries}
                      onSkipEntireSeries={() =>
                        applySeriesBatchAction('skip-series')
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
            aria-label="Nastavení a výběr"
            className="relative z-10 w-full sm:max-w-md h-full bg-[#141417] border-l border-zinc-800 flex flex-col overflow-hidden shadow-2xl"
          >
            <div className="shrink-0 px-5 py-4 border-b border-zinc-800 flex items-center justify-between gap-3">
              <h2 className="font-display text-base font-semibold text-zinc-100">
                Nastavení a výběr
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
                    {isDeleteMode ? 'Stav mazání' : 'Stav výběru'}
                  </h3>
                  {(isDeleteMode
                    ? trashShotsList.length > 0 || sparedCount > 0
                    : pickedShotsList.length > 0 || dimmedCount > 0) && (
                    <button
                      type="button"
                      onClick={() => {
                        setIsDrawerOpen(false);
                        void handleResetFolderSession();
                      }}
                      className={`text-xs font-medium text-zinc-400 transition-colors cursor-pointer ${
                        isDeleteMode
                          ? 'hover:text-rose-300'
                          : 'hover:text-amber-300'
                      }`}
                      title={
                        isDeleteMode
                          ? 'Vymazat označení ke smazání pro tuto složku'
                          : 'Vymazat výběr pro tuto složku a začít znovu'
                      }
                    >
                      {isDeleteMode ? 'Resetovat mazání' : 'Resetovat výběr'}
                    </button>
                  )}
                </div>
                {isDeleteMode ? (
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-[#09090B] border border-zinc-800/80 p-2.5">
                      <p className="font-mono text-lg font-semibold text-zinc-100 tabular-nums">
                        {unratedDeleteCount.toLocaleString('cs-CZ')}
                      </p>
                      <p className="text-[11px] text-zinc-500">Nehodnoceno</p>
                    </div>
                    <div className="rounded-lg bg-[#09090B] border border-zinc-700/80 p-2.5">
                      <p className="font-mono text-lg font-semibold text-zinc-200 tabular-nums">
                        {sparedCount.toLocaleString('cs-CZ')}
                      </p>
                      <p className="text-[11px] text-zinc-400">Nemazat</p>
                    </div>
                    <div className="rounded-lg bg-[#09090B] border border-rose-500/40 p-2.5">
                      <p className="font-mono text-lg font-semibold text-rose-400 tabular-nums">
                        {trashShotsList.length.toLocaleString('cs-CZ')}
                      </p>
                      <p className="text-[11px] text-rose-200/80">Ke smazání</p>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-[#09090B] border border-zinc-800/80 p-2.5">
                      <p className="font-mono text-lg font-semibold text-zinc-100 tabular-nums">
                        {Math.max(
                          0,
                          unratedSelectCount - autoDimmedShotIds.size
                        ).toLocaleString('cs-CZ')}
                      </p>
                      <p className="text-[11px] text-zinc-500">Nehodnoceno</p>
                    </div>
                    <div className="rounded-lg bg-[#09090B] border border-amber-500/30 p-2.5">
                      <p className="font-mono text-lg font-semibold text-amber-400 tabular-nums">
                        {pickedShotsList.length.toLocaleString('cs-CZ')}
                      </p>
                      <p className="text-[11px] text-zinc-400">Vybráno ★</p>
                    </div>
                    <div className="rounded-lg bg-[#09090B] border border-zinc-800/80 p-2.5">
                      <p className="font-mono text-lg font-semibold text-zinc-400 tabular-nums">
                        {(dimmedCount + autoDimmedShotIds.size).toLocaleString(
                          'cs-CZ'
                        )}
                      </p>
                      <p className="text-[11px] text-zinc-500">Zešedlé</p>
                    </div>
                  </div>
                )}

                {/* Granular Progress Reset Section in Studio Filtry Drawer */}
                <div className="mt-4 pt-4 border-t border-zinc-800/80 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                      Částečný reset postupu
                    </p>
                    {resetScopeNotice && (
                      <span className="text-[11px] font-medium text-emerald-400 truncate">
                        {resetScopeNotice}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-1.5">
                    {PARTIAL_RESET_OPTIONS.map((opt) => {
                      const isDestructive =
                        opt.scope === 'everything' ||
                        opt.scope === 'all-select' ||
                        opt.scope === 'all-delete';
                      return (
                        <button
                          key={opt.scope}
                          type="button"
                          onClick={() => handlePartialResetScope(opt.scope)}
                          title={opt.description}
                          className={`w-full min-h-[38px] px-3 py-2 rounded-xl border text-left transition-colors cursor-pointer flex items-center justify-between gap-2 ${
                            isDestructive
                              ? 'border-rose-500/35 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 hover:border-rose-500/60'
                              : 'border-zinc-800 bg-[#09090B] text-zinc-200 hover:border-zinc-600 hover:text-white'
                          }`}
                        >
                          <div className="min-w-0">
                            <p className="text-xs font-semibold truncate">
                              {opt.label}
                            </p>
                            <p className="text-[10px] text-zinc-400 truncate">
                              {opt.description}
                            </p>
                          </div>
                          <RotateCcw
                            className={`w-3.5 h-3.5 shrink-0 ${
                              isDestructive ? 'text-rose-300' : 'text-zinc-400'
                            }`}
                            aria-hidden="true"
                          />
                        </button>
                      );
                    })}
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

              {/* Whole-Folder Preview Download & Conversion */}
              <div className="border-t border-zinc-800/80 pt-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                    Náhledy složky (plynulý chod)
                  </h3>
                  {folderCacheCoverage && folderCacheCoverage.total > 0 && (
                    <span className="font-mono text-[11px] text-zinc-400 tabular-nums">
                      {folderCacheCoverage.detailCached.toLocaleString('cs-CZ')}{' '}
                      / {folderCacheCoverage.total.toLocaleString('cs-CZ')}
                    </span>
                  )}
                </div>

                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  Stáhne a převede náhledy pro celou složku do úložiště
                  prohlížeče, aniž by zatěžovala RAM. Prohlížení a přepínání
                  velkých složek je pak výrazně plynulejší.
                </p>

                {folderPreloadProgress &&
                  (folderPreloadProgress.status === 'running' ||
                    folderPreloadProgress.status === 'paused-series') && (
                    <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-amber-200 truncate">
                          {folderPreloadProgress.status === 'paused-series'
                            ? 'Pozastaveno (otevřená série)'
                            : 'Stahuji a převádím náhledy…'}
                        </span>
                        <span className="font-mono text-[11px] text-amber-200 tabular-nums shrink-0">
                          {folderPreloadProgress.processed.toLocaleString(
                            'cs-CZ'
                          )}{' '}
                          / {folderPreloadProgress.total.toLocaleString('cs-CZ')}
                        </span>
                      </div>

                      <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
                        <div
                          className="h-full bg-amber-400 transition-all duration-150"
                          style={{
                            width: `${
                              folderPreloadProgress.total > 0
                                ? Math.min(
                                    100,
                                    Math.round(
                                      (folderPreloadProgress.processed /
                                        folderPreloadProgress.total) *
                                        100
                                    )
                                  )
                                : 0
                            }%`,
                          }}
                        />
                      </div>

                      <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-zinc-400 tabular-nums">
                        <span className="truncate">
                          {folderPreloadProgress.currentFileName ||
                            'Připravuji…'}
                        </span>
                        <span className="shrink-0">
                          {folderPreloadProgress.converted > 0
                            ? `Převedeno ${folderPreloadProgress.converted}`
                            : ''}
                          {folderPreloadProgress.skipped > 0
                            ? `${folderPreloadProgress.converted > 0 ? ' · ' : ''}Uloženo ${folderPreloadProgress.skipped}`
                            : ''}
                          {folderPreloadProgress.bytesStored > 0
                            ? ` · ${formatBytes(folderPreloadProgress.bytesStored)}`
                            : ''}
                        </span>
                      </div>
                    </div>
                  )}

                {folderPreloadProgress &&
                  folderPreloadProgress.status === 'completed' && (
                    <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span className="tabular-nums">
                        Hotovo: {folderPreloadProgress.converted} převedeno,{' '}
                        {folderPreloadProgress.skipped} již připraveno
                        {folderPreloadProgress.failed > 0
                          ? `, ${folderPreloadProgress.failed} přeskočeno`
                          : ''}
                        .
                      </span>
                    </div>
                  )}

                {folderPreloadProgress &&
                  folderPreloadProgress.status === 'cancelled' && (
                    <p className="text-[11px] text-zinc-400 tabular-nums">
                      Zastaveno po {folderPreloadProgress.processed} z{' '}
                      {folderPreloadProgress.total} snímků — hotové náhledy
                      zůstaly uložené.
                    </p>
                  )}

                {folderPreloadProgress &&
                  folderPreloadProgress.status === 'error' && (
                    <p className="text-[11px] text-rose-300">
                      {folderPreloadProgress.errorMessage ||
                        'Při přípravě náhledů došlo k chybě.'}
                    </p>
                  )}

                {folderPreloadProgress &&
                (folderPreloadProgress.status === 'running' ||
                  folderPreloadProgress.status === 'paused-series') ? (
                  <button
                    type="button"
                    onClick={handleCancelFolderPreviewPreload}
                    className="w-full min-h-[42px] inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl border border-rose-500/50 bg-rose-500/15 text-xs font-semibold text-rose-200 hover:bg-rose-500/25 transition-colors cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5 fill-rose-300 text-rose-300 shrink-0" />
                    <span>Zastavit přípravu náhledů</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleStartFolderPreviewPreload()}
                    disabled={allOrderedShots.length === 0}
                    className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-xl border border-amber-500/55 bg-amber-500/15 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    <Download className="w-4 h-4 shrink-0" />
                    <span>
                      {folderCacheCoverage &&
                      folderCacheCoverage.total > 0 &&
                      folderCacheCoverage.detailCached >=
                        folderCacheCoverage.total
                        ? 'Znovu zkontrolovat náhledy složky'
                        : folderCacheCoverage &&
                            folderCacheCoverage.detailCached > 0
                          ? `Připravit zbývající náhledy (${Math.max(0, folderCacheCoverage.total - folderCacheCoverage.detailCached)})`
                          : 'Stáhnout a převést náhledy celé složky'}
                    </span>
                  </button>
                )}
              </div>

              {/* Behavior Toggles */}
              <div className="border-t border-zinc-800/80 pt-5 space-y-3">
                <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                  Série &amp; nastavení
                </h3>

                <button
                  type="button"
                  onClick={() => {
                    const next = !autoSeriesEnabled;
                    onToggleFilmstripSeriesEnabled(next);
                    if (!next) {
                      setActiveSeriesShotIds(new Set());
                      setIsSeriesOpen(false);
                      setIsEditingSeries(false);
                    }
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
                    <span>Automatické série v liště</span>
                  </span>
                  <span className="font-mono text-[11px]">
                    {autoSeriesEnabled ? 'Zapnuto' : 'Vypnuto'}
                  </span>
                </button>

                {!autoSeriesEnabled && (
                  <p className="text-[11px] text-zinc-400 leading-relaxed px-1">
                    Lišta je načtena rovně bez automatických sérií — ruční série
                    můžete kdykoliv vytvořit v Galerii tlačítkem Vytvořit sérii a
                    zůstanou vždy pohromadě.
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
                          ? allOrderedShots.length > 0
                            ? `${analyzedVisualCount}/${allOrderedShots.length}`
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
                                onClick={() =>
                                  onUpdateGlobalCalibration({
                                    calibration: null,
                                    examples: [],
                                  })
                                }
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
                              onClick={() =>
                                onUpdateGlobalCalibration({
                                  baseSensitivity: 'strict',
                                  calibration: null,
                                })
                              }
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
                              onClick={() =>
                                onUpdateGlobalCalibration({
                                  baseSensitivity: 'balanced',
                                  calibration: null,
                                })
                              }
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
                              onClick={() =>
                                onUpdateGlobalCalibration({
                                  baseSensitivity: 'loose',
                                  calibration: null,
                                })
                              }
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
                          disabled={allOrderedShots.length < 2}
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
                      Toto zařízení nepodporuje vibrace.
                    </p>
                  )}
                </div>
              </div>

              {/* Active Mode Queue List: Picked/Liked (Výběr) or Trash Queue (Mazání) */}
              {isDeleteMode ? (
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
                                  const batchId = `${Date.now()}-untrash`;
                                  setRatingsMap((prev) => {
                                    const next = { ...prev };
                                    const targets = pairSelectEnabled
                                      ? activePhotos.filter(
                                          (p) => p.stem === file.stem
                                        )
                                      : [file];
                                    for (const p of targets) {
                                      const updated = buildUpdatedEntry(
                                        prev[p.id],
                                        p,
                                        { deleteState: 'unrated' },
                                        batchId
                                      );
                                      if (updated) next[p.id] = updated;
                                      else delete next[p.id];
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
                      výběru (ostatní fotky v sérii jen zešednou, nesmažou se).
                      Na konci je zkopírujete nebo přesunete do podsložky „
                      {LIKED_SUBFOLDER_NAME}“.
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
                                  const batchId = `${Date.now()}-unpick`;
                                  setRatingsMap((prev) => {
                                    const next = { ...prev };
                                    const targets = pairSelectEnabled
                                      ? activePhotos.filter(
                                          (p) => p.stem === file.stem
                                        )
                                      : [file];
                                    for (const p of targets) {
                                      const updated = buildUpdatedEntry(
                                        prev[p.id],
                                        p,
                                        { selectState: 'unrated' },
                                        batchId
                                      );
                                      if (updated) next[p.id] = updated;
                                      else delete next[p.id];
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

            </div>
          </aside>
        </div>
      )}

      <SeriesCalibrationModal
        isOpen={isCalibrationOpen}
        shots={allOrderedShots}
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
          onUpdateGlobalCalibration({
            calibration: cal,
            examples,
          });
        }}
        onResetCalibration={() => {
          onUpdateGlobalCalibration({
            calibration: null,
            examples: [],
          });
        }}
        onClose={() => setIsCalibrationOpen(false)}
      />
    </section>
  );
};

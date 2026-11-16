import { useEffect, useState, useCallback, useRef } from 'react';
import { HardDrive, Star, Trash2 } from 'lucide-react';
import {
  AppAuthUser,
  clearAccessToken,
  getRememberedGoogleEmail,
  googleSignIn,
  initAuth,
  logout,
  trySilentNativeDriveRefresh,
} from './lib/auth';
import {
  AuthExpiredError,
  DriveFolder,
  DrivePhotoFile,
  getFileStem,
  streamPhotosInFolder,
} from './lib/driveApi';
import { clearMediaCache } from './lib/rawParser';
import { LocalStreamStarter } from './lib/localMedia';
import { ManualLockedSeries } from './lib/burstGrouping';
import {
  GlobalCalibrationState,
  appendContinuousCalibrationFeedback,
  readFilmstripSeriesEnabled,
  readGlobalCalibrationState,
  writeFilmstripSeriesEnabled,
  writeGlobalCalibrationState,
} from './lib/appSettings';
import {
  CustomVisualCalibration,
  SimilaritySensitivity,
  VisualCalibrationExample,
} from './lib/visualSimilarity';
import {
  loadLocalFolderSession,
  loadLocalManualSeries,
  pickNewerResumeTarget,
  readLocalResumePosition,
  saveLocalManualSeries,
} from './lib/localPersistence';
import {
  FolderResumeTarget,
  PersistedDecisionEntry,
  PersistedFolderSummary,
  ShardEntriesMap,
  WorkflowMode,
  loadAllFolderSummaries,
  loadFolderDecisions,
  loadFolderManualSeries,
  loadGlobalCalibrationPreference,
  saveFolderManualSeries,
  saveGlobalCalibrationPreference,
  testFirestoreConnection,
} from './lib/cullPersistence';
import { isCapacitorNativeApp } from './lib/androidNativeBridge';
import {
  UpdateCheckResult,
  checkForAppUpdate,
  getConfiguredGitHubRepo,
} from './lib/appUpdater';
import { AppView, Header } from './components/Header';
import { MobileBottomNav } from './components/MobileBottomNav';
import { PhoneStorageHub } from './components/PhoneStorageHub';
import { LocalSourcePicker } from './components/LocalSourcePicker';
import { FolderBrowser } from './components/FolderBrowser';
import { AppMenuView } from './components/AppMenuView';
import { SwipeStudio } from './components/SwipeStudio';
import {
  FinishSelectionModal,
  LikedTransferMode,
} from './components/FinishSelectionModal';
import {
  FinishTrashModal,
  TrashExecutionMode,
} from './components/FinishTrashModal';
import { OfflineIndicator } from './components/OfflineIndicator';

export default function App() {
  const [authResolved, setAuthResolved] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(true);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [user, setUser] = useState<AppAuthUser | null>(null);
  const [rememberedEmail, setRememberedEmail] = useState<string | null>(() =>
    getRememberedGoogleEmail()
  );
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [latestUpdateCheck, setLatestUpdateCheck] =
    useState<UpdateCheckResult | null>(null);

  const [view, setView] = useState<AppView>('phone');
  const lastHubViewRef = useRef<'phone' | 'drive'>('phone');

  const [activeFolder, setActiveFolder] = useState<DriveFolder | null>(null);
  const [folderPhotos, setFolderPhotos] = useState<DrivePhotoFile[]>([]);
  const [isLoadingPhotos, setIsLoadingPhotos] = useState(false);
  const [isLoadingMorePhotos, setIsLoadingMorePhotos] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [loadingFolderId, setLoadingFolderId] = useState<string | null>(null);
  const [folderLoadError, setFolderLoadError] = useState<string | null>(null);

  const [movedOutIds, setMovedOutIds] = useState<Set<string>>(new Set());
  const [lastActionSummary, setLastActionSummary] = useState<string | null>(
    null
  );

  // Cloud-persisted folder progress summaries & active folder decisions
  const [folderSummaries, setFolderSummaries] = useState<
    Record<string, PersistedFolderSummary>
  >({});
  const [activeFolderDecisions, setActiveFolderDecisions] = useState<
    Record<string, PersistedDecisionEntry>
  >({});
  const [activeFolderShardMap, setActiveFolderShardMap] =
    useState<ShardEntriesMap>({});
  const [activeFolderResumeTarget, setActiveFolderResumeTarget] =
    useState<FolderResumeTarget | null>(null);
  const [activeFolderManualSeries, setActiveFolderManualSeries] = useState<
    ManualLockedSeries[]
  >([]);
  const [isDecisionsLoaded, setIsDecisionsLoaded] = useState(false);
  const decisionsLoadSeqRef = useRef(0);

  // Global app settings: filmstrip series default OFF ('Ne') + cross-folder learned series calibration
  const [filmstripSeriesEnabled, setFilmstripSeriesEnabled] = useState<boolean>(
    () => readFilmstripSeriesEnabled()
  );
  const [globalCalibrationState, setGlobalCalibrationState] =
    useState<GlobalCalibrationState>(() => readGlobalCalibrationState());
  const globalCalibrationRef = useRef(globalCalibrationState);
  globalCalibrationRef.current = globalCalibrationState;

  // Synced queues from SwipeStudio
  const [pickedFilesQueue, setPickedFilesQueue] = useState<DrivePhotoFile[]>(
    []
  );
  const [pickedShotCount, setPickedShotCount] = useState(0);
  const [pickedThumbs, setPickedThumbs] = useState<Record<string, string>>({});

  const [trashFilesQueue, setTrashFilesQueue] = useState<DrivePhotoFile[]>([]);
  const [trashShotCount, setTrashShotCount] = useState(0);

  // Finish Selection modal state (Výběr -> Liked)
  const [finishState, setFinishState] = useState<{
    isOpen: boolean;
    files: DrivePhotoFile[];
    shotCount: number;
    thumbnails: Record<string, string>;
  }>({
    isOpen: false,
    files: [],
    shotCount: 0,
    thumbnails: {},
  });

  // Finish Trash modal state (Mazání)
  const [finishTrashState, setFinishTrashState] = useState<{
    isOpen: boolean;
    files: DrivePhotoFile[];
    shotCount: number;
    thumbnails: Record<string, string>;
  }>({
    isOpen: false,
    files: [],
    shotCount: 0,
    thumbnails: {},
  });

  const navigateToView = useCallback((nextView: AppView) => {
    if (nextView === 'phone' || nextView === 'drive') {
      lastHubViewRef.current = nextView;
    }
    setView((prev) => {
      if (prev !== nextView) {
        try {
          window.history.pushState({ appView: nextView }, '');
        } catch {
          // Ignore history restrictions in sandboxed environments
        }
      }
      return nextView;
    });
  }, []);

  const activeFolderRef = useRef<DriveFolder | null>(null);
  activeFolderRef.current = activeFolder;

  // Progressive folder stream cancellation & resume tracking
  const folderStreamAbortRef = useRef<AbortController | null>(null);
  const resumeStateRef = useRef<{
    folderId: string;
    nextPageToken?: string;
    pageNumber: number;
  } | null>(null);

  const abortFolderStream = useCallback(() => {
    if (folderStreamAbortRef.current) {
      folderStreamAbortRef.current.abort();
      folderStreamAbortRef.current = null;
    }
  }, []);

  // Android Hardware / Gesture Back button support
  useEffect(() => {
    const onPopState = () => {
      if (finishState.isOpen) {
        setFinishState({
          isOpen: false,
          files: [],
          shotCount: 0,
          thumbnails: {},
        });
        return;
      }
      if (finishTrashState.isOpen) {
        setFinishTrashState({
          isOpen: false,
          files: [],
          shotCount: 0,
          thumbnails: {},
        });
        return;
      }
      if (view === 'select' || view === 'delete') {
        setView(lastHubViewRef.current);
        return;
      }
      if (view !== 'phone') {
        setView('phone');
      }
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [finishState.isOpen, finishTrashState.isOpen, view]);

  useEffect(() => {
    if (!isCapacitorNativeApp() && !getConfiguredGitHubRepo()) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void checkForAppUpdate().then((res) => {
        if (!cancelled) {
          setLatestUpdateCheck(res);
        }
      });
    }, 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    void testFirestoreConnection();
    const syncUserCloudState = (uid: string) => {
      loadAllFolderSummaries(uid)
        .then((summaries) => setFolderSummaries(summaries))
        .catch(() => {
          // Structured error already logged by handleFirestoreError
        });
      loadGlobalCalibrationPreference(uid)
        .then((cloudCal) => {
          const localCal = globalCalibrationRef.current;
          if (cloudCal) {
            const localHasData =
              Boolean(localCal.calibration) || localCal.examples.length > 0;
            const cloudHasData =
              Boolean(cloudCal.calibration) || cloudCal.examples.length > 0;
            if (
              cloudHasData &&
              (!localHasData || cloudCal.updatedAtMs > localCal.updatedAtMs)
            ) {
              writeGlobalCalibrationState(cloudCal);
              setGlobalCalibrationState(cloudCal);
            } else if (
              localHasData &&
              localCal.updatedAtMs > cloudCal.updatedAtMs
            ) {
              void saveGlobalCalibrationPreference(uid, localCal).catch(
                () => {}
              );
            }
          } else if (
            localCal.calibration ||
            localCal.examples.length > 0
          ) {
            void saveGlobalCalibrationPreference(uid, localCal).catch(
              () => {}
            );
          }
        })
        .catch(() => {
          // Non-fatal calibration sync error
        });
    };

    const unsubscribe = initAuth(
      (loggedUser, token) => {
        setUser(loggedUser);
        setRememberedEmail(loggedUser.email || getRememberedGoogleEmail());
        setAccessToken(token);
        setNeedsAuth(false);
        setAuthError(null);
        setAuthResolved(true);
        if (loggedUser.isFirebaseSynced) {
          syncUserCloudState(loggedUser.uid);
        }
      },
      (loggedUser) => {
        setUser(loggedUser);
        setRememberedEmail(loggedUser.email || getRememberedGoogleEmail());
        setAccessToken(null);
        setNeedsAuth(false);
        setAuthResolved(true);
        if (loggedUser.isFirebaseSynced) {
          syncUserCloudState(loggedUser.uid);
        }
      },
      () => {
        setUser(null);
        setAccessToken(null);
        setNeedsAuth(true);
        setAuthResolved(true);
        setFolderSummaries({});
        const current = activeFolderRef.current;
        if (current && (!current.sourceKind || current.sourceKind === 'drive')) {
          abortFolderStream();
          setActiveFolder(null);
          setFolderPhotos([]);
          setView((prev) =>
            prev === 'select' || prev === 'delete' ? 'drive' : prev
          );
        }
      }
    );
    return () => {
      unsubscribe();
      abortFolderStream();
    };
  }, [abortFolderStream]);

  const performGoogleSignIn = useCallback(
    async (forceAccountSelect = false, navigateToDriveAfter = false) => {
      setIsSigningIn(true);
      setAuthError(null);
      try {
        const result = await googleSignIn({
          forceAccountSelect,
          loginHint: forceAccountSelect
            ? null
            : user?.email ?? rememberedEmail ?? undefined,
        });
        if (result) {
          setUser(result.user);
          setRememberedEmail(result.user.email || getRememberedGoogleEmail());
          setAccessToken(result.accessToken);
          setNeedsAuth(false);
          setAuthResolved(true);
          if (navigateToDriveAfter) {
            navigateToView('drive');
          }
          if (result.user.isFirebaseSynced) {
            loadAllFolderSummaries(result.user.uid)
              .then((summaries) => setFolderSummaries(summaries))
              .catch(() => {
                // Structured error already logged by handleFirestoreError
              });
          }
        }
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Přihlášení se nezdařilo. Zkuste to prosím znovu.';
        setAuthError(msg);
      } finally {
        setIsSigningIn(false);
      }
    },
    [user?.email, rememberedEmail, navigateToView]
  );

  const handleSignIn = useCallback(() => {
    void performGoogleSignIn(false, false);
  }, [performGoogleSignIn]);

  const handleSwitchGoogleAccount = useCallback(() => {
    void performGoogleSignIn(true, false);
  }, [performGoogleSignIn]);

  const handleSignOut = useCallback(async () => {
    const current = activeFolderRef.current;
    const isCurrentDrive =
      current && (!current.sourceKind || current.sourceKind === 'drive');
    if (isCurrentDrive) {
      abortFolderStream();
      clearMediaCache();
    }
    await logout();
    setUser(null);
    setRememberedEmail(null);
    setAccessToken(null);
    setNeedsAuth(true);
    setAuthResolved(true);
    setAuthError(null);
    setFolderSummaries({});

    if (isCurrentDrive) {
      setActiveFolder(null);
      setFolderPhotos([]);
      setMovedOutIds(new Set());
      setPickedFilesQueue([]);
      setPickedShotCount(0);
      setPickedThumbs({});
      setTrashFilesQueue([]);
      setTrashShotCount(0);
      setLastActionSummary(null);
      setIsLoadingMorePhotos(false);
      setLoadMoreError(null);
      setActiveFolderDecisions({});
      setActiveFolderShardMap({});
      setActiveFolderResumeTarget(null);
      setActiveFolderManualSeries([]);
      setIsDecisionsLoaded(false);
      resumeStateRef.current = null;
    }
  }, [abortFolderStream]);

  const handleAuthExpired = useCallback(() => {
    void (async () => {
      const refreshed = await trySilentNativeDriveRefresh(true);
      if (refreshed?.accessToken) {
        if (refreshed.user) {
          setUser(refreshed.user);
        }
        setAccessToken(refreshed.accessToken);
        setNeedsAuth(false);
        setAuthError(null);
        return;
      }

      const current = activeFolderRef.current;
      const isCurrentDrive =
        !current?.sourceKind || current.sourceKind === 'drive';
      if (isCurrentDrive) {
        abortFolderStream();
        setIsLoadingPhotos(false);
        setIsLoadingMorePhotos(false);
        setView('drive');
      }
      clearAccessToken();
      setAccessToken(null);
      setAuthError(
        'Platnost přihlášení k Google Drive po hodině vypršela. Klepnutím obnovíte přístup bez ztráty rozpracovaných složek.'
      );
    })();
  }, [abortFolderStream]);

  const startStreamFrom = useCallback(
    async (
      folder: DriveFolder,
      targetMode: WorkflowMode,
      startPageToken?: string,
      startPageNumber = 0
    ) => {
      if (!accessToken) {
        handleAuthExpired();
        return;
      }

      abortFolderStream();
      const controller = new AbortController();
      folderStreamAbortRef.current = controller;

      const isInitial = startPageNumber === 0;
      if (isInitial) {
        setIsLoadingPhotos(true);
        setLoadingFolderId(folder.id);
        setFolderLoadError(null);
        setLastActionSummary(null);
        clearMediaCache();
      } else {
        setIsLoadingMorePhotos(true);
        setLoadMoreError(null);
      }

      let openedStudio = !isInitial;

      try {
        await streamPhotosInFolder(
          accessToken,
          folder.id,
          (batch, meta) => {
            if (controller.signal.aborted) return;

            resumeStateRef.current = {
              folderId: folder.id,
              nextPageToken: meta.nextPageToken,
              pageNumber: meta.pageNumber,
            };

            if (isInitial && meta.pageNumber === 1) {
              setActiveFolder({ ...folder, sourceKind: 'drive' });
              setFolderPhotos(batch);
              setMovedOutIds(new Set());
              setPickedFilesQueue([]);
              setPickedShotCount(0);
              setPickedThumbs({});
              setTrashFilesQueue([]);
              setTrashShotCount(0);
              setIsLoadingPhotos(false);
              setLoadingFolderId(null);
              setIsLoadingMorePhotos(meta.hasMore);
              lastHubViewRef.current = 'drive';
              navigateToView(targetMode);
              openedStudio = true;
            } else {
              if (batch.length > 0) {
                setFolderPhotos((prev) => [...prev, ...batch]);
              }
              setIsLoadingMorePhotos(meta.hasMore);
            }
          },
          {
            signal: controller.signal,
            startPageToken,
            startPageNumber,
          }
        );

        if (!controller.signal.aborted) {
          setIsLoadingMorePhotos(false);
          if (!openedStudio) {
            setActiveFolder({ ...folder, sourceKind: 'drive' });
            setFolderPhotos([]);
            setMovedOutIds(new Set());
            setPickedFilesQueue([]);
            setPickedShotCount(0);
            setPickedThumbs({});
            setTrashFilesQueue([]);
            setTrashShotCount(0);
            lastHubViewRef.current = 'drive';
            navigateToView(targetMode);
          }
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        if (err instanceof AuthExpiredError) {
          handleAuthExpired();
          return;
        }
        const msg =
          err instanceof Error
            ? err.message
            : 'Nepodařilo se načíst fotografie ze složky.';
        if (!openedStudio) {
          setFolderLoadError(msg);
        } else {
          setLoadMoreError(msg);
        }
        setIsLoadingMorePhotos(false);
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingPhotos(false);
          setLoadingFolderId(null);
        }
      }
    },
    [accessToken, abortFolderStream, handleAuthExpired, navigateToView]
  );

  const handleSelectFolder = useCallback(
    (folder: DriveFolder, mode: WorkflowMode) => {
      if (
        activeFolder &&
        activeFolder.id === folder.id &&
        (!activeFolder.sourceKind || activeFolder.sourceKind === 'drive') &&
        folderPhotos.length > 0 &&
        !isLoadingPhotos
      ) {
        lastHubViewRef.current = 'drive';
        navigateToView(mode);
        return;
      }

      resumeStateRef.current = null;
      setLoadMoreError(null);
      setActiveFolderDecisions({});
      setActiveFolderShardMap({});
      setActiveFolderManualSeries([]);
      setIsDecisionsLoaded(false);

      const localPos = readLocalResumePosition(folder.id);
      const summary = folderSummaries[folder.id];
      const summaryPos: FolderResumeTarget | null =
        summary && (summary.lastShotId || summary.lastShotName)
          ? {
              shotId: summary.lastShotId,
              fileName: summary.lastShotName,
              stem: summary.lastShotName
                ? getFileStem(summary.lastShotName)
                : undefined,
              updatedAtMs: summary.updatedAtMs || 0,
            }
          : null;
      const initialResume = pickNewerResumeTarget(localPos, summaryPos);
      setActiveFolderResumeTarget(initialResume);

      const mergeManualLists = (
        a: ManualLockedSeries[],
        b: ManualLockedSeries[]
      ): ManualLockedSeries[] => {
        const byId = new Map<string, ManualLockedSeries>();
        for (const item of [...a, ...b]) {
          const prev = byId.get(item.id);
          if (!prev || (item.updatedAtMs || 0) >= (prev.updatedAtMs || 0)) {
            byId.set(item.id, item);
          }
        }
        return Array.from(byId.values());
      };

      const loadSeq = ++decisionsLoadSeqRef.current;
      if (user?.uid && user.isFirebaseSynced) {
        Promise.all([
          loadFolderDecisions(user.uid, folder.id),
          loadFolderManualSeries(user.uid, folder.id).catch(() => []),
          loadLocalManualSeries(folder.id).catch(() => []),
        ])
          .then(
            ([
              {
                entries,
                shardMap,
                lastShotId,
                lastShotName,
                folderUpdatedAtMs,
              },
              cloudManual,
              localManual,
            ]) => {
              if (decisionsLoadSeqRef.current !== loadSeq) return;
              const cloudPos: FolderResumeTarget | null =
                lastShotId || lastShotName
                  ? {
                      shotId: lastShotId,
                      fileName: lastShotName,
                      stem: lastShotName ? getFileStem(lastShotName) : undefined,
                      updatedAtMs: folderUpdatedAtMs || 0,
                    }
                  : null;
              setActiveFolderResumeTarget(
                pickNewerResumeTarget(initialResume, cloudPos)
              );
              setActiveFolderDecisions(entries);
              setActiveFolderShardMap(shardMap);
              setActiveFolderManualSeries(
                mergeManualLists(localManual, cloudManual)
              );
              setIsDecisionsLoaded(true);
            }
          )
          .catch(() => {
            if (decisionsLoadSeqRef.current !== loadSeq) return;
            setIsDecisionsLoaded(true);
          });
      } else {
        loadLocalFolderSession(folder.id)
          .then((session) => {
            if (decisionsLoadSeqRef.current !== loadSeq) return;
            const idbPos: FolderResumeTarget | null =
              session.lastShotId || session.lastShotName
                ? {
                    shotId: session.lastShotId,
                    fileName: session.lastShotName,
                    stem: session.lastShotName
                      ? getFileStem(session.lastShotName)
                      : undefined,
                    updatedAtMs: session.updatedAtMs || 0,
                  }
                : null;
            setActiveFolderResumeTarget(
              pickNewerResumeTarget(initialResume, idbPos)
            );
            setActiveFolderDecisions(session.entries);
            setActiveFolderShardMap({});
            setActiveFolderManualSeries(session.manualSeries || []);
            setIsDecisionsLoaded(true);
          })
          .catch(() => {
            if (decisionsLoadSeqRef.current !== loadSeq) return;
            setIsDecisionsLoaded(true);
          });
      }

      void startStreamFrom(folder, mode, undefined, 0);
    },
    [
      activeFolder,
      folderPhotos.length,
      isLoadingPhotos,
      navigateToView,
      startStreamFrom,
      user?.uid,
      user?.isFirebaseSynced,
      folderSummaries,
    ]
  );

  const handleStartLocalStream = useCallback(
    async (starter: LocalStreamStarter, mode: WorkflowMode) => {
      abortFolderStream();
      const controller = new AbortController();
      folderStreamAbortRef.current = controller;

      clearMediaCache();
      resumeStateRef.current = null;
      setIsLoadingPhotos(true);
      setIsLoadingMorePhotos(false);
      setLoadingFolderId(null);
      setFolderLoadError(null);
      setLoadMoreError(null);
      setLastActionSummary(null);

      let openedStudio = false;

      try {
        await starter.launch((folder, batch, meta) => {
          if (controller.signal.aborted) return;

          if (meta.pageNumber === 1) {
            setActiveFolderDecisions({});
            setActiveFolderShardMap({});
            setActiveFolderManualSeries([]);
            setIsDecisionsLoaded(false);

            const localPos = readLocalResumePosition(folder.id);
            setActiveFolderResumeTarget(localPos);

            const loadSeq = ++decisionsLoadSeqRef.current;
            loadLocalFolderSession(folder.id)
              .then((session) => {
                if (decisionsLoadSeqRef.current !== loadSeq) return;
                const idbPos: FolderResumeTarget | null =
                  session.lastShotId || session.lastShotName
                    ? {
                        shotId: session.lastShotId,
                        fileName: session.lastShotName,
                        stem: session.lastShotName
                          ? getFileStem(session.lastShotName)
                          : undefined,
                        updatedAtMs: session.updatedAtMs || 0,
                      }
                    : null;
                setActiveFolderResumeTarget(
                  pickNewerResumeTarget(localPos, idbPos)
                );
                setActiveFolderDecisions(session.entries);
                setActiveFolderShardMap({});
                setActiveFolderManualSeries(session.manualSeries || []);
                setIsDecisionsLoaded(true);
              })
              .catch(() => {
                if (decisionsLoadSeqRef.current !== loadSeq) return;
                setIsDecisionsLoaded(true);
              });

            setActiveFolder(folder);
            setFolderPhotos(batch);
            setMovedOutIds(new Set());
            setPickedFilesQueue([]);
            setPickedShotCount(0);
            setPickedThumbs({});
            setTrashFilesQueue([]);
            setTrashShotCount(0);
            setIsLoadingPhotos(false);
            setIsLoadingMorePhotos(meta.hasMore);
            lastHubViewRef.current = 'phone';
            navigateToView(mode);
            openedStudio = true;
          } else {
            if (batch.length > 0) {
              setFolderPhotos((prev) => [...prev, ...batch]);
            }
            setIsLoadingMorePhotos(meta.hasMore);
          }
        }, controller.signal);

        if (!controller.signal.aborted) {
          setIsLoadingMorePhotos(false);
          if (!openedStudio) {
            setActiveFolderDecisions({});
            setActiveFolderShardMap({});
            setActiveFolderResumeTarget(null);
            setIsDecisionsLoaded(true);
            setActiveFolder({
              id: `local-empty:${starter.folderName}`,
              name: starter.folderName,
              sourceKind: 'local-file',
              capabilities: {
                sourceKind: 'local-file',
                canTrashSubfolder: false,
                canPermanentDelete: false,
                isReadOnlyFallback: true,
                supportsDirectoryPicker: false,
              },
            });
            setFolderPhotos([]);
            setMovedOutIds(new Set());
            setPickedFilesQueue([]);
            setPickedShotCount(0);
            setPickedThumbs({});
            setTrashFilesQueue([]);
            setTrashShotCount(0);
            lastHubViewRef.current = 'phone';
            navigateToView(mode);
          }
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        const msg =
          err instanceof Error
            ? err.message
            : 'Nepodařilo se načíst fotografie z vybrané složky.';
        if (!openedStudio) {
          setFolderLoadError(msg);
        } else {
          setLoadMoreError(msg);
        }
        setIsLoadingMorePhotos(false);
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingPhotos(false);
          setLoadingFolderId(null);
        }
      }
    },
    [abortFolderStream, navigateToView]
  );

  const handleRetryLoadMore = useCallback(() => {
    const resume = resumeStateRef.current;
    if (!activeFolder || !resume || resume.folderId !== activeFolder.id) return;
    if (!resume.nextPageToken) return;
    const currentMode: WorkflowMode = view === 'delete' ? 'delete' : 'select';
    void startStreamFrom(
      activeFolder,
      currentMode,
      resume.nextPageToken,
      resume.pageNumber
    );
  }, [activeFolder, startStreamFrom, view]);

  const handleRequestFinishSelection = useCallback(
    (
      pickedFiles: DrivePhotoFile[],
      shotCount: number,
      thumbnails: Record<string, string>
    ) => {
      if (pickedFiles.length === 0) return;
      try {
        window.history.pushState({ finishModal: 'selectra' }, '');
      } catch {
        // Ignore history restrictions
      }
      setFinishState({
        isOpen: true,
        files: pickedFiles,
        shotCount,
        thumbnails,
      });
    },
    []
  );

  const handleFinishComplete = useCallback(
    (
      processedIds: string[],
      mode: LikedTransferMode,
      failedItems: { file: DrivePhotoFile; error: string }[],
      customMessage?: string
    ) => {
      if (mode === 'move' && processedIds.length > 0) {
        setMovedOutIds((prev) => {
          const next = new Set(prev);
          for (const id of processedIds) {
            next.add(id);
          }
          return next;
        });
      }

      if (customMessage) {
        setLastActionSummary(customMessage);
      } else if (processedIds.length > 0) {
        setLastActionSummary(
          `${mode === 'move' ? 'Přesunuto' : 'Zkopírováno'} do podsložky „Liked“: ${processedIds.length.toLocaleString('cs-CZ')} souborů.`
        );
      }

      if (failedItems.length === 0) {
        setFinishState({
          isOpen: false,
          files: [],
          shotCount: 0,
          thumbnails: {},
        });
      }
    },
    []
  );

  const handleRequestFinishTrash = useCallback(
    (
      trashFiles: DrivePhotoFile[],
      shotCount: number,
      thumbnails: Record<string, string>
    ) => {
      if (trashFiles.length === 0) return;
      try {
        window.history.pushState({ finishModal: 'framecull' }, '');
      } catch {
        // Ignore history restrictions
      }
      setFinishTrashState({
        isOpen: true,
        files: trashFiles,
        shotCount,
        thumbnails,
      });
    },
    []
  );

  const handleFinishTrashComplete = useCallback(
    (
      processedIds: string[],
      mode: TrashExecutionMode,
      failedItems: { file: DrivePhotoFile; error: string }[],
      customMessage?: string
    ) => {
      if (processedIds.length > 0) {
        setMovedOutIds((prev) => {
          const next = new Set(prev);
          for (const id of processedIds) {
            next.add(id);
          }
          return next;
        });
      }

      if (customMessage) {
        setLastActionSummary(customMessage);
      } else if (processedIds.length > 0) {
        setLastActionSummary(
          mode === 'permanent'
            ? `Trvale smazáno: ${processedIds.length.toLocaleString('cs-CZ')} souborů.`
            : `Přesunuto do koše: ${processedIds.length.toLocaleString('cs-CZ')} souborů.`
        );
      }

      if (failedItems.length === 0) {
        setFinishTrashState({
          isOpen: false,
          files: [],
          shotCount: 0,
          thumbnails: {},
        });
      }
    },
    []
  );

  const handleOpenFinishSelection = useCallback(() => {
    handleRequestFinishSelection(
      pickedFilesQueue,
      pickedShotCount,
      pickedThumbs
    );
  }, [
    handleRequestFinishSelection,
    pickedFilesQueue,
    pickedShotCount,
    pickedThumbs,
  ]);

  const handleOpenFinishTrash = useCallback(() => {
    handleRequestFinishTrash(trashFilesQueue, trashShotCount, pickedThumbs);
  }, [
    handleRequestFinishTrash,
    trashFilesQueue,
    trashShotCount,
    pickedThumbs,
  ]);

  const handleSelectionUpdate = useCallback(
    (
      files: DrivePhotoFile[],
      shotCount: number,
      thumbnails: Record<string, string>,
      trashFiles: DrivePhotoFile[],
      tShotCount: number
    ) => {
      setPickedFilesQueue(files);
      setPickedShotCount(shotCount);
      setPickedThumbs(thumbnails);
      setTrashFilesQueue(trashFiles);
      setTrashShotCount(tShotCount);
    },
    []
  );

  const handlePersistedStateChange = useCallback(
    (
      entries: Record<string, PersistedDecisionEntry>,
      shardMap: ShardEntriesMap,
      resumeTarget?: FolderResumeTarget
    ) => {
      setActiveFolderDecisions(entries);
      setActiveFolderShardMap(shardMap);
      if (resumeTarget) {
        setActiveFolderResumeTarget(resumeTarget);
      }
    },
    []
  );

  const handleUpdatePhotoTimestamps = useCallback(
    (updates: Record<string, { ms: number; label: string }>) => {
      setFolderPhotos((prev) =>
        prev.map((p) => {
          const u = updates[p.id];
          if (!u) return p;
          return { ...p, takenAtMs: u.ms, takenAtLabel: u.label };
        })
      );
    },
    []
  );

  const handleToggleFilmstripSeriesEnabled = useCallback((enabled: boolean) => {
    setFilmstripSeriesEnabled(enabled);
    writeFilmstripSeriesEnabled(enabled);
  }, []);

  const persistGlobalCalibration = useCallback(
    (next: GlobalCalibrationState) => {
      globalCalibrationRef.current = next;
      setGlobalCalibrationState(next);
      writeGlobalCalibrationState(next);
      if (user?.uid && user.isFirebaseSynced) {
        void saveGlobalCalibrationPreference(user.uid, next).catch(() => {
          // Non-fatal background cloud sync
        });
      }
    },
    [user?.uid, user?.isFirebaseSynced]
  );

  const handleAppendCalibrationFeedback = useCallback(
    (
      newExamples: VisualCalibrationExample[],
      baseSensitivityOverride?: SimilaritySensitivity
    ) => {
      if (newExamples.length === 0) return;
      const next = appendContinuousCalibrationFeedback({
        currentState: globalCalibrationRef.current,
        newExamples,
        baseSensitivityOverride,
      });
      persistGlobalCalibration(next);
    },
    [persistGlobalCalibration]
  );

  const handleUpdateGlobalCalibration = useCallback(
    (patch: {
      baseSensitivity?: SimilaritySensitivity;
      calibration?: CustomVisualCalibration | null;
      examples?: VisualCalibrationExample[];
    }) => {
      const curr = globalCalibrationRef.current;
      const next: GlobalCalibrationState = {
        baseSensitivity: patch.baseSensitivity ?? curr.baseSensitivity,
        calibration:
          patch.calibration !== undefined
            ? patch.calibration
            : curr.calibration,
        examples: patch.examples ?? curr.examples,
        updatedAtMs: Date.now(),
      };
      persistGlobalCalibration(next);
    },
    [persistGlobalCalibration]
  );

  const handleResetGlobalCalibration = useCallback(() => {
    persistGlobalCalibration({
      baseSensitivity: 'balanced',
      calibration: null,
      examples: [],
      updatedAtMs: Date.now(),
    });
  }, [persistGlobalCalibration]);

  const handleActiveManualSeriesChange = useCallback(
    (nextSeries: ManualLockedSeries[]) => {
      setActiveFolderManualSeries(nextSeries);
      const current = activeFolderRef.current;
      if (!current) return;
      void saveLocalManualSeries({
        folderId: current.id,
        folderName: current.name,
        manualSeries: nextSeries,
      });
      const isDrive = !current.sourceKind || current.sourceKind === 'drive';
      if (isDrive && user?.uid && user.isFirebaseSynced) {
        void saveFolderManualSeries({
          userId: user.uid,
          folderId: current.id,
          folderName: current.name,
          manualSeries: nextSeries,
        }).catch(() => {
          // Local copy already persisted
        });
      }
    },
    [user?.uid, user?.isFirebaseSynced]
  );

  const isAuthenticated = !needsAuth && Boolean(user);
  const isLocalFolderActive = Boolean(
    activeFolder?.sourceKind && activeFolder.sourceKind !== 'drive'
  );
  const hasUsableActiveFolder =
    Boolean(activeFolder) &&
    (isLocalFolderActive ||
      (isAuthenticated && Boolean(accessToken) && Boolean(user)));

  const isStudioFullscreen =
    (view === 'select' || view === 'delete') && hasUsableActiveFolder;

  return (
    <div
      className={
        isStudioFullscreen
          ? 'h-[100dvh] w-full overflow-hidden overscroll-none flex flex-col bg-[#09090B] text-zinc-100'
          : 'min-h-[100dvh] flex flex-col bg-[#09090B] text-zinc-100'
      }
    >
      {!isStudioFullscreen && (
        <Header
          activeView={view}
          hasActiveFolder={hasUsableActiveFolder}
          pickedCount={pickedShotCount}
          trashCount={trashShotCount}
          onNavigate={(nextView) => {
            setFolderLoadError(null);
            navigateToView(nextView);
          }}
          onOpenFinishSelection={handleOpenFinishSelection}
          onOpenFinishTrash={handleOpenFinishTrash}
        />
      )}

      <div
        className={
          isStudioFullscreen
            ? 'flex-1 min-h-0 flex flex-col overflow-hidden'
            : 'flex-1'
        }
      >
        {folderLoadError && !isStudioFullscreen && (
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 pt-4">
            <div
              role="alert"
              className="flex items-center justify-between gap-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200"
            >
              <span>{folderLoadError}</span>
              <button
                type="button"
                onClick={() => setFolderLoadError(null)}
                className="text-xs font-medium text-rose-300 hover:text-white cursor-pointer"
              >
                Skrýt
              </button>
            </div>
          </div>
        )}

        {isStudioFullscreen &&
        activeFolder &&
        (view === 'select' || view === 'delete') ? (
          <SwipeStudio
            key={`${activeFolder.id}:${view}`}
            workflowMode={view}
            userId={user?.isFirebaseSynced ? user.uid : null}
            folder={activeFolder}
            photos={folderPhotos}
            accessToken={accessToken}
            initialDecisions={activeFolderDecisions}
            initialShardMap={activeFolderShardMap}
            initialResumeTarget={activeFolderResumeTarget}
            isDecisionsLoaded={isDecisionsLoaded}
            isLoadingMore={isLoadingMorePhotos}
            loadMoreError={loadMoreError}
            onRetryLoadMore={handleRetryLoadMore}
            onBackToFolders={() => {
              const targetTab: AppView = isLocalFolderActive
                ? 'phone'
                : 'drive';
              setView(targetTab);
            }}
            onAuthExpired={handleAuthExpired}
            onRequestFinishSelection={handleRequestFinishSelection}
            onRequestFinishTrash={handleRequestFinishTrash}
            onSelectionUpdate={handleSelectionUpdate}
            onPersistedStateChange={handlePersistedStateChange}
            onUpdatePhotoTimestamps={handleUpdatePhotoTimestamps}
            onFolderSummaryChange={(summary) => {
              if (!isLocalFolderActive) {
                setFolderSummaries((prev) => {
                  const next = { ...prev };
                  if (summary) {
                    next[activeFolder.id] = summary;
                  } else {
                    delete next[activeFolder.id];
                  }
                  return next;
                });
              }
            }}
            movedOutIds={movedOutIds}
            isFinishModalOpen={finishState.isOpen || finishTrashState.isOpen}
            lastActionSummary={lastActionSummary}
            filmstripSeriesEnabled={filmstripSeriesEnabled}
            onToggleFilmstripSeriesEnabled={handleToggleFilmstripSeriesEnabled}
            initialManualSeries={activeFolderManualSeries}
            onManualSeriesChange={handleActiveManualSeriesChange}
            globalCalibrationState={globalCalibrationState}
            onUpdateGlobalCalibration={handleUpdateGlobalCalibration}
            onAppendCalibrationFeedback={handleAppendCalibrationFeedback}
          />
        ) : view === 'drive' ? (
          <FolderBrowser
            authResolved={authResolved}
            isAuthenticated={isAuthenticated}
            accessToken={accessToken}
            userEmail={user?.email}
            rememberedEmail={rememberedEmail}
            onReconnectDrive={handleSignIn}
            onSwitchAccount={handleSwitchGoogleAccount}
            onNavigatePhone={() => navigateToView('phone')}
            isReconnectingDrive={isSigningIn}
            driveAuthNotice={authError}
            onSelectFolder={handleSelectFolder}
            onAuthExpired={handleAuthExpired}
            isLoadingPhotos={isLoadingPhotos}
            loadingFolderId={loadingFolderId}
            folderSummaries={folderSummaries}
          />
        ) : view === 'menu' ? (
          <AppMenuView
            isAuthenticated={isAuthenticated}
            hasDriveToken={Boolean(accessToken)}
            userEmail={user?.email}
            rememberedEmail={rememberedEmail}
            isSigningIn={isSigningIn}
            authError={authError}
            onSignIn={handleSignIn}
            onSwitchGoogleAccount={handleSwitchGoogleAccount}
            onSignOut={() => void handleSignOut()}
            onNavigateDrive={() => navigateToView('drive')}
            filmstripSeriesEnabled={filmstripSeriesEnabled}
            onToggleFilmstripSeriesEnabled={handleToggleFilmstripSeriesEnabled}
            globalCalibrationSummary={
              globalCalibrationState.calibration
                ? {
                    sameCount: globalCalibrationState.calibration.sameCount,
                    differentCount:
                      globalCalibrationState.calibration.differentCount,
                    accuracyPct: globalCalibrationState.calibration.accuracyPct,
                    minScore: globalCalibrationState.calibration.minScore,
                    exampleCount: globalCalibrationState.examples.length,
                  }
                : null
            }
            onResetGlobalCalibration={handleResetGlobalCalibration}
            initialUpdateCheck={latestUpdateCheck}
            onUpdateCheckChange={setLatestUpdateCheck}
          />
        ) : view === 'select' || view === 'delete' ? (
          <main className="mx-auto max-w-2xl px-4 sm:px-6 pt-10 pb-24 md:pb-12">
            <div className="rounded-2xl border border-zinc-800 bg-[#141417] p-6 sm:p-8 space-y-5">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1.5">
                  <h1 className="font-display text-xl sm:text-2xl font-bold text-zinc-50">
                    {view === 'delete'
                      ? 'Mazání fotek'
                      : 'Výběr nejlepších fotek'}
                  </h1>
                  <p className="text-sm text-zinc-400 leading-relaxed">
                    {view === 'delete'
                      ? 'Otevřete složku pro čisté mazání nepovedených záběrů. Ponechané snímky se neoznačí jako vybrané — pouze zůstanou nedotčené.'
                      : 'Otevřete složku pro čistý výběr nejlepších záběrů ★ do podsložky Liked. Ostatní fotky v sérii zešednou, ale nic se neodsuzuje k mazání.'}
                  </p>
                </div>
                <div
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${
                    view === 'delete'
                      ? 'bg-rose-500/10 text-rose-400'
                      : 'bg-amber-500/10 text-amber-400'
                  }`}
                >
                  {view === 'delete' ? (
                    <Trash2 className="w-5 h-5" aria-hidden="true" />
                  ) : (
                    <Star
                      className="w-5 h-5 fill-current"
                      aria-hidden="true"
                    />
                  )}
                </div>
              </div>

              <LocalSourcePicker
                fixedMode={view}
                onStartLocalStream={handleStartLocalStream}
              />

              <div className="pt-2 border-t border-zinc-800/80 flex items-center justify-between gap-3">
                <span className="text-xs text-zinc-500">
                  Nebo otevřete složku uloženou na cloudu:
                </span>
                <button
                  type="button"
                  onClick={() => navigateToView('drive')}
                  className="min-h-[42px] px-4 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-100 text-xs font-semibold hover:border-zinc-500 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <HardDrive
                    className="w-4 h-4 text-zinc-400 shrink-0"
                    aria-hidden="true"
                  />
                  <span>Otevřít z Google Drive</span>
                </button>
              </div>
            </div>
          </main>
        ) : (
          <PhoneStorageHub
            activeFolder={hasUsableActiveFolder ? activeFolder : null}
            activePhotosCount={folderPhotos.length}
            pickedCount={pickedShotCount}
            trashCount={trashShotCount}
            isAuthenticated={isAuthenticated}
            hasDriveToken={Boolean(accessToken)}
            userEmail={user?.email}
            rememberedEmail={rememberedEmail}
            onOpenStudio={(mode) => navigateToView(mode)}
            onOpenFinishSelection={handleOpenFinishSelection}
            onOpenFinishTrash={handleOpenFinishTrash}
            onStartLocalStream={handleStartLocalStream}
            onNavigateDrive={() => navigateToView('drive')}
          />
        )}
      </div>

      {!isStudioFullscreen && (
        <MobileBottomNav
          activeTab={view}
          hasActiveFolder={hasUsableActiveFolder}
          isGoogleConnected={isAuthenticated && Boolean(accessToken)}
          hasUpdateAvailable={latestUpdateCheck?.status === 'update_available'}
          onSelectTab={(nextTab) => {
            setFolderLoadError(null);
            navigateToView(nextTab);
          }}
        />
      )}

      <OfflineIndicator />

      {(accessToken || isLocalFolderActive) && (
        <>
          <FinishSelectionModal
            isOpen={finishState.isOpen}
            folder={activeFolder}
            pickedFiles={finishState.files}
            pickedShotCount={finishState.shotCount}
            thumbnails={finishState.thumbnails}
            accessToken={accessToken}
            isStillLoadingFolder={isLoadingMorePhotos}
            onCancel={() =>
              setFinishState({
                isOpen: false,
                files: [],
                shotCount: 0,
                thumbnails: {},
              })
            }
            onAuthExpired={handleAuthExpired}
            onComplete={handleFinishComplete}
          />
          <FinishTrashModal
            isOpen={finishTrashState.isOpen}
            folder={activeFolder}
            trashFiles={finishTrashState.files}
            trashShotCount={finishTrashState.shotCount}
            thumbnails={finishTrashState.thumbnails}
            accessToken={accessToken}
            isStillLoadingFolder={isLoadingMorePhotos}
            onCancel={() =>
              setFinishTrashState({
                isOpen: false,
                files: [],
                shotCount: 0,
                thumbnails: {},
              })
            }
            onAuthExpired={handleAuthExpired}
            onComplete={handleFinishTrashComplete}
          />
        </>
      )}
    </div>
  );
}

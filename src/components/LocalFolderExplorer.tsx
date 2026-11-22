import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Image as ImageIcon,
  Images,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  Usb,
  X,
} from 'lucide-react';
import { isSupportedPhoto } from '../lib/driveApi';
import { PersistedFolderSummary, WorkflowMode } from '../lib/cullPersistence';
import {
  LocalDirectoryListing,
  LocalPreviewPhotoItem,
  LocalStorageRoot,
  LocalStreamStarter,
  LocalSubfolderEntry,
  hasAndroidNativeBridge,
  streamAndroidNativePickResult,
  supportsWebDirectoryPicker,
} from '../lib/localMedia';
import {
  attachWebDirectoryRoot,
  attachWebVirtualRootFromFileList,
  createWebDirectoryStreamStarter,
  listWebDirectory,
  listWebStorageRoots,
  removeWebStorageRoot,
} from '../lib/webLocalExplorer';
import { useI18n } from '../lib/i18n';

interface BreadcrumbNode {
  label: string;
  kind: LocalStorageRoot['kind'];
  path?: string;
  treeId?: string;
  docId?: string;
  relPathParts?: string[];
}

interface LocalFolderExplorerProps {
  localSummaries: Record<string, PersistedFolderSummary>;
  fixedMode?: WorkflowMode;
  onStartLocalStream: (starter: LocalStreamStarter, mode: WorkflowMode) => void;
  onFolderOpened?: () => void;
}

const PREVIEW_PAGE_SIZE = 24;
const THUMB_CONCURRENCY = 3;

function getPhotoExtUpper(item: LocalPreviewPhotoItem): string {
  if (item.fileExtension) return item.fileExtension.toUpperCase();
  const dot = item.name.lastIndexOf('.');
  if (dot >= 0 && dot + 1 < item.name.length) {
    return item.name.slice(dot + 1).toUpperCase();
  }
  return 'IMG';
}

function isPhotoRaw(item: LocalPreviewPhotoItem): boolean {
  if (typeof item.isRaw === 'boolean') return item.isRaw;
  return isSupportedPhoto({ name: item.name, mimeType: item.mimeType }).isRaw;
}

export const LocalFolderExplorer: React.FC<LocalFolderExplorerProps> = ({
  localSummaries,
  fixedMode,
  onStartLocalStream,
  onFolderOpened,
}) => {
  const { t, formatNumber, plural } = useI18n();
  const isNative = hasAndroidNativeBridge();

  const [hasAllFilesAccess, setHasAllFilesAccess] = useState<boolean>(!isNative);
  const [roots, setRoots] = useState<LocalStorageRoot[]>([]);
  const [shortcuts, setShortcuts] = useState<LocalStorageRoot[]>([]);
  const [activeRoot, setActiveRoot] = useState<LocalStorageRoot | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbNode[]>([]);
  const [listing, setListing] = useState<LocalDirectoryListing | null>(null);

  const [loadingRoots, setLoadingRoots] = useState(true);
  const [loadingDir, setLoadingDir] = useState(false);
  const [requestingPermission, setRequestingPermission] = useState(false);
  const [attachingRoot, setAttachingRoot] = useState(false);
  const [openingTargetId, setOpeningTargetId] = useState<string | null>(null);
  const [explorerError, setExplorerError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [visiblePreviewCount, setVisiblePreviewCount] =
    useState(PREVIEW_PAGE_SIZE);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [failedThumbs, setFailedThumbs] = useState<Record<string, boolean>>({});

  const dirLoadSeqRef = useRef(0);
  const blobUrlsRef = useRef<string[]>([]);
  const fallbackWebDirInputRef = useRef<HTMLInputElement>(null);

  const revokeAllBlobUrls = useCallback(() => {
    for (const url of blobUrlsRef.current) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Ignore cleanup errors
      }
    }
    blobUrlsRef.current = [];
  }, []);

  useEffect(() => {
    return () => {
      revokeAllBlobUrls();
    };
  }, [revokeAllBlobUrls]);

  const loadDirectoryNode = useCallback(
    async (root: LocalStorageRoot, node: BreadcrumbNode) => {
      const seq = ++dirLoadSeqRef.current;
      setLoadingDir(true);
      setExplorerError(null);
      setVisiblePreviewCount(PREVIEW_PAGE_SIZE);
      setThumbUrls({});
      setFailedThumbs({});
      revokeAllBlobUrls();

      try {
        let nextListing: LocalDirectoryListing;
        if (
          (node.kind === 'file' || node.kind === 'saf') &&
          window.FrameCullNative?.listLocalDirectory
        ) {
          nextListing = await window.FrameCullNative.listLocalDirectory({
            kind: node.kind,
            path: node.path,
            treeId: node.treeId,
            docId: node.docId,
          });
        } else {
          nextListing = await listWebDirectory(root, node.relPathParts || []);
        }
        if (dirLoadSeqRef.current !== seq) return;
        setListing(nextListing);
      } catch (err: unknown) {
        if (dirLoadSeqRef.current !== seq) return;
        setListing(null);
        setExplorerError(
          err instanceof Error
            ? err.message
            : t(
                'Nepodařilo se načíst obsah této složky.',
                'Could not load contents of this folder.'
              )
        );
      } finally {
        if (dirLoadSeqRef.current === seq) {
          setLoadingDir(false);
        }
      }
    },
    [revokeAllBlobUrls, t]
  );

  const selectRootAndOpen = useCallback(
    (root: LocalStorageRoot, initialTrail?: BreadcrumbNode[]) => {
      setActiveRoot(root);
      setSearchQuery('');
      const trail: BreadcrumbNode[] =
        initialTrail && initialTrail.length > 0
          ? initialTrail
          : [
              {
                label: root.name,
                kind: root.kind,
                path: root.path,
                treeId: root.treeId,
                docId: root.docId,
                relPathParts: [],
              },
            ];
      setBreadcrumbs(trail);
      void loadDirectoryNode(root, trail[trail.length - 1]);
    },
    [loadDirectoryNode]
  );

  const refreshRoots = useCallback(
    async (preferRootId?: string) => {
      setLoadingRoots(true);
      setExplorerError(null);
      try {
        if (isNative && window.FrameCullNative?.listStorageRoots) {
          const res = await window.FrameCullNative.listStorageRoots();
          setHasAllFilesAccess(Boolean(res.hasAllFilesAccess));
          setRoots(res.roots);
          setShortcuts(res.shortcuts);

          if (res.roots.length > 0) {
            const preferred = preferRootId
              ? res.roots.find((r) => r.id === preferRootId)
              : null;
            setActiveRoot((prev) => {
              const keepExisting =
                !preferred && prev
                  ? res.roots.find((r) => r.id === prev.id)
                  : null;
              const target = preferred || keepExisting || res.roots[0];
              if (!keepExisting || preferred) {
                const startNode: BreadcrumbNode = {
                  label: target.name,
                  kind: target.kind,
                  path: target.path,
                  treeId: target.treeId,
                  docId: target.docId,
                  relPathParts: [],
                };
                setBreadcrumbs([startNode]);
                void loadDirectoryNode(target, startNode);
              }
              return target;
            });
          } else {
            setActiveRoot(null);
            setBreadcrumbs([]);
            setListing(null);
          }
        } else {
          setHasAllFilesAccess(true);
          const webRoots = await listWebStorageRoots();
          setRoots(webRoots);
          setShortcuts([]);
          if (webRoots.length > 0) {
            const preferred = preferRootId
              ? webRoots.find((r) => r.id === preferRootId)
              : null;
            setActiveRoot((prev) => {
              const keepExisting =
                !preferred && prev
                  ? webRoots.find((r) => r.id === prev.id)
                  : null;
              const target = preferred || keepExisting || webRoots[0];
              if (!keepExisting || preferred) {
                const startNode: BreadcrumbNode = {
                  label: target.name,
                  kind: target.kind,
                  path: target.path,
                  relPathParts: [],
                };
                setBreadcrumbs([startNode]);
                void loadDirectoryNode(target, startNode);
              }
              return target;
            });
          } else {
            setActiveRoot(null);
            setBreadcrumbs([]);
            setListing(null);
          }
        }
      } catch (err: unknown) {
        setExplorerError(
          err instanceof Error
            ? err.message
            : t(
                'Nepodařilo se načíst seznam úložišť.',
                'Could not load storage volumes.'
              )
        );
      } finally {
        setLoadingRoots(false);
      }
    },
    [isNative, loadDirectoryNode, t]
  );

  useEffect(() => {
    void refreshRoots();
  }, [refreshRoots]);

  // Auto-recheck Android All-Files Access when user returns from system Settings
  useEffect(() => {
    if (!isNative) return;
    const handleResumeCheck = () => {
      if (document.visibilityState === 'hidden') return;
      if (!window.FrameCullNative?.getStoragePermissionStatus) return;
      void window.FrameCullNative.getStoragePermissionStatus()
        .then((status) => {
          if (status.granted !== hasAllFilesAccess) {
            void refreshRoots();
          }
        })
        .catch(() => {
          // Ignore resume check failures
        });
    };
    window.addEventListener('focus', handleResumeCheck);
    document.addEventListener('visibilitychange', handleResumeCheck);
    return () => {
      window.removeEventListener('focus', handleResumeCheck);
      document.removeEventListener('visibilitychange', handleResumeCheck);
    };
  }, [hasAllFilesAccess, isNative, refreshRoots]);

  const visiblePhotos = useMemo(() => {
    if (!listing?.photos) return [];
    return listing.photos.slice(0, visiblePreviewCount);
  }, [listing?.photos, visiblePreviewCount]);

  // Progressively load read-only thumbnails for visible photos in current folder
  useEffect(() => {
    if (!visiblePhotos.length) return;
    let cancelled = false;
    const pending = visiblePhotos.filter(
      (p) => !thumbUrls[p.id] && !failedThumbs[p.id]
    );
    if (pending.length === 0) return;

    let cursor = 0;

    const loadOne = async (photo: LocalPreviewPhotoItem) => {
      try {
        if (photo.localFile) {
          if (isPhotoRaw(photo)) {
            if (!cancelled) {
              setFailedThumbs((prev) => ({ ...prev, [photo.id]: true }));
            }
            return;
          }
          const objectUrl = URL.createObjectURL(photo.localFile);
          if (cancelled) {
            URL.revokeObjectURL(objectUrl);
            return;
          }
          blobUrlsRef.current.push(objectUrl);
          setThumbUrls((prev) => ({ ...prev, [photo.id]: objectUrl }));
          return;
        }

        if (!photo.uri || !window.FrameCullNative) {
          if (!cancelled) {
            setFailedThumbs((prev) => ({ ...prev, [photo.id]: true }));
          }
          return;
        }

        const raw = isPhotoRaw(photo);
        let url: string | null = null;
        if (raw && window.FrameCullNative.extractRawThumbnailUrl) {
          const extracted = await window.FrameCullNative.extractRawThumbnailUrl(
            photo.uri
          );
          url = extracted?.url || null;
        } else if (!raw && window.FrameCullNative.getThumbnailUrl) {
          url = await window.FrameCullNative.getThumbnailUrl(photo.uri);
        }

        if (cancelled) return;
        if (url) {
          setThumbUrls((prev) => ({ ...prev, [photo.id]: url! }));
        } else {
          setFailedThumbs((prev) => ({ ...prev, [photo.id]: true }));
        }
      } catch {
        if (!cancelled) {
          setFailedThumbs((prev) => ({ ...prev, [photo.id]: true }));
        }
      }
    };

    const worker = async () => {
      while (!cancelled && cursor < pending.length) {
        const next = pending[cursor++];
        if (!next) break;
        await loadOne(next);
      }
    };

    const workers = Array.from(
      { length: Math.min(THUMB_CONCURRENCY, pending.length) },
      () => worker()
    );
    void Promise.all(workers);

    return () => {
      cancelled = true;
    };
  }, [visiblePhotos, thumbUrls, failedThumbs]);

  const handleRequestAllFiles = async () => {
    if (!window.FrameCullNative?.requestAllFilesAccess || requestingPermission) {
      return;
    }
    setRequestingPermission(true);
    setExplorerError(null);
    try {
      const res = await window.FrameCullNative.requestAllFilesAccess();
      if (res?.granted) {
        await refreshRoots();
      }
    } catch (err: unknown) {
      setExplorerError(
        err instanceof Error
          ? err.message
          : t(
              'Nepodařilo se otevřít nastavení oprávnění.',
              'Could not open storage permission settings.'
            )
      );
    } finally {
      setRequestingPermission(false);
    }
  };

  const handleAttachExternalRoot = async () => {
    if (attachingRoot) return;
    setExplorerError(null);
    setAttachingRoot(true);
    try {
      if (isNative && window.FrameCullNative?.attachSafRoot) {
        const mounted = await window.FrameCullNative.attachSafRoot();
        if (mounted) {
          await refreshRoots(mounted.id);
        }
        return;
      }

      if (supportsWebDirectoryPicker()) {
        try {
          const mounted = await attachWebDirectoryRoot();
          if (mounted) {
            await refreshRoots(mounted.id);
          }
          return;
        } catch (err: unknown) {
          // Cross-origin iframe or browser restriction: fall back cleanly to webkitdirectory virtual tree
          if (
            err instanceof DOMException &&
            (err.name === 'SecurityError' || err.name === 'NotAllowedError')
          ) {
            fallbackWebDirInputRef.current?.click();
            return;
          }
          throw err;
        }
      }

      fallbackWebDirInputRef.current?.click();
    } catch (err: unknown) {
      setExplorerError(
        err instanceof Error
          ? err.message
          : t(
              'Nepodařilo se připojit složku úložiště.',
              'Could not attach storage folder.'
            )
      );
    } finally {
      setAttachingRoot(false);
    }
  };

  const handleWebFallbackDirChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const arr = Array.from(files);
    e.target.value = '';
    const mounted = attachWebVirtualRootFromFileList(arr);
    if (mounted) {
      void refreshRoots(mounted.id);
    }
  };

  const handleRemoveRoot = async (
    e: React.MouseEvent,
    root: LocalStorageRoot
  ) => {
    e.stopPropagation();
    if (root.kind === 'saf' && window.FrameCullNative?.removeSafRoot) {
      await window.FrameCullNative.removeSafRoot(root.treeId || root.id);
    } else if (root.kind === 'web-handle' || root.kind === 'web-virtual') {
      await removeWebStorageRoot(root.id);
    }
    await refreshRoots();
  };

  const handleShortcutClick = (shortcut: LocalStorageRoot) => {
    const internalRoot =
      roots.find((r) => r.volumeType === 'internal') || roots[0] || shortcut;
    const trail: BreadcrumbNode[] =
      internalRoot.path && shortcut.path && shortcut.path !== internalRoot.path
        ? [
            {
              label: internalRoot.name,
              kind: internalRoot.kind,
              path: internalRoot.path,
            },
            {
              label: shortcut.name,
              kind: shortcut.kind,
              path: shortcut.path,
            },
          ]
        : [
            {
              label: shortcut.name,
              kind: shortcut.kind,
              path: shortcut.path,
            },
          ];
    selectRootAndOpen(internalRoot, trail);
  };

  const handleEnterSubfolder = (sub: LocalSubfolderEntry) => {
    if (!activeRoot) return;
    setSearchQuery('');
    const nextNode: BreadcrumbNode = {
      label: sub.name,
      kind: activeRoot.kind,
      path: sub.path,
      treeId: sub.treeId || activeRoot.treeId,
      docId: sub.docId,
      relPathParts: sub.relPathParts,
    };
    const nextTrail = [...breadcrumbs, nextNode];
    setBreadcrumbs(nextTrail);
    void loadDirectoryNode(activeRoot, nextNode);
  };

  const handleBreadcrumbClick = (index: number) => {
    if (!activeRoot) return;
    const nextTrail = breadcrumbs.slice(0, index + 1);
    if (nextTrail.length === 0) return;
    setSearchQuery('');
    setBreadcrumbs(nextTrail);
    void loadDirectoryNode(activeRoot, nextTrail[nextTrail.length - 1]);
  };

  const handleGoUp = () => {
    if (!activeRoot) return;
    if (breadcrumbs.length > 1) {
      handleBreadcrumbClick(breadcrumbs.length - 2);
      return;
    }
    if (listing?.canGoUp && listing.parentPath && activeRoot.kind === 'file') {
      const parentName =
        listing.parentPath.split('/').filter(Boolean).pop() ||
        t('Lokální úložiště', 'Local Storage');
      const upNode: BreadcrumbNode = {
        label: parentName,
        kind: 'file',
        path: listing.parentPath,
      };
      setBreadcrumbs([upNode]);
      void loadDirectoryNode(activeRoot, upNode);
    }
  };

  const handleRefreshCurrent = () => {
    if (!activeRoot || breadcrumbs.length === 0) {
      void refreshRoots();
      return;
    }
    void loadDirectoryNode(activeRoot, breadcrumbs[breadcrumbs.length - 1]);
  };

  const handleLaunchFolder = async (
    target: {
      id: string;
      name: string;
      kind: LocalStorageRoot['kind'];
      path?: string;
      treeId?: string;
      docId?: string;
      relPathParts?: string[];
    },
    mode: WorkflowMode
  ) => {
    if (openingTargetId) return;
    setExplorerError(null);
    setOpeningTargetId(target.id);
    try {
      if (
        (target.kind === 'file' || target.kind === 'saf') &&
        window.FrameCullNative?.openLocalDirectory
      ) {
        const res = await window.FrameCullNative.openLocalDirectory({
          kind: target.kind,
          path: target.path,
          treeId: target.treeId,
          docId: target.docId,
          folderName: target.name,
        });
        if (!res) return;
        if (res.files.length === 0) {
          setExplorerError(
            t(
              `Ve složce „${target.name}“ nebyly nalezeny žádné podporované fotky ani RAW soubory.`,
              `No supported photos or RAW files were found in "${target.name}".`
            )
          );
          return;
        }
        onFolderOpened?.();
        onStartLocalStream(
          {
            folderName: res.folderName || target.name,
            launch: (onBatch, signal) =>
              streamAndroidNativePickResult(res, onBatch, signal),
          },
          mode
        );
        return;
      }

      if (!activeRoot) return;
      const starter = await createWebDirectoryStreamStarter(
        activeRoot,
        target.relPathParts || [],
        target.name
      );
      onFolderOpened?.();
      onStartLocalStream(starter, mode);
    } catch (err: unknown) {
      setExplorerError(
        err instanceof Error
          ? err.message
          : t(
              'Nepodařilo se otevřít vybranou složku.',
              'Could not open the selected folder.'
            )
      );
    } finally {
      setOpeningTargetId(null);
    }
  };

  const filteredSubfolders = useMemo(() => {
    if (!listing?.subfolders) return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return listing.subfolders;
    return listing.subfolders.filter((sub) =>
      sub.name.toLowerCase().includes(q)
    );
  }, [listing?.subfolders, searchQuery]);

  const currentNode =
    breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1] : null;

  const currentRawCount = useMemo(() => {
    if (!listing?.photos) return 0;
    return listing.photos.reduce(
      (acc, item) => acc + (isPhotoRaw(item) ? 1 : 0),
      0
    );
  }, [listing?.photos]);

  const currentSummary = listing?.folderId
    ? localSummaries[listing.folderId]
    : undefined;

  const canOpenCurrentFolder = Boolean(
    listing &&
      (listing.photos.length > 0 ||
        listing.subfolders.some((s) => (s.photoCount ?? 1) > 0))
  );

  const getRootDisplayLabel = (root: LocalStorageRoot) => {
    if (root.volumeType === 'internal') {
      return t('Interní úložiště', 'Internal Storage');
    }
    return root.name;
  };

  return (
    <section
      aria-label={t(
        'Průzkumník lokálního úložiště',
        'Local Storage Folder Explorer'
      )}
      className="space-y-4"
    >
      <input
        ref={fallbackWebDirInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory is supported in Chromium/WebKit/Firefox
        webkitdirectory=""
        directory=""
        onChange={handleWebFallbackDirChange}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* Section Title + Mount External USB/SD or Web Root Action */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg sm:text-xl font-semibold tracking-tight text-zinc-100">
            {t('Průzkumník složek', 'Folder Explorer')}
          </h2>
          <p className="mt-0.5 text-xs sm:text-sm text-zinc-400">
            {t(
              'Procházejte strukturu složek přímo v aplikaci a spusťte Výběr nebo Mazání v libovolné složce.',
              'Browse your folder structure directly in the app and start Select or Delete in any folder.'
            )}
          </p>
        </div>

        <button
          type="button"
          onClick={() => void handleAttachExternalRoot()}
          disabled={attachingRoot}
          className="min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-700 bg-[#141417] text-zinc-200 hover:border-zinc-500 hover:text-white text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 self-start sm:self-auto cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-amber-500"
        >
          {isNative ? (
            <Usb className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
          ) : (
            <FolderPlus
              className="w-4 h-4 text-amber-400 shrink-0"
              aria-hidden="true"
            />
          )}
          <span>
            {attachingRoot
              ? t('Připojuji…', 'Attaching…')
              : isNative
                ? t('Připojit USB / SD', 'Attach USB / SD')
                : t('Připojit složku', 'Attach folder')}
          </span>
        </button>
      </div>

      {/* Android One-Time All-Files Permission Card (disappears immediately once granted) */}
      {isNative && !hasAllFilesAccess && !loadingRoots && (
        <div className="rounded-2xl border border-zinc-800 bg-[#141417] p-5 sm:p-6 space-y-4">
          <div className="flex items-start gap-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
              <ShieldCheck className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="space-y-1 min-w-0">
              <h3 className="font-display text-base font-semibold text-zinc-100">
                {t(
                  'Povolte přístup k lokálnímu úložišti',
                  'Allow access to local storage'
                )}
              </h3>
              <p className="text-sm text-zinc-400 leading-relaxed">
                {t(
                  'Pro zobrazení celé struktury složek (DCIM, Pictures, SD karta) přímo v aplikaci bez otevírání systémového průzkumníku povolte jednorázové oprávnění „Přístup ke všem souborům“. Případně můžete níže připojit konkrétní USB / SD složku přes SAF.',
                  'To browse your full folder tree (DCIM, Pictures, SD card) directly inside the app without opening the system picker, grant one-time All Files Access. Alternatively, attach a specific USB / SD root below.'
                )}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => void handleRequestAllFiles()}
              disabled={requestingPermission}
              className="min-h-[44px] px-4 py-2.5 rounded-xl bg-amber-500 text-zinc-950 hover:bg-amber-400 text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-amber-500"
            >
              <HardDrive className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>
                {requestingPermission
                  ? t('Otevírám nastavení…', 'Opening settings…')
                  : t(
                      'Povolit přístup ke všem souborům',
                      'Grant All Files Access'
                    )}
              </span>
            </button>

            <button
              type="button"
              onClick={() => void handleAttachExternalRoot()}
              disabled={attachingRoot}
              className="min-h-[44px] px-4 py-2.5 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-200 hover:border-zinc-500 hover:text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Usb className="w-4 h-4 text-zinc-400 shrink-0" aria-hidden="true" />
              <span>
                {t('Připojit USB / SD (SAF)', 'Attach USB / SD (SAF)')}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Storage Volumes & Quick Shortcuts Bar */}
      {(roots.length > 0 || shortcuts.length > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Volume Root Switchers */}
          <div
            role="tablist"
            aria-label={t('Dostupná úložiště', 'Available storage volumes')}
            className="flex flex-wrap items-center gap-1 p-1 rounded-xl border border-zinc-800 bg-[#141417]"
          >
            {roots.map((root) => {
              const isSelected = activeRoot?.id === root.id;
              const isRemovableRoot =
                root.kind === 'saf' ||
                root.kind === 'web-handle' ||
                root.kind === 'web-virtual';
              return (
                <div key={root.id} className="inline-flex items-center">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    onClick={() => selectRootAndOpen(root)}
                    className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      isSelected
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {root.volumeType === 'usb' || root.volumeType === 'saf' ? (
                      <Usb className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <HardDrive
                        className="w-3.5 h-3.5 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate max-w-[180px]">
                      {getRootDisplayLabel(root)}
                    </span>
                  </button>
                  {isRemovableRoot && (
                    <button
                      type="button"
                      onClick={(e) => void handleRemoveRoot(e, root)}
                      aria-label={t(
                        `Odpojit ${root.name}`,
                        `Disconnect ${root.name}`
                      )}
                      title={t('Odpojit úložiště', 'Disconnect storage')}
                      className="min-h-[36px] min-w-[30px] inline-flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/80 transition-colors cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Quick Shortcuts (DCIM, Pictures, Download, Documents) */}
          {shortcuts.length > 0 && (
            <div
              aria-label={t('Rychlé složky', 'Quick folders')}
              className="flex flex-wrap items-center gap-1.5"
            >
              {shortcuts.map((sc) => {
                const isActivePath =
                  listing?.kind === 'file' && listing.path === sc.path;
                return (
                  <button
                    key={sc.id}
                    type="button"
                    onClick={() => handleShortcutClick(sc)}
                    className={`min-h-[40px] px-3 py-1.5 rounded-xl border text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      isActivePath
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-200'
                        : 'border-zinc-800 bg-[#141417] text-zinc-300 hover:border-zinc-700 hover:text-white'
                    }`}
                  >
                    <Folder className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>{sc.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Web Empty State when no root folder has been mounted yet */}
      {!isNative && !loadingRoots && roots.length === 0 && (
        <div className="rounded-2xl border border-zinc-800 bg-[#141417] p-6 sm:p-8 space-y-4">
          <div className="flex items-start gap-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
              <FolderOpen className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <h3 className="font-display text-base font-semibold text-zinc-100">
                {t(
                  'Připojte kořenovou složku lokálního úložiště',
                  'Attach a local storage root folder'
                )}
              </h3>
              <p className="text-sm text-zinc-400 leading-relaxed max-w-2xl">
                {t(
                  'V webovém prohlížeči nejprve jednorázově připojte složku (např. Fotky, DCIM nebo SD kartu). Poté můžete v aplikaci volně procházet celou její strukturu podsložek včetně náhledů snímků.',
                  'In a web browser, attach a top-level folder once (such as Photos, DCIM, or an SD card). You can then browse its full subfolder tree and photo previews right inside the app.'
                )}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleAttachExternalRoot()}
            disabled={attachingRoot}
            className="min-h-[44px] px-4 py-2.5 rounded-xl bg-amber-500 text-zinc-950 hover:bg-amber-400 text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <FolderPlus className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>
              {attachingRoot
                ? t('Připojuji složku…', 'Attaching folder…')
                : t('Připojit kořenovou složku', 'Attach root folder')}
            </span>
          </button>
        </div>
      )}

      {/* Main Folder Browser Canvas (when a root is active) */}
      {activeRoot && (
        <div className="space-y-4">
          {/* Toolbar: Back + Breadcrumbs + Subfolder Filter + Refresh */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <nav
              aria-label={t('Cesta v lokálním úložišti', 'Local storage path')}
              className="flex flex-wrap items-center gap-1 text-sm min-h-[40px]"
            >
              {(breadcrumbs.length > 1 || listing?.canGoUp) && (
                <button
                  type="button"
                  onClick={handleGoUp}
                  className="mr-1 inline-flex items-center justify-center min-h-[40px] min-w-[40px] rounded-xl border border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors cursor-pointer"
                  aria-label={t('Zpět o úroveň výš', 'Go up one level')}
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}

              {breadcrumbs.map((crumb, idx) => {
                const isLast = idx === breadcrumbs.length - 1;
                const display =
                  idx === 0 && activeRoot.volumeType === 'internal'
                    ? t('Interní úložiště', 'Internal Storage')
                    : crumb.label;
                return (
                  <React.Fragment key={`${crumb.label}-${idx}`}>
                    {idx > 0 && (
                      <ChevronRight
                        className="w-4 h-4 text-zinc-600 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => handleBreadcrumbClick(idx)}
                      disabled={isLast}
                      className={`min-h-[36px] px-2 py-1 rounded-lg transition-colors truncate max-w-[200px] ${
                        isLast
                          ? 'font-semibold text-zinc-100 cursor-default'
                          : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 cursor-pointer'
                      }`}
                    >
                      {display}
                    </button>
                  </React.Fragment>
                );
              })}
            </nav>

            <div className="flex items-center gap-2">
              <div className="relative flex-1 sm:w-64">
                <Search
                  className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('Filtrovat podsložky…', 'Filter subfolders…')}
                  className="w-full h-10 pl-9 pr-14 rounded-xl bg-[#141417] border border-zinc-800 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer"
                  >
                    {t('Zrušit', 'Clear')}
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={handleRefreshCurrent}
                disabled={loadingDir}
                className="inline-flex items-center justify-center min-h-[40px] min-w-[40px] rounded-xl border border-zinc-800 bg-[#141417] text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors cursor-pointer disabled:opacity-50"
                aria-label={t('Obnovit obsah složky', 'Refresh folder contents')}
                title={t('Obnovit', 'Refresh')}
              >
                <RefreshCw
                  className={`w-4 h-4 ${loadingDir ? 'animate-spin' : ''}`}
                />
              </button>
            </div>
          </div>

          {/* Error Banner */}
          {explorerError && (
            <div
              role="alert"
              className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs text-rose-200"
            >
              <span>{explorerError}</span>
              <button
                type="button"
                onClick={handleRefreshCurrent}
                className="px-3 py-1.5 rounded-lg bg-zinc-900/80 text-zinc-100 hover:bg-zinc-800 font-medium cursor-pointer whitespace-nowrap"
              >
                {t('Zkusit znovu', 'Try again')}
              </button>
            </div>
          )}

          {/* Current Folder Action Bar */}
          {listing && currentNode && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-2xl border border-zinc-800 bg-[#141417] p-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
                  <Images className="w-5 h-5" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-zinc-100 truncate">
                    {t('Aktuální složka', 'Current folder')}:{' '}
                    {breadcrumbs.length === 1 &&
                    activeRoot.volumeType === 'internal'
                      ? t('Interní úložiště', 'Internal Storage')
                      : listing.name}
                  </p>
                  <p className="text-xs text-zinc-400 tabular-nums truncate mt-0.5">
                    {listing.photos.length > 0 ? (
                      <>
                        {formatNumber(listing.photos.length)}{' '}
                        {plural(
                          listing.photos.length,
                          ['fotka', 'fotky', 'fotek'],
                          ['photo', 'photos']
                        )}
                        {currentRawCount > 0
                          ? ` · ${formatNumber(currentRawCount)} RAW`
                          : ''}
                      </>
                    ) : (
                      t(
                        'Žádné fotky přímo zde',
                        'No photos directly in this folder'
                      )
                    )}
                    {listing.subfolders.length > 0
                      ? ` · ${formatNumber(listing.subfolders.length)} ${plural(
                          listing.subfolders.length,
                          ['podsložka', 'podsložky', 'podsložek'],
                          ['subfolder', 'subfolders']
                        )}`
                      : ''}
                    {currentSummary &&
                    (currentSummary.keepCount > 0 ||
                      currentSummary.trashCount > 0)
                      ? ` · ${t('Vybráno', 'Picked')} ★ ${formatNumber(
                          currentSummary.keepCount
                        )}${
                          currentSummary.trashCount > 0
                            ? ` · ${t('Ke smazání', 'To delete')} ${formatNumber(
                                currentSummary.trashCount
                              )}`
                            : ''
                        }`
                      : ''}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {(!fixedMode || fixedMode === 'select') && (
                  <button
                    type="button"
                    disabled={
                      !canOpenCurrentFolder || openingTargetId !== null
                    }
                    onClick={() =>
                      void handleLaunchFolder(
                        {
                          id: listing.folderId,
                          name: listing.name,
                          kind: listing.kind,
                          path: listing.path,
                          treeId: listing.treeId || activeRoot.treeId,
                          docId: listing.docId,
                          relPathParts: currentNode.relPathParts,
                        },
                        'select'
                      )
                    }
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-amber-500 text-zinc-950 hover:bg-amber-400 font-semibold text-sm inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Star
                      className="w-4 h-4 fill-current shrink-0"
                      aria-hidden="true"
                    />
                    <span>
                      {openingTargetId === listing.folderId
                        ? t('Načítám…', 'Loading…')
                        : t('Výběr v této složce', 'Select in folder')}
                    </span>
                  </button>
                )}

                {(!fixedMode || fixedMode === 'delete') && (
                  <button
                    type="button"
                    disabled={
                      !canOpenCurrentFolder || openingTargetId !== null
                    }
                    onClick={() =>
                      void handleLaunchFolder(
                        {
                          id: listing.folderId,
                          name: listing.name,
                          kind: listing.kind,
                          path: listing.path,
                          treeId: listing.treeId || activeRoot.treeId,
                          docId: listing.docId,
                          relPathParts: currentNode.relPathParts,
                        },
                        'delete'
                      )
                    }
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-rose-500 text-white hover:bg-rose-400 font-semibold text-sm inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>
                      {openingTargetId === listing.folderId
                        ? t('Načítám…', 'Loading…')
                        : t('Mazání v této složce', 'Delete in folder')}
                    </span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Subfolders List */}
          <div className="rounded-2xl border border-zinc-800 bg-[#141417] overflow-hidden">
            {loadingDir ? (
              <div className="divide-y divide-zinc-800/70">
                {Array.from({ length: 5 }).map((_, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between px-4 py-3.5 animate-pulse"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-zinc-800" />
                      <div className="space-y-1.5">
                        <div className="h-4 w-44 rounded bg-zinc-800" />
                        <div className="h-3 w-28 rounded bg-zinc-800/70" />
                      </div>
                    </div>
                    <div className="h-9 w-24 rounded-lg bg-zinc-800" />
                  </div>
                ))}
              </div>
            ) : filteredSubfolders.length === 0 ? (
              <div className="p-8 text-center space-y-1.5">
                <p className="text-sm font-medium text-zinc-300">
                  {searchQuery
                    ? t(
                        `Žádné podsložky neodpovídají filtru „${searchQuery}“.`,
                        `No subfolders match "${searchQuery}".`
                      )
                    : t(
                        'V této složce nejsou žádné další podsložky.',
                        'There are no subfolders in this folder.'
                      )}
                </p>
                {listing && listing.photos.length > 0 && !searchQuery && (
                  <p className="text-xs text-zinc-500">
                    {t(
                      'Níže vidíte náhled fotek v této složce. Pro spuštění třídění použijte tlačítka výše.',
                      'See the read-only photo preview below. Use the buttons above to start culling this folder.'
                    )}
                  </p>
                )}
              </div>
            ) : (
              <ul className="divide-y divide-zinc-800/70">
                {filteredSubfolders.map((sub) => {
                  const summary = localSummaries[sub.id];
                  const isOpeningThis = openingTargetId === sub.id;
                  const metaParts: string[] = [];
                  if (typeof sub.photoCount === 'number') {
                    metaParts.push(
                      `${formatNumber(sub.photoCount)} ${plural(
                        sub.photoCount,
                        ['fotka', 'fotky', 'fotek'],
                        ['photo', 'photos']
                      )}`
                    );
                  }
                  if (
                    typeof sub.subfolderCount === 'number' &&
                    sub.subfolderCount > 0
                  ) {
                    metaParts.push(
                      `${formatNumber(sub.subfolderCount)} ${plural(
                        sub.subfolderCount,
                        ['podsložka', 'podsložky', 'podsložek'],
                        ['subfolder', 'subfolders']
                      )}`
                    );
                  }
                  if (summary && summary.keepCount > 0) {
                    metaParts.push(
                      `${t('Vybráno', 'Picked')} ★ ${formatNumber(
                        summary.keepCount
                      )}`
                    );
                  }
                  if (summary && summary.trashCount > 0) {
                    metaParts.push(
                      `${t('Ke smazání', 'To delete')} ${formatNumber(
                        summary.trashCount
                      )}`
                    );
                  }
                  const hasKnownPhotos =
                    sub.photoCount === undefined ||
                    sub.photoCount > 0 ||
                    (sub.subfolderCount ?? 0) > 0;

                  return (
                    <li
                      key={sub.id}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 px-4 py-3 hover:bg-zinc-800/35 transition-colors"
                    >
                      <button
                        type="button"
                        onClick={() => handleEnterSubfolder(sub)}
                        className="flex items-center gap-3.5 min-w-0 flex-1 text-left cursor-pointer min-h-[44px] focus-visible:outline-2 focus-visible:outline-amber-500 rounded-lg"
                      >
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-800/80 text-zinc-200">
                          <Folder className="w-5 h-5" aria-hidden="true" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-zinc-100 truncate">
                            {sub.name}
                          </p>
                          <p className="text-xs text-zinc-400 tabular-nums truncate mt-0.5">
                            {metaParts.length > 0
                              ? metaParts.join(' · ')
                              : t('Otevřít složku', 'Open folder')}
                          </p>
                        </div>
                        <ChevronRight
                          className="w-4 h-4 text-zinc-500 shrink-0 sm:hidden"
                          aria-hidden="true"
                        />
                      </button>

                      <div className="flex items-center gap-1.5 self-end sm:self-auto shrink-0">
                        <button
                          type="button"
                          onClick={() => handleEnterSubfolder(sub)}
                          className="min-h-[40px] px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-white rounded-lg border border-zinc-800 hover:border-zinc-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          {t('Otevřít', 'Open')}
                        </button>

                        {hasKnownPhotos && (!fixedMode || fixedMode === 'select') && (
                          <button
                            type="button"
                            disabled={openingTargetId !== null}
                            onClick={() =>
                              void handleLaunchFolder(
                                {
                                  id: sub.id,
                                  name: sub.name,
                                  kind: activeRoot.kind,
                                  path: sub.path,
                                  treeId: sub.treeId || activeRoot.treeId,
                                  docId: sub.docId,
                                  relPathParts: sub.relPathParts,
                                },
                                'select'
                              )
                            }
                            className="min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                          >
                            <Star
                              className="w-3.5 h-3.5 fill-current shrink-0"
                              aria-hidden="true"
                            />
                            <span>
                              {isOpeningThis
                                ? t('Načítám…', 'Loading…')
                                : t('Výběr', 'Select')}
                            </span>
                          </button>
                        )}

                        {hasKnownPhotos && (!fixedMode || fixedMode === 'delete') && (
                          <button
                            type="button"
                            disabled={openingTargetId !== null}
                            onClick={() =>
                              void handleLaunchFolder(
                                {
                                  id: sub.id,
                                  name: sub.name,
                                  kind: activeRoot.kind,
                                  path: sub.path,
                                  treeId: sub.treeId || activeRoot.treeId,
                                  docId: sub.docId,
                                  relPathParts: sub.relPathParts,
                                },
                                'delete'
                              )
                            }
                            className="min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                          >
                            <Trash2
                              className="w-3.5 h-3.5 shrink-0"
                              aria-hidden="true"
                            />
                            <span>{t('Mazání', 'Delete')}</span>
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Read-Only Photo Preview Grid (strictly non-selectable) */}
          {!loadingDir && listing && listing.photos.length > 0 && (
            <div className="rounded-2xl border border-zinc-800 bg-[#141417] p-4 sm:p-5 space-y-3.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-display text-sm sm:text-base font-semibold text-zinc-100">
                  {t('Fotky v této složce', 'Photos in this folder')}
                </h3>
                <p className="text-xs text-zinc-400 tabular-nums">
                  {formatNumber(listing.photos.length)}{' '}
                  {plural(
                    listing.photos.length,
                    ['snímek', 'snímky', 'snímků'],
                    ['photo', 'photos']
                  )}{' '}
                  ·{' '}
                  {t(
                    'pouze náhled (výběr probíhá po celých složkách)',
                    'preview only (selection works at the folder level)'
                  )}
                </p>
              </div>

              <div
                aria-label={t(
                  'Pouze náhled fotografií v aktuální složce',
                  'Read-only preview of photos in current folder'
                )}
                className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2 select-none"
              >
                {visiblePhotos.map((photo) => {
                  const thumb = thumbUrls[photo.id];
                  const failed = failedThumbs[photo.id];
                  const raw = isPhotoRaw(photo);
                  const ext = getPhotoExtUpper(photo);
                  return (
                    <figure
                      key={photo.id}
                      className="relative aspect-square rounded-xl overflow-hidden bg-[#09090B] border border-zinc-800/80 pointer-events-none select-none"
                    >
                      {thumb ? (
                        <img
                          src={thumb}
                          alt={photo.name}
                          loading="lazy"
                          decoding="async"
                          draggable={false}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 px-2 text-center bg-zinc-900/80">
                          <ImageIcon
                            className={`w-5 h-5 ${
                              failed ? 'text-zinc-500' : 'text-zinc-600 animate-pulse'
                            }`}
                            aria-hidden="true"
                          />
                          <span className="font-mono text-[10px] font-medium text-zinc-400">
                            {ext}
                          </span>
                        </div>
                      )}
                      <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-2 pt-4 pb-1.5 flex items-center justify-between gap-1 text-[10px] text-zinc-200">
                        <span className="truncate">{photo.name}</span>
                        {raw && (
                          <span className="font-mono text-[9px] text-amber-300 shrink-0">
                            {ext}
                          </span>
                        )}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>

              {listing.photos.length > visiblePreviewCount && (
                <div className="pt-1 flex justify-center">
                  <button
                    type="button"
                    onClick={() =>
                      setVisiblePreviewCount((c) => c + PREVIEW_PAGE_SIZE)
                    }
                    className="min-h-[42px] px-4 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-zinc-200 hover:border-zinc-500 hover:text-white text-xs font-medium transition-colors cursor-pointer tabular-nums"
                  >
                    {t(
                      `Zobrazit další náhledy (zbývá ${formatNumber(
                        listing.photos.length - visiblePreviewCount
                      )})`,
                      `Show more previews (${formatNumber(
                        listing.photos.length - visiblePreviewCount
                      )} remaining)`
                    )}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

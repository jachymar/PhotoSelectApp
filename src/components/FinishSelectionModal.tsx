import React, { useEffect, useMemo, useState } from 'react';
import {
  Star,
  X,
  AlertTriangle,
  CheckCircle2,
  Image as ImageIcon,
  FileText,
  Share2,
  FolderPlus,
  Copy,
  FolderInput,
  Check,
  Loader2,
  Folder,
  FolderOpen,
  ChevronRight,
  Search,
  Plus,
} from 'lucide-react';
import {
  AuthExpiredError,
  DriveFolder,
  DrivePhotoFile,
  LIKED_SUBFOLDER_NAME,
  copyDriveFileToFolder,
  createDriveFolder,
  findDriveSubfolder,
  findOrCreateDriveSubfolder,
  formatBytes,
  listDriveFolderFileNames,
  listDriveFolders,
  moveDriveFileToFolder,
} from '../lib/driveApi';
import {
  WebDirectoryHandleLike,
  buildLikedListText,
  downloadTextFile,
  exportPhotosToWebDirectoryHandle,
  exportPickedLocalPhotos,
  listFileNamesInWebDirectory,
  listSubfolderNamesInWebDirectory,
  pickWebDirectoryHandle,
  readPreferredExportFolderName,
  sanitizeExportFolderName,
  supportsWebDirectoryPicker,
  writePreferredExportFolderName,
} from '../lib/localMedia';
import { getFastPreviewThumbnailUrl } from '../lib/rawParser';
import { triggerHaptic } from '../lib/haptics';

export type LikedTransferMode = 'copy' | 'move';
export type ExportFormatFilter = 'all' | 'jpg' | 'raw';
export type ExportDestinationMode = 'subfolder' | 'external';

const LOCAL_EXPORTED_HISTORY_PREFIX = 'selectra_liked_exported_v1:';
const FOLDER_NAME_PRESETS = ['Liked', 'Výběr', 'Upravené', 'Finální'];

function normalizeFileNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function buildHistoryBucketKey(
  folderId: string | undefined,
  destKey: string
): string {
  return `${LOCAL_EXPORTED_HISTORY_PREFIX}${folderId || 'default'}:${destKey
    .trim()
    .toLowerCase()}`;
}

function loadExportedNamesHistory(
  folderId?: string,
  destKey = LIKED_SUBFOLDER_NAME
): Set<string> {
  if (!folderId || typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(
      buildHistoryBucketKey(folderId, destKey)
    );
    const legacyRaw =
      destKey.toLowerCase() === 'liked'
        ? window.localStorage.getItem(
            `${LOCAL_EXPORTED_HISTORY_PREFIX}${folderId}`
          )
        : null;
    const out = new Set<string>();
    for (const r of [raw, legacyRaw]) {
      if (!r) continue;
      const parsed = JSON.parse(r);
      if (!Array.isArray(parsed)) continue;
      for (const x of parsed) {
        if (typeof x === 'string' && x.trim().length > 0) {
          out.add(normalizeFileNameKey(x));
        }
      }
    }
    return out;
  } catch {
    return new Set();
  }
}

function saveExportedNamesHistory(
  folderId: string | undefined,
  destKey: string,
  names: Iterable<string>
): void {
  if (!folderId || typeof window === 'undefined') return;
  try {
    const existing = loadExportedNamesHistory(folderId, destKey);
    for (const n of names) {
      const key = normalizeFileNameKey(n);
      if (key) existing.add(key);
    }
    const arr = Array.from(existing).slice(-5000);
    window.localStorage.setItem(
      buildHistoryBucketKey(folderId, destKey),
      JSON.stringify(arr)
    );
  } catch {
    // Ignore storage quota errors
  }
}

interface FinishSelectionModalProps {
  isOpen: boolean;
  folder?: DriveFolder | null;
  pickedFiles: DrivePhotoFile[];
  pickedShotCount: number;
  thumbnails: Record<string, string>;
  accessToken?: string | null;
  isStillLoadingFolder?: boolean;
  onCancel: () => void;
  onAuthExpired: () => void;
  onComplete: (
    processedIds: string[],
    mode: LikedTransferMode,
    failedItems: { file: DrivePhotoFile; error: string }[],
    customMessage?: string
  ) => void;
}

export const FinishSelectionModal: React.FC<FinishSelectionModalProps> = ({
  isOpen,
  folder,
  pickedFiles,
  pickedShotCount,
  thumbnails,
  accessToken,
  isStillLoadingFolder = false,
  onCancel,
  onAuthExpired,
  onComplete,
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exportFormat, setExportFormat] = useState<ExportFormatFilter>('all');
  const [transferMode, setTransferMode] = useState<LikedTransferMode>('copy');
  const [destinationMode, setDestinationMode] =
    useState<ExportDestinationMode>('subfolder');
  const [customFolderName, setCustomFolderName] = useState<string>(() =>
    readPreferredExportFolderName()
  );
  const [useSubfolderInExternal, setUseSubfolderInExternal] =
    useState<boolean>(true);

  // External destination state for Google Drive
  const [driveBreadcrumbs, setDriveBreadcrumbs] = useState<
    Array<{ id: string; name: string }>
  >([{ id: 'root', name: 'Můj disk' }]);
  const [driveSearchQuery, setDriveSearchQuery] = useState('');
  const [driveChildFolders, setDriveChildFolders] = useState<DriveFolder[]>([]);
  const [isLoadingDriveFolders, setIsLoadingDriveFolders] = useState(false);
  const [selectedExternalDriveFolder, setSelectedExternalDriveFolder] =
    useState<DriveFolder | null>(null);
  const [newDriveFolderName, setNewDriveFolderName] = useState('');
  const [isCreatingDriveFolder, setIsCreatingDriveFolder] = useState(false);

  // External destination state for Android SAF or Desktop Web Directory Picker
  const [externalSafFolder, setExternalSafFolder] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [externalWebDirHandle, setExternalWebDirHandle] =
    useState<WebDirectoryHandleLike | null>(null);
  const [externalWebSubfolders, setExternalWebSubfolders] = useState<string[]>(
    []
  );

  const [visibleLimit, setVisibleLimit] = useState(100);
  const [isCheckingExisting, setIsCheckingExisting] = useState(false);
  const [existingInLikedNames, setExistingInLikedNames] = useState<Set<string>>(
    () => new Set()
  );
  const [cachedTargetDriveFolderId, setCachedTargetDriveFolderId] = useState<
    string | null
  >(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isExportingReadOnly, setIsExportingReadOnly] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<{
    processedCount: number;
    skippedCount: number;
    failed: { file: DrivePhotoFile; error: string }[];
  } | null>(null);

  const sourceKind =
    folder?.sourceKind || pickedFiles[0]?.sourceKind || 'drive';
  const capabilities = folder?.capabilities;
  const isDrive = sourceKind === 'drive';
  const isAndroidSaf = sourceKind === 'android-saf';
  const canUseWebDirPicker = !isDrive && !isAndroidSaf && supportsWebDirectoryPicker();
  const isReadOnlyLocal =
    !isDrive &&
    !isAndroidSaf &&
    !(destinationMode === 'external' && externalWebDirHandle) &&
    (sourceKind === 'local-file' || Boolean(capabilities?.isReadOnlyFallback));

  const cleanFolderName = useMemo(
    () => sanitizeExportFolderName(customFolderName),
    [customFolderName]
  );

  const targetDisplayLabel = useMemo(() => {
    if (destinationMode === 'subfolder') {
      return folder?.name
        ? `${folder.name} / ${cleanFolderName}`
        : cleanFolderName;
    }
    if (isDrive) {
      const base =
        selectedExternalDriveFolder?.name ||
        driveBreadcrumbs[driveBreadcrumbs.length - 1]?.name ||
        'Můj disk';
      return useSubfolderInExternal ? `${base} / ${cleanFolderName}` : base;
    }
    if (isAndroidSaf) {
      if (!externalSafFolder) return `Jiná složka / ${cleanFolderName}`;
      return useSubfolderInExternal
        ? `${externalSafFolder.name} / ${cleanFolderName}`
        : externalSafFolder.name;
    }
    if (externalWebDirHandle) {
      return useSubfolderInExternal
        ? `${externalWebDirHandle.name} / ${cleanFolderName}`
        : externalWebDirHandle.name;
    }
    return cleanFolderName;
  }, [
    destinationMode,
    folder?.name,
    cleanFolderName,
    isDrive,
    selectedExternalDriveFolder,
    driveBreadcrumbs,
    useSubfolderInExternal,
    isAndroidSaf,
    externalSafFolder,
    externalWebDirHandle,
  ]);

  // Format counts & smart labels across all picked files
  const { standardFiles, rawFiles, jpgLabel, rawLabel } = useMemo(() => {
    const std: DrivePhotoFile[] = [];
    const raw: DrivePhotoFile[] = [];
    for (const f of pickedFiles) {
      if (f.isRaw) raw.push(f);
      else std.push(f);
    }
    const allStdAreJpg =
      std.length === 0 ||
      std.every(
        (f) => f.fileExtension === 'jpg' || f.fileExtension === 'jpeg'
      );
    const hasCr3 = raw.some((f) => f.fileExtension === 'cr3');
    const allRawAreCr3 =
      raw.length > 0 && raw.every((f) => f.fileExtension === 'cr3');

    return {
      standardFiles: std,
      rawFiles: raw,
      jpgLabel: allStdAreJpg ? 'Jen JPG' : 'Jen JPG / foto',
      rawLabel: allRawAreCr3
        ? 'Jen CR3'
        : hasCr3
          ? 'Jen CR3 / RAW'
          : 'Jen RAW',
    };
  }, [pickedFiles]);

  // Initialize modal state on open
  useEffect(() => {
    if (!isOpen) return;
    setExportFormat('all');
    setTransferMode('copy');
    setDestinationMode('subfolder');
    setCustomFolderName(readPreferredExportFolderName());
    setUseSubfolderInExternal(true);
    setDriveBreadcrumbs([{ id: 'root', name: 'Můj disk' }]);
    setDriveSearchQuery('');
    setSelectedExternalDriveFolder(null);
    setNewDriveFolderName('');
    setExternalSafFolder(null);
    setExternalWebDirHandle(null);
    setExternalWebSubfolders([]);
    setVisibleLimit(100);
    setIsProcessing(false);
    setIsExportingReadOnly(false);
    setExportNote(null);
    setPermissionError(null);
    setProgress({ done: 0, total: 0 });
    setSummary(null);
    setCachedTargetDriveFolderId(null);
  }, [isOpen]);

  // Load Drive folders when browsing external destination on Google Drive
  useEffect(() => {
    if (!isOpen || !isDrive || destinationMode !== 'external' || !accessToken) {
      return;
    }
    let cancelled = false;
    const currentParentId =
      driveBreadcrumbs[driveBreadcrumbs.length - 1]?.id || 'root';

    const timer = window.setTimeout(
      () => {
        setIsLoadingDriveFolders(true);
        listDriveFolders(accessToken, {
          parentId: currentParentId,
          searchQuery: driveSearchQuery,
        })
          .then((list) => {
            if (cancelled) return;
            setDriveChildFolders(list);
          })
          .catch((err) => {
            if (cancelled) return;
            if (err instanceof AuthExpiredError) {
              onAuthExpired();
            }
          })
          .finally(() => {
            if (!cancelled) {
              setIsLoadingDriveFolders(false);
            }
          });
      },
      driveSearchQuery.trim() ? 220 : 0
    );

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    isOpen,
    isDrive,
    destinationMode,
    accessToken,
    driveBreadcrumbs,
    driveSearchQuery,
    onAuthExpired,
  ]);

  // Dynamically scan destination folder for already-exported files whenever target changes
  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    setCachedTargetDriveFolderId(null);

    const timer = window.setTimeout(() => {
      const checkExisting = async () => {
        setIsCheckingExisting(true);
        let existingNames = new Set<string>();
        let resolvedDriveTargetId: string | null = null;
        const historyKey = `${destinationMode}:${targetDisplayLabel}`;

        try {
          if (isDrive && accessToken && folder?.id) {
            if (destinationMode === 'subfolder') {
              const sub = await findDriveSubfolder(
                accessToken,
                folder.id,
                cleanFolderName
              );
              if (sub?.id) {
                resolvedDriveTargetId = sub.id;
                existingNames = await listDriveFolderFileNames(
                  accessToken,
                  sub.id
                );
              }
            } else {
              const parentId =
                selectedExternalDriveFolder?.id ||
                driveBreadcrumbs[driveBreadcrumbs.length - 1]?.id ||
                'root';
              if (useSubfolderInExternal) {
                const sub = await findDriveSubfolder(
                  accessToken,
                  parentId,
                  cleanFolderName
                );
                if (sub?.id) {
                  resolvedDriveTargetId = sub.id;
                  existingNames = await listDriveFolderFileNames(
                    accessToken,
                    sub.id
                  );
                }
              } else {
                resolvedDriveTargetId = parentId;
                existingNames = await listDriveFolderFileNames(
                  accessToken,
                  parentId
                );
              }
            }
          } else if (
            isAndroidSaf &&
            window.FrameCullNative?.listSubfolderFileNames
          ) {
            const targetRootId =
              destinationMode === 'external'
                ? externalSafFolder?.id
                : folder?.id;
            const subName =
              destinationMode === 'external' && !useSubfolderInExternal
                ? ''
                : cleanFolderName;
            if (targetRootId && subName) {
              const nativeNames =
                await window.FrameCullNative.listSubfolderFileNames(
                  targetRootId,
                  subName
                );
              existingNames = new Set(
                nativeNames
                  .filter((n) => typeof n === 'string' && n.trim().length > 0)
                  .map((n) => normalizeFileNameKey(n))
              );
            }
            for (const hist of loadExportedNamesHistory(
              targetRootId || folder?.id,
              cleanFolderName
            )) {
              existingNames.add(hist);
            }
          } else if (destinationMode === 'external' && externalWebDirHandle) {
            existingNames = await listFileNamesInWebDirectory(
              externalWebDirHandle,
              useSubfolderInExternal ? cleanFolderName : undefined
            );
          } else {
            existingNames = loadExportedNamesHistory(folder?.id, historyKey);
          }
        } catch (err) {
          if (err instanceof AuthExpiredError) {
            if (!cancelled) onAuthExpired();
            return;
          }
        }

        if (cancelled) return;

        const seenInPicked = new Set<string>(existingNames);
        const initialSelected = new Set<string>();
        for (const f of pickedFiles) {
          const key = normalizeFileNameKey(f.name);
          if (!existingNames.has(key) && !seenInPicked.has(key)) {
            initialSelected.add(f.id);
            seenInPicked.add(key);
          }
        }

        setCachedTargetDriveFolderId(resolvedDriveTargetId);
        setExistingInLikedNames(existingNames);
        setSelectedIds(initialSelected);
        setIsCheckingExisting(false);
      };

      void checkExisting();
    }, 140);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    isOpen,
    pickedFiles,
    isDrive,
    isAndroidSaf,
    accessToken,
    folder?.id,
    destinationMode,
    cleanFolderName,
    selectedExternalDriveFolder,
    driveBreadcrumbs,
    useSubfolderInExternal,
    externalSafFolder,
    externalWebDirHandle,
    targetDisplayLabel,
    onAuthExpired,
  ]);

  // Apply chosen format filter (`Vše` / `Jen JPG` / `Jen CR3`)
  const filteredFiles = useMemo(() => {
    if (exportFormat === 'jpg') return standardFiles;
    if (exportFormat === 'raw') return rawFiles;
    return pickedFiles;
  }, [exportFormat, pickedFiles, standardFiles, rawFiles]);

  // Detect files already in target folder (or repeated filename earlier in the same export batch)
  const {
    exportableFilteredFiles,
    alreadyInLikedFilteredIds,
    duplicateNameFilteredIds,
  } = useMemo(() => {
    const exportable: DrivePhotoFile[] = [];
    const inLikedIds = new Set<string>();
    const dupNameIds = new Set<string>();
    const seenNames = new Set<string>();

    for (const f of filteredFiles) {
      const key = normalizeFileNameKey(f.name);
      if (existingInLikedNames.has(key)) {
        inLikedIds.add(f.id);
      } else if (seenNames.has(key)) {
        dupNameIds.add(f.id);
      } else {
        seenNames.add(key);
        exportable.push(f);
      }
    }
    return {
      exportableFilteredFiles: exportable,
      alreadyInLikedFilteredIds: inLikedIds,
      duplicateNameFilteredIds: dupNameIds,
    };
  }, [filteredFiles, existingInLikedNames]);

  if (!isOpen) return null;

  const selectedFiles = exportableFilteredFiles.filter((f) =>
    selectedIds.has(f.id)
  );
  const rawSelectedCount = selectedFiles.filter((f) => f.isRaw).length;
  const totalBytes = selectedFiles.reduce(
    (acc, f) => acc + (f.sizeBytes || 0),
    0
  );
  const visibleFiles = filteredFiles.slice(0, visibleLimit);
  const remainingHidden = Math.max(0, filteredFiles.length - visibleLimit);
  const skippedExistingCount = alreadyInLikedFilteredIds.size;

  const toggleFile = (id: string) => {
    if (isProcessing || isCheckingExisting) return;
    if (alreadyInLikedFilteredIds.has(id) || duplicateNameFilteredIds.has(id)) {
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allExportableSelected =
    exportableFilteredFiles.length > 0 &&
    exportableFilteredFiles.every((f) => selectedIds.has(f.id));

  const handleToggleSelectAllInView = () => {
    if (isProcessing || isCheckingExisting) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allExportableSelected) {
        for (const f of exportableFilteredFiles) {
          next.delete(f.id);
        }
      } else {
        for (const f of exportableFilteredFiles) {
          next.add(f.id);
        }
      }
      return next;
    });
  };

  const handleCreateDriveFolderHere = async () => {
    if (!accessToken || !newDriveFolderName.trim() || isCreatingDriveFolder) {
      return;
    }
    setIsCreatingDriveFolder(true);
    setPermissionError(null);
    try {
      const parentId =
        driveBreadcrumbs[driveBreadcrumbs.length - 1]?.id || 'root';
      const created = await createDriveFolder(
        accessToken,
        parentId,
        newDriveFolderName.trim()
      );
      setNewDriveFolderName('');
      setDriveChildFolders((prev) => {
        if (prev.some((f) => f.id === created.id)) return prev;
        return [created, ...prev];
      });
      setSelectedExternalDriveFolder(created);
      setDriveBreadcrumbs((prev) => [
        ...prev,
        { id: created.id, name: created.name },
      ]);
      triggerHaptic('selection');
    } catch (err: unknown) {
      if (err instanceof AuthExpiredError) {
        onAuthExpired();
        return;
      }
      setPermissionError(
        err instanceof Error
          ? err.message
          : 'Nepodařilo se vytvořit novou složku na Google Drive.'
      );
    } finally {
      setIsCreatingDriveFolder(false);
    }
  };

  const handlePickExternalSafFolder = async () => {
    if (!window.FrameCullNative?.pickDirectoryTree) return;
    setPermissionError(null);
    try {
      const picked = await window.FrameCullNative.pickDirectoryTree();
      if (picked) {
        setExternalSafFolder({
          id: picked.folderId,
          name: picked.folderName || 'Vybraná složka',
        });
        triggerHaptic('selection');
      }
    } catch (err: unknown) {
      setPermissionError(
        err instanceof Error
          ? err.message
          : 'Nepodařilo se vybrat cílovou složku v úložišti.'
      );
    }
  };

  const handlePickExternalWebDirectory = async () => {
    setPermissionError(null);
    try {
      const handle = await pickWebDirectoryHandle();
      if (handle) {
        setExternalWebDirHandle(handle);
        const subs = await listSubfolderNamesInWebDirectory(handle);
        setExternalWebSubfolders(subs);
        triggerHaptic('selection');
      }
    } catch (err: unknown) {
      setPermissionError(
        err instanceof Error
          ? err.message
          : 'Nepodařilo se otevřít výběr cílové složky.'
      );
    }
  };

  const handleConfirmExportToLiked = async () => {
    if (selectedFiles.length === 0 || isProcessing || isCheckingExisting) return;

    triggerHaptic('selection');
    setPermissionError(null);
    writePreferredExportFolderName(cleanFolderName);

    if (destinationMode === 'external' && isAndroidSaf && !externalSafFolder) {
      setPermissionError(
        'Nejprve vyberte cílovou složku v úložišti (nebo přepněte na Podsložku v aktuální složce).'
      );
      return;
    }

    // Direct Web File System Access export when user picked an external folder on desktop
    if (destinationMode === 'external' && externalWebDirHandle) {
      setIsProcessing(true);
      setProgress({ done: 0, total: selectedFiles.length });
      try {
        const res = await exportPhotosToWebDirectoryHandle(
          externalWebDirHandle,
          useSubfolderInExternal ? cleanFolderName : null,
          selectedFiles,
          (done, total) => setProgress({ done, total })
        );
        const succeededNames = new Set(
          selectedFiles
            .filter((f) => !res.failed.some((fl) => fl.name === f.name))
            .map((f) => f.name)
        );
        const processedIds = selectedFiles
          .filter((f) => succeededNames.has(f.name))
          .map((f) => f.id);
        const failedItems = res.failed
          .map((fl) => {
            const file = selectedFiles.find((f) => f.name === fl.name);
            return file ? { file, error: fl.error } : null;
          })
          .filter(
            (x): x is { file: DrivePhotoFile; error: string } => x !== null
          );

        setIsProcessing(false);
        triggerHaptic('confirm');
        const customMsg = `Zkopírováno do složky „${res.targetFolderLabel}“: ${res.succeededCount.toLocaleString('cs-CZ')} souborů.`;
        if (failedItems.length === 0) {
          onComplete(processedIds, 'copy', [], customMsg);
        } else {
          setSummary({
            processedCount: res.succeededCount,
            skippedCount: skippedExistingCount,
            failed: failedItems,
          });
          onComplete(processedIds, 'copy', failedItems, customMsg);
        }
      } catch (err: unknown) {
        setIsProcessing(false);
        setPermissionError(
          err instanceof Error
            ? err.message
            : 'Chyba při zápisu do vybrané složky.'
        );
      }
      return;
    }

    if (isReadOnlyLocal) {
      await handleExportReadOnlyFiles();
      return;
    }

    setIsProcessing(true);
    setProgress({ done: 0, total: selectedFiles.length });

    const processedIds: string[] = [];
    const newlyExportedNames: string[] = [];
    const failedItems: { file: DrivePhotoFile; error: string }[] = [];
    let skippedRuntimeCount = 0;

    if (isAndroidSaf && window.FrameCullNative) {
      try {
        const uriToFile = new Map<string, DrivePhotoFile>();
        const uris: string[] = [];
        for (const f of selectedFiles) {
          if (f.nativeUri) {
            uriToFile.set(f.nativeUri, f);
            uris.push(f.nativeUri);
          } else {
            failedItems.push({ file: f, error: 'Chybí Android SAF URI.' });
          }
        }

        const nativeOp =
          transferMode === 'move'
            ? window.FrameCullNative.moveToSubfolder
            : window.FrameCullNative.copyToSubfolder;

        if (!nativeOp) {
          throw new Error(
            `Nativní Android obal v této verzi nepodporuje zápis do složky „${cleanFolderName}“.`
          );
        }

        const targetFolderId =
          destinationMode === 'external' && externalSafFolder
            ? externalSafFolder.id
            : folder?.id || '';
        const targetSubfolderName =
          destinationMode === 'external' && !useSubfolderInExternal
            ? '.'
            : cleanFolderName;

        const result = await nativeOp(
          targetFolderId,
          targetSubfolderName,
          uris
        );
        for (const uri of result.succeeded) {
          const matched = uriToFile.get(uri);
          if (matched) {
            processedIds.push(matched.id);
            newlyExportedNames.push(matched.name);
          }
        }
        for (const fail of result.failed) {
          const matched = uriToFile.get(fail.uri);
          if (matched) {
            failedItems.push({ file: matched, error: fail.error });
          }
        }
        if (newlyExportedNames.length > 0) {
          saveExportedNamesHistory(
            targetFolderId,
            cleanFolderName,
            newlyExportedNames
          );
        }
        setProgress({ done: selectedFiles.length, total: selectedFiles.length });
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? err.message
            : `Chyba při zápisu do složky „${cleanFolderName}“ na zařízení.`;
        for (const f of selectedFiles) {
          if (!processedIds.includes(f.id)) {
            failedItems.push({ file: f, error: msg });
          }
        }
      }
    } else {
      // Google Drive API
      if (!accessToken || !folder) {
        onAuthExpired();
        setIsProcessing(false);
        return;
      }

      try {
        let targetDriveFolder: DriveFolder;
        if (cachedTargetDriveFolderId) {
          targetDriveFolder = {
            id: cachedTargetDriveFolderId,
            name: targetDisplayLabel,
          };
        } else if (destinationMode === 'subfolder') {
          targetDriveFolder = await findOrCreateDriveSubfolder(
            accessToken,
            folder.id,
            cleanFolderName
          );
        } else {
          const baseParent =
            selectedExternalDriveFolder ||
            driveBreadcrumbs[driveBreadcrumbs.length - 1] || {
              id: 'root',
              name: 'Můj disk',
            };
          if (useSubfolderInExternal) {
            targetDriveFolder = await findOrCreateDriveSubfolder(
              accessToken,
              baseParent.id,
              cleanFolderName
            );
          } else {
            targetDriveFolder = {
              id: baseParent.id,
              name: baseParent.name,
            };
          }
        }

        const liveExistingNames = new Set(existingInLikedNames);
        if (!cachedTargetDriveFolderId && targetDriveFolder.id) {
          const freshNames = await listDriveFolderFileNames(
            accessToken,
            targetDriveFolder.id
          );
          for (const n of freshNames) liveExistingNames.add(n);
        }

        const batchSize = 4;
        for (let i = 0; i < selectedFiles.length; i += batchSize) {
          const batch = selectedFiles.slice(i, i + batchSize);
          await Promise.all(
            batch.map(async (file) => {
              const nameKey = normalizeFileNameKey(file.name);
              if (liveExistingNames.has(nameKey)) {
                skippedRuntimeCount++;
                setProgress((p) => ({ ...p, done: p.done + 1 }));
                return;
              }
              liveExistingNames.add(nameKey);

              try {
                if (transferMode === 'move') {
                  const sourceParentId = file.parents?.[0] || folder.id;
                  await moveDriveFileToFolder(
                    accessToken,
                    file.id,
                    sourceParentId,
                    targetDriveFolder.id,
                    targetDisplayLabel
                  );
                } else {
                  await copyDriveFileToFolder(
                    accessToken,
                    file.id,
                    targetDriveFolder.id,
                    file.name,
                    targetDisplayLabel
                  );
                }
                processedIds.push(file.id);
                newlyExportedNames.push(file.name);
              } catch (err: unknown) {
                liveExistingNames.delete(nameKey);
                if (err instanceof AuthExpiredError) {
                  onAuthExpired();
                  return;
                }
                failedItems.push({
                  file,
                  error: err instanceof Error ? err.message : 'Neznámá chyba',
                });
              } finally {
                setProgress((p) => ({ ...p, done: p.done + 1 }));
              }
            })
          );
        }
      } catch (err: unknown) {
        if (err instanceof AuthExpiredError) {
          onAuthExpired();
          setIsProcessing(false);
          return;
        }
        const msg =
          err instanceof Error
            ? err.message
            : `Nepodařilo se připravit cílovou složku „${targetDisplayLabel}“ na Google Drive.`;
        for (const f of selectedFiles) {
          if (!processedIds.includes(f.id)) {
            failedItems.push({ file: f, error: msg });
          }
        }
      }
    }

    if (newlyExportedNames.length > 0) {
      setExistingInLikedNames((prev) => {
        const next = new Set(prev);
        for (const n of newlyExportedNames) {
          next.add(normalizeFileNameKey(n));
        }
        return next;
      });
    }

    setIsProcessing(false);
    triggerHaptic('confirm');

    const count = processedIds.length;
    const totalSkipped = skippedExistingCount + skippedRuntimeCount;
    const noun = count === 1 ? 'soubor' : count < 5 ? 'soubory' : 'souborů';
    const actionWord =
      transferMode === 'move' ? 'Přesunuto' : 'Zkopírováno';
    const whereWord = isDrive ? 'na Google Drive ' : '';
    const formatNote =
      exportFormat === 'jpg'
        ? ` (${jpgLabel.toLowerCase()})`
        : exportFormat === 'raw'
          ? ` (${rawLabel.toLowerCase()})`
          : '';
    const skipNote =
      totalSkipped > 0
        ? ` · ${totalSkipped.toLocaleString('cs-CZ')} již v „${targetDisplayLabel}“ přeskočeno`
        : '';

    const customMsg =
      count > 0
        ? `${actionWord} do složky „${targetDisplayLabel}“ ${whereWord}${formatNote}: ${count.toLocaleString('cs-CZ')} ${noun}${skipNote}.`
        : totalSkipped > 0
          ? `Všechny vybrané soubory (${totalSkipped.toLocaleString('cs-CZ')}) už ve složce „${targetDisplayLabel}“ jsou — nic nebylo duplikováno.`
          : undefined;

    if (failedItems.length === 0) {
      onComplete(processedIds, transferMode, [], customMsg);
    } else {
      setSummary({
        processedCount: count,
        skippedCount: totalSkipped,
        failed: failedItems,
      });
      onComplete(processedIds, transferMode, failedItems, customMsg);
    }
  };

  const handleDownloadList = () => {
    const safeName = (folder?.name || 'selectra').replace(
      /[^a-zA-Z0-9_-]+/g,
      '_'
    );
    const safeExport = cleanFolderName.replace(/[^a-zA-Z0-9_-]+/g, '_');
    downloadTextFile(
      `${safeName}_${safeExport}.txt`,
      buildLikedListText(selectedFiles)
    );
    setExportNote('Seznam vybraných souborů (.txt) byl stažen.');
  };

  const handleExportReadOnlyFiles = async () => {
    if (selectedFiles.length === 0 || isExportingReadOnly) return;
    setIsExportingReadOnly(true);
    setExportNote(null);
    try {
      const res = await exportPickedLocalPhotos(selectedFiles);
      if (res.count > 0) {
        saveExportedNamesHistory(
          folder?.id,
          `${destinationMode}:${targetDisplayLabel}`,
          selectedFiles.map((f) => f.name)
        );
        const msg =
          res.method === 'share'
            ? `Sdíleno ${res.count.toLocaleString('cs-CZ')} vybraných souborů.`
            : `Staženo ${res.count.toLocaleString('cs-CZ')} vybraných souborů.`;
        setExportNote(msg);
        onComplete(
          selectedFiles.map((f) => f.id),
          'copy',
          [],
          msg
        );
      }
    } catch (err: unknown) {
      setExportNote(
        err instanceof Error
          ? err.message
          : 'Export vybraných snímků se nezdařil.'
      );
    } finally {
      setIsExportingReadOnly(false);
    }
  };

  const currentDriveCrumb =
    driveBreadcrumbs[driveBreadcrumbs.length - 1] || {
      id: 'root',
      name: 'Můj disk',
    };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-2 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="finish-modal-title"
    >
      <div className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-[#141417] shadow-2xl overflow-hidden flex flex-col max-h-[94dvh]">
        {/* Header */}
        <div className="flex items-start justify-between gap-2.5 px-3.5 sm:px-6 py-3 sm:py-4 border-b border-zinc-800">
          <div className="flex items-start gap-2.5 sm:gap-3 min-w-0">
            <div className="flex h-9 w-9 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
              <Star
                className="w-4 h-4 sm:w-5 sm:h-5 fill-amber-400"
                aria-hidden="true"
              />
            </div>
            <div className="min-w-0">
              <h2
                id="finish-modal-title"
                className="font-display text-sm sm:text-lg font-semibold text-zinc-100 truncate"
              >
                Dokončit výběr — „{targetDisplayLabel}“
              </h2>
              <p className="mt-0.5 text-[11px] sm:text-sm text-zinc-400 tabular-nums">
                Vybráno {pickedShotCount.toLocaleString('cs-CZ')}{' '}
                {pickedShotCount === 1
                  ? 'snímek'
                  : pickedShotCount < 5
                    ? 'snímky'
                    : 'snímků'}{' '}
                · k uložení{' '}
                <strong className="text-zinc-200 font-semibold">
                  {selectedFiles.length.toLocaleString('cs-CZ')}
                </strong>{' '}
                {selectedFiles.length === 1
                  ? 'soubor'
                  : selectedFiles.length < 5
                    ? 'soubory'
                    : 'souborů'}
                {rawSelectedCount > 0 && exportFormat === 'all'
                  ? ' (vč. RAW)'
                  : ''}{' '}
                · {formatBytes(totalBytes)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isProcessing}
            className="min-h-[38px] min-w-[38px] sm:min-h-[40px] sm:min-w-[40px] inline-flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-40 shrink-0"
            aria-label="Zavřít dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-3.5 sm:p-6 overflow-y-auto space-y-4 flex-1">
          {isStillLoadingFolder && (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
              <span>
                Složka se stále načítá na pozadí. Tento export obsahuje zatím
                vybrané snímky.
              </span>
            </div>
          )}

          {permissionError && (
            <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <span>{permissionError}</span>
            </div>
          )}

          {/* Destination Folder Name + Location Mode (Subfolder vs External Folder) */}
          <div className="rounded-xl border border-zinc-800 bg-[#09090B] p-3 sm:p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <label
                htmlFor="export-folder-name-input"
                className="text-xs font-semibold text-zinc-200"
              >
                Název cílové složky pro vybrané fotky
              </label>
              <div className="flex flex-wrap items-center gap-1">
                {FOLDER_NAME_PRESETS.map((preset) => {
                  const active =
                    cleanFolderName.toLowerCase() === preset.toLowerCase();
                  return (
                    <button
                      key={preset}
                      type="button"
                      disabled={isProcessing}
                      onClick={() => {
                        setCustomFolderName(preset);
                        writePreferredExportFolderName(preset);
                      }}
                      className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                        active
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                          : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200 border border-zinc-800'
                      }`}
                    >
                      {preset}
                    </button>
                  );
                })}
              </div>
            </div>

            <input
              id="export-folder-name-input"
              type="text"
              value={customFolderName}
              disabled={isProcessing}
              onChange={(e) => setCustomFolderName(e.target.value)}
              placeholder="Liked"
              maxLength={80}
              className="w-full min-h-[40px] px-3 py-2 rounded-lg border border-zinc-700 bg-[#141417] text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
            />

            {/* Location Mode: Subfolder inside current folder vs Any External Folder */}
            <div className="space-y-2 pt-1">
              <p className="text-xs font-medium text-zinc-400">
                Kam složku uložit
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => setDestinationMode('subfolder')}
                  className={`text-left p-2.5 sm:p-3 rounded-xl border transition-colors cursor-pointer ${
                    destinationMode === 'subfolder'
                      ? 'border-amber-500/70 bg-amber-500/10'
                      : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                  }`}
                >
                  <p className="text-xs sm:text-sm font-semibold text-zinc-100 flex items-center gap-1.5">
                    <FolderPlus className="w-4 h-4 text-amber-400 shrink-0" />
                    <span className="truncate">Podsložka v aktuální složce</span>
                  </p>
                  <p className="mt-0.5 text-[11px] text-zinc-400 truncate">
                    {folder?.name
                      ? `${folder.name} / ${cleanFolderName}`
                      : `Vytvoří podsložku „${cleanFolderName}“`}
                  </p>
                </button>

                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => setDestinationMode('external')}
                  className={`text-left p-2.5 sm:p-3 rounded-xl border transition-colors cursor-pointer ${
                    destinationMode === 'external'
                      ? 'border-amber-500/70 bg-amber-500/10'
                      : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                  }`}
                >
                  <p className="text-xs sm:text-sm font-semibold text-zinc-100 flex items-center gap-1.5">
                    <FolderOpen className="w-4 h-4 text-amber-400 shrink-0" />
                    <span className="truncate">Jiná složka (kdekoliv)</span>
                  </p>
                  <p className="mt-0.5 text-[11px] text-zinc-400 truncate">
                    Procházet existující složky nebo vytvořit novou mimo zdroj
                  </p>
                </button>
              </div>
            </div>

            {/* External Folder Browser / Picker */}
            {destinationMode === 'external' && (
              <div className="mt-2 pt-3 border-t border-zinc-800/90 space-y-3">
                <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={useSubfolderInExternal}
                    disabled={isProcessing}
                    onChange={(e) =>
                      setUseSubfolderInExternal(e.target.checked)
                    }
                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 accent-amber-500"
                  />
                  <span>
                    Vytvořit uvnitř vybrané složky podsložku „
                    <strong className="text-amber-300">{cleanFolderName}</strong>
                    “ (při odškrtnutí uloží fotky přímo do vybrané složky)
                  </span>
                </label>

                {isDrive ? (
                  <div className="rounded-xl border border-zinc-800 bg-[#141417] p-3 space-y-2.5">
                    {/* Breadcrumbs */}
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-1 flex-wrap text-xs">
                        {driveBreadcrumbs.map((crumb, idx) => (
                          <React.Fragment key={`${crumb.id}-${idx}`}>
                            {idx > 0 && (
                              <ChevronRight className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setDriveSearchQuery('');
                                setDriveBreadcrumbs((prev) =>
                                  prev.slice(0, idx + 1)
                                );
                                setSelectedExternalDriveFolder(
                                  crumb.id === 'root'
                                    ? null
                                    : { id: crumb.id, name: crumb.name }
                                );
                              }}
                              className={`px-1.5 py-0.5 rounded hover:bg-zinc-800 transition-colors cursor-pointer ${
                                idx === driveBreadcrumbs.length - 1
                                  ? 'font-semibold text-amber-300'
                                  : 'text-zinc-400 hover:text-zinc-200'
                              }`}
                            >
                              {crumb.name}
                            </button>
                          </React.Fragment>
                        ))}
                      </div>
                      <span className="text-[11px] text-emerald-400 font-medium">
                        Cíl: {targetDisplayLabel}
                      </span>
                    </div>

                    {/* Search + Create New Folder in Current Drive Directory */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          type="text"
                          value={driveSearchQuery}
                          onChange={(e) => setDriveSearchQuery(e.target.value)}
                          placeholder="Hledat složku na Google Drive…"
                          className="w-full min-h-[36px] pl-8 pr-2.5 py-1.5 rounded-lg border border-zinc-800 bg-[#09090B] text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
                        />
                      </div>

                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={newDriveFolderName}
                          onChange={(e) =>
                            setNewDriveFolderName(e.target.value)
                          }
                          placeholder={`Nová složka v „${currentDriveCrumb.name}“…`}
                          className="flex-1 min-w-0 min-h-[36px] px-2.5 py-1.5 rounded-lg border border-zinc-800 bg-[#09090B] text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500"
                        />
                        <button
                          type="button"
                          disabled={
                            !newDriveFolderName.trim() || isCreatingDriveFolder
                          }
                          onClick={() => void handleCreateDriveFolderHere()}
                          className="min-h-[36px] px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-amber-300 inline-flex items-center gap-1 shrink-0 cursor-pointer disabled:opacity-40"
                        >
                          {isCreatingDriveFolder ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Plus className="w-3.5 h-3.5" />
                          )}
                          <span>Vytvořit</span>
                        </button>
                      </div>
                    </div>

                    {/* Subfolder list */}
                    <div className="max-h-36 overflow-y-auto rounded-lg border border-zinc-800/90 bg-[#09090B] divide-y divide-zinc-800/60">
                      {isLoadingDriveFolders ? (
                        <div className="p-3 flex items-center justify-center gap-2 text-xs text-zinc-400">
                          <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                          <span>Načítám složky z Google Drive…</span>
                        </div>
                      ) : driveChildFolders.length === 0 ? (
                        <div className="p-3 text-center text-xs text-zinc-500">
                          V „{currentDriveCrumb.name}“ nejsou žádné další
                          podsložky. Fotky se uloží do „{targetDisplayLabel}“.
                        </div>
                      ) : (
                        driveChildFolders.map((df) => {
                          const isCurrentPicked =
                            selectedExternalDriveFolder?.id === df.id;
                          return (
                            <div
                              key={df.id}
                              className={`flex items-center justify-between gap-2 px-3 py-2 text-xs transition-colors ${
                                isCurrentPicked
                                  ? 'bg-amber-500/15 text-amber-200'
                                  : 'hover:bg-zinc-900 text-zinc-200'
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  setDriveSearchQuery('');
                                  setSelectedExternalDriveFolder(df);
                                  setDriveBreadcrumbs((prev) => [
                                    ...prev,
                                    { id: df.id, name: df.name },
                                  ]);
                                }}
                                className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                              >
                                <Folder className="w-4 h-4 text-amber-400 shrink-0" />
                                <span className="truncate font-medium">
                                  {df.name}
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedExternalDriveFolder(df);
                                }}
                                className={`px-2 py-1 rounded text-[11px] font-semibold shrink-0 cursor-pointer ${
                                  isCurrentPicked
                                    ? 'bg-amber-500 text-zinc-950'
                                    : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                                }`}
                              >
                                {isCurrentPicked ? 'Vybráno' : 'Zvolit'}
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                ) : isAndroidSaf ? (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-xl border border-zinc-800 bg-[#141417] p-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-zinc-200 truncate">
                        {externalSafFolder
                          ? `Vybraná složka: ${externalSafFolder.name}`
                          : 'Zatím nebyla vybrána žádná jiná složka'}
                      </p>
                      <p className="text-[11px] text-zinc-400 truncate">
                        Cíl: {targetDisplayLabel}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handlePickExternalSafFolder()}
                      className="min-h-[38px] px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/40 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 transition-colors shrink-0 cursor-pointer"
                    >
                      {externalSafFolder
                        ? 'Změnit cílovou složku…'
                        : 'Vybrat cílovou složku v úložišti…'}
                    </button>
                  </div>
                ) : canUseWebDirPicker ? (
                  <div className="space-y-2 rounded-xl border border-zinc-800 bg-[#141417] p-3">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-zinc-200 truncate">
                          {externalWebDirHandle
                            ? `Vybraná složka: ${externalWebDirHandle.name}`
                            : 'Vyberte libovolnou složku v zařízení'}
                        </p>
                        <p className="text-[11px] text-zinc-400 truncate">
                          Cíl: {targetDisplayLabel}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handlePickExternalWebDirectory()}
                        className="min-h-[38px] px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/40 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 transition-colors shrink-0 cursor-pointer"
                      >
                        {externalWebDirHandle
                          ? 'Změnit cílovou složku…'
                          : 'Procházet a vybrat složku…'}
                      </button>
                    </div>
                    {externalWebSubfolders.length > 0 && (
                      <div className="pt-1.5 border-t border-zinc-800/80 flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] text-zinc-400">
                          Existující podsložky:
                        </span>
                        {externalWebSubfolders.slice(0, 12).map((sub) => (
                          <button
                            key={sub}
                            type="button"
                            onClick={() => {
                              setCustomFolderName(sub);
                              setUseSubfolderInExternal(true);
                            }}
                            className={`px-2 py-0.5 rounded text-[11px] cursor-pointer ${
                              cleanFolderName === sub && useSubfolderInExternal
                                ? 'bg-amber-500 text-zinc-950 font-semibold'
                                : 'bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
                            }`}
                          >
                            {sub}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-zinc-400">
                    V mobilním prohlížeči budou vybrané snímky vyexportovány
                    přes systémové sdílení / stažení se jménem sady „
                    {cleanFolderName}“.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Export Format Filter: Vše (JPG + RAW) / Jen JPG / Jen CR3 (RAW) */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-zinc-400">
              Formát pro export do „{targetDisplayLabel}“
            </p>
            <div
              className="grid grid-cols-3 gap-1.5 p-1 rounded-xl border border-zinc-800 bg-[#09090B]"
              role="group"
              aria-label="Vyberte formát souborů pro export"
            >
              <button
                type="button"
                disabled={isProcessing || pickedFiles.length === 0}
                onClick={() => setExportFormat('all')}
                aria-pressed={exportFormat === 'all'}
                className={`min-h-[38px] px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap tabular-nums disabled:opacity-40 disabled:cursor-not-allowed ${
                  exportFormat === 'all'
                    ? 'bg-amber-500 text-zinc-950'
                    : 'text-zinc-300 hover:text-white hover:bg-zinc-900'
                }`}
              >
                Vše ({pickedFiles.length})
              </button>

              <button
                type="button"
                disabled={isProcessing || standardFiles.length === 0}
                onClick={() => setExportFormat('jpg')}
                aria-pressed={exportFormat === 'jpg'}
                className={`min-h-[38px] px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap tabular-nums disabled:opacity-40 disabled:cursor-not-allowed ${
                  exportFormat === 'jpg'
                    ? 'bg-amber-500 text-zinc-950'
                    : 'text-zinc-300 hover:text-white hover:bg-zinc-900'
                }`}
              >
                {jpgLabel} ({standardFiles.length})
              </button>

              <button
                type="button"
                disabled={isProcessing || rawFiles.length === 0}
                onClick={() => setExportFormat('raw')}
                aria-pressed={exportFormat === 'raw'}
                className={`min-h-[38px] px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap tabular-nums disabled:opacity-40 disabled:cursor-not-allowed ${
                  exportFormat === 'raw'
                    ? 'bg-amber-500 text-zinc-950'
                    : 'text-zinc-300 hover:text-white hover:bg-zinc-900'
                }`}
              >
                {rawLabel} ({rawFiles.length})
              </button>
            </div>
          </div>

          {/* Transfer Mode Selector (Copy vs Move) */}
          {!isReadOnlyLocal && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3">
              <button
                type="button"
                disabled={isProcessing}
                onClick={() => setTransferMode('copy')}
                className={`text-left p-3 sm:p-3.5 rounded-xl border transition-colors cursor-pointer ${
                  transferMode === 'copy'
                    ? 'border-amber-500/70 bg-amber-500/10'
                    : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                }`}
              >
                <p className="text-xs sm:text-sm font-semibold text-zinc-100 flex items-center gap-2">
                  <Copy className="w-4 h-4 text-amber-400 shrink-0" />
                  <span className="truncate">
                    Zkopírovat do „{cleanFolderName}“
                  </span>
                </p>
                <p className="mt-1 text-xs text-zinc-400">
                  Přidá jen soubory, které v cílové složce ještě nejsou. Původní
                  složka zůstane kompletní.
                </p>
              </button>

              <button
                type="button"
                disabled={
                  isProcessing ||
                  Boolean(
                    destinationMode === 'external' && externalWebDirHandle
                  )
                }
                onClick={() => setTransferMode('move')}
                className={`text-left p-3 sm:p-3.5 rounded-xl border transition-colors cursor-pointer disabled:opacity-40 ${
                  transferMode === 'move'
                    ? 'border-amber-500/70 bg-amber-500/10'
                    : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                }`}
              >
                <p className="text-xs sm:text-sm font-semibold text-zinc-100 flex items-center gap-2">
                  <FolderInput className="w-4 h-4 text-amber-400 shrink-0" />
                  <span className="truncate">
                    Přesunout do „{cleanFolderName}“
                  </span>
                </p>
                <p className="mt-1 text-xs text-zinc-400">
                  {isDrive
                    ? `Bleskový přesun na Google Drive (bez duplikátů) do „${targetDisplayLabel}“.`
                    : `Přesune vybrané soubory přímo do „${targetDisplayLabel}“ bez duplikování místa.`}
                </p>
              </button>
            </div>
          )}

          {/* Duplicate Check Status Banner */}
          {isCheckingExisting ? (
            <div className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-[#09090B] px-3.5 py-2.5 text-xs text-zinc-300">
              <Loader2 className="w-4 h-4 text-amber-400 animate-spin shrink-0" />
              <span>
                Kontroluji složku „{targetDisplayLabel}“, abych přeskočil už
                uložené fotky…
              </span>
            </div>
          ) : (
            skippedExistingCount > 0 && (
              <div className="flex items-start gap-2.5 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-200 tabular-nums">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>
                  {exportableFilteredFiles.length === 0
                    ? `Všech ${skippedExistingCount.toLocaleString('cs-CZ')} souborů v tomto filtru už ve složce „${targetDisplayLabel}“ je — nic se nebude duplikovat.`
                    : `${skippedExistingCount.toLocaleString('cs-CZ')} ${
                        skippedExistingCount === 1
                          ? `soubor už ve složce „${cleanFolderName}“ je`
                          : skippedExistingCount < 5
                            ? `soubory už ve složce „${cleanFolderName}“ jsou`
                            : `souborů už ve složce „${cleanFolderName}“ je`
                      } — byly automaticky odznačeny, aby nevznikly duplicity.`}
                </span>
              </div>
            )
          )}

          {isReadOnlyLocal && (
            <div className="space-y-3">
              <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200 leading-relaxed">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
                <span>
                  U jednotlivě vybraných fotografií bez přímého zápisu do složky
                  můžete{canUseWebDirPicker ? ' výše zvolit „Jiná složka (kdekoliv)“ a vybrat cílovou složku na disku, nebo ' : ' '}
                  vybrané fotky rovnou exportovat / sdílet, případně stáhnout
                  jejich seznam (.txt).
                </span>
              </div>

              <div className="flex">
                <button
                  type="button"
                  onClick={handleDownloadList}
                  disabled={selectedFiles.length === 0}
                  className="w-full min-h-[42px] flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-zinc-700 bg-[#09090B] text-xs font-medium text-zinc-100 hover:border-amber-500/60 transition-colors cursor-pointer disabled:opacity-40"
                >
                  <FileText className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>Stáhnout seznam (.txt)</span>
                </button>
              </div>

              {exportNote && (
                <p className="text-xs text-emerald-300">{exportNote}</p>
              )}
            </div>
          )}

          {/* File checklist */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-zinc-400 tabular-nums">
                Soubory pro „{cleanFolderName}“ ({selectedFiles.length}/
                {exportableFilteredFiles.length} nových)
              </p>
              {exportableFilteredFiles.length > 0 && (
                <button
                  type="button"
                  disabled={isProcessing || isCheckingExisting}
                  onClick={handleToggleSelectAllInView}
                  className="text-xs text-amber-400 hover:text-amber-300 cursor-pointer disabled:opacity-40"
                >
                  {allExportableSelected
                    ? 'Odznačit nové'
                    : `Vybrat vše (${exportableFilteredFiles.length})`}
                </button>
              )}
            </div>

            <div className="rounded-xl border border-zinc-800 bg-[#09090B] max-h-52 overflow-y-auto">
              <ul className="divide-y divide-zinc-800/80">
                {visibleFiles.map((file) => {
                  const alreadyInLiked = alreadyInLikedFilteredIds.has(file.id);
                  const isDupName = duplicateNameFilteredIds.has(file.id);
                  const blocked = alreadyInLiked || isDupName;
                  const checked = !blocked && selectedIds.has(file.id);
                  const thumb =
                    thumbnails[file.id] ||
                    getFastPreviewThumbnailUrl(file.thumbnailLink);

                  return (
                    <li key={file.id}>
                      <label
                        className={`flex items-center gap-3 px-3 sm:px-3.5 py-2.5 transition-colors ${
                          blocked
                            ? 'opacity-55 cursor-not-allowed bg-zinc-950/60'
                            : 'cursor-pointer hover:bg-zinc-900/70'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={isProcessing || isCheckingExisting || blocked}
                          onChange={() => toggleFile(file.id)}
                          className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 accent-amber-500 cursor-pointer disabled:cursor-not-allowed"
                        />
                        <div className="h-10 w-12 shrink-0 overflow-hidden rounded-md bg-zinc-900 border border-zinc-800 flex items-center justify-center">
                          {thumb ? (
                            <img
                              src={thumb}
                              alt={file.name}
                              referrerPolicy="no-referrer"
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <ImageIcon className="w-4 h-4 text-zinc-600" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-zinc-200 truncate">
                            {file.relativePath || file.name}
                          </p>
                          <p className="font-mono text-[11px] text-zinc-500 tabular-nums flex flex-wrap items-center gap-x-1.5">
                            <span>
                              {file.fileExtension.toUpperCase()} ·{' '}
                              {formatBytes(file.sizeBytes)}
                            </span>
                            {alreadyInLiked && (
                              <span className="inline-flex items-center gap-1 font-sans text-emerald-400 font-medium">
                                <Check className="w-3 h-3" aria-hidden="true" />
                                Už v „{cleanFolderName}“ · přeskočí se
                              </span>
                            )}
                            {!alreadyInLiked && isDupName && (
                              <span className="font-sans text-amber-400 font-medium">
                                · Stejný název už v exportu · přeskočí se
                              </span>
                            )}
                          </p>
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {remainingHidden > 0 && (
                <div className="p-3 border-t border-zinc-800/80 text-center">
                  <button
                    type="button"
                    onClick={() => setVisibleLimit((v) => v + 150)}
                    className="text-xs font-medium text-amber-400 hover:text-amber-300 cursor-pointer tabular-nums"
                  >
                    Zobrazit dalších {Math.min(150, remainingHidden)} (zbývá{' '}
                    {remainingHidden.toLocaleString('cs-CZ')})
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Progress or Error Summary */}
          {isProcessing && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-zinc-300 tabular-nums">
                <span>
                  {transferMode === 'move'
                    ? `Přesouvám soubory do „${targetDisplayLabel}“…`
                    : `Kopíruji soubory do „${targetDisplayLabel}“…`}
                </span>
                <span>
                  {progress.done.toLocaleString('cs-CZ')} /{' '}
                  {progress.total.toLocaleString('cs-CZ')}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full bg-amber-500 transition-all duration-200"
                  style={{
                    width: `${
                      progress.total > 0
                        ? Math.round((progress.done / progress.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
          )}

          {summary && summary.failed.length > 0 && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3.5 text-xs text-rose-200 space-y-1">
              <p className="font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                Uloženo {summary.processedCount} souborů
                {summary.skippedCount > 0
                  ? ` (${summary.skippedCount} přeskočeno)`
                  : ''}
                , u {summary.failed.length} nastala chyba:
              </p>
              <ul className="list-disc pl-5 text-rose-300 max-h-28 overflow-y-auto">
                {summary.failed.slice(0, 20).map((item) => (
                  <li key={item.file.id}>
                    {item.file.name}: {item.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 sm:gap-3 px-3.5 sm:px-6 py-3 sm:py-4 border-t border-zinc-800 bg-[#0D0D10]">
          <button
            type="button"
            onClick={onCancel}
            disabled={isProcessing || isExportingReadOnly}
            className="min-h-[42px] px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-medium rounded-lg border border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-40"
          >
            Zavřít
          </button>
          <button
            type="button"
            onClick={() => void handleConfirmExportToLiked()}
            disabled={
              isCheckingExisting ||
              selectedFiles.length === 0 ||
              isProcessing ||
              isExportingReadOnly
            }
            className="min-h-[42px] inline-flex items-center gap-2 px-3.5 sm:px-5 py-2 text-xs sm:text-sm font-semibold rounded-lg bg-amber-500 text-zinc-950 hover:bg-amber-400 transition-colors cursor-pointer disabled:opacity-40 tabular-nums max-w-[72vw] sm:max-w-none"
          >
            {isReadOnlyLocal ? (
              <>
                <Share2 className="w-4 h-4 shrink-0" />
                <span className="truncate">
                  {isExportingReadOnly
                    ? 'Exportuji…'
                    : `Exportovat / sdílet (${selectedFiles.length.toLocaleString('cs-CZ')})`}
                </span>
              </>
            ) : isProcessing ? (
              <>
                <FolderPlus className="w-4 h-4 shrink-0" />
                <span className="truncate">
                  Zpracovávám ({progress.done}/{progress.total})…
                </span>
              </>
            ) : transferMode === 'move' ? (
              <>
                <FolderInput className="w-4 h-4 shrink-0" />
                <span className="truncate">
                  Přesunout do „{cleanFolderName}“ (
                  {selectedFiles.length.toLocaleString('cs-CZ')})
                </span>
              </>
            ) : (
              <>
                <FolderPlus className="w-4 h-4 shrink-0" />
                <span className="truncate">
                  Zkopírovat do „{cleanFolderName}“ (
                  {selectedFiles.length.toLocaleString('cs-CZ')})
                </span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

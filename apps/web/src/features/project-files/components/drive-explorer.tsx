'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { DRAG_MIME } from '@/features/file-browser/components/file-tree-item';
import { useFilesStore, useFilesStoreApi } from '@/features/file-browser/store/files-store';
import type { FileNode } from '@/features/file-browser/types';
import { EmptyState } from '@/features/layout/section/empty-state';
import { DriveEmptyArt } from './drive-empty-art';
import { ErrorState } from '@/features/layout/section/error-state';
import { isSandboxNotReadyError } from '@kortix/sdk';
import {
  ClipboardIcon as Clipboard,
  FolderPlusIcon as FolderPlus,
  ClipboardTextIcon,
  MoonIcon,
  XIcon,
  UploadSimpleIcon,
  UploadIcon as Upload,
  ArrowsLeftRightIcon,
  CheckSquareIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { Download } from '@/features/icon/icons/download';
import { useTranslations } from '@/i18n/use-translations';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ElementType,
  type ReactNode,
} from 'react';
import { useFileExplorerSource } from '../explorer-source';
import { buildGitStatusMap } from '../hooks';
import {
  forEachLimit,
  partitionUploadBatch,
  resolveUploadTarget,
  UPLOAD_CONCURRENCY,
} from '../upload-batch';
import {
  droppedEntries,
  type DroppedEntry,
  hasFolder,
  readDroppedTree,
  type TreeFile,
  treeLevels,
} from '../drop-tree';
import {
  DriveCreateDialog,
  type DriveCreateKind,
  type DriveLocation,
  type FolderAudienceMode,
} from './drive-create-dialog';
import { DriveGridView } from './drive-grid-view';
import { DriveListView } from './drive-list-view';
import { type DriveUpload, useDriveUploads } from '../store/upload-store';
import {
  DRIVE_ACTION_ROW_CLASS,
  DriveNewMenu,
  DriveNewMenuItems,
  DrivePathBar,
  DriveViewMenu,
} from './drive-toolbar';
import {
  createSelectionStore,
  DRIVE_ITEM_ATTR,
  type DriveSelection,
  DriveSelectionContext,
} from './drive-selection';
import { DriveSelectionBar } from './drive-selection-bar';
import { DriveRenameContext, DriveRenameDialog } from './drive-rename-dialog';
import { FileHistoryPopoverContent } from './file-history-popover';
import { FilePreviewModal } from './file-preview-modal';
import { FileSearch } from './file-search';
import { isPartialListing, LoadMoreRow } from './load-more-row';

/** System directories always pinned at the top of the listing. */
const ELEVATED_DIRS = new Set(['.kortix', '.opencode']);

/**
 * Google Drive-style file explorer — the ONE explorer implementation, shared
 * by every surface. Data access comes from the injected FileExplorerSource
 * (live sandbox vs. project git-ref); capabilities on the source decide which
 * affordances render (mutations, search overlay, dotfile toggle, …).
 *
 * Layout — ONE action row, and a path strip that only appears once there is
 * a path to show:
 * +---------------------------------------------------+
 * | {leading}                          [+ New]  [ ⋯ ]  |
 * +---------------------------------------------------+
 * | workspace › src › ui          (hidden at the root) |
 * +---------------------------------------------------+
 * | Main area (grid or list view) + injected panels    |
 * +---------------------------------------------------+
 *
 * `leading` is how a host puts its own identity — the session panel's
 * All files / Changes tabs — in that row instead of stacking a second full
 * header above it.
 *
 * Opening a file (single- or double-click, context menu) always opens the
 * full-screen preview modal overlay.
 */
export function DriveExplorer({
  embedded = false,
  shareContext,
  leading,
  trailing,
  rootLabel,
  rootIcon,
  location,
  onOpenFolder,
  onTeamFolderCreated,
  listingAs,
  panels,
  children,
}: {
  embedded?: boolean;
  shareContext?: { projectId: string; sessionId: string };
  /**
   * Host chrome for the START of the action row — the session panel's tab
   * strip. Sharing the row is what lets that host drop its own header.
   */
  leading?: ReactNode;
  /**
   * Host actions for the END of the action row, after New and the view menu
   * in their one secondary button group.
   */
  trailing?: ReactNode;
  /** Glyph before the first crumb. */
  rootIcon?: ReactNode;
  /** The first crumb of the path bar (default: the store root's name). */
  rootLabel?: string;
  /**
   * Where a new folder or file lands, in the host's own words (Drive names
   * "My drive", a company drive, a shared folder). Default: the root crumb
   * and the path below it.
   */
  location?: DriveLocation;
  /**
   * Open a folder from outside this view (the upload toast's "Open folder",
   * once the user has left). Absent: the button only works while mounted.
   */
  onOpenFolder?: (path: string) => void;
  /**
   * Drive: a folder made at the top is a team folder, and the create dialog
   * asks who can open it. Called once it exists.
   */
  onTeamFolderCreated?: (path: string, audience: FolderAudienceMode) => void;
  /**
   * Element type for the listing region.
   *
   * A tabbed host passes a `TabsContent` wrapper, so the listing IS the tab
   * panel while its tab strip rides in `leading`. The row and the listing are
   * siblings, which is the whole point: the panel never contains the tablist
   * that controls it, and the host still gets one row instead of two.
   */
  listingAs?: ElementType<{ className?: string; children?: ReactNode }>;
  /** Rendered inside the relative content area (slide-in side panels). */
  panels?: ReactNode;
  /** Rendered at the root (portal dialogs owned by the wrapping surface). */
  children?: ReactNode;
} = {}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tDrives = useTranslations('drives');
  // Plain <div> unless a tabbed host claims the listing as its panel.
  const ListingRegion = listingAs ?? 'div';
  const source = useFileExplorerSource();
  // Asleep: the listing comes from the git mirror instead. Writing and search
  // both run INSIDE the box, so they are withheld rather than left to fail.
  const parked = source.useReadinessParked();
  const capabilities = parked
    ? { ...source.capabilities, write: false, search: false }
    : source.capabilities;
  const canWrite = capabilities.write;

  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const viewMode = useFilesStore((s) => s.viewMode);
  const sortBy = useFilesStore((s) => s.sortBy);
  const sortOrder = useFilesStore((s) => s.sortOrder);
  const isSearchOpen = useFilesStore((s) => s.isSearchOpen);
  const toggleSearch = useFilesStore((s) => s.toggleSearch);
  const closeSearch = useFilesStore((s) => s.closeSearch);
  const openFileWithList = useFilesStore((s) => s.openFileWithList);

  const clipboard = useFilesStore((s) => s.clipboard);
  const copyToClipboard = useFilesStore((s) => s.copyToClipboard);
  const cutToClipboard = useFilesStore((s) => s.cutToClipboard);
  const clearClipboard = useFilesStore((s) => s.clearClipboard);

  source.useFileEventInvalidation();

  /**
   * Rows shown before the server confirms them: a folder just created, a file
   * still uploading. Each is keyed to the folder it was made in and drops out
   * once the server confirmed it and a newer listing arrived (or the write
   * failed). `seen` is the listing in hand when the server confirmed it.
   */
  const [pending, setPending] = useState<{ dir: string; node: FileNode; seen?: unknown }[]>([]);
  const [gone, setGone] = useState<{ path: string; seen?: unknown }[]>([]);

  const listing = source.useFileList(currentPath);
  const { data: listed, isLoading, isFetching, error, refetch: refetchFiles } = listing;
  const files = useMemo(() => {
    if (!listed) return listed;
    const hiddenPaths = new Set(
      gone.filter((g) => !('seen' in g) || g.seen === listed).map((g) => g.path),
    );
    const shown = hiddenPaths.size ? listed.filter((f) => !hiddenPaths.has(f.path)) : listed;
    const names = new Set(shown.map((f) => f.name.toLowerCase()));
    const extra = pending
      .filter((p) => p.dir === currentPath && !names.has(p.node.name.toLowerCase()))
      // A listing fetched after the server confirmed the row is the truth.
      .filter((p) => !('seen' in p) || p.seen === listed)
      .map((p) => p.node);
    return extra.length ? [...shown, ...extra] : shown;
  }, [listed, pending, gone, currentPath]);
  const listedRef = useRef(listed);
  useEffect(() => {
    listedRef.current = listed;
  }, [listed]);
  const partial = isPartialListing(listing);

  // A readiness 503 means the sandbox is BOOTING — it becomes healthy on its
  // own, so keep polling. A parked box never reaches here: `parked` switches
  // the source to the git mirror, whose errors are never readiness 503s.
  const sandboxWaking = !!error && isSandboxNotReadyError(error);
  useEffect(() => {
    if (!sandboxWaking) return;
    const interval = window.setInterval(() => void refetchFiles(), 3_000);
    return () => window.clearInterval(interval);
  }, [sandboxWaking, refetchFiles]);

  const { data: gitStatuses } = source.useGitStatus();
  const gitStatusMap = useMemo(() => buildGitStatusMap(gitStatuses), [gitStatuses]);

  const uploadMutation = source.useFileUpload();
  // Called unconditionally: a source's hooks never change between renders.
  const previewUpload = source.useUploadPreview?.();
  const downloadZip = source.useDownloadZip?.();
  const setClipboardItems = useFilesStore((s) => s.setClipboardItems);
  const deleteMutation = source.useFileDelete();
  const mkdirMutation = source.useFileMkdir();
  const renameMutation = source.useFileRename();
  const createMutation = source.useFileCreate();
  const copyMutation = source.useFileCopy();
  const downloadFile = source.useDownloadFile();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderPickerRef = useRef<HTMLInputElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  const [isDragOverPage, setIsDragOverPage] = useState(false);
  // Project-wide, so a batch keeps going (and its tray keeps reporting) after
  // this folder view unmounts. The tray itself is in the project shell.
  const uploads = useDriveUploads((s) => s.uploads);
  // Cards and rows still on their way up show a spinner until the server has them.
  const uploadingPaths = useMemo(
    () =>
      new Set(
        uploads
          .filter((u) => u.status === 'queued' || u.status === 'uploading')
          .map((u) => (u.targetPath ? `${u.targetPath.replace(/\/+$/, '')}/${u.file.name}` : u.file.name)),
      ),
    [uploads],
  );
  const dragPageCounter = useRef(0);

  const [createKind, setCreateKind] = useState<DriveCreateKind | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileNode | null>(null);
  const filesStoreApi = useFilesStoreApi();
  const requestRename = useCallback(
    (node: FileNode) => {
      // An open preview sits above every dialog; close it first.
      if (filesStoreApi.getState().selectedFilePath) filesStoreApi.getState().goBackToBrowser();
      setRenameTarget(node);
    },
    [filesStoreApi],
  );

  const [deleteTargets, setDeleteTargets] = useState<FileNode[]>([]);
  const deleteTarget = deleteTargets.length === 1 ? deleteTargets[0]! : null;

  const { downloadDir, isDownloading: isDirDownloading } = source.useDirectoryDownload();

  // Delayed loading state to prevent skeleton flash on fast loads
  const [showSkeleton, setShowSkeleton] = useState(false);
  useEffect(() => {
    if (isLoading) {
      const timer = setTimeout(() => setShowSkeleton(true), 200);
      return () => clearTimeout(timer);
    }
    setShowSkeleton(false);
  }, [isLoading]);

  const isRootPath = currentPath === '/' || currentPath === '.' || currentPath === '';
  const normalizedCurrentPath = isRootPath ? '' : currentPath.replace(/\/$/, '');
  const filesAllowedHere = capabilities.filesAllowedAt?.(currentPath) ?? true;

  // Cmd+P search, Escape close (search-capable sources only)
  const searchEnabled = capabilities.search;
  useEffect(() => {
    if (!searchEnabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return;

      const isMod = e.metaKey || e.ctrlKey;

      if (isMod && e.key === 'p') {
        e.preventDefault();
        toggleSearch();
        return;
      }

      if (e.key === 'Escape' && isSearchOpen) {
        e.preventDefault();
        closeSearch();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchEnabled, toggleSearch, closeSearch, isSearchOpen]);

  // Sort and separate dirs and files
  const { elevatedDirs, dirs, fileItems } = useMemo(() => {
    if (!files)
      return {
        elevatedDirs: [] as FileNode[],
        dirs: [] as FileNode[],
        fileItems: [] as FileNode[],
      };

    const sortFn = (a: FileNode, b: FileNode) => {
      let cmp = 0;
      switch (sortBy) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'type': {
          const extA = a.name.includes('.') ? a.name.split('.').pop() || '' : '';
          const extB = b.name.includes('.') ? b.name.split('.').pop() || '' : '';
          cmp = extA.localeCompare(extB);
          if (cmp === 0) cmp = a.name.localeCompare(b.name);
          break;
        }
        case 'modified':
        case 'size':
          cmp = a.name.localeCompare(b.name);
          break;
      }
      return sortOrder === 'desc' ? -cmp : cmp;
    };

    // A partial folder keeps the server's name order: a sorted subset would
    // put a later page's rows above the ones shown (KRTX-1723).
    const sorted = (nodes: FileNode[]) => (partial ? nodes : nodes.sort(sortFn));
    const allDirs = files.filter((f) => f.type === 'directory');
    const elevatedDirs = allDirs
      .filter((f) => ELEVATED_DIRS.has(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const dirs = sorted(allDirs.filter((f) => !ELEVATED_DIRS.has(f.name)));
    const fileItems = sorted(files.filter((f) => f.type === 'file'));
    return { elevatedDirs, dirs, fileItems };
  }, [files, sortBy, sortOrder, partial]);

  // ── Handlers ──────────────────────────────────────────────────

  const handleNavigateToDir = useCallback(
    (node: FileNode) => {
      navigateToPath(node.path);
    },
    [navigateToPath],
  );

  // Opening a file always shows the in-place preview modal.
  const handleOpenFile = useCallback(
    (node: FileNode) => {
      const allFiles = fileItems.map((f) => f.path);
      const index = allFiles.indexOf(node.path);
      openFileWithList(node.path, allFiles, Math.max(0, index));
    },
    [fileItems, openFileWithList],
  );

  const handlePreviewFile = handleOpenFile;

  const handleDownload = useCallback(
    async (node: FileNode) => {
      try {
        await downloadFile(node.path, node.name);
        successToast(tHardcodedUi('i18nComplete.text7eca5e05f915', { value0: node.name }));
      } catch {
        errorToast(tHardcodedUi('i18nComplete.textc85c359673e0', { value0: node.name }));
      }
    },
    [downloadFile, tHardcodedUi],
  );

  const handleDownloadDir = useCallback(
    (node: FileNode) => {
      downloadDir(node.path, node.name);
    },
    [downloadDir],
  );

  /** A listing row for `name` in the folder in view, before the server has it. */
  const pendingNode = useCallback(
    (name: string, type: FileNode['type']): FileNode => {
      const path = normalizedCurrentPath ? `${normalizedCurrentPath}/${name}` : name;
      return { name, path, absolute: path, type, ignored: false };
    },
    [normalizedCurrentPath],
  );
  /** `ok`: the server has it, keep the row until the next listing. Else remove it. */
  const settlePending = useCallback((dir: string, name: string, ok: boolean) => {
    const seen = listedRef.current;
    const match = (p: { dir: string; node: FileNode }) => p.dir === dir && p.node.name === name;
    setPending((prev) =>
      prev
        // Rows already handed over to a newer listing are dead weight.
        .filter((p) => !('seen' in p) || p.seen === seen)
        .flatMap((p) => (match(p) ? (ok ? [{ ...p, seen }] : []) : [p])),
    );
  }, []);

  /**
   * Rows hidden before the server confirms they are gone: a delete, or the old
   * name of a rename or move. Same hand-over as `pending`: a failure brings the
   * row back; a success keeps it hidden until a newer listing arrives.
   */
  const settleGone = useCallback((path: string, ok: boolean) => {
    const seen = listedRef.current;
    setGone((prev) =>
      prev
        .filter((g) => !('seen' in g) || g.seen === seen)
        .flatMap((g) => (g.path === path ? (ok ? [{ ...g, seen }] : []) : [g])),
    );
  }, []);

  const handleRename = useCallback(
    async (node: FileNode, newName: string) => {
      if (!newName || newName === node.name) return;
      const parentPath = node.path.substring(0, node.path.lastIndexOf('/'));
      const newPath = parentPath ? `${parentPath}/${newName}` : newName;
      // The new name shows at once; the old row hides until the server answers.
      const dir = currentPath;
      setGone((prev) => [...prev, { path: node.path }]);
      setPending((prev) => [...prev, { dir, node: { ...node, name: newName, path: newPath, absolute: newPath } }]);
      let ok = false;
      try {
        await renameMutation.mutateAsync({ from: node.path, to: newPath });
        ok = true;
      } catch (err) {
        errorToast(
          tHardcodedUi('i18nComplete.textd6f8c9c8e719', {
            value0:
              err instanceof Error
                ? err.message
                : tHardcodedUi.raw('i18nComplete.textada37a724fca'),
          }),
        );
      } finally {
        settleGone(node.path, ok);
        settlePending(dir, newName, ok);
      }
    },
    [currentPath, renameMutation, settleGone, settlePending, tHardcodedUi],
  );

  const goBackToBrowser = useFilesStore((s) => s.goBackToBrowser);
  const filesStore = useFilesStoreApi();
  const handleDelete = useCallback(
    (node: FileNode) => {
      // An open preview sits above every dialog; close it so the confirmation
      // is not hidden behind it.
      if (filesStore.getState().selectedFilePath) goBackToBrowser();
      setDeleteTargets([node]);
    },
    [goBackToBrowser, filesStore],
  );

  /** The rows go at once and the dialog closes; a refused delete brings its row back. */
  const confirmDelete = useCallback(async () => {
    const targets = deleteTargets;
    if (targets.length === 0) return;
    setDeleteTargets([]);
    setGone((prev) => [...prev, ...targets.map((t) => ({ path: t.path }))]);
    // Four at a time, like uploads: 200 parallel deletes trip rate limits and
    // each one refetches the folder.
    await forEachLimit(targets, UPLOAD_CONCURRENCY, async (target) => {
      let ok = false;
      try {
        await deleteMutation.mutateAsync({ filePath: target.path });
        ok = true;
      } catch (err) {
        errorToast(
          tHardcodedUi('i18nComplete.text5d4ff119f3d4', {
            value0:
              err instanceof Error ? err.message : tHardcodedUi.raw('i18nComplete.textada37a724fca'),
          }),
        );
      } finally {
        settleGone(target.path, ok);
      }
    });
  }, [deleteTargets, deleteMutation, settleGone, tHardcodedUi]);

  const handleHistory = useCallback((node: FileNode) => {
    setHistoryPopoverPath(node.path);
  }, []);

  const handleCopy = useCallback(
    (node: FileNode) => {
      copyToClipboard(node.path, node.name, node.type);
      successToast(tHardcodedUi('i18nComplete.textd46dc6f5e3e3', { value0: node.name }));
    },
    [copyToClipboard, tHardcodedUi],
  );

  const handleCut = useCallback(
    (node: FileNode) => {
      cutToClipboard(node.path, node.name, node.type);
      successToast(tHardcodedUi('i18nComplete.text80565873fe1e', { value0: node.name }));
    },
    [cutToClipboard, tHardcodedUi],
  );

  const handleDropMove = useCallback(
    async (sourcePath: string, targetDirPath: string) => {
      const sourceName = sourcePath.split('/').pop() || '';
      const destPath = targetDirPath ? `${targetDirPath}/${sourceName}` : sourceName;
      if (sourcePath === destPath) return;
      setGone((prev) => [...prev, { path: sourcePath }]);
      let ok = false;
      try {
        await renameMutation.mutateAsync({ from: sourcePath, to: destPath });
        ok = true;
      } catch (err) {
        errorToast(
          tHardcodedUi('i18nComplete.text66d6798adfa9', {
            value0:
              err instanceof Error
                ? err.message
                : tHardcodedUi.raw('i18nComplete.text27c2ccd962c2'),
          }),
        );
      } finally {
        settleGone(sourcePath, ok);
      }
    },
    [renameMutation, settleGone, tHardcodedUi],
  );

  // Upload
  const handleUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);
  const handlePickFolder = useCallback(() => {
    folderPickerRef.current?.click();
  }, []);

  /**
   * Send one file and track it in the tray. The mutation settles after its
   * listing refetch, so the pending row hands over to the real one in place.
   */
  const uploadAsync = uploadMutation.mutateAsync;
  const runUpload = useCallback(
    async (upload: DriveUpload, shownIn: string | null) => {
      const patch = (next: Partial<DriveUpload>) => useDriveUploads.getState().patch(upload.id, next);
      patch({ status: 'uploading', sent: 0, error: undefined });
      let ok = false;
      try {
        await uploadAsync({
          file: upload.file,
          targetPath: upload.targetPath,
          onProgress: (sent) => patch({ sent }),
        });
        ok = true;
        patch({ status: 'done', sent: upload.file.size });
      } catch (err) {
        patch({ status: 'error', error: err instanceof Error ? err.message : undefined });
      } finally {
        if (shownIn !== null) settlePending(shownIn, upload.file.name, ok);
      }
      return ok;
    },
    [uploadAsync, settlePending],
  );

  // Still showing? Then "Open folder" navigates here; otherwise the host opens it.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const openFolder = useCallback(
    (path: string) => {
      if (mountedRef.current) navigateToPath(path);
      else onOpenFolder?.(path);
    },
    [navigateToPath, onOpenFolder],
  );

  /**
   * Put files in the tray with their previews, then send them, 4 at a time.
   * `landedIn` is the folder the batch lands in, for the toast's "Open folder".
   */
  const startBatch = useCallback(
    async (
      items: { file: File; targetPath?: string }[],
      shownIn: string | null,
      landedIn: string,
    ) => {
      const batch: DriveUpload[] = items.map(({ file, targetPath }) => {
        const upload: DriveUpload = { id: crypto.randomUUID(), file, targetPath, status: 'queued' };
        upload.retry = () => {
          previewUpload?.(file, targetPath);
          void runUpload(upload, null);
        };
        return upload;
      });
      useDriveUploads.getState().add(batch);
      for (const u of batch) previewUpload?.(u.file, u.targetPath);
      let failed = 0;
      await forEachLimit(batch, UPLOAD_CONCURRENCY, async (u) => {
        if (!(await runUpload(u, shownIn))) failed++;
      });
      // One toast for the whole batch; a failure stays in the tray with Retry.
      if (failed === 0) {
        successToast(tDrives('uploaded', { count: batch.length }), {
          actions: [{ label: tDrives('openFolder'), onClick: () => openFolder(landedIn) }],
        });
      }
    },
    [previewUpload, runUpload, tDrives, openFolder],
  );

  /**
   * Upload a batch: `UPLOAD_CONCURRENCY` files at a time, each listed in the
   * folder at once and tracked in the tray. `targetDirPath` is the folder the
   * files were dropped ONTO; without it the batch lands in the folder in view.
   *
   * Oversized files are refused before any bytes move — see `upload-batch.ts`.
   * One failed file never stops the rest; its tray row offers Retry.
   */
  const handleUploadFiles = useCallback(
    async (fileList: FileList | File[], targetDirPath?: string) => {
      const { accepted, rejected } = partitionUploadBatch(Array.from(fileList));

      for (const { reason } of rejected) errorToast(reason);
      if (accepted.length === 0) return;

      const targetPath = resolveUploadTarget({
        currentPath,
        isRootPath,
        dropTargetDir: targetDirPath,
      });
      // Only files landing in the folder in view get a row here.
      const shownIn = targetDirPath ? null : currentPath;

      if (shownIn !== null) {
        setPending((prev) => [
          ...prev,
          ...accepted.map((file) => ({ dir: shownIn, node: pendingNode(file.name, 'file') })),
        ]);
      }
      await startBatch(
        accepted.map((file) => ({ file, targetPath })),
        shownIn,
        targetDirPath ?? currentPath,
      );
    },
    [currentPath, isRootPath, pendingNode, startBatch],
  );

  /**
   * Upload a tree (a picked or dropped folder) into `base`: its folders are
   * made first, one depth at a time (a level in parallel), then its files go
   * up into them. Top folders landing in the folder in view show at once.
   */
  const uploadTree = useCallback(
    async (tree: TreeFile[], base: string) => {
      const { accepted, rejected } = partitionUploadBatch(tree.map((t) => t.file));
      for (const { reason } of rejected) errorToast(reason);
      const items = tree.filter((t) => accepted.includes(t.file));
      if (items.length === 0) return;

      const root = base === '/' ? '' : base.replace(/\/+$/, '');
      const at = (rel: string) => (root && rel ? `${root}/${rel}` : root || rel);
      const levels = treeLevels(items);
      const tops = levels[0] ?? [];

      const dir = currentPath;
      const inView = root === normalizedCurrentPath;
      if (inView) {
        setPending((prev) => [...prev, ...tops.map((top) => ({ dir, node: pendingNode(top, 'directory') }))]);
      }
      let ok = true;
      try {
        for (const level of levels) {
          await Promise.all(
            level.map((d) =>
              mkdirMutation.mutateAsync({ dirPath: at(d) }).catch((err: unknown) => {
                // Already there (an earlier upload of the same folder): reuse it.
                if ((err as { status?: number } | null)?.status !== 409) throw err;
              }),
            ),
          );
        }
      } catch (err) {
        ok = false;
        errorToast(
          tHardcodedUi('i18nComplete.text5334297c9387', {
            value0: err instanceof Error ? err.message : tHardcodedUi.raw('i18nComplete.text27c2ccd962c2'),
          }),
        );
      } finally {
        if (inView) for (const top of tops) settlePending(dir, top, ok);
      }
      if (!ok) return;
      await startBatch(
        items.map(({ file, dir: rel }) => ({ file, targetPath: at(rel) || undefined })),
        // Loose files dropped beside the folders land in the view.
        inView ? currentPath : null,
        tops.length === 1 ? at(tops[0]!) : root || '/',
      );
    },
    [currentPath, normalizedCurrentPath, pendingNode, settlePending, mkdirMutation, startBatch, tHardcodedUi],
  );

  /** The folder picker (`webkitRelativePath` is `Picked/sub/file.png`). The browser already asked. */
  const handleUploadFolder = useCallback(
    (fileList: FileList) =>
      uploadTree(
        Array.from(fileList).map((file) => ({
          file,
          dir: (file.webkitRelativePath || file.name).split('/').slice(0, -1).join('/'),
        })),
        normalizedCurrentPath || '/',
      ),
    [uploadTree, normalizedCurrentPath],
  );

  /**
   * A drop: plain files upload at once; a drop with folders in it is read as
   * a tree and asks first, in our own dialog (a drop never gets the
   * browser's prompt). `base` is the folder dropped onto, or the view.
   */
  const [treeToConfirm, setTreeToConfirm] = useState<{
    tree: TreeFile[];
    base: string;
    name: string;
    folders: number;
  } | null>(null);
  const handleDrop = useCallback(
    async (files: File[], entries: DroppedEntry[], targetDirPath?: string) => {
      if (!hasFolder(entries)) {
        if (files.length) await handleUploadFiles(files, targetDirPath);
        return;
      }
      const tree = await readDroppedTree(entries);
      if (tree.length === 0) return;
      const folders = entries.filter((e) => e.isDirectory);
      setTreeToConfirm({
        tree,
        base: targetDirPath ?? (normalizedCurrentPath || '/'),
        name: folders.length === 1 ? folders[0]!.name : '',
        folders: folders.length,
      });
    },
    [handleUploadFiles, normalizedCurrentPath],
  );

  /**
   * External files dropped onto a folder row upload INTO that folder.
   *
   * The row stops the event before the page-level handler sees it, so this
   * also clears the page drop overlay — otherwise it would stay on screen.
   */
  const handleRowDropUpload = useCallback(
    (files: File[], targetDirPath: string, entries: DroppedEntry[] = []) => {
      dragPageCounter.current = 0;
      setIsDragOverPage(false);
      void handleDrop(files, entries, targetDirPath);
    },
    [handleDrop],
  );

  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files || e.target.files.length === 0) return;
      await handleUploadFiles(e.target.files);
      e.target.value = '';
    },
    [handleUploadFiles],
  );

  const nameTaken = useCallback(
    (name: string) => {
      const lower = name.toLowerCase();
      return (files ?? []).some((f) => f.name.toLowerCase() === lower);
    },
    [files],
  );

  /**
   * Create from the modal. The row shows at once; the request runs behind it.
   * A failure removes the row and says why.
   */
  const handleCreate = useCallback(
    async (kind: DriveCreateKind, name: string, audience?: FolderAudienceMode) => {
      const dir = currentPath;
      const node = pendingNode(name, kind === 'folder' ? 'directory' : 'file');
      setPending((prev) => [...prev, { dir, node }]);
      let ok = false;
      try {
        if (kind === 'folder')
          await mkdirMutation.mutateAsync({ dirPath: node.path, everyone: audience === 'everyone' });
        else await createMutation.mutateAsync({ filePath: node.path });
        ok = true;
        if (audience) onTeamFolderCreated?.(node.path, audience);
      } catch (err) {
        errorToast(
          (err as { status?: number } | null)?.status === 409
            ? tHardcodedUi('i18nComplete.textf445afc1e6ed', { value0: name })
            : tHardcodedUi(
                kind === 'folder' ? 'i18nComplete.text5334297c9387' : 'i18nComplete.text6658eaceba2a',
                {
                  value0:
                    err instanceof Error
                      ? err.message
                      : tHardcodedUi.raw('i18nComplete.text27c2ccd962c2'),
                },
              ),
        );
      } finally {
        settlePending(dir, name, ok);
      }
    },
    [
      currentPath,
      pendingNode,
      settlePending,
      mkdirMutation,
      createMutation,
      onTeamFolderCreated,
      tHardcodedUi,
    ],
  );

  // Paste: every item on the clipboard, into the folder in view.
  const clipboardItems = useFilesStore((s) => s.clipboardItems);
  // One flag for the whole run: the per-mutation `isPending` drops between
  // items and misses folder creation, which let Paste be pressed twice.
  const [pasting, setPasting] = useState(false);
  const handlePaste = useCallback(async () => {
    if (clipboardItems.length === 0 || pasting) return;
    setPasting(true);
    try {
      const destDir = normalizedCurrentPath;
      const taken = new Set((files ?? []).map((f) => f.name.toLowerCase()));
      const isCut = clipboardItems[0]!.operation === 'cut';
      let pasted = 0;
      for (const item of clipboardItems) {
        let destName = item.name;
        const sourceDir = item.path.substring(0, item.path.lastIndexOf('/'));
        if (isCut && sourceDir === destDir) continue; // already here
        if (taken.has(destName.toLowerCase())) {
          if (isCut) {
            errorToast(tHardcodedUi('i18nComplete.textf445afc1e6ed', { value0: destName }));
            continue;
          }
          const ext = destName.includes('.') ? destName.substring(destName.lastIndexOf('.')) : '';
          const baseName = ext ? destName.substring(0, destName.lastIndexOf('.')) : destName;
          let n = 1;
          let candidate = `${baseName} (copy)${ext}`;
          while (taken.has(candidate.toLowerCase())) candidate = `${baseName} (copy ${++n})${ext}`;
          destName = candidate;
        }
        taken.add(destName.toLowerCase());
        const destPath = destDir ? `${destDir}/${destName}` : destName;
        try {
          if (!isCut && item.type === 'file') await copyMutation.mutateAsync({ sourcePath: item.path, destPath });
          else if (!isCut) await mkdirMutation.mutateAsync({ dirPath: destPath });
          else await renameMutation.mutateAsync({ from: item.path, to: destPath });
          pasted++;
        } catch (err) {
          errorToast(
            tHardcodedUi('i18nComplete.texta619e901f9c0', {
              value0: err instanceof Error ? err.message : tHardcodedUi.raw('i18nComplete.text27c2ccd962c2'),
            }),
          );
        }
      }
      if (pasted > 0) successToast(tDrives('pasted', { count: pasted }));
      if (isCut) clearClipboard();
    } finally {
      setPasting(false);
    }
  }, [
    pasting,
    clipboardItems,
    normalizedCurrentPath,
    files,
    copyMutation,
    renameMutation,
    mkdirMutation,
    clearClipboard,
    tDrives,
    tHardcodedUi,
  ]);

  // Keyboard: Ctrl+V paste
  useEffect(() => {
    if (!canWrite) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'v' && clipboard) {
        e.preventDefault();
        handlePaste();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canWrite, clipboard, handlePaste]);

  // Local history popover state
  const [historyPopoverPath, setHistoryPopoverPath] = useState<string | null>(null);

  // ── Page-level drag & drop (external files only) ─────────────
  const isExternalFileDrag = useCallback(
    (e: React.DragEvent) => {
      // Only activate for external file drops, not internal file-tree drags
      return (
        canWrite &&
        e.dataTransfer.types.includes('Files') &&
        !e.dataTransfer.types.includes(DRAG_MIME)
      );
    },
    [canWrite],
  );

  const handlePageDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!isExternalFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragPageCounter.current++;
      if (dragPageCounter.current === 1) {
        setIsDragOverPage(true);
      }
    },
    [isExternalFileDrag],
  );

  const handlePageDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!isExternalFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragPageCounter.current--;
      if (dragPageCounter.current <= 0) {
        dragPageCounter.current = 0;
        setIsDragOverPage(false);
      }
    },
    [isExternalFileDrag],
  );

  const handlePageDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isExternalFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    },
    [isExternalFileDrag],
  );

  const handlePageDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!canWrite || !filesAllowedHere) return;
      e.preventDefault();
      e.stopPropagation();
      dragPageCounter.current = 0;
      setIsDragOverPage(false);
      // Both read now: the DataTransfer empties once this handler returns.
      const files = Array.from(e.dataTransfer.files ?? []);
      const entries = droppedEntries(e.dataTransfer);
      await handleDrop(files, entries);
    },
    [canWrite, filesAllowedHere, handleDrop],
  );

  // ── Multi-selection ───────────────────────────────────────────
  // The selection lives in a store, not React state: cards subscribe to their
  // own "am I selected", the bar to the count. A drag that changes three
  // cards re-renders three cards. Leaving the folder clears it.
  const [selectionStore] = useState(createSelectionStore);
  useEffect(() => selectionStore.clear(), [currentPath, selectionStore]);
  const selectMode = useSyncExternalStore(selectionStore.subscribe, selectionStore.mode, () => false);
  const ordered = useMemo(() => [...elevatedDirs, ...dirs, ...fileItems], [elevatedDirs, dirs, fileItems]);
  // Read by the stable callbacks below at the moment they run.
  const orderedRef = useRef(ordered);
  useEffect(() => {
    orderedRef.current = ordered;
  }, [ordered]);
  const anchorRef = useRef<string | null>(null);
  const exitSelect = useCallback(() => selectionStore.clear(), [selectionStore]);
  const selectAll = useCallback(
    () => selectionStore.set(new Set(orderedRef.current.map((n) => n.path))),
    [selectionStore],
  );
  const selectedNodes = useCallback(() => {
    const paths = selectionStore.paths();
    return orderedRef.current.filter((n) => paths.has(n.path));
  }, [selectionStore]);

  const [zipping, setZipping] = useState(false);
  const bulkDownload = useCallback(
    async (nodes: FileNode[]) => {
      if (nodes.length === 0) return;
      if (!downloadZip) {
        for (const n of nodes) if (n.type === 'file') await handleDownload(n);
        return;
      }
      setZipping(true);
      try {
        const folder = normalizedCurrentPath.split('/').filter(Boolean).pop() ?? rootLabel ?? 'files';
        await downloadZip(
          nodes.map((n) => ({ path: n.path, name: n.name, type: n.type })),
          nodes.length === 1 ? nodes[0]!.name : folder,
        );
      } catch (err) {
        errorToast(tDrives('zipFailed', { message: err instanceof Error ? err.message : '' }));
      } finally {
        setZipping(false);
      }
    },
    [downloadZip, handleDownload, normalizedCurrentPath, rootLabel, tDrives],
  );
  const bulkClipboard = useCallback(
    (nodes: FileNode[], operation: 'copy' | 'cut') => {
      setClipboardItems(nodes.map((n) => ({ path: n.path, name: n.name, type: n.type })), operation);
      exitSelect();
    },
    [setClipboardItems, exitSelect],
  );
  const bulkDelete = useCallback(
    (nodes: FileNode[]) => {
      if (filesStore.getState().selectedFilePath) goBackToBrowser();
      setDeleteTargets(nodes);
      exitSelect();
    },
    [filesStore, goBackToBrowser, exitSelect],
  );

  // Stable for the life of the folder view: every callback reads the store and
  // `orderedRef` when it runs, so a selection change never re-renders cards
  // through this context.
  const zippingRef = useRef(zipping);
  useEffect(() => {
    zippingRef.current = zipping;
  }, [zipping]);
  const selectionValue = useMemo<DriveSelection>(
    () => ({
      store: selectionStore,
      onItemClick: (node, event, open) => {
        const paths = selectionStore.paths();
        const list = orderedRef.current;
        if (event.shiftKey && anchorRef.current) {
          // A range from the last clicked item, added to what is selected.
          const a = list.findIndex((n) => n.path === anchorRef.current);
          const b = list.findIndex((n) => n.path === node.path);
          if (a >= 0 && b >= 0) {
            const next = new Set(paths);
            for (const n of list.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(n.path);
            selectionStore.set(next);
            return;
          }
        }
        anchorRef.current = node.path;
        if (!(selectionStore.mode() || event.metaKey || event.ctrlKey)) {
          open();
          return;
        }
        const next = new Set(paths);
        if (next.has(node.path)) next.delete(node.path);
        else next.add(node.path);
        selectionStore.set(next);
      },
      selectItem: (node) => {
        anchorRef.current = node.path;
        selectionStore.set(new Set([...selectionStore.paths(), node.path]));
      },
      dragPaths: (node) => {
        const paths = selectionStore.paths();
        return paths.has(node.path) && paths.size > 1 ? [...paths] : [node.path];
      },
      // Built when a menu opens, from the selection at that moment.
      selectionMenu: (node, Item, Separator) => {
        const paths = selectionStore.paths();
        if (!(paths.has(node.path) && paths.size > 1)) return null;
        const count = paths.size;
        const nodes = selectedNodes();
        return (
          <>
            <Item onClick={() => void bulkDownload(nodes)} disabled={zippingRef.current}>
              <Download />
              {tDrives('downloadZipCount', { count })}
            </Item>
            {canWrite ? (
              <>
                <Separator />
                <Item onClick={() => bulkClipboard(nodes, 'copy')}>
                  <Clipboard />
                  {tDrives('copyCount', { count })}
                </Item>
                <Item onClick={() => bulkClipboard(nodes, 'cut')}>
                  <ArrowsLeftRightIcon />
                  {tDrives('moveCount', { count })}
                </Item>
                <Separator />
                <Item onClick={() => bulkDelete(nodes)}>
                  <TrashIcon />
                  {tDrives('deleteCount', { count })}
                </Item>
              </>
            ) : null}
            <Separator />
            <Item onClick={exitSelect}>
              <XIcon />
              {tDrives('deselectAll')}
            </Item>
          </>
        );
      },
    }),
    [selectionStore, selectedNodes, bulkDownload, bulkClipboard, bulkDelete, exitSelect, canWrite, tDrives],
  );

  // ⌘/Ctrl+A selects every item in view; Escape leaves selecting. Neither
  // fires while a preview or any dialog is open: those own the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (filesStore.getState().selectedFilePath) return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && orderedRef.current.length > 0) {
        e.preventDefault();
        selectAll();
      } else if (e.key === 'Escape' && selectionStore.mode()) {
        exitSelect();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filesStore, selectAll, exitSelect, selectionStore]);

  // Drag on empty space draws a rectangle; what it touches is selected
  // (added to the selection with Shift or ⌘/Ctrl). A click there clears it.
  //
  // Cost per pointer move is fixed: the items' boxes are measured once when
  // the drag starts (in scroll-content coordinates, so a scroll mid-drag keeps
  // them right), the work runs at most once per frame, the rectangle is moved
  // by its style (no React render), and the store notifies only when the hit
  // set actually changed.
  const scrollRef = useRef<HTMLDivElement>(null);
  const marqueeBoxRef = useRef<HTMLDivElement>(null);
  const marqueeRef = useRef<{
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    base: ReadonlySet<string>;
    items: { path: string; left: number; top: number; right: number; bottom: number }[];
    moved: boolean;
    frame: number;
  } | null>(null);
  const onMarqueeDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest(`[${DRIVE_ITEM_ATTR}],button,a,input,[role="menuitem"]`)) return;
      const box = e.currentTarget;
      const rect = box.getBoundingClientRect();
      // A press on the scrollbar scrolls; it never starts a rectangle.
      if (e.clientX >= rect.left + box.clientWidth) return;
      // Content coordinates: viewport position + the scroll at this moment.
      const toContent = (b: DOMRect) => ({
        left: b.left - rect.left + box.scrollLeft,
        top: b.top - rect.top + box.scrollTop,
        right: b.right - rect.left + box.scrollLeft,
        bottom: b.bottom - rect.top + box.scrollTop,
      });
      const items = Array.from(box.querySelectorAll<HTMLElement>(`[${DRIVE_ITEM_ATTR}]`), (el) => ({
        path: el.getAttribute(DRIVE_ITEM_ATTR)!,
        ...toContent(el.getBoundingClientRect()),
      }));
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      marqueeRef.current = {
        x: e.clientX - rect.left + box.scrollLeft,
        y: e.clientY - rect.top + box.scrollTop,
        lastX: e.clientX,
        lastY: e.clientY,
        base: additive ? new Set(selectionStore.paths()) : new Set(),
        items,
        moved: false,
        frame: 0,
      };
      box.setPointerCapture(e.pointerId);
    },
    [selectionStore],
  );
  const drawMarquee = useCallback(() => {
    const m = marqueeRef.current;
    const box = scrollRef.current;
    const el = marqueeBoxRef.current;
    if (!m || !box || !el) return;
    m.frame = 0;
    const rect = box.getBoundingClientRect();
    const x = m.lastX - rect.left + box.scrollLeft;
    const y = m.lastY - rect.top + box.scrollTop;
    const r = { left: Math.min(m.x, x), right: Math.max(m.x, x), top: Math.min(m.y, y), bottom: Math.max(m.y, y) };
    el.style.display = 'block';
    el.style.transform = `translate(${r.left}px, ${r.top}px)`;
    el.style.width = `${r.right - r.left}px`;
    el.style.height = `${r.bottom - r.top}px`;
    const next = new Set(m.base);
    for (const it of m.items) {
      if (it.right > r.left && it.left < r.right && it.bottom > r.top && it.top < r.bottom) next.add(it.path);
    }
    // ponytail: no auto-scroll at the edges; select in two drags or scroll first.
    selectionStore.set(next, next.size > 0 || selectionStore.mode());
  }, [selectionStore]);
  const onMarqueeMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const m = marqueeRef.current;
      if (!m) return;
      m.lastX = e.clientX;
      m.lastY = e.clientY;
      if (!m.moved) {
        const rect = e.currentTarget.getBoundingClientRect();
        const dx = e.clientX - rect.left + e.currentTarget.scrollLeft - m.x;
        const dy = e.clientY - rect.top + e.currentTarget.scrollTop - m.y;
        if (Math.hypot(dx, dy) < 4) return;
        m.moved = true;
        // No text selection while the rectangle is out.
        e.currentTarget.style.userSelect = 'none';
      }
      if (!m.frame) m.frame = requestAnimationFrame(drawMarquee);
    },
    [drawMarquee],
  );
  const onMarqueeUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const m = marqueeRef.current;
      marqueeRef.current = null;
      if (m?.frame) cancelAnimationFrame(m.frame);
      if (marqueeBoxRef.current) marqueeBoxRef.current.style.display = 'none';
      e.currentTarget.style.userSelect = '';
      // A plain click on empty space clears the selection.
      if (m && !m.moved && selectionStore.paths().size > 0) exitSelect();
    },
    [selectionStore, exitSelect],
  );

  const isEmpty =
    !isLoading &&
    !error &&
    Boolean(files) &&
    !listing.hasNextPage &&
    elevatedDirs.length === 0 &&
    dirs.length === 0 &&
    fileItems.length === 0;

  return (
    <DriveSelectionContext.Provider value={selectionValue}>
    <DriveRenameContext.Provider value={canWrite ? requestRename : null}>
    <div
      className="bg-background relative flex h-full flex-col"
      onDragEnter={handlePageDragEnter}
      onDragLeave={handlePageDragLeave}
      onDragOver={handlePageDragOver}
      onDrop={handlePageDrop}
    >
      <div className={DRIVE_ACTION_ROW_CLASS}>
        {leading}
        {(() => {
          const newMenu = (
            <DriveNewMenu
              compact={embedded}
              onUpload={canWrite && filesAllowedHere ? handleUpload : undefined}
              onUploadFolder={canWrite ? handlePickFolder : undefined}
              onNewFile={
                canWrite && filesAllowedHere && capabilities.newFile !== false ? () => setCreateKind('file') : undefined
              }
              onNewFolder={canWrite ? () => setCreateKind('folder') : undefined}
            />
          );
          const viewMenu = (
            <DriveViewMenu
              variant="secondary"
              showSearch={capabilities.search}
              showHiddenToggle={capabilities.hiddenToggle}
              onRefresh={() => refetchFiles()}
              isRefreshing={isFetching}
              onDownloadDir={() => {
                const dirName = isRootPath
                  ? 'workspace'
                  : currentPath.split('/').filter(Boolean).pop() || 'directory';
                const dirPath = isRootPath ? '/workspace' : currentPath;
                downloadDir(dirPath, dirName);
              }}
              isDownloading={isDirDownloading(isRootPath ? '/workspace' : currentPath)}
              sortDisabled={partial}
            />
          );
          // One secondary group whether or not the host adds actions.
          return (
            <ButtonGroup className="ml-auto shrink-0">
              {newMenu}
              {viewMenu}
              {trailing}
            </ButtonGroup>
          );
        })()}
      </div>

      <DrivePathBar as="row" rootLabel={rootLabel} rootIcon={rootIcon} />

      {/* Search overlay */}
      {capabilities.search && isSearchOpen && <FileSearch />}

      {/* Hidden file input for uploads */}
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        onChange={handleFileInputChange}
        multiple
      />
      <input
        type="file"
        ref={folderPickerRef}
        className="hidden"
        multiple
        // Not in React's input types; every current browser supports it.
        {...{ webkitdirectory: '' }}
        onChange={(e) => {
          const picked = e.target.files;
          if (picked?.length) void handleUploadFolder(picked);
          e.target.value = '';
        }}
      />

      <ListingRegion className="relative min-h-0 flex-1">
        {/* Right-click on empty space: the New menu. A row's own menu wins —
            it prevents the default, so this trigger never opens over it. */}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              ref={scrollRef}
              className="absolute inset-0 overflow-y-auto"
              onPointerDown={onMarqueeDown}
              onPointerMove={onMarqueeMove}
              onPointerUp={onMarqueeUp}
              onPointerCancel={onMarqueeUp}
            >
              {/* Moved by its style during a drag (see \`drawMarquee\`), never by a render. */}
              <div
                ref={marqueeBoxRef}
                aria-hidden
                className="border-kortix-base bg-kortix-base/15 pointer-events-none absolute top-0 left-0 z-20 hidden rounded-sm border"
              />
              {isLoading && showSkeleton && (
                <div className="animate-in fade-in-0 p-4 duration-(--duration-moderate) motion-reduce:animate-none">
                  {viewMode === 'grid' ? (
                    <div className="space-y-6">
                      <div>
                        <Skeleton className="mb-3 h-4 w-16" />
                        <div
                          className="grid gap-2"
                          style={{
                            gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                          }}
                        >
                          {Array.from({ length: 6 }).map((_, i) => (
                            <Skeleton key={`f${i}`} className="h-10 rounded-lg" />
                          ))}
                        </div>
                      </div>
                      <div>
                        <Skeleton className="mb-3 h-4 w-12" />
                        <div
                          className="grid gap-2.5"
                          style={{
                            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                          }}
                        >
                          {Array.from({ length: 8 }).map((_, i) => (
                            <Skeleton key={`fi${i}`} className="h-[138px] rounded-lg" />
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {Array.from({ length: 10 }).map((_, i) => (
                        <Skeleton key={i} className="h-10 w-full rounded-sm" />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {!!error &&
                !isLoading &&
                (sandboxWaking ? (
                  <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                    <Loading className="text-muted-foreground size-4" />
                    <p className="text-muted-foreground text-sm font-medium">
                      {tHardcodedUi.raw('i18nComplete.text5e3de76869f3')}
                    </p>
                    <p className="text-muted-foreground max-w-xs text-xs">
                      {tHardcodedUi.raw('i18nComplete.textc1b1dc22e207')}
                    </p>
                  </div>
                ) : (
                  <ErrorState
                    title={tHardcodedUi.raw(
                      'featuresProjectFilesComponentsFileExplorerPage.line658JsxTextFailedToLoadFiles',
                    )}
                    description={
                      error instanceof Error
                        ? error.message
                        : tHardcodedUi.raw('i18nComplete.text27c2ccd962c2')
                    }
                    action={
                      <Button variant="outline" size="sm" onClick={() => refetchFiles()}>
                        {tHardcodedUi.raw('i18nComplete.text942087cc2d41')}
                      </Button>
                    }
                  />
                ))}

              {/* The mirror had nothing, but the branch push is best-effort, so the
                  files may exist and simply be unreachable. "Empty folder" is the one
                  thing this cannot state as fact. Same words as the Terminal panel. */}
              {isEmpty && parked && (
                <EmptyState icon={MoonIcon} title={tHardcodedUi.raw('i18nComplete.text3915f5ca49b3')} />
              )}

              {isEmpty && !parked && (
                <EmptyState
                  className="min-h-full"
                  media={<DriveEmptyArt />}
                  title={tHardcodedUi.raw(
                    'featuresProjectFilesComponentsDriveListView.line396JsxTextThisFolderIsEmpty',
                  )}
                  description={
                    canWrite
                      ? tHardcodedUi.raw('i18nComplete.text9720774edbde')
                      : tHardcodedUi.raw(
                          'featuresProjectFilesComponentsDriveListView.line398JsxTextNoFilesOrSubfoldersAtThisPathIn',
                        )
                  }
                  // An empty folder with no way to add a file is the worst case of
                  // the missing-affordance bug — surface upload here, not only in
                  // the toolbar menu.
                  action={
                    canWrite ? (
                      <Button variant="outline" size="sm" className="gap-1.5" onClick={handleUpload}>
                        <Upload className="size-3.5 shrink-0" />
                        {tHardcodedUi.raw('i18nComplete.text4118deee6e13')}
                      </Button>
                    ) : undefined
                  }
                  secondaryAction={
                    canWrite ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setCreateKind('folder')}
                      >
                        <FolderPlus className="size-3.5 shrink-0" />
                        {tHardcodedUi.raw('i18nComplete.textcf28f49ec597')}
                      </Button>
                    ) : undefined
                  }
                />
              )}

              {!isLoading && !error && files && !isEmpty && (
                <>
                  {viewMode === 'grid' ? (
                    <DriveGridView
                      elevatedDirs={elevatedDirs}
                      dirs={dirs}
                      files={fileItems}
                      onNavigateToDir={handleNavigateToDir}
                      onOpenFile={handleOpenFile}
                      onPreviewFile={handlePreviewFile}
                      onDownload={handleDownload}
                      onDownloadDir={handleDownloadDir}
                      onRename={handleRename}
                      onDelete={handleDelete}
                      onHistory={handleHistory}
                      onCopy={handleCopy}
                      onCut={handleCut}
                      onDropMove={handleDropMove}
                      onDropUpload={handleRowDropUpload}
                      gitStatusMap={gitStatusMap}
                      clipboardPath={clipboard?.path}
                      clipboardOperation={clipboard?.operation}
                      isDirDownloading={isDirDownloading}
                      readOnly={!canWrite}
                      uploadingPaths={uploadingPaths}
                    />
                  ) : (
                    <DriveListView
                      elevatedDirs={elevatedDirs}
                      dirs={dirs}
                      files={fileItems}
                      sortDisabled={partial}
                      onNavigateToDir={handleNavigateToDir}
                      onOpenFile={handleOpenFile}
                      onPreviewFile={handlePreviewFile}
                      onDownload={handleDownload}
                      onDownloadDir={handleDownloadDir}
                      onRename={handleRename}
                      onDelete={handleDelete}
                      onHistory={handleHistory}
                      onCopy={handleCopy}
                      onCut={handleCut}
                      onDropMove={handleDropMove}
                      onDropUpload={handleRowDropUpload}
                      gitStatusMap={gitStatusMap}
                      clipboardPath={clipboard?.path}
                      clipboardOperation={clipboard?.operation}
                      isDirDownloading={isDirDownloading}
                      readOnly={!canWrite}
                      uploadingPaths={uploadingPaths}
                    />
                  )}
                  <LoadMoreRow listing={listing} />
                </>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-48">
            <DriveNewMenuItems
              Item={ContextMenuItem}
              Separator={ContextMenuSeparator}
              onUpload={canWrite && filesAllowedHere ? handleUpload : undefined}
              onUploadFolder={canWrite ? handlePickFolder : undefined}
              onNewFile={
                canWrite && filesAllowedHere && capabilities.newFile !== false
                  ? () => setCreateKind('file')
                  : undefined
              }
              onNewFolder={canWrite ? () => setCreateKind('folder') : undefined}
            />
            {ordered.length > 0 ? (
              <>
                {canWrite ? <ContextMenuSeparator /> : null}
                <ContextMenuItem onClick={() => selectionStore.set(new Set(selectionStore.paths()), true)}>
                  <CheckSquareIcon />
                  {tDrives('select')}
                </ContextMenuItem>
                <ContextMenuItem onClick={selectAll}>
                  <CheckSquareIcon />
                  {tDrives('selectAll')}
                </ContextMenuItem>
              </>
            ) : null}
          </ContextMenuContent>
        </ContextMenu>

        {panels}
      </ListingRegion>

      {/* Drag & drop overlay: inset from the edges, the focus-ring blue for
          "this is the target", and the folder the drop lands in. */}
      {canWrite && filesAllowedHere && isDragOverPage && (
        <div className="bg-background/85 pointer-events-none absolute inset-0 z-50 p-3 backdrop-blur-sm">
          {/* Blue is the border's alone; the centre reads like Drive's empty
              state: a muted glyph (the New menu's Upload glyph), then the words. */}
          <div className="border-kortix-base flex h-full flex-col items-center justify-center gap-4 rounded-md border-2 border-dashed p-6 text-center">
            <UploadSimpleIcon className="text-muted-foreground size-10" />
            <div className="max-w-xs space-y-1.5">
              <p className="text-foreground text-sm font-semibold tracking-tight">
                {tDrives('dropToUpload', {
                  folder: normalizedCurrentPath.split('/').filter(Boolean).pop() ?? rootLabel ?? '/',
                })}
              </p>
              <p className="text-muted-foreground text-sm">{tDrives('dropHint')}</p>
            </div>
          </div>
        </div>
      )}

      {/* Clipboard bar: floats at the bottom centre of the listing, inside its
          edges, like the Triggers page's selection bar (\`schedule-view.tsx\`). */}
      {selectMode ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
          <div className="pointer-events-auto w-full max-w-xl">
            <DriveSelectionBar
              store={selectionStore}
              total={ordered.length}
              zipping={zipping}
              canWrite={canWrite}
              onSelectAll={selectAll}
              onClearSelection={() => selectionStore.set(new Set())}
              onDownload={() => void bulkDownload(selectedNodes())}
              onCopy={() => bulkClipboard(selectedNodes(), 'copy')}
              onMove={() => bulkClipboard(selectedNodes(), 'cut')}
              onDelete={() => bulkDelete(selectedNodes())}
              onExit={exitSelect}
            />
          </div>
        </div>
      ) : null}

      {canWrite && clipboard && !selectMode && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
          <div className="bg-popover text-popover-foreground border-border pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-lg border p-2 pl-3.5 shadow-md">
            <Clipboard className="text-muted-foreground size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm" aria-live="polite">
              {clipboardItems.length > 1
                ? tDrives(clipboard.operation === 'cut' ? 'clipboardMovingMany' : 'clipboardCopyingMany', {
                    count: clipboardItems.length,
                  })
                : tDrives(clipboard.operation === 'cut' ? 'clipboardMoving' : 'clipboardCopying', {
                    name: clipboard.name,
                  })}
            </span>
            <ButtonGroup className="shrink-0">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="gap-1.5 active:scale-[0.96]"
                onClick={handlePaste}
                disabled={pasting}
              >
                {pasting ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : (
                  <ClipboardTextIcon className="size-3.5 shrink-0" />
                )}
                {tHardcodedUi.raw('featuresFilesComponentsFileExplorerPage.line771JsxTextPasteHere')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="gap-1.5 active:scale-[0.96]"
                onClick={clearClipboard}
                // A paste already sent cannot be taken back; Cancel would only
                // hide the bar while it finishes.
                disabled={pasting}
              >
                <XIcon className="size-3.5 shrink-0" />
                {tHardcodedUi.raw('i18nComplete.text19766ed6ccb2')}
              </Button>
            </ButtonGroup>
          </div>
        </div>
      )}

      <DriveCreateDialog
        kind={canWrite ? createKind : null}
        location={
          location ?? {
            icon: rootIcon,
            crumbs: [
              ...(rootLabel ? [rootLabel] : []),
              ...normalizedCurrentPath.split('/').filter(Boolean),
            ],
          }
        }
        isTaken={nameTaken}
        askAudience={!!onTeamFolderCreated && isRootPath}
        onCreate={(kind, name, audience) => void handleCreate(kind, name, audience)}
        onClose={() => setCreateKind(null)}
      />

      <DriveRenameDialog
        node={renameTarget}
        isTaken={nameTaken}
        onRename={(node, newName) => void handleRename(node, newName)}
        onClose={() => setRenameTarget(null)}
      />

      {/* File preview modal */}
      <FilePreviewModal embedded={embedded} shareContext={shareContext} />

      {/* History popover */}
      {historyPopoverPath && (
        <div className="bg-popover border-border animate-in slide-in-from-bottom-4 fade-in-0 fixed right-4 bottom-4 z-50 overflow-hidden rounded-md border shadow-xl duration-(--duration-moderate) motion-reduce:animate-none">
          <FileHistoryPopoverContent
            filePath={historyPopoverPath}
            onClose={() => setHistoryPopoverPath(null)}
          />
        </div>
      )}

      {/* A dropped folder asks first: how many files, from where, into where. */}
      <AlertDialog open={!!treeToConfirm} onOpenChange={(open) => !open && setTreeToConfirm(null)}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {treeToConfirm?.name
                ? tDrives('uploadTreeTitle', { count: treeToConfirm.tree.length, name: treeToConfirm.name })
                : tDrives('uploadTreesTitle', {
                    count: treeToConfirm?.tree.length ?? 0,
                    folders: treeToConfirm?.folders ?? 0,
                  })}
            </AlertDialogTitle>
            <AlertDialogDescription>{tDrives('uploadTreeDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tDrives('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const pick = treeToConfirm;
                setTreeToConfirm(null);
                if (pick) void uploadTree(pick.tree, pick.base);
              }}
            >
              {tDrives('upload')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteTargets.length > 0} onOpenChange={() => setDeleteTargets([])}>
        <AlertDialogContent
          className="sm:max-w-md"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            deleteButtonRef.current?.focus();
          }}
        >
          {deleteTargets.length > 1 ? (
            <AlertDialogHeader>
              <AlertDialogTitle>{tDrives('deleteManyTitle', { count: deleteTargets.length })}</AlertDialogTitle>
              <AlertDialogDescription>{tDrives('deleteManyDescription')}</AlertDialogDescription>
            </AlertDialogHeader>
          ) : (
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tHardcodedUi.raw('i18nComplete.texte2d0a54968ea')}{' '}
              {deleteTarget?.type === 'directory' ? 'folder' : 'file'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tHardcodedUi.raw(
                'featuresProjectFilesComponentsFileExplorerPage.line806JsxTextAreYouSureYouWantToDelete',
              )}{' '}
              <span className="text-foreground font-semibold">
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsFileExplorerPage.line807JsxTextQuot',
                )}
                {deleteTarget?.name}
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsFileExplorerPage.line807JsxTextQuot32c14d98',
                )}
              </span>
              {tHardcodedUi.raw(
                'featuresProjectFilesComponentsFileExplorerPage.line807JsxTextThisActionCannotBeUndone',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>
              {tHardcodedUi.raw('i18nComplete.text19766ed6ccb2')}
            </AlertDialogCancel>
            <AlertDialogAction
              ref={deleteButtonRef}
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {tHardcodedUi.raw('i18nComplete.texte2d0a54968ea')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {children}
    </div>
    </DriveRenameContext.Provider>
    </DriveSelectionContext.Provider>
  );
}

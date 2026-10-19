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
import { ErrorState } from '@/features/layout/section/error-state';
import { isSandboxNotReadyError } from '@kortix/sdk';
import {
  ClipboardIcon as Clipboard,
  FolderOpenIcon as FolderOpen,
  FolderPlusIcon as FolderPlus,
  MoonIcon,
  UploadIcon as Upload,
} from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { DriveCreateDialog, type DriveCreateKind, type DriveLocation } from './drive-create-dialog';
import { DriveGridView } from './drive-grid-view';
import { DriveListView } from './drive-list-view';
import { type DriveUpload, DriveUploadTray } from './drive-upload-tray';
import {
  DRIVE_ACTION_ROW_CLASS,
  DriveNewMenu,
  DriveNewMenuItems,
  DrivePathBar,
  DriveViewMenu,
} from './drive-toolbar';
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
  const [uploads, setUploads] = useState<DriveUpload[]>([]);
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

  const [deleteTarget, setDeleteTarget] = useState<FileNode | null>(null);

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
      setDeleteTarget(node);
    },
    [goBackToBrowser, filesStore],
  );

  /** The row goes at once and the dialog closes; a refused delete brings it back. */
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setGone((prev) => [...prev, { path: target.path }]);
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
  }, [deleteTarget, deleteMutation, settleGone, tHardcodedUi]);

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
        successToast(tHardcodedUi('i18nComplete.text854362dd1a76', { value0: sourceName }));
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
      const patch = (next: Partial<DriveUpload>) =>
        setUploads((prev) => prev.map((u) => (u.id === upload.id ? { ...u, ...next } : u)));
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

  /** Put files in the tray with their previews, then send them, 4 at a time. */
  const startBatch = useCallback(
    async (items: { file: File; targetPath?: string }[], shownIn: string | null) => {
      const batch: DriveUpload[] = items.map(({ file, targetPath }) => ({
        id: crypto.randomUUID(),
        file,
        targetPath,
        status: 'queued',
      }));
      // A finished earlier batch makes way; one still running keeps its rows.
      setUploads((prev) => (prev.every((u) => u.status === 'done') ? batch : [...prev, ...batch]));
      for (const u of batch) previewUpload?.(u.file, u.targetPath);
      let failed = 0;
      await forEachLimit(batch, UPLOAD_CONCURRENCY, async (u) => {
        if (!(await runUpload(u, shownIn))) failed++;
      });
      // One toast for the whole batch; a failure stays in the tray with Retry.
      if (failed === 0) successToast(tDrives('uploaded', { count: batch.length }));
    },
    [previewUpload, runUpload, tDrives],
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
      );
    },
    [currentPath, isRootPath, pendingNode, startBatch],
  );

  /**
   * Upload a picked folder: its tree is made here first, one depth at a time
   * (a level's folders in parallel), then its files go up into it. The top
   * folder shows in the listing at once.
   */
  const handleUploadFolder = useCallback(
    async (fileList: FileList) => {
      const { accepted, rejected } = partitionUploadBatch(Array.from(fileList));
      for (const { reason } of rejected) errorToast(reason);
      if (accepted.length === 0) return;

      const here = (rel: string) => (normalizedCurrentPath ? `${normalizedCurrentPath}/${rel}` : rel);
      // `webkitRelativePath` is `Picked/sub/file.png`.
      const dirOf = (file: File) => (file.webkitRelativePath || file.name).split('/').slice(0, -1);
      const levels: string[][] = [];
      for (const file of accepted) {
        dirOf(file).forEach((_, depth, parts) => {
          (levels[depth] ??= []).push(parts.slice(0, depth + 1).join('/'));
        });
      }
      const top = levels[0]?.[0];
      if (!top) return;

      const dir = currentPath;
      setPending((prev) => [...prev, { dir, node: pendingNode(top, 'directory') }]);
      let ok = true;
      try {
        for (const level of levels) {
          await Promise.all(
            [...new Set(level)].map((d) =>
              mkdirMutation.mutateAsync({ dirPath: here(d) }).catch((err: unknown) => {
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
        settlePending(dir, top, ok);
      }
      if (!ok) return;
      await startBatch(
        accepted.map((file) => ({ file, targetPath: here(dirOf(file).join('/')) })),
        null,
      );
    },
    [currentPath, normalizedCurrentPath, pendingNode, settlePending, mkdirMutation, startBatch, tHardcodedUi],
  );

  const handleRetryUpload = useCallback(
    (id: string) => {
      const upload = uploads.find((u) => u.id === id);
      if (!upload) return;
      previewUpload?.(upload.file, upload.targetPath);
      void runUpload(upload, null);
    },
    [uploads, previewUpload, runUpload],
  );

  // A clean run leaves the tray for 4 s; one with a failure stays until closed.
  useEffect(() => {
    if (uploads.length === 0 || uploads.some((u) => u.status !== 'done')) return;
    const timer = window.setTimeout(() => setUploads([]), 4_000);
    return () => window.clearTimeout(timer);
  }, [uploads]);

  /**
   * External files dropped onto a folder row upload INTO that folder.
   *
   * The row stops the event before the page-level handler sees it, so this
   * also clears the page drop overlay — otherwise it would stay on screen.
   */
  const handleRowDropUpload = useCallback(
    (files: File[], targetDirPath: string) => {
      dragPageCounter.current = 0;
      setIsDragOverPage(false);
      void handleUploadFiles(files, targetDirPath);
    },
    [handleUploadFiles],
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
    async (kind: DriveCreateKind, name: string) => {
      const dir = currentPath;
      const node = pendingNode(name, kind === 'folder' ? 'directory' : 'file');
      setPending((prev) => [...prev, { dir, node }]);
      let ok = false;
      try {
        if (kind === 'folder') await mkdirMutation.mutateAsync({ dirPath: node.path });
        else await createMutation.mutateAsync({ filePath: node.path });
        ok = true;
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
    [currentPath, pendingNode, settlePending, mkdirMutation, createMutation, tHardcodedUi],
  );

  // Paste
  const handlePaste = useCallback(async () => {
    if (!clipboard) return;
    const destDir = normalizedCurrentPath;
    let destName = clipboard.name;

    if (files) {
      const existingNames = new Set(files.map((f) => f.name.toLowerCase()));
      if (existingNames.has(destName.toLowerCase())) {
        if (clipboard.operation === 'copy') {
          const ext = destName.includes('.') ? destName.substring(destName.lastIndexOf('.')) : '';
          const baseName = ext ? destName.substring(0, destName.lastIndexOf('.')) : destName;
          let counter = 0;
          let candidate = `${baseName} (copy)${ext}`;
          while (existingNames.has(candidate.toLowerCase())) {
            counter++;
            candidate = `${baseName} (copy ${counter + 1})${ext}`;
          }
          destName = candidate;
        } else {
          const sourceDir = clipboard.path.substring(0, clipboard.path.lastIndexOf('/')) || '.';
          const normalizedSourceDir = sourceDir === '' ? '.' : sourceDir;
          const normalizedDestDir = destDir === '' ? '.' : destDir;
          if (normalizedSourceDir === normalizedDestDir) {
            errorToast(tHardcodedUi.raw('i18nComplete.text7a1bdceb4943'));
            return;
          }
        }
      }
    }

    const destPath = destDir ? `${destDir}/${destName}` : destName;

    try {
      if (clipboard.operation === 'copy') {
        if (clipboard.type === 'file') {
          await copyMutation.mutateAsync({ sourcePath: clipboard.path, destPath });
          successToast(tHardcodedUi('i18nComplete.textbb45167cfb4d', { value0: clipboard.name }));
        } else {
          await mkdirMutation.mutateAsync({ dirPath: destPath });
          successToast(tHardcodedUi('i18nComplete.textd6318e7ae71a', { value0: clipboard.name }));
        }
      } else {
        await renameMutation.mutateAsync({ from: clipboard.path, to: destPath });
        successToast(tHardcodedUi('i18nComplete.text59004552be50', { value0: clipboard.name }));
        clearClipboard();
      }
    } catch (err) {
      errorToast(
        tHardcodedUi('i18nComplete.texta619e901f9c0', {
          value0:
            err instanceof Error ? err.message : tHardcodedUi.raw('i18nComplete.text27c2ccd962c2'),
        }),
      );
    }
  }, [
    clipboard,
    normalizedCurrentPath,
    files,
    copyMutation,
    renameMutation,
    mkdirMutation,
    clearClipboard,
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

      if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
      await handleUploadFiles(e.dataTransfer.files);
    },
    [canWrite, filesAllowedHere, handleUploadFiles],
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
          <ContextMenuTrigger asChild disabled={!canWrite}>
            <div className="absolute inset-0 overflow-y-auto">
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
                  icon={FolderOpen}
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
                        variant="ghost"
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
              onUpload={filesAllowedHere ? handleUpload : undefined}
              onUploadFolder={handlePickFolder}
              onNewFile={
                filesAllowedHere && capabilities.newFile !== false ? () => setCreateKind('file') : undefined
              }
              onNewFolder={() => setCreateKind('folder')}
            />
          </ContextMenuContent>
        </ContextMenu>

        {panels}
      </ListingRegion>

      {/* Drag & drop overlay */}
      {canWrite && filesAllowedHere && isDragOverPage && (
        <div className="bg-background/80 border-primary/50 pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-md border-2 border-dashed backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="bg-primary/10 flex h-16 w-16 items-center justify-center rounded-md">
              <Upload className="text-primary h-8 w-8" />
            </div>
            <div>
              <p className="text-foreground text-base font-medium">
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsFileExplorerPage.line771JsxTextDropFilesToUpload',
                )}
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsFileExplorerPage.line773JsxTextFilesWillBeUploadedToTheCurrentDirectory',
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Clipboard indicator bar */}
      {canWrite && clipboard && (
        <div className="border-border/40 bg-muted/20 text-muted-foreground flex shrink-0 items-center justify-between gap-2 border-t px-4 py-2 text-xs">
          <div className="flex items-center gap-2">
            <Clipboard className="h-3.5 w-3.5" />
            <span>
              {clipboard.operation === 'cut' ? 'Moving' : 'Copying'}:{' '}
              <span className="text-foreground font-medium">{clipboard.name}</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              onClick={handlePaste}
              disabled={copyMutation.isPending || renameMutation.isPending}
            >
              {tHardcodedUi.raw('featuresFilesComponentsFileExplorerPage.line771JsxTextPasteHere')}
            </Button>
            <button
              onClick={clearClipboard}
              className="text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
            >
              {tHardcodedUi.raw('i18nComplete.text19766ed6ccb2')}
            </button>
          </div>
        </div>
      )}

      {canWrite ? (
        <DriveUploadTray
          uploads={uploads}
          onRetry={handleRetryUpload}
          onDismiss={() => setUploads([])}
        />
      ) : null}

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
        onCreate={(kind, name) => void handleCreate(kind, name)}
        onClose={() => setCreateKind(null)}
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

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent
          className="sm:max-w-md"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            deleteButtonRef.current?.focus();
          }}
        >
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
  );
}

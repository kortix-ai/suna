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
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { Clipboard, FilePlus, FolderOpen, FolderPlus, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useFileExplorerSource } from '../explorer-source';
import { buildGitStatusMap } from '../hooks';
import { useFilesStore } from '../store/files-store';
import type { FileNode } from '../types';
import { DriveGridView } from './drive-grid-view';
import { DriveListView } from './drive-list-view';
import { DriveToolbar } from './drive-toolbar';
import { FileHistoryPopoverContent } from './file-history-popover';
import { FilePreviewModal } from './file-preview-modal';
import { FileSearch } from './file-search';
import { DRAG_MIME } from './file-tree-item';

/** System directories always pinned at the top of the listing. */
const ELEVATED_DIRS = new Set(['.kortix', '.opencode']);

export interface DriveExplorerToolbarOptions {
  showVersionSelector?: boolean;
  checkpointsToggle?: { open: boolean; onToggle: () => void };
  changeRequestsToggle?: { open: boolean; onToggle: () => void; openCount?: number };
  openChangeRequestAction?: { onClick: () => void; disabled?: boolean };
}

/**
 * Google Drive-style file explorer — the ONE explorer implementation, shared
 * by every surface. Data access comes from the injected FileExplorerSource
 * (live sandbox vs. project git-ref); capabilities on the source decide which
 * affordances render (mutations, search overlay, dotfile toggle, …).
 *
 * Layout:
 * +---------------------------------------------------+
 * | DriveToolbar (breadcrumbs + actions)               |
 * +---------------------------------------------------+
 * | Main area (grid or list view) + injected panels    |
 * +---------------------------------------------------+
 *
 * Opening a file (single- or double-click, context menu) always opens the
 * full-screen preview modal overlay.
 */
export function DriveExplorer({
  embedded = false,
  shareContext,
  toolbar,
  panels,
  children,
}: {
  embedded?: boolean;
  shareContext?: { projectId: string; sessionId: string };
  toolbar?: DriveExplorerToolbarOptions;
  /** Rendered inside the relative content area (slide-in side panels). */
  panels?: ReactNode;
  /** Rendered at the root (portal dialogs owned by the wrapping surface). */
  children?: ReactNode;
} = {}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const source = useFileExplorerSource();
  const { capabilities } = source;
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

  const {
    data: files,
    isLoading,
    isFetching,
    error,
    refetch: refetchFiles,
  } = source.useFileList(currentPath);

  const { data: gitStatuses } = source.useGitStatus();
  const gitStatusMap = useMemo(() => buildGitStatusMap(gitStatuses), [gitStatuses]);

  const uploadMutation = source.useFileUpload();
  const deleteMutation = source.useFileDelete();
  const mkdirMutation = source.useFileMkdir();
  const renameMutation = source.useFileRename();
  const createMutation = source.useFileCreate();
  const copyMutation = source.useFileCopy();
  const downloadFile = source.useDownloadFile();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  const [isDragOverPage, setIsDragOverPage] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const dragPageCounter = useRef(0);

  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileCreateInputRef = useRef<HTMLInputElement>(null);

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

  // Auto-focus folder input
  useEffect(() => {
    if (isCreatingFolder) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = folderInputRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(0, el.value.length);
          }
        });
      });
    }
  }, [isCreatingFolder]);

  // Auto-focus file input
  useEffect(() => {
    if (isCreatingFile) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = fileCreateInputRef.current;
          if (el) {
            el.focus();
            const dotIdx = el.value.lastIndexOf('.');
            el.setSelectionRange(0, dotIdx > 0 ? dotIdx : el.value.length);
          }
        });
      });
    }
  }, [isCreatingFile]);

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

    const allDirs = files.filter((f) => f.type === 'directory');
    const elevatedDirs = allDirs
      .filter((f) => ELEVATED_DIRS.has(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const dirs = allDirs.filter((f) => !ELEVATED_DIRS.has(f.name)).sort(sortFn);
    const fileItems = files.filter((f) => f.type === 'file').sort(sortFn);
    return { elevatedDirs, dirs, fileItems };
  }, [files, sortBy, sortOrder]);

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
        successToast(`Downloaded ${node.name}`);
      } catch {
        errorToast(`Failed to download ${node.name}`);
      }
    },
    [downloadFile],
  );

  const handleDownloadDir = useCallback(
    (node: FileNode) => {
      downloadDir(node.path, node.name);
    },
    [downloadDir],
  );

  const handleRename = useCallback(
    async (node: FileNode, newName: string) => {
      if (!newName || newName === node.name) return;
      const parentPath = node.path.substring(0, node.path.lastIndexOf('/'));
      const newPath = parentPath ? `${parentPath}/${newName}` : newName;
      try {
        await renameMutation.mutateAsync({ from: node.path, to: newPath });
        successToast(`Renamed to ${newName}`);
      } catch (err) {
        errorToast(`Failed to rename: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
    [renameMutation],
  );

  const handleDelete = useCallback((node: FileNode) => {
    setDeleteTarget(node);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ filePath: deleteTarget.path });
      successToast(`Deleted ${deleteTarget.name}`);
    } catch (err) {
      errorToast(`Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, deleteMutation]);

  const handleHistory = useCallback((node: FileNode) => {
    setHistoryPopoverPath(node.path);
  }, []);

  const handleCopy = useCallback(
    (node: FileNode) => {
      copyToClipboard(node.path, node.name, node.type);
      successToast(`Copied "${node.name}" to clipboard`);
    },
    [copyToClipboard],
  );

  const handleCut = useCallback(
    (node: FileNode) => {
      cutToClipboard(node.path, node.name, node.type);
      successToast(`Cut "${node.name}" to clipboard`);
    },
    [cutToClipboard],
  );

  const handleDropMove = useCallback(
    async (sourcePath: string, targetDirPath: string) => {
      const sourceName = sourcePath.split('/').pop() || '';
      const destPath = targetDirPath ? `${targetDirPath}/${sourceName}` : sourceName;
      if (sourcePath === destPath) return;
      try {
        await renameMutation.mutateAsync({ from: sourcePath, to: destPath });
        successToast(`Moved "${sourceName}"`);
      } catch (err) {
        errorToast(`Failed to move: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
    [renameMutation],
  );

  // Upload
  const handleUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /** Upload a batch of files, showing per-file toasts */
  const handleUploadFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      setUploadingCount(files.length);
      let successCount = 0;

      for (const file of files) {
        try {
          await uploadMutation.mutateAsync({
            file,
            targetPath: isRootPath ? undefined : currentPath,
          });
          successCount++;
        } catch (err) {
          errorToast(
            `Failed to upload ${file.name}: ${err instanceof Error ? err.message : 'Unknown error'}`,
          );
        }
      }

      setUploadingCount(0);

      if (successCount > 0) {
        successToast(
          successCount === 1
            ? `Uploaded ${files[0].name}`
            : `Uploaded ${successCount} file${successCount > 1 ? 's' : ''}`,
        );
      }
    },
    [uploadMutation, isRootPath, currentPath],
  );

  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files || e.target.files.length === 0) return;
      await handleUploadFiles(e.target.files);
      e.target.value = '';
    },
    [handleUploadFiles],
  );

  // Create folder
  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) {
      setIsCreatingFolder(false);
      return;
    }
    const folderPath = normalizedCurrentPath
      ? `${normalizedCurrentPath}/${newFolderName.trim()}`
      : newFolderName.trim();
    try {
      await mkdirMutation.mutateAsync({ dirPath: folderPath });
      successToast(`Created folder: ${newFolderName.trim()}`);
    } catch (err) {
      errorToast(
        `Failed to create folder: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    } finally {
      setIsCreatingFolder(false);
      setNewFolderName('');
    }
  }, [mkdirMutation, normalizedCurrentPath, newFolderName]);

  // Create file
  const handleCreateFile = useCallback(async () => {
    if (!newFileName.trim()) {
      setIsCreatingFile(false);
      return;
    }
    const filePath = normalizedCurrentPath
      ? `${normalizedCurrentPath}/${newFileName.trim()}`
      : newFileName.trim();
    try {
      await createMutation.mutateAsync({ filePath });
      successToast(`Created file: ${newFileName.trim()}`);
    } catch (err) {
      errorToast(`Failed to create file: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsCreatingFile(false);
      setNewFileName('');
    }
  }, [createMutation, normalizedCurrentPath, newFileName]);

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
            errorToast('Item is already in this directory');
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
          successToast(`Copied "${clipboard.name}" here`);
        } else {
          await mkdirMutation.mutateAsync({ dirPath: destPath });
          successToast(`Created copy of folder "${clipboard.name}" here (empty)`);
        }
      } else {
        await renameMutation.mutateAsync({ from: clipboard.path, to: destPath });
        successToast(`Moved "${clipboard.name}" here`);
        clearClipboard();
      }
    } catch (err) {
      errorToast(`Failed to paste: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [
    clipboard,
    normalizedCurrentPath,
    files,
    copyMutation,
    renameMutation,
    mkdirMutation,
    clearClipboard,
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
      if (!canWrite) return;
      e.preventDefault();
      e.stopPropagation();
      dragPageCounter.current = 0;
      setIsDragOverPage(false);

      if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
      await handleUploadFiles(e.dataTransfer.files);
    },
    [canWrite, handleUploadFiles],
  );

  const isEmpty =
    !isLoading &&
    !error &&
    Boolean(files) &&
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
      <DriveToolbar
        readOnly={!canWrite}
        showSearch={capabilities.search}
        showHiddenToggle={capabilities.hiddenToggle}
        showVersionSelector={toolbar?.showVersionSelector}
        checkpointsToggle={toolbar?.checkpointsToggle}
        changeRequestsToggle={toolbar?.changeRequestsToggle}
        openChangeRequestAction={toolbar?.openChangeRequestAction}
        onRefresh={() => refetchFiles()}
        isRefreshing={isFetching}
        onUpload={handleUpload}
        onNewFolder={() => {
          setNewFolderName('New Folder');
          setIsCreatingFolder(true);
        }}
        onNewFile={() => {
          setNewFileName('untitled.txt');
          setIsCreatingFile(true);
        }}
        onDownloadDir={() => {
          const dirName = isRootPath
            ? 'workspace'
            : currentPath.split('/').filter(Boolean).pop() || 'directory';
          const dirPath = isRootPath ? '/workspace' : currentPath;
          downloadDir(dirPath, dirName);
        }}
        isDownloading={isDirDownloading(isRootPath ? '/workspace' : currentPath)}
      />

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

      {/* Inline create inputs (shown at top of file area) */}
      {canWrite && (isCreatingFolder || isCreatingFile) && (
        <div className="border-border/30 bg-muted/10 border-b px-4 py-2">
          {isCreatingFolder && (
            <div className="flex max-w-md items-center gap-2">
              <FolderPlus className="text-muted-foreground h-4 w-4 shrink-0" />
              <input
                type="text"
                ref={folderInputRef}
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateFolder();
                  if (e.key === 'Escape') {
                    setIsCreatingFolder(false);
                    setNewFolderName('');
                  }
                }}
                onBlur={handleCreateFolder}
                className="border-border focus:ring-primary flex-1 rounded-2xl border bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1"
                placeholder={tHardcodedUi.raw(
                  'featuresProjectFilesComponentsFileExplorerPage.line594JsxAttrPlaceholderFolderName',
                )}
              />
            </div>
          )}
          {isCreatingFile && (
            <div className="flex max-w-md items-center gap-2">
              <FilePlus className="text-muted-foreground h-4 w-4 shrink-0" />
              <input
                type="text"
                ref={fileCreateInputRef}
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateFile();
                  if (e.key === 'Escape') {
                    setIsCreatingFile(false);
                    setNewFileName('');
                  }
                }}
                onBlur={handleCreateFile}
                className="border-border focus:ring-primary flex-1 rounded-2xl border bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1"
                placeholder={tHardcodedUi.raw(
                  'featuresProjectFilesComponentsFileExplorerPage.line612JsxAttrPlaceholderFileName',
                )}
              />
            </div>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 overflow-y-auto">
          {isLoading && showSkeleton && (
            <div className="animate-in fade-in-0 p-4 duration-200">
              {viewMode === 'grid' ? (
                <div className="space-y-6">
                  <div>
                    <Skeleton className="mb-3 h-4 w-16" />
                    <div
                      className="grid gap-2"
                      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
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
                      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}
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
                    <Skeleton key={i} className="h-10 w-full rounded" />
                  ))}
                </div>
              )}
            </div>
          )}

          {!!error && !isLoading && (
            <ErrorState
              title={tHardcodedUi.raw(
                'featuresProjectFilesComponentsFileExplorerPage.line658JsxTextFailedToLoadFiles',
              )}
              description={error instanceof Error ? error.message : 'Unknown error'}
              action={
                <Button variant="outline" size="sm" onClick={() => refetchFiles()}>
                  Retry
                </Button>
              }
            />
          )}

          {isEmpty && (
            <EmptyState
              icon={FolderOpen}
              title={tHardcodedUi.raw(
                'featuresProjectFilesComponentsDriveListView.line396JsxTextThisFolderIsEmpty',
              )}
              description={tHardcodedUi.raw(
                'featuresProjectFilesComponentsDriveListView.line398JsxTextNoFilesOrSubfoldersAtThisPathIn',
              )}
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
                  gitStatusMap={gitStatusMap}
                  clipboardPath={clipboard?.path}
                  clipboardOperation={clipboard?.operation}
                  isDirDownloading={isDirDownloading}
                  readOnly={!canWrite}
                />
              ) : (
                <DriveListView
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
                  gitStatusMap={gitStatusMap}
                  clipboardPath={clipboard?.path}
                  clipboardOperation={clipboard?.operation}
                  isDirDownloading={isDirDownloading}
                  readOnly={!canWrite}
                />
              )}
            </>
          )}
        </div>

        {panels}
      </div>

      {/* Upload progress indicator */}
      {uploadingCount > 0 && (
        <div className="absolute top-12 right-0 left-0 z-40">
          <div className="bg-primary/20 h-0.5 w-full overflow-hidden">
            <div className="bg-primary h-full w-full animate-pulse" />
          </div>
        </div>
      )}

      {/* Drag & drop overlay */}
      {canWrite && isDragOverPage && (
        <div className="bg-background/80 border-primary/50 pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="bg-primary/10 flex h-16 w-16 items-center justify-center rounded-2xl">
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
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* File preview modal */}
      <FilePreviewModal embedded={embedded} shareContext={shareContext} />

      {/* History popover */}
      {historyPopoverPath && (
        <div className="bg-popover border-border animate-in slide-in-from-bottom-4 fade-in-0 fixed right-4 bottom-4 z-50 overflow-hidden rounded-2xl border shadow-2xl duration-200">
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
              Delete {deleteTarget?.type === 'directory' ? 'folder' : 'file'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tHardcodedUi.raw(
                'featuresProjectFilesComponentsFileExplorerPage.line806JsxTextAreYouSureYouWantToDelete',
              )}{' '}
              <span className="text-foreground font-semibold">
                {tHardcodedUi.raw('featuresProjectFilesComponentsFileExplorerPage.line807JsxTextQuot')}
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
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              ref={deleteButtonRef}
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {children}
    </div>
  );
}

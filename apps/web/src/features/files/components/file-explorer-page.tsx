'use client';

import { useEffect, useMemo, useCallback, useState, useRef } from 'react';
import {
  Search,
  ServerOff,
  RefreshCw,
  FolderPlus,
  FilePlus,
  Upload,
  Clipboard,
  FolderOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { Skeleton } from '@/components/ui/skeleton';
import { useFilesStore } from '../store/files-store';
import {
  useFileList,
  useServerHealth,
  useFileEventInvalidation,
  useGitStatus,
  buildGitStatusMap,
} from '../hooks';
import {
  useFileUpload,
  useFileDelete,
  useFileMkdir,
  useFileRename,
  useFileCreate,
  useFileCopy,
} from '../hooks/use-file-mutations';
import { downloadFile } from '../api/opencode-files';
import { useDirectoryDownload } from '../hooks/use-directory-download';
import { useServerStore } from '@/stores/server-store';
import { openTabAndNavigate } from '@/stores/tab-store';
import type { FileNode } from '../types';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

import { DriveToolbar } from './drive-toolbar';
import { DriveGridView } from './drive-grid-view';
import { DriveListView } from './drive-list-view';
import { FileSearch } from './file-search';
import { FilePreviewModal } from './file-preview-modal';
import { FileHistoryPopoverContent } from './file-history-popover';
import { DRAG_MIME } from './file-tree-item';

/**
 * Google Drive-style file explorer page.
 * 
 * Layout:
 * +---------------------------------------------------+
 * | DriveToolbar (breadcrumbs + actions)               |
 * +---------------------------------------------------+
 * | Main area (grid or list view)                      |
 * +---------------------------------------------------+
 * 
 * File preview opens as a full-screen modal overlay.
 */
export function FileExplorerPage() {
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const viewMode = useFilesStore((s) => s.viewMode);
  const sortBy = useFilesStore((s) => s.sortBy);
  const sortOrder = useFilesStore((s) => s.sortOrder);
  const isSearchOpen = useFilesStore((s) => s.isSearchOpen);
  const toggleSearch = useFilesStore((s) => s.toggleSearch);
  const closeSearch = useFilesStore((s) => s.closeSearch);
  const openFile = useFilesStore((s) => s.openFile);
  const openFileWithList = useFilesStore((s) => s.openFileWithList);

  // Clipboard
  const clipboard = useFilesStore((s) => s.clipboard);
  const copyToClipboard = useFilesStore((s) => s.copyToClipboard);
  const cutToClipboard = useFilesStore((s) => s.cutToClipboard);
  const clearClipboard = useFilesStore((s) => s.clearClipboard);

  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const { data: health, isLoading: isHealthLoading, refetch } = useServerHealth();

  useFileEventInvalidation();

  // File list
  const {
    data: files,
    isLoading,
    error,
    refetch: refetchFiles,
  } = useFileList(currentPath, {
    enabled: health?.healthy === true,
  });

  // Git status
  const { data: gitStatuses } = useGitStatus({ enabled: health?.healthy === true });
  const gitStatusMap = useMemo(() => buildGitStatusMap(gitStatuses), [gitStatuses]);

  // Mutations
  const uploadMutation = useFileUpload();
  const deleteMutation = useFileDelete();
  const mkdirMutation = useFileMkdir();
  const renameMutation = useFileRename();
  const createMutation = useFileCreate();
  const copyMutation = useFileCopy();

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  // Drag & drop upload state
  const [isDragOverPage, setIsDragOverPage] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const dragPageCounter = useRef(0);

  // Inline create states
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileCreateInputRef = useRef<HTMLInputElement>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<FileNode | null>(null);

  // Directory download
  const { downloadDir, isDownloading: isDirDownloading } = useDirectoryDownload();

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
          if (el) { el.focus(); el.setSelectionRange(0, el.value.length); }
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

  // Cmd+P search, Escape close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      const isMod = e.metaKey || e.ctrlKey;

      if (isMod && e.key === 'p') {
        e.preventDefault();
        toggleSearch();
        return;
      }

      if (e.key === 'Escape' && isSearchOpen) {
        e.preventDefault();
        closeSearch();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSearch, closeSearch, isSearchOpen]);

  // Elevated system directories — always pinned at the top
  const ELEVATED_DIRS = new Set(['.kortix', '.opencode']);

  // Sort and separate dirs and files
  const { elevatedDirs, dirs, fileItems } = useMemo(() => {
    if (!files) return { elevatedDirs: [] as FileNode[], dirs: [] as FileNode[], fileItems: [] as FileNode[] };

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
    const dirs = allDirs
      .filter((f) => !ELEVATED_DIRS.has(f.name))
      .sort(sortFn);
    const fileItems = files
      .filter((f) => f.type === 'file')
      .sort(sortFn);
    return { elevatedDirs, dirs, fileItems };
  }, [files, sortBy, sortOrder]);

  // ── Handlers ──────────────────────────────────────────────────

  const handleNavigateToDir = useCallback((node: FileNode) => {
    navigateToPath(node.path);
  }, [navigateToPath]);

  const handleOpenFile = useCallback((node: FileNode) => {
    // Open in tab
    openTabAndNavigate({
      id: `file:${node.path}`,
      title: node.name,
      type: 'file',
      href: `/files/${encodeURIComponent(node.path)}`,
    });
  }, []);

  const handlePreviewFile = useCallback((node: FileNode) => {
    // Open in preview modal
    const allFiles = fileItems.map((f) => f.path);
    const index = allFiles.indexOf(node.path);
    openFileWithList(node.path, allFiles, Math.max(0, index));
  }, [fileItems, openFileWithList]);

  const handleOpenInTab = useCallback((node: FileNode) => {
    openTabAndNavigate({
      id: `file:${node.path}`,
      title: node.name,
      type: 'file',
      href: `/files/${encodeURIComponent(node.path)}`,
    });
  }, []);

  const handleDownload = useCallback(async (node: FileNode) => {
    try {
      await downloadFile(node.path, node.name);
      toast.success(`Downloaded ${node.name}`);
    } catch {
      toast.error(`Failed to download ${node.name}`);
    }
  }, []);

  const handleDownloadDir = useCallback((node: FileNode) => {
    downloadDir(node.path, node.name);
  }, [downloadDir]);

  const handleRename = useCallback(async (node: FileNode, newName: string) => {
    if (!newName || newName === node.name) return;
    const parentPath = node.path.substring(0, node.path.lastIndexOf('/'));
    const newPath = parentPath ? `${parentPath}/${newName}` : newName;
    try {
      await renameMutation.mutateAsync({ from: node.path, to: newPath });
      toast.success(`Renamed to ${newName}`);
    } catch (err) {
      toast.error(`Failed to rename: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [renameMutation]);

  const handleDelete = useCallback((node: FileNode) => {
    setDeleteTarget(node);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ filePath: deleteTarget.path });
      toast.success(`Deleted ${deleteTarget.name}`);
    } catch (err) {
      toast.error(`Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, deleteMutation]);

  const handleHistory = useCallback((node: FileNode) => {
    setHistoryPopoverPath(node.path);
  }, []);

  const handleCopy = useCallback((node: FileNode) => {
    copyToClipboard(node.path, node.name, node.type);
    toast.success(`Copied "${node.name}" to clipboard`);
  }, [copyToClipboard]);

  const handleCut = useCallback((node: FileNode) => {
    cutToClipboard(node.path, node.name, node.type);
    toast.success(`Cut "${node.name}" to clipboard`);
  }, [cutToClipboard]);

  const handleDropMove = useCallback(async (sourcePath: string, targetDirPath: string) => {
    const sourceName = sourcePath.split('/').pop() || '';
    const destPath = targetDirPath ? `${targetDirPath}/${sourceName}` : sourceName;
    if (sourcePath === destPath) return;
    try {
      await renameMutation.mutateAsync({ from: sourcePath, to: destPath });
      toast.success(`Moved "${sourceName}"`);
    } catch (err) {
      toast.error(`Failed to move: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [renameMutation]);

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
          toast.error(
            `Failed to upload ${file.name}: ${err instanceof Error ? err.message : 'Unknown error'}`,
          );
        }
      }

      setUploadingCount(0);

      if (successCount > 0) {
        toast.success(
          successCount === 1
            ? `Uploaded ${files[0].name}`
            : `Uploaded ${successCount} file${successCount > 1 ? 's' : ''}`,
        );
      }
    },
    [uploadMutation, isRootPath, currentPath],
  );

  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    await handleUploadFiles(e.target.files);
    e.target.value = '';
  }, [handleUploadFiles]);

  // Create folder
  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) { setIsCreatingFolder(false); return; }
    const folderPath = normalizedCurrentPath
      ? `${normalizedCurrentPath}/${newFolderName.trim()}`
      : newFolderName.trim();
    try {
      await mkdirMutation.mutateAsync({ dirPath: folderPath });
      toast.success(`Created folder: ${newFolderName.trim()}`);
    } catch (err) {
      toast.error(`Failed to create folder: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsCreatingFolder(false);
      setNewFolderName('');
    }
  }, [mkdirMutation, normalizedCurrentPath, newFolderName]);

  // Create file
  const handleCreateFile = useCallback(async () => {
    if (!newFileName.trim()) { setIsCreatingFile(false); return; }
    const filePath = normalizedCurrentPath
      ? `${normalizedCurrentPath}/${newFileName.trim()}`
      : newFileName.trim();
    try {
      await createMutation.mutateAsync({ filePath });
      toast.success(`Created file: ${newFileName.trim()}`);
    } catch (err) {
      toast.error(`Failed to create file: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
            toast.error('Item is already in this directory');
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
          toast.success(`Copied "${clipboard.name}" here`);
        } else {
          await mkdirMutation.mutateAsync({ dirPath: destPath });
          toast.success(`Created copy of folder "${clipboard.name}" here (empty)`);
        }
      } else {
        await renameMutation.mutateAsync({ from: clipboard.path, to: destPath });
        toast.success(`Moved "${clipboard.name}" here`);
        clearClipboard();
      }
    } catch (err) {
      toast.error(`Failed to paste: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [clipboard, normalizedCurrentPath, files, copyMutation, renameMutation, mkdirMutation, clearClipboard]);

  // Keyboard: Ctrl+V paste
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'v' && clipboard) {
        e.preventDefault();
        handlePaste();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clipboard, handlePaste]);

  // Local history popover state
  const [historyPopoverPath, setHistoryPopoverPath] = useState<string | null>(null);

  // ── Page-level drag & drop (external files only) ─────────────
  const isExternalFileDrag = useCallback((e: React.DragEvent) => {
    // Only activate for external file drops, not internal file-tree drags
    return e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes(DRAG_MIME);
  }, []);

  const handlePageDragEnter = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragPageCounter.current++;
    if (dragPageCounter.current === 1) {
      setIsDragOverPage(true);
    }
  }, [isExternalFileDrag]);

  const handlePageDragLeave = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragPageCounter.current--;
    if (dragPageCounter.current <= 0) {
      dragPageCounter.current = 0;
      setIsDragOverPage(false);
    }
  }, [isExternalFileDrag]);

  const handlePageDragOver = useCallback((e: React.DragEvent) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, [isExternalFileDrag]);

  const handlePageDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragPageCounter.current = 0;
    setIsDragOverPage(false);

    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    await handleUploadFiles(e.dataTransfer.files);
  }, [handleUploadFiles]);

  // ── Render ────────────────────────────────────────────────────

  // Server not reachable
  if (!isHealthLoading && !health?.healthy) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center bg-background">
        <ServerOff className="h-12 w-12 text-muted-foreground/30" />
        <div>
          <h3 className="text-base font-medium text-foreground">Server not reachable</h3>
          <p className="text-sm text-muted-foreground mt-1.5">
            Could not connect to{' '}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{serverUrl}</code>
          </p>
        </div>
        <Button variant="outline" size="sm" className="" onClick={() => refetch()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div
      className="h-full flex flex-col bg-background relative"
      onDragEnter={handlePageDragEnter}
      onDragLeave={handlePageDragLeave}
      onDragOver={handlePageDragOver}
      onDrop={handlePageDrop}
    >
      <DriveToolbar
        onUpload={handleUpload}
        onNewFolder={() => { setNewFolderName('New Folder'); setIsCreatingFolder(true); }}
        onNewFile={() => { setNewFileName('untitled.txt'); setIsCreatingFile(true); }}
        onDownloadDir={() => {
          const dirName = isRootPath ? 'workspace' : (currentPath.split('/').filter(Boolean).pop() || 'directory');
          const dirPath = isRootPath ? '/workspace' : currentPath;
          downloadDir(dirPath, dirName);
        }}
        isDownloading={isDirDownloading(isRootPath ? '/workspace' : currentPath)}
      />

      {/* Search overlay */}
      {isSearchOpen && <FileSearch />}

      {/* Hidden file input for uploads */}
      <input type="file" ref={fileInputRef} className="hidden" onChange={handleFileInputChange} multiple />

      {/* Inline create inputs (shown at top of file area) */}
      {(isCreatingFolder || isCreatingFile) && (
        <div className="px-4 py-2 border-b border-border/30 bg-muted/10">
          {isCreatingFolder && (
            <div className="flex items-center gap-2 max-w-md">
              <FolderPlus className="h-4 w-4 text-muted-foreground shrink-0" />
              <input
                type="text"
                ref={folderInputRef}
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateFolder();
                  if (e.key === 'Escape') { setIsCreatingFolder(false); setNewFolderName(''); }
                }}
                onBlur={handleCreateFolder}
                className="flex-1 text-sm bg-transparent border border-border rounded-lg px-3 py-1.5 outline-none focus:ring-1 focus:ring-primary"
                placeholder="Folder name"
              />
            </div>
          )}
          {isCreatingFile && (
            <div className="flex items-center gap-2 max-w-md">
              <FilePlus className="h-4 w-4 text-muted-foreground shrink-0" />
              <input
                type="text"
                ref={fileCreateInputRef}
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateFile();
                  if (e.key === 'Escape') { setIsCreatingFile(false); setNewFileName(''); }
                }}
                onBlur={handleCreateFile}
                className="flex-1 text-sm bg-transparent border border-border rounded-lg px-3 py-1.5 outline-none focus:ring-1 focus:ring-primary"
                placeholder="File name"
              />
            </div>
          )}
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 overflow-y-auto">
        {/* Loading - only show skeleton after 200ms delay to prevent flash */}
        {isLoading && showSkeleton && (
          <div className="p-4 animate-in fade-in-0 duration-200">
            {viewMode === 'grid' ? (
              <div className="space-y-6">
                <div>
                  <Skeleton className="h-4 w-16 mb-3" />
                  <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
                    {Array.from({ length: 6 }).map((_, i) => (
                      <Skeleton key={`f${i}`} className="h-10 rounded-lg" />
                    ))}
                  </div>
                </div>
                <div>
                  <Skeleton className="h-4 w-12 mb-3" />
                  <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
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

        {/* Error */}
        {error && !isLoading && (
          <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
            <p className="text-sm text-muted-foreground">Failed to load files</p>
            <p className="text-xs text-muted-foreground max-w-sm">
              {error instanceof Error ? error.message : 'Unknown error'}
            </p>
            <Button variant="outline" size="sm" onClick={() => refetchFiles()}>
              Retry
            </Button>
          </div>
        )}

        {/* File view */}
        {!isLoading && !error && files && (
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
                onOpenInTab={handleOpenInTab}
                gitStatusMap={gitStatusMap}
                clipboardPath={clipboard?.path}
                clipboardOperation={clipboard?.operation}
                isDirDownloading={isDirDownloading}
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
                onOpenInTab={handleOpenInTab}
                gitStatusMap={gitStatusMap}
                clipboardPath={clipboard?.path}
                clipboardOperation={clipboard?.operation}
                isDirDownloading={isDirDownloading}
              />
            )}
          </>
        )}
      </div>

      {/* Upload progress indicator */}
      {uploadingCount > 0 && (
        <div className="absolute top-12 left-0 right-0 z-40">
          <div className="h-0.5 bg-primary/20 w-full overflow-hidden">
            <div className="h-full bg-primary animate-pulse w-full" />
          </div>
        </div>
      )}

      {/* Drag & drop overlay */}
      {isDragOverPage && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm border-2 border-dashed border-primary/50 rounded-xl pointer-events-none">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Upload className="h-8 w-8 text-primary" />
            </div>
            <div>
              <p className="text-base font-medium text-foreground">Drop files to upload</p>
              <p className="text-sm text-muted-foreground mt-1">
                Files will be uploaded to the current directory
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Clipboard indicator bar */}
      {clipboard && (
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-t border-border/40 bg-muted/20 text-xs text-muted-foreground shrink-0">
          <div className="flex items-center gap-2">
            <Clipboard className="h-3.5 w-3.5" />
            <span>
              {clipboard.operation === 'cut' ? 'Moving' : 'Copying'}:{' '}
              <span className="font-medium text-foreground">{clipboard.name}</span>
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
              Paste here
            </Button>
            <button
              onClick={clearClipboard}
              className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* File preview modal */}
      <FilePreviewModal />

      {/* History popover */}
      {historyPopoverPath && (
        <div className="fixed bottom-4 right-4 z-50 bg-popover border border-border rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 fade-in-0 duration-200">
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
          onOpenAutoFocus={(e) => { e.preventDefault(); deleteButtonRef.current?.focus(); }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.type === 'directory' ? 'folder' : 'file'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{' '}
              <span className="font-semibold text-foreground">&quot;{deleteTarget?.name}&quot;</span>?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              ref={deleteButtonRef}
              onClick={(e) => { e.preventDefault(); confirmDelete(); }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

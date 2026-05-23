'use client';

import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import {
  Search,
  RefreshCw,
  FolderUp,
  ServerOff,
  Upload,
  FolderPlus,
  FilePlus,
  Clipboard,
  Download,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
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
import { useFilesStore } from '../store/files-store';
import { useFileList, useServerHealth, useGitStatus, buildGitStatusMap } from '../hooks';
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
import type { FileNode } from '../types';
import { FileBreadcrumbs } from './file-breadcrumbs';
import { FileTreeItem, DRAG_MIME } from './file-tree-item';
import { FileSearch } from './file-search';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useDiagnosticsStore, buildDiagnosticCountsMap } from '@/stores/diagnostics-store';

/** Drop target for the ".." (parent directory) row */
function ParentDropTarget({
  currentPath,
  onClick,
  onDropMove,
}: {
  currentPath: string;
  onClick: () => void;
  onDropMove: (sourcePath: string, targetDirPath: string) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const counterRef = useRef(0);

  const parentPath = useMemo(() => {
    const lastSlash = currentPath.lastIndexOf('/');
    return lastSlash <= 0 ? '/' : currentPath.slice(0, lastSlash);
  }, [currentPath]);

  return (
    <button
      onClick={onClick}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        counterRef.current++;
        setIsDragOver(true);
      }}
      onDragLeave={() => {
        counterRef.current--;
        if (counterRef.current <= 0) {
          counterRef.current = 0;
          setIsDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        counterRef.current = 0;
        setIsDragOver(false);
        const sourcePath = e.dataTransfer.getData(DRAG_MIME);
        if (!sourcePath) return;
        onDropMove(sourcePath, parentPath === '.' ? '' : parentPath);
      }}
      className={cn(
        'flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left rounded-lg transition-colors cursor-pointer',
        'hover:bg-muted/80 text-muted-foreground',
        isDragOver && 'bg-primary/15 ring-1 ring-primary/40',
      )}
    >
      <FolderUp className="h-4 w-4 shrink-0" />
      <span>..</span>
    </button>
  );
}

export function FileBrowser() {
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const openFile = useFilesStore((s) => s.openFile);
  const openFileWithList = useFilesStore((s) => s.openFileWithList);
  const isSearchOpen = useFilesStore((s) => s.isSearchOpen);
  const toggleSearch = useFilesStore((s) => s.toggleSearch);
  const openHistory = useFilesStore((s) => s.openHistory);
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  // Clipboard
  const clipboard = useFilesStore((s) => s.clipboard);
  const copyToClipboard = useFilesStore((s) => s.copyToClipboard);
  const cutToClipboard = useFilesStore((s) => s.cutToClipboard);
  const clearClipboard = useFilesStore((s) => s.clearClipboard);

  const { data: health, isLoading: isHealthLoading } = useServerHealth();
  const {
    data: files,
    isLoading,
    error,
    refetch,
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
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileCreateInputRef = useRef<HTMLInputElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Folder creation state
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  // File creation state
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');

  // Auto-focus and select all text when folder input appears
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

  // Auto-focus and select file name (before extension) when file input appears
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

  // All sibling names in current directory (for duplicate detection)
  const siblingNames = useMemo(() => {
    if (!files) return [];
    return files.map((f) => f.name);
  }, [files]);

  // Check if folder name already exists
  const folderNameExists = useMemo(() => {
    if (!isCreatingFolder || !newFolderName.trim() || !files) return false;
    const name = newFolderName.trim().toLowerCase();
    return files.some((f) => f.name.toLowerCase() === name);
  }, [isCreatingFolder, newFolderName, files]);

  // Check if file name already exists
  const fileNameExists = useMemo(() => {
    if (!isCreatingFile || !newFileName.trim() || !files) return false;
    const name = newFileName.trim().toLowerCase();
    return files.some((f) => f.name.toLowerCase() === name);
  }, [isCreatingFile, newFileName, files]);

  // Separate dirs and files, sorted
  const { dirs, fileItems } = useMemo(() => {
    if (!files) return { dirs: [] as FileNode[], fileItems: [] as FileNode[] };
    const dirs = files
      .filter((f) => f.type === 'directory')
      .sort((a, b) => a.name.localeCompare(b.name));
    const fileItems = files
      .filter((f) => f.type === 'file')
      .sort((a, b) => a.name.localeCompare(b.name));
    return { dirs, fileItems };
  }, [files]);

  // Build per-entry diagnostic counts from the diagnostics store.
  // Uses buildDiagnosticCountsMap for flexible absolute→relative path matching.
  const diagByFile = useDiagnosticsStore((s) => s.byFile);
  const diagCountsLookup = useMemo(
    () => buildDiagnosticCountsMap(diagByFile),
    [diagByFile],
  );
  const diagnosticCountsMap = useMemo(() => {
    const map = new Map<string, { errors: number; warnings: number }>();
    if (!files || Object.keys(diagCountsLookup).length === 0) return map;

    for (const node of files) {
      if (node.type === 'file') {
        // Direct lookup for files
        const counts = diagCountsLookup[node.path];
        if (counts && (counts.errors > 0 || counts.warnings > 0)) {
          map.set(node.path, counts);
        }
      } else {
        // Aggregate counts for directories
        const prefix = node.path.endsWith('/') ? node.path : node.path + '/';
        let errors = 0;
        let warnings = 0;
        for (const [filePath, counts] of Object.entries(diagCountsLookup)) {
          if (filePath.startsWith(prefix) || filePath === node.path) {
            errors += counts.errors;
            warnings += counts.warnings;
          }
        }
        if (errors > 0 || warnings > 0) {
          map.set(node.path, { errors, warnings });
        }
      }
    }
    return map;
  }, [files, diagCountsLookup]);

  const isRootPath = currentPath === '/' || currentPath === '.' || currentPath === '';
  const normalizedCurrentPath = isRootPath ? '' : currentPath.replace(/\/$/, '');

  // Build file list for prev/next navigation in viewer
  const handleFileClick = useCallback(
    (node: FileNode) => {
      if (node.type === 'directory') {
        navigateToPath(node.path);
      } else {
        const allFiles = fileItems.map((f) => f.path);
        const index = allFiles.indexOf(node.path);
        openFileWithList(node.path, allFiles, Math.max(0, index));
      }
    },
    [fileItems, navigateToPath, openFileWithList],
  );

  // Navigate up one level
  const handleNavigateUp = useCallback(() => {
    if (isRootPath) return;
    // Strip the last path segment. If the path has no slash (e.g. ".agent-browser"
    // from root listing), go to root '/'. Otherwise remove the trailing /segment.
    const lastSlash = currentPath.lastIndexOf('/');
    const parent = lastSlash <= 0 ? '/' : currentPath.slice(0, lastSlash);
    navigateToPath(parent);
  }, [isRootPath, currentPath, navigateToPath]);

  // Open file history
  const handleHistory = useCallback(
    (node: FileNode) => {
      openHistory(node.path);
    },
    [openHistory],
  );

  // Download a file — file-browser is not mounted on /projects/* so we
  // short-circuit to avoid threading project context through this legacy
  // component. The download invocation is left as a stub.
  const handleDownload = useCallback(async (node: FileNode) => {
    try {
      await downloadFile('', '', node.path, node.name);
      toast.success(`Downloaded ${node.name}`);
    } catch (err) {
      toast.error(`Failed to download ${node.name}`);
    }
  }, []);

  // Directory download with progress toast
  const { downloadDir, isDownloading: isDirDownloading, downloadingPaths } = useDirectoryDownload();
  const handleDownloadDirectory = useCallback((node: FileNode) => {
    downloadDir(node.path, node.name);
  }, [downloadDir]);

  // Rename a file/folder (called from inline input in FileTreeItem)
  const handleRename = useCallback(
    async (node: FileNode, newName: string) => {
      if (!newName || newName === node.name) return;

      const parentPath = node.path.substring(0, node.path.lastIndexOf('/'));
      const newPath = parentPath ? `${parentPath}/${newName}` : newName;

      try {
        await renameMutation.mutateAsync({ from: node.path, to: newPath });
        toast.success(`Renamed to ${newName}`);
      } catch (err) {
        toast.error(`Failed to rename: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
    [renameMutation],
  );

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<FileNode | null>(null);

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

  // Upload file
  const handleUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      if (!event.target.files || event.target.files.length === 0) return;

      const file = event.target.files[0];
      try {
        await uploadMutation.mutateAsync({
          file,
          targetPath: isRootPath ? undefined : currentPath,
        });
        toast.success(`Uploaded ${file.name}`);
      } catch (err) {
        toast.error(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      } finally {
        event.target.value = '';
      }
    },
    [uploadMutation, isRootPath, currentPath],
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
    if (!newFileName.trim()) {
      setIsCreatingFile(false);
      return;
    }

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

  // Copy/Cut handlers for items
  const handleCopy = useCallback(
    (node: FileNode) => {
      copyToClipboard(node.path, node.name, node.type);
      toast.success(`Copied "${node.name}" to clipboard`);
    },
    [copyToClipboard],
  );

  const handleCut = useCallback(
    (node: FileNode) => {
      cutToClipboard(node.path, node.name, node.type);
      toast.success(`Cut "${node.name}" to clipboard`);
    },
    [cutToClipboard],
  );

  // Drag-and-drop move handler: move sourcePath into targetDirPath
  const handleDropMove = useCallback(
    async (sourcePath: string, targetDirPath: string) => {
      const sourceName = sourcePath.split('/').pop() || '';
      const destPath = targetDirPath ? `${targetDirPath}/${sourceName}` : sourceName;

      if (sourcePath === destPath) return;

      try {
        await renameMutation.mutateAsync({ from: sourcePath, to: destPath });
        toast.success(`Moved "${sourceName}" to ${targetDirPath.split('/').pop() || 'root'}`);
      } catch (err) {
        toast.error(`Failed to move: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
    [renameMutation],
  );

  // Paste handler
  const handlePaste = useCallback(async () => {
    if (!clipboard) return;

    const destDir = normalizedCurrentPath;

    // Generate a unique name if there's a conflict
    let destName = clipboard.name;
    if (files) {
      const existingNames = new Set(files.map((f) => f.name.toLowerCase()));
      if (existingNames.has(destName.toLowerCase())) {
        if (clipboard.operation === 'copy') {
          // Generate "name (copy)", "name (copy 2)", etc.
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
          // For move/cut, if source and dest dirs are the same, the item is already there
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
          await copyMutation.mutateAsync({
            sourcePath: clipboard.path,
            destPath,
          });
          toast.success(`Copied "${clipboard.name}" here`);
        } else {
          // For directories, use rename to copy (mkdir + read+upload is complex)
          // We'll use the rename API but since it's a copy, we need a different approach.
          // For now, create the directory at dest (the copy of directory contents
          // would require recursive read+upload, which the API doesn't natively support).
          // Best approach: create empty dir with same name for copy
          await mkdirMutation.mutateAsync({ dirPath: destPath });
          toast.success(`Created copy of folder "${clipboard.name}" here (empty)`);
          toast('Note: directory contents are not copied', { description: 'Copy individual files to move them.' });
        }
      } else {
        // Cut = move via rename
        await renameMutation.mutateAsync({ from: clipboard.path, to: destPath });
        toast.success(`Moved "${clipboard.name}" here`);
        clearClipboard();
      }
    } catch (err) {
      toast.error(`Failed to paste: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [clipboard, normalizedCurrentPath, files, copyMutation, renameMutation, mkdirMutation, clearClipboard]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when user is typing in inputs
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      const isMod = e.metaKey || e.ctrlKey;

      // Ctrl/Cmd + V: Paste
      if (isMod && e.key === 'v' && clipboard) {
        e.preventDefault();
        handlePaste();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clipboard, handlePaste]);

  // Server not reachable
  if (!isHealthLoading && !health?.healthy) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
        <ServerOff className="h-12 w-12 text-muted-foreground" />
        <div>
          <h3 className="text-lg font-medium">Server not reachable</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Could not connect to the OpenCode server at{' '}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
              {serverUrl}
            </code>
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Make sure <code className="text-xs bg-muted px-1.5 py-0.5 rounded">opencode serve</code> or{' '}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">opencode web</code> is running.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full relative">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b shrink-0">
        <FileBreadcrumbs />
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleUpload}
            disabled={uploadMutation.isPending}
            title="Upload file"
          >
            <Upload className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => {
              setIsCreatingFile(true);
              setNewFileName('untitled.txt');
            }}
            disabled={createMutation.isPending}
            title="New file"
          >
            <FilePlus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => {
              setIsCreatingFolder(true);
              setNewFolderName('New Folder');
            }}
            disabled={mkdirMutation.isPending}
            title="New folder"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
          {clipboard && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-primary"
              onClick={handlePaste}
              disabled={copyMutation.isPending || renameMutation.isPending}
              title={`Paste "${clipboard.name}" (${clipboard.operation})`}
            >
              <Clipboard className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={toggleSearch}
            title="Search files (Ctrl+P)"
          >
            <Search className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => refetch()}
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => {
              const dirName = isRootPath ? 'workspace' : (currentPath.split('/').filter(Boolean).pop() || 'directory');
              const dirPath = isRootPath ? '/workspace' : currentPath;
              downloadDir(dirPath, dirName);
            }}
            disabled={isDirDownloading(isRootPath ? '/workspace' : currentPath)}
            title="Download current directory as zip"
          >
            {isDirDownloading(isRootPath ? '/workspace' : currentPath) ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* Hidden file input for uploads */}
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        onChange={handleFileInputChange}
      />

      {/* Search overlay */}
      {isSearchOpen && <FileSearch />}

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {/* Loading state */}
        {isLoading && (
          <div className="p-3 space-y-1.5">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full rounded-lg" />
            ))}
          </div>
        )}

        {/* Error state */}
        {error && !isLoading && (
          <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
            <p className="text-sm text-muted-foreground">
              Failed to load files
            </p>
            <p className="text-xs text-muted-foreground max-w-sm">
              {error instanceof Error ? error.message : 'Unknown error'}
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        )}

        {/* File entries */}
        {!isLoading && !error && files && (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="p-1.5 min-h-full">
                {/* Go up — also a drop target for moving items to parent */}
                {!isRootPath && (
                  <ParentDropTarget
                    currentPath={currentPath}
                    onClick={handleNavigateUp}
                    onDropMove={handleDropMove}
                  />
                )}

                {/* New folder inline input */}
                {isCreatingFolder && (
                  <div className="flex flex-col gap-0.5 px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <FolderPlus className="h-4 w-4 text-blue-400 shrink-0" />
                      <input
                        type="text"
                        ref={folderInputRef}
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !folderNameExists) handleCreateFolder();
                          if (e.key === 'Escape') {
                            setIsCreatingFolder(false);
                            setNewFolderName('');
                          }
                        }}
                        onBlur={() => {
                          if (!folderNameExists) handleCreateFolder();
                          else {
                            setIsCreatingFolder(false);
                            setNewFolderName('');
                          }
                        }}
                        className={cn(
                          'flex-1 h-7 text-sm bg-card border rounded-2xl px-3 outline-none focus:ring-2 focus:ring-primary/50 selection:bg-primary/15 selection:text-foreground',
                          folderNameExists && 'border-destructive focus:ring-destructive/30',
                        )}
                      />
                    </div>
                    {folderNameExists && (
                      <p className="text-xs text-destructive pl-6">
                        A file or folder with that name already exists
                      </p>
                    )}
                  </div>
                )}

                {/* New file inline input */}
                {isCreatingFile && (
                  <div className="flex flex-col gap-0.5 px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <FilePlus className="h-4 w-4 text-green-400 shrink-0" />
                      <input
                        type="text"
                        ref={fileCreateInputRef}
                        value={newFileName}
                        onChange={(e) => setNewFileName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !fileNameExists) handleCreateFile();
                          if (e.key === 'Escape') {
                            setIsCreatingFile(false);
                            setNewFileName('');
                          }
                        }}
                        onBlur={() => {
                          if (!fileNameExists) handleCreateFile();
                          else {
                            setIsCreatingFile(false);
                            setNewFileName('');
                          }
                        }}
                        className={cn(
                          'flex-1 h-7 text-sm bg-card border rounded-2xl px-3 outline-none focus:ring-2 focus:ring-primary/50 selection:bg-primary/15 selection:text-foreground',
                          fileNameExists && 'border-destructive focus:ring-destructive/30',
                        )}
                      />
                    </div>
                    {fileNameExists && (
                      <p className="text-xs text-destructive pl-6">
                        A file or folder with that name already exists
                      </p>
                    )}
                  </div>
                )}

                {/* Directories first */}
                {dirs.map((node) => (
                  <FileTreeItem
                    key={node.path}
                    node={node}
                    onClick={() => handleFileClick(node)}
                    onDownload={handleDownloadDirectory}
                    isDownloadingItem={isDirDownloading(node.path)}
                    onRename={handleRename}
                    onDelete={handleDelete}
                    onCopy={handleCopy}
                    onCut={handleCut}
                    onDropMove={handleDropMove}
                    siblingNames={siblingNames}
                    gitStatus={gitStatusMap.get(node.path)}
                    isCut={clipboard?.operation === 'cut' && clipboard.path === node.path}
                    diagnosticCounts={diagnosticCountsMap.get(node.path)}
                  />
                ))}

                {/* Then files */}
                {fileItems.map((node) => (
                  <FileTreeItem
                    key={node.path}
                    node={node}
                    onClick={() => handleFileClick(node)}
                    onDownload={handleDownload}
                    onRename={handleRename}
                    onDelete={handleDelete}
                    onHistory={handleHistory}
                    onCopy={handleCopy}
                    onCut={handleCut}
                    onDropMove={handleDropMove}
                    siblingNames={siblingNames}
                    gitStatus={gitStatusMap.get(node.path)}
                    isCut={clipboard?.operation === 'cut' && clipboard.path === node.path}
                    diagnosticCounts={diagnosticCountsMap.get(node.path)}
                  />
                ))}

                {/* Empty directory */}
                {files.length === 0 && !isCreatingFolder && !isCreatingFile && (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <p className="text-sm text-muted-foreground">
                      Empty directory
                    </p>
                  </div>
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              <ContextMenuItem
                onClick={() => {
                  setTimeout(() => {
                    setNewFileName('untitled.txt');
                    setIsCreatingFile(true);
                  }, 100);
                }}
                disabled={createMutation.isPending}
              >
                <FilePlus className="mr-2 h-4 w-4" />
                New File
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  setTimeout(() => {
                    setNewFolderName('New Folder');
                    setIsCreatingFolder(true);
                  }, 100);
                }}
                disabled={mkdirMutation.isPending}
              >
                <FolderPlus className="mr-2 h-4 w-4" />
                New Folder
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={handleUpload}
                disabled={uploadMutation.isPending}
              >
                <Upload className="mr-2 h-4 w-4" />
                Upload File
              </ContextMenuItem>
              {clipboard && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onClick={handlePaste}
                    disabled={copyMutation.isPending || renameMutation.isPending}
                  >
                    <Clipboard className="mr-2 h-4 w-4" />
                    Paste{' '}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {clipboard.operation === 'cut' ? 'Move' : 'Copy'}
                    </span>
                  </ContextMenuItem>
                </>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => refetch()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}
      </div>

      {/* Clipboard indicator bar */}
      {clipboard && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-t bg-muted/30 text-xs text-muted-foreground shrink-0">
          <span className="truncate">
            {clipboard.operation === 'cut' ? 'Moving' : 'Copying'}:{' '}
            <span className="font-medium text-foreground">{clipboard.name}</span>
          </span>
          <button
            onClick={clearClipboard}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0 cursor-pointer"
          >
            Cancel
          </button>
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
              Are you sure you want to delete{' '}
              <span className="font-semibold text-foreground">
                &quot;{deleteTarget?.name}&quot;
              </span>
              ? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              ref={deleteButtonRef}
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
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

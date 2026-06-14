'use client';

import { useTranslations } from 'next-intl';

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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { buildDiagnosticCountsMap, useDiagnosticsStore } from '@/stores/diagnostics-store';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clipboard,
  ClipboardCopy,
  Copy,
  Download,
  FilePlus,
  FolderOpen,
  FolderPlus,
  History,
  Home,
  Pencil,
  RefreshCw,
  Scissors,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { downloadFile } from '../api/opencode-files';
import { buildGitStatusMap, useFileList, useGitStatus, useServerHealth } from '../hooks';
import { useDirectoryDownload } from '../hooks/use-directory-download';
import {
  useFileCopy,
  useFileCreate,
  useFileDelete,
  useFileMkdir,
  useFileRename,
  useFileUpload,
} from '../hooks/use-file-mutations';
import { useFilesStore, useFilesStoreApi } from '../store/files-store';
import type { FileNode } from '../types';
import { getFileIcon } from './file-icon';
import type { GitStatusType } from './file-tree-item';
import { DRAG_MIME } from './file-tree-item';

// ─── Recursive tree node ────────────────────────────────────────────────────

interface CreatingInDir {
  dirPath: string;
  type: 'file' | 'folder';
}

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  gitStatusMap: Map<string, GitStatusType>;
  diagnosticCountsMap: Map<string, { errors: number; warnings: number }>;
  onRename: (node: FileNode, newName: string) => void;
  onDelete: (node: FileNode) => void;
  onCopy: (node: FileNode) => void;
  onCut: (node: FileNode) => void;
  onDropMove: (sourcePath: string, targetDirPath: string) => void;
  onCreateInDir: (dirPath: string, type: 'file' | 'folder') => void;
  onUploadToDir: (dirPath: string) => void;
  creatingInDir: CreatingInDir | null;
  onCreatingInDirSubmit: (name: string) => void;
  onCreatingInDirCancel: () => void;
  onDownloadDir: (path: string, name: string) => void;
  isDirDownloading: (path: string) => boolean;
}

const gitStatusTextColor: Record<GitStatusType, string> = {
  added: 'text-emerald-500 dark:text-green-400',
  modified: 'text-yellow-500 dark:text-yellow-400',
  deleted: 'text-red-500 dark:text-red-400',
};

const gitStatusBadgeColor: Record<GitStatusType, string> = {
  added: 'text-emerald-500 dark:text-green-400',
  modified: 'text-yellow-500 dark:text-yellow-400',
  deleted: 'text-red-500 dark:text-red-400',
};

const gitStatusLabel: Record<GitStatusType, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
};

function TreeNode({
  node,
  depth,
  gitStatusMap,
  diagnosticCountsMap,
  onRename,
  onDelete,
  onCopy,
  onCut,
  onDropMove,
  onCreateInDir,
  onUploadToDir,
  creatingInDir,
  onCreatingInDirSubmit,
  onCreatingInDirCancel,
  onDownloadDir,
  isDirDownloading,
}: TreeNodeProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const filesStore = useFilesStoreApi();
  const expandedDirs = useFilesStore((s) => s.expandedDirs);
  const toggleDir = useFilesStore((s) => s.toggleDir);
  const selectedFilePath = useFilesStore((s) => s.selectedFilePath);
  const openFile = useFilesStore((s) => s.openFile);
  const clipboard = useFilesStore((s) => s.clipboard);

  const isDir = node.type === 'directory';
  const isExpanded = isDir && expandedDirs.has(node.path);
  const isSelected = selectedFilePath === node.path;
  const isCut = clipboard?.operation === 'cut' && clipboard.path === node.path;
  const gitStatus = gitStatusMap.get(node.path);
  const diagCounts = diagnosticCountsMap.get(node.path);

  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameName, setRenameName] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  // Auto-focus rename input
  useEffect(() => {
    if (isRenaming) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = renameInputRef.current;
          if (el) {
            el.focus();
            const dotIdx = el.value.lastIndexOf('.');
            el.setSelectionRange(
              0,
              isDir ? el.value.length : dotIdx > 0 ? dotIdx : el.value.length,
            );
          }
        });
      });
    }
  }, [isRenaming, isDir]);

  const confirmRename = useCallback(() => {
    const trimmed = renameName.trim();
    if (trimmed && trimmed !== node.name) {
      onRename(node, trimmed);
    }
    setIsRenaming(false);
    setRenameName('');
  }, [renameName, node, onRename]);

  const handleClick = useCallback(() => {
    if (isDir) {
      toggleDir(node.path);
    } else {
      openFile(node.path);
    }
  }, [isDir, node.path, toggleDir, openFile]);

  // DnD handlers
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(DRAG_MIME, node.path);
      e.dataTransfer.setData('text/plain', node.name);
      e.dataTransfer.effectAllowed = 'move';
      setIsDragging(true);
    },
    [node.path, node.name],
  );

  const handleDragEnd = useCallback(() => setIsDragging(false), []);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isDir || !e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    },
    [isDir],
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!isDir || !e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      dragCounterRef.current++;
      setIsDragOver(true);
    },
    [isDir],
  );

  const handleDragLeave = useCallback(() => {
    if (!isDir) return;
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, [isDir]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!isDir) return;
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      const sourcePath = e.dataTransfer.getData(DRAG_MIME);
      if (!sourcePath || sourcePath === node.path || node.path.startsWith(sourcePath + '/')) return;
      onDropMove(sourcePath, node.path);
    },
    [isDir, node.path, onDropMove],
  );

  const paddingLeft = 8 + depth * 16;

  const rowContent = isRenaming ? (
    <div className="flex w-full items-center gap-1.5 py-1" style={{ paddingLeft }}>
      {/* Spacer matching the chevron width so the icon stays aligned */}
      <span className="w-3.5 shrink-0" />
      {getFileIcon(node.name, { isDirectory: isDir, className: 'h-4 w-4 shrink-0' })}
      <input
        type="text"
        ref={renameInputRef}
        value={renameName}
        onChange={(e) => setRenameName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') confirmRename();
          if (e.key === 'Escape') {
            setIsRenaming(false);
            setRenameName('');
          }
        }}
        onBlur={() => confirmRename()}
        className="border-primary/50 selection:bg-primary/25 selection:text-foreground min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 text-sm outline-none"
      />
    </div>
  ) : (
    <button
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-1.5 py-1 text-left text-sm transition-colors',
        'hover:bg-muted/50',
        isSelected && 'bg-primary/[0.08] text-primary',
        isCut && 'opacity-40',
        isDragging && 'opacity-30',
        isDragOver && 'bg-primary/[0.12] ring-primary/30 ring-1',
        node.ignored && 'opacity-40',
      )}
      style={{ paddingLeft }}
    >
      {/* Chevron for dirs */}
      {isDir ? (
        isExpanded ? (
          <ChevronDown className="text-muted-foreground/70 h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground/70 h-3.5 w-3.5 shrink-0" />
        )
      ) : (
        <span className="w-3.5 shrink-0" />
      )}

      {/* Icon */}
      {isDir && isExpanded ? (
        <FolderOpen className="h-4 w-4 shrink-0 text-blue-400" />
      ) : (
        getFileIcon(node.name, { isDirectory: isDir, className: 'h-4 w-4 shrink-0' })
      )}

      {/* Name */}
      <span
        className={cn(
          'flex-1 truncate',
          gitStatus && gitStatusTextColor[gitStatus],
          !gitStatus &&
            node.name.startsWith('.') &&
            node.name !== '.kortix' &&
            node.name !== '.opencode' &&
            'opacity-50',
        )}
      >
        {node.name}
      </span>

      {/* Indicators */}
      {(gitStatus || (diagCounts && (diagCounts.errors > 0 || diagCounts.warnings > 0))) && (
        <span className="inline-flex shrink-0 items-center gap-1 pr-2">
          {diagCounts && diagCounts.errors > 0 && (
            <span className="inline-flex items-center gap-0.5 text-red-500/80">
              <CircleAlert className="h-3 w-3" />
              <span className="text-xs leading-none font-medium">{diagCounts.errors}</span>
            </span>
          )}
          {diagCounts && diagCounts.warnings > 0 && (
            <span className="inline-flex items-center gap-0.5 text-yellow-500/80">
              <AlertTriangle className="h-3 w-3" />
              <span className="text-xs leading-none font-medium">{diagCounts.warnings}</span>
            </span>
          )}
          {gitStatus && (
            <span
              className={cn(
                'ml-0.5 text-xs leading-none font-medium',
                gitStatusBadgeColor[gitStatus],
              )}
            >
              {gitStatusLabel[gitStatus]}
            </span>
          )}
        </span>
      )}
    </button>
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{rowContent}</ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onClick={handleClick}>
            <ChevronRight className="mr-2 h-4 w-4" />
            {isDir ? 'Open folder' : 'Open file'}
          </ContextMenuItem>
          {!isDir && (
            <ContextMenuItem onClick={() => downloadFile('', '', node.path, node.name)}>
              <Download className="mr-2 h-4 w-4" />
              Download
            </ContextMenuItem>
          )}
          {isDir && (
            <ContextMenuItem
              onClick={() => onDownloadDir(node.path, node.name)}
              disabled={isDirDownloading(node.path)}
            >
              {isDirDownloading(node.path) ? (
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              {isDirDownloading(node.path) ? 'Zipping…' : 'Download as zip'}
            </ContextMenuItem>
          )}
          {!isDir && (
            <ContextMenuItem onClick={() => filesStore.getState().openHistory(node.path)}>
              <History className="mr-2 h-4 w-4" />
              {tHardcodedUi.raw('featuresProjectFilesComponentsFileTree.line367JsxTextViewHistory')}
            </ContextMenuItem>
          )}
          {isDir && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => onCreateInDir(node.path, 'file')}>
                <FilePlus className="mr-2 h-4 w-4" />
                {tHardcodedUi.raw('featuresProjectFilesComponentsFileTree.line375JsxTextNewFile')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onCreateInDir(node.path, 'folder')}>
                <FolderPlus className="mr-2 h-4 w-4" />
                {tHardcodedUi.raw('featuresProjectFilesComponentsFileTree.line379JsxTextNewFolder')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onUploadToDir(node.path)}>
                <Upload className="mr-2 h-4 w-4" />
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsFileTree.line383JsxTextUploadFile',
                )}
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onCopy(node)}>
            <ClipboardCopy className="mr-2 h-4 w-4" />
            Copy
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onCut(node)}>
            <Scissors className="mr-2 h-4 w-4" />
            Cut
          </ContextMenuItem>
          <ContextMenuItem onClick={() => navigator.clipboard.writeText(node.path)}>
            <Copy className="mr-2 h-4 w-4" />
            {tHardcodedUi.raw('featuresProjectFilesComponentsFileTree.line398JsxTextCopyPath')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => {
              setTimeout(() => {
                setRenameName(node.name);
                setIsRenaming(true);
              }, 100);
            }}
          >
            <Pencil className="mr-2 h-4 w-4" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => onDelete(node)}
            className="text-muted-foreground focus:text-foreground"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Recursive children */}
      {isDir && isExpanded && (
        <TreeNodeChildren
          dirPath={node.path}
          depth={depth + 1}
          gitStatusMap={gitStatusMap}
          diagnosticCountsMap={diagnosticCountsMap}
          onRename={onRename}
          onDelete={onDelete}
          onCopy={onCopy}
          onCut={onCut}
          onDropMove={onDropMove}
          onCreateInDir={onCreateInDir}
          onUploadToDir={onUploadToDir}
          creatingInDir={creatingInDir}
          onCreatingInDirSubmit={onCreatingInDirSubmit}
          onCreatingInDirCancel={onCreatingInDirCancel}
          onDownloadDir={onDownloadDir}
          isDirDownloading={isDirDownloading}
        />
      )}
    </>
  );
}

// ─── Lazy-loaded directory children ─────────────────────────────────────────

interface TreeNodeChildrenProps {
  dirPath: string;
  depth: number;
  gitStatusMap: Map<string, GitStatusType>;
  diagnosticCountsMap: Map<string, { errors: number; warnings: number }>;
  onRename: (node: FileNode, newName: string) => void;
  onDelete: (node: FileNode) => void;
  onCopy: (node: FileNode) => void;
  onCut: (node: FileNode) => void;
  onDropMove: (sourcePath: string, targetDirPath: string) => void;
  onCreateInDir: (dirPath: string, type: 'file' | 'folder') => void;
  onUploadToDir: (dirPath: string) => void;
  creatingInDir: CreatingInDir | null;
  onCreatingInDirSubmit: (name: string) => void;
  onCreatingInDirCancel: () => void;
  onDownloadDir: (path: string, name: string) => void;
  isDirDownloading: (path: string) => boolean;
}

function InlineCreateInput({
  type,
  depth,
  onSubmit,
  onCancel,
}: {
  type: 'file' | 'folder';
  depth: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(type === 'file' ? 'untitled.txt' : 'New Folder');
  const inputRef = useRef<HTMLInputElement>(null);
  // Guard: ignore blur events until the input has been properly focused.
  // Without this, the context-menu closing causes a stray blur that
  // immediately submits the default name before the user can type.
  const readyRef = useRef(false);
  const submittedRef = useRef(false);

  useEffect(() => {
    // Triple-rAF to ensure the context menu portal has fully unmounted
    // and focus can land on the input without being stolen.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (el) {
            el.focus();
            if (type === 'file') {
              const d = el.value.lastIndexOf('.');
              el.setSelectionRange(0, d > 0 ? d : el.value.length);
            } else {
              el.setSelectionRange(0, el.value.length);
            }
            readyRef.current = true;
          }
        });
      });
    });
  }, [type]);

  const handleSubmit = useCallback(() => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    const trimmed = name.trim();
    if (trimmed) {
      onSubmit(trimmed);
    } else {
      onCancel();
    }
  }, [name, onSubmit, onCancel]);

  const handleBlur = useCallback(() => {
    // Only treat blur as a submit once the input is truly active
    if (!readyRef.current) return;
    handleSubmit();
  }, [handleSubmit]);

  return (
    <div className="flex items-center gap-1.5 py-1" style={{ paddingLeft: 8 + depth * 16 }}>
      {/* Spacer matching the chevron width in TreeNode rows */}
      <span className="w-3.5 shrink-0" />
      {type === 'file' ? (
        <FilePlus className="h-4 w-4 shrink-0 text-green-400" />
      ) : (
        <FolderPlus className="h-4 w-4 shrink-0 text-blue-400" />
      )}
      <input
        type="text"
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit();
          if (e.key === 'Escape') onCancel();
        }}
        onBlur={handleBlur}
        className="border-primary/50 selection:bg-primary/25 selection:text-foreground min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 text-sm outline-none"
      />
    </div>
  );
}

function TreeNodeChildren({
  dirPath,
  depth,
  gitStatusMap,
  diagnosticCountsMap,
  onRename,
  onDelete,
  onCopy,
  onCut,
  onDropMove,
  onCreateInDir,
  onUploadToDir,
  creatingInDir,
  onCreatingInDirSubmit,
  onCreatingInDirCancel,
  onDownloadDir,
  isDirDownloading,
}: TreeNodeChildrenProps) {
  const { data: children, isLoading } = useFileList(dirPath);

  const sorted = useMemo(() => {
    if (!children) return [];
    return [...children].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [children]);

  const showInlineCreate = creatingInDir && creatingInDir.dirPath === dirPath;

  if (isLoading) {
    return (
      <div className="py-1" style={{ paddingLeft: 8 + depth * 16 }}>
        <Skeleton className="h-5 w-24 rounded" />
      </div>
    );
  }

  if (!sorted.length && !showInlineCreate) {
    return (
      <div
        className="text-muted-foreground/40 py-1 text-xs italic select-none"
        style={{ paddingLeft: 8 + depth * 16 + 16 }}
      >
        empty
      </div>
    );
  }

  return (
    <>
      {showInlineCreate && (
        <InlineCreateInput
          type={creatingInDir.type}
          depth={depth}
          onSubmit={onCreatingInDirSubmit}
          onCancel={onCreatingInDirCancel}
        />
      )}
      {sorted.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={depth}
          gitStatusMap={gitStatusMap}
          diagnosticCountsMap={diagnosticCountsMap}
          onRename={onRename}
          onDelete={onDelete}
          onCopy={onCopy}
          onCut={onCut}
          onDropMove={onDropMove}
          onCreateInDir={onCreateInDir}
          onUploadToDir={onUploadToDir}
          creatingInDir={creatingInDir}
          onCreatingInDirSubmit={onCreatingInDirSubmit}
          onCreatingInDirCancel={onCreatingInDirCancel}
          onDownloadDir={onDownloadDir}
          isDirDownloading={isDirDownloading}
        />
      ))}
    </>
  );
}

// ─── Main tree sidebar ──────────────────────────────────────────────────────

export function FileTree() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const filesStore = useFilesStoreApi();
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const clipboard = useFilesStore((s) => s.clipboard);
  const copyToClipboard = useFilesStore((s) => s.copyToClipboard);
  const cutToClipboard = useFilesStore((s) => s.cutToClipboard);
  const clearClipboard = useFilesStore((s) => s.clearClipboard);
  const toggleSearch = useFilesStore((s) => s.toggleSearch);

  const { data: health } = useServerHealth();

  // Git status
  const { data: gitStatuses } = useGitStatus({ enabled: health?.healthy === true });
  const gitStatusMap = useMemo(() => buildGitStatusMap(gitStatuses), [gitStatuses]);

  // Diagnostics — uses buildDiagnosticCountsMap to handle abs→rel path matching
  const diagByFile = useDiagnosticsStore((s) => s.byFile);
  const diagCountsLookup = useMemo(() => buildDiagnosticCountsMap(diagByFile), [diagByFile]);
  const diagnosticCountsMap = useMemo(() => {
    const map = new Map<string, { errors: number; warnings: number }>();
    for (const [filePath, counts] of Object.entries(diagCountsLookup)) {
      if (counts.errors > 0 || counts.warnings > 0) {
        map.set(filePath, counts);
        // Propagate to ancestor directories
        const parts = filePath.split('/');
        for (let i = 1; i < parts.length; i++) {
          const dirPath = parts.slice(0, i).join('/');
          const existing = map.get(dirPath) || { errors: 0, warnings: 0 };
          map.set(dirPath, {
            errors: existing.errors + counts.errors,
            warnings: existing.warnings + counts.warnings,
          });
        }
      }
    }
    return map;
  }, [diagCountsLookup]);

  // Directory download with progress
  const { downloadDir, isDownloading: isDirDownloading } = useDirectoryDownload();

  // Mutations
  const renameMutation = useFileRename();
  const deleteMutationHook = useFileDelete();
  const mkdirMutation = useFileMkdir();
  const createMutation = useFileCreate();
  const uploadMutation = useFileUpload();
  const copyMutation = useFileCopy();

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<FileNode | null>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  // Inline create states (root-level)
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [uploadTargetPath, setUploadTargetPath] = useState<string | undefined>(undefined);
  const fileCreateInputRef = useRef<HTMLInputElement>(null);
  const folderCreateInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Path bar navigation
  const [pathInputActive, setPathInputActive] = useState(false);
  const [pathInputValue, setPathInputValue] = useState('');
  const pathInputRef2 = useRef<HTMLInputElement>(null);

  // Inline create states (inside a specific folder via context menu)
  const [creatingInDir, setCreatingInDir] = useState<CreatingInDir | null>(null);

  useEffect(() => {
    if (isCreatingFile) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = fileCreateInputRef.current;
          if (el) {
            el.focus();
            const d = el.value.lastIndexOf('.');
            el.setSelectionRange(0, d > 0 ? d : el.value.length);
          }
        });
      });
    }
  }, [isCreatingFile]);

  useEffect(() => {
    if (isCreatingFolder) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = folderCreateInputRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(0, el.value.length);
          }
        });
      });
    }
  }, [isCreatingFolder]);

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
      await deleteMutationHook.mutateAsync({ filePath: deleteTarget.path });
      successToast(`Deleted ${deleteTarget.name}`);
    } catch (err) {
      errorToast(`Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, deleteMutationHook]);

  const handleCopy = useCallback(
    (node: FileNode) => {
      copyToClipboard(node.path, node.name, node.type);
      successToast(`Copied "${node.name}"`);
    },
    [copyToClipboard],
  );

  const handleCut = useCallback(
    (node: FileNode) => {
      cutToClipboard(node.path, node.name, node.type);
      successToast(`Cut "${node.name}"`);
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

  const handlePaste = useCallback(async () => {
    if (!clipboard) return;
    const isRootPath = currentPath === '/' || currentPath === '.' || currentPath === '';
    const destDir = isRootPath ? '' : currentPath.replace(/\/$/, '');
    const destPath = destDir ? `${destDir}/${clipboard.name}` : clipboard.name;
    try {
      if (clipboard.operation === 'copy') {
        if (clipboard.type === 'file') {
          await copyMutation.mutateAsync({ sourcePath: clipboard.path, destPath });
          successToast(`Copied "${clipboard.name}" here`);
        } else {
          await mkdirMutation.mutateAsync({ dirPath: destPath });
          successToast(`Created copy of folder "${clipboard.name}" (empty)`);
        }
      } else {
        await renameMutation.mutateAsync({ from: clipboard.path, to: destPath });
        successToast(`Moved "${clipboard.name}" here`);
        clearClipboard();
      }
    } catch (err) {
      errorToast(`Failed to paste: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [clipboard, currentPath, copyMutation, renameMutation, mkdirMutation, clearClipboard]);

  const isRootPath = currentPath === '/' || currentPath === '.' || currentPath === '';
  const normalizedCurrentPath = isRootPath ? '' : currentPath.replace(/\/$/, '');

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
      successToast(`Created ${newFileName.trim()}`);
    } catch (err) {
      errorToast(`Failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsCreatingFile(false);
      setNewFileName('');
    }
  }, [createMutation, normalizedCurrentPath, newFileName]);

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
      errorToast(`Failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsCreatingFolder(false);
      setNewFolderName('');
    }
  }, [mkdirMutation, normalizedCurrentPath, newFolderName]);

  // Handlers for creating inside a specific folder (via context menu)
  const expandDir = useFilesStore((s) => s.expandDir);

  const handleCreateInDir = useCallback(
    (dirPath: string, type: 'file' | 'folder') => {
      // Expand the folder so the inline input is visible
      expandDir(dirPath);
      // Use setTimeout to let the context menu close and folder expand first
      setTimeout(() => {
        setCreatingInDir({ dirPath, type });
      }, 100);
    },
    [expandDir],
  );

  const handleCreatingInDirSubmit = useCallback(
    async (name: string) => {
      if (!creatingInDir) return;
      const { dirPath, type } = creatingInDir;
      const fullPath = `${dirPath}/${name}`;
      try {
        if (type === 'file') {
          await createMutation.mutateAsync({ filePath: fullPath });
          successToast(`Created ${name}`);
        } else {
          await mkdirMutation.mutateAsync({ dirPath: fullPath });
          successToast(`Created folder: ${name}`);
        }
      } catch (err) {
        errorToast(`Failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      } finally {
        setCreatingInDir(null);
      }
    },
    [creatingInDir, createMutation, mkdirMutation],
  );

  const handleCreatingInDirCancel = useCallback(() => {
    setCreatingInDir(null);
  }, []);

  const handleUpload = useCallback((targetPath?: string) => {
    setUploadTargetPath(targetPath);
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files || e.target.files.length === 0) return;
      const file = e.target.files[0];
      try {
        const targetPath = uploadTargetPath ?? (isRootPath ? undefined : currentPath);
        await uploadMutation.mutateAsync({ file, targetPath });
        successToast(`Uploaded ${file.name}`);
      } catch (err) {
        errorToast(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      } finally {
        e.target.value = '';
        setUploadTargetPath(undefined);
      }
    },
    [uploadMutation, uploadTargetPath, isRootPath, currentPath],
  );

  // Keyboard: Ctrl+V paste
  useEffect(() => {
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
  }, [clipboard, handlePaste]);

  return (
    <div className="flex h-full flex-col">
      {/* Tree header */}
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-muted-foreground/60 text-xs font-medium tracking-wider uppercase select-none">
          Explorer
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => {
              setNewFileName('untitled.txt');
              setIsCreatingFile(true);
            }}
            title={tHardcodedUi.raw(
              'featuresProjectFilesComponentsFileTree.line912JsxAttrTitleNewFile',
            )}
          >
            <FilePlus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => {
              setNewFolderName('New Folder');
              setIsCreatingFolder(true);
            }}
            title={tHardcodedUi.raw(
              'featuresProjectFilesComponentsFileTree.line915JsxAttrTitleNewFolder',
            )}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => handleUpload()}
            title="Upload"
          >
            <Upload className="h-3.5 w-3.5" />
          </Button>
          {clipboard && (
            <Button
              variant="ghost"
              size="icon"
              className="text-primary h-6 w-6"
              onClick={handlePaste}
              title={`Paste "${clipboard.name}"`}
            >
              <Clipboard className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Path bar — click to edit, Enter to navigate */}
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5">
        {currentPath !== '/workspace' && (
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground/50 hover:text-foreground h-5 w-5 shrink-0"
            title={tHardcodedUi.raw(
              'featuresProjectFilesComponentsFileTree.line936JsxAttrTitleBackToWorkspace',
            )}
            onClick={() => navigateToPath('/workspace')}
          >
            <Home className="h-3 w-3" />
          </Button>
        )}
        {pathInputActive ? (
          <input
            type="text"
            ref={pathInputRef2}
            value={pathInputValue}
            onChange={(e) => setPathInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const p = pathInputValue.trim() || '/workspace';
                navigateToPath(p);
                setPathInputActive(false);
              }
              if (e.key === 'Escape') {
                setPathInputActive(false);
              }
            }}
            onBlur={() => setPathInputActive(false)}
            className="bg-muted/40 border-border/60 text-foreground min-w-0 flex-1 rounded border px-1.5 py-0.5 font-mono text-xs outline-none"
            autoFocus
          />
        ) : (
          <button
            className="text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/30 min-w-0 flex-1 cursor-pointer truncate rounded px-1.5 py-0.5 text-left font-mono text-xs transition-colors"
            title={tHardcodedUi.raw(
              'featuresProjectFilesComponentsFileTree.line964JsxAttrTitleClickToNavigateToPath',
            )}
            onClick={() => {
              setPathInputValue(currentPath);
              setPathInputActive(true);
            }}
          >
            {currentPath === '/workspace' ? '~/workspace' : currentPath}
          </button>
        )}
      </div>

      {/* Hidden file input */}
      <input type="file" ref={fileInputRef} className="hidden" onChange={handleFileInputChange} />

      {/* Tree content */}
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <div className="py-0.5">
          {/* Inline create inputs */}
          {isCreatingFile && (
            <div className="flex items-center gap-1.5 px-3 py-1">
              <FilePlus className="h-4 w-4 shrink-0 text-green-400" />
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
                onBlur={() => handleCreateFile()}
                className="border-primary/50 min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 text-sm outline-none"
              />
            </div>
          )}
          {isCreatingFolder && (
            <div className="flex items-center gap-1.5 px-3 py-1">
              <FolderPlus className="h-4 w-4 shrink-0 text-blue-400" />
              <input
                type="text"
                ref={folderCreateInputRef}
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateFolder();
                  if (e.key === 'Escape') {
                    setIsCreatingFolder(false);
                    setNewFolderName('');
                  }
                }}
                onBlur={() => handleCreateFolder()}
                className="border-primary/50 min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 text-sm outline-none"
              />
            </div>
          )}

          {/* Root tree - use currentPath from store (defaults to /workspace, can navigate to /) */}
          <TreeNodeChildren
            dirPath={currentPath}
            depth={0}
            gitStatusMap={gitStatusMap}
            diagnosticCountsMap={diagnosticCountsMap}
            onRename={handleRename}
            onDelete={handleDelete}
            onCopy={handleCopy}
            onCut={handleCut}
            onDropMove={handleDropMove}
            onCreateInDir={handleCreateInDir}
            onUploadToDir={handleUpload}
            creatingInDir={creatingInDir}
            onCreatingInDirSubmit={handleCreatingInDirSubmit}
            onCreatingInDirCancel={handleCreatingInDirCancel}
            onDownloadDir={downloadDir}
            isDirDownloading={isDirDownloading}
          />
        </div>
      </ScrollArea>

      {/* Clipboard indicator */}
      {clipboard && (
        <div className="border-border/50 bg-muted/20 text-muted-foreground flex shrink-0 items-center justify-between gap-1.5 border-t px-3 py-1.5 text-xs">
          <span className="truncate">
            {clipboard.operation === 'cut' ? 'Move' : 'Copy'}:{' '}
            <span className="text-foreground/80 font-medium">{clipboard.name}</span>
          </span>
          <Button onClick={clearClipboard} variant="muted" size="xs">
            Cancel
          </Button>
        </div>
      )}

      {/* Delete confirmation */}
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
                'featuresProjectFilesComponentsFileTree.line1054JsxTextAreYouSureYouWantToDelete',
              )}
              <span className="text-foreground font-semibold">
                {tHardcodedUi.raw('featuresProjectFilesComponentsFileTree.line1054JsxTextQuot')}
                {deleteTarget?.name}
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsFileTree.line1054JsxTextQuotec1ca351',
                )}
              </span>
              {tHardcodedUi.raw(
                'featuresProjectFilesComponentsFileTree.line1054JsxTextThisActionCannotBeUndone',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutationHook.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              ref={deleteButtonRef}
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
              disabled={deleteMutationHook.isPending}
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              {deleteMutationHook.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

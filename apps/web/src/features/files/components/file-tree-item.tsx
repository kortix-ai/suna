'use client';

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  ChevronRight,
  Download,
  RefreshCw,
  History,
  Pencil,
  Trash2,
  Copy,
  Scissors,
  ClipboardCopy,
  CircleAlert,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FileNode } from '../types';
import { getFileIcon } from './file-icon';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

/** Git status for display purposes */
export type GitStatusType = 'added' | 'deleted' | 'modified';

interface FileTreeItemProps {
  node: FileNode;
  onClick: () => void;
  onDownload?: (node: FileNode) => void;
  onRename?: (node: FileNode, newName: string) => void;
  onDelete?: (node: FileNode) => void;
  onHistory?: (node: FileNode) => void;
  onCopy?: (node: FileNode) => void;
  onCut?: (node: FileNode) => void;
  /** Called when another item is dropped onto this directory */
  onDropMove?: (sourcePath: string, targetDirPath: string) => void;
  /** All sibling names in the current directory, for duplicate detection */
  siblingNames?: string[];
  /** Git status for this file/directory */
  gitStatus?: GitStatusType;
  /** Whether this item is currently cut (pending move) */
  isCut?: boolean;
  /** LSP diagnostic counts for this item (aggregated for directories) */
  diagnosticCounts?: { errors: number; warnings: number };
  /** Whether this item is currently being downloaded (shows spinner in context menu) */
  isDownloadingItem?: boolean;
}

// Custom MIME type for internal drag-and-drop
const DRAG_MIME = 'application/x-file-tree-path';

/** File extension / filename to icon mapping */
function getNodeIcon(node: FileNode) {
  return getFileIcon(node.name, { isDirectory: node.type === 'directory' });
}

/** Git status → text color class */
const gitStatusTextColor: Record<GitStatusType, string> = {
  added: 'text-emerald-500 dark:text-green-400',
  modified: 'text-yellow-500 dark:text-yellow-400',
  deleted: 'text-red-500 dark:text-red-400',
};

/** Git status → badge label */
const gitStatusLabel: Record<GitStatusType, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
};

/** Git status → badge color class */
const gitStatusBadgeColor: Record<GitStatusType, string> = {
  added: 'text-emerald-500 dark:text-green-400',
  modified: 'text-yellow-500 dark:text-yellow-400',
  deleted: 'text-red-500 dark:text-red-400',
};

/** Get selection end index: before extension for files, full length for folders */
function getNameSelectionEnd(name: string, isDirectory: boolean): number {
  if (isDirectory) return name.length;
  const dotIdx = name.lastIndexOf('.');
  return dotIdx > 0 ? dotIdx : name.length;
}

export { DRAG_MIME };

export function FileTreeItem({ node, onClick, onDownload, onRename, onDelete, onHistory, onCopy, onCut, onDropMove, siblingNames, gitStatus, isCut, diagnosticCounts, isDownloadingItem }: FileTreeItemProps) {
  const hasContextMenu = onDownload || onRename || onDelete || onHistory || onCopy || onCut;

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameName, setRenameName] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  // Check for duplicate name (exclude current node's own name)
  const nameConflict = useMemo(() => {
    if (!isRenaming || !renameName.trim() || !siblingNames) return false;
    const trimmed = renameName.trim().toLowerCase();
    if (trimmed === node.name.toLowerCase()) return false; // same name is fine
    return siblingNames.some((n) => n.toLowerCase() === trimmed);
  }, [isRenaming, renameName, siblingNames, node.name]);

  // Auto-focus and select when entering rename mode
  useEffect(() => {
    if (isRenaming) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = renameInputRef.current;
          if (el) {
            el.focus();
            const selEnd = getNameSelectionEnd(el.value, node.type === 'directory');
            el.setSelectionRange(0, selEnd);
          }
        });
      });
    }
  }, [isRenaming, node.type]);

  const startRenaming = () => {
    setRenameName(node.name);
    setIsRenaming(true);
  };

  const confirmRename = () => {
    const trimmed = renameName.trim();
    if (trimmed && trimmed !== node.name && !nameConflict && onRename) {
      onRename(node, trimmed);
    }
    setIsRenaming(false);
    setRenameName('');
  };

  const cancelRename = () => {
    setIsRenaming(false);
    setRenameName('');
  };

  // --- Drag source handlers ---
  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, node.path);
    e.dataTransfer.setData('text/plain', node.name);
    e.dataTransfer.effectAllowed = 'move';
    setIsDragging(true);
  }, [node.path, node.name]);

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  // --- Drop target handlers (directories only) ---
  const isDropTarget = node.type === 'directory' && !!onDropMove;

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isDropTarget) return;
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, [isDropTarget]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isDropTarget) return;
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    dragCounterRef.current++;
    setIsDragOver(true);
  }, [isDropTarget]);

  const handleDragLeave = useCallback(() => {
    if (!isDropTarget) return;
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, [isDropTarget]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!isDropTarget) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);

    const sourcePath = e.dataTransfer.getData(DRAG_MIME);
    if (!sourcePath) return;

    // Don't drop onto self or into own subtree
    if (sourcePath === node.path || node.path.startsWith(sourcePath + '/')) return;

    onDropMove!(sourcePath, node.path);
  }, [isDropTarget, node.path, onDropMove]);

  const content = isRenaming ? (
    <div
      className={cn(
        'flex items-center gap-2 w-full px-3 py-1.5 text-sm rounded-md',
        node.ignored && 'opacity-50',
      )}
    >
      {getNodeIcon(node)}
      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
        <input
          type="text"
          ref={renameInputRef}
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !nameConflict) confirmRename();
            if (e.key === 'Escape') cancelRename();
          }}
          onBlur={() => {
            if (!nameConflict) confirmRename();
            else cancelRename();
          }}
          className={cn(
            'w-full text-sm bg-transparent border rounded px-1.5 py-0.5 outline-none selection:bg-primary/15 selection:text-foreground',
            nameConflict ? 'border-red-500/60' : 'border-primary',
          )}
        />
        {nameConflict && (
          <p className="text-xs text-red-400">
            A file or folder with that name already exists
          </p>
        )}
      </div>
    </div>
  ) : (
    <button
      draggable={!isRenaming}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left rounded-md transition-colors cursor-pointer',
        'hover:bg-muted/80',
        node.ignored && 'opacity-50',
        isCut && 'opacity-40',
        isDragging && 'opacity-30',
        isDragOver && 'bg-primary/15 ring-1 ring-primary/40',
      )}
    >
      {getNodeIcon(node)}
      <span className={cn(
        'truncate flex-1',
        gitStatus && gitStatusTextColor[gitStatus],
        !gitStatus && node.name.startsWith('.') && node.name !== '.kortix' && node.name !== '.opencode' && 'opacity-50',
      )}>
        {node.name}
      </span>
      {/* Right-side indicators: git status + diagnostics */}
      {(gitStatus || (diagnosticCounts && (diagnosticCounts.errors > 0 || diagnosticCounts.warnings > 0))) && (
        <span className="inline-flex items-center gap-1.5 shrink-0">
          {diagnosticCounts && diagnosticCounts.errors > 0 && (
            <span className="inline-flex items-center gap-0.5 text-red-500">
              <CircleAlert className="h-3 w-3" />
              <span className="text-xs font-semibold leading-none">{diagnosticCounts.errors}</span>
            </span>
          )}
          {diagnosticCounts && diagnosticCounts.warnings > 0 && (
            <span className="inline-flex items-center gap-0.5 text-yellow-500">
              <AlertTriangle className="h-3 w-3" />
              <span className="text-xs font-semibold leading-none">{diagnosticCounts.warnings}</span>
            </span>
          )}
          {gitStatus && (
            <span className={cn('text-xs font-semibold leading-none', gitStatusBadgeColor[gitStatus])}>
              {gitStatusLabel[gitStatus]}
            </span>
          )}
        </span>
      )}
      {node.type === 'directory' && (
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      )}
    </button>
  );

  if (!hasContextMenu) {
    return content;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {content}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={onClick}>
          <ChevronRight className="mr-2 h-4 w-4" />
          {node.type === 'directory' ? 'Open folder' : 'Open file'}
        </ContextMenuItem>

        {onDownload && (
          <ContextMenuItem onClick={() => onDownload(node)} disabled={isDownloadingItem}>
            {isDownloadingItem ? (
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            {isDownloadingItem
              ? 'Zipping…'
              : node.type === 'directory'
              ? 'Download as zip'
              : 'Download'}
          </ContextMenuItem>
        )}

        {node.type === 'file' && onHistory && (
          <ContextMenuItem onClick={() => onHistory(node)}>
            <History className="mr-2 h-4 w-4" />
            View History
          </ContextMenuItem>
        )}

        <ContextMenuSeparator />

        {onCopy && (
          <ContextMenuItem
            onClick={() => onCopy(node)}
          >
            <ClipboardCopy className="mr-2 h-4 w-4" />
            Copy
          </ContextMenuItem>
        )}

        {onCut && (
          <ContextMenuItem
            onClick={() => onCut(node)}
          >
            <Scissors className="mr-2 h-4 w-4" />
            Cut
          </ContextMenuItem>
        )}

        <ContextMenuItem
          onClick={() => {
            navigator.clipboard.writeText(node.path);
          }}
        >
          <Copy className="mr-2 h-4 w-4" />
          Copy path
        </ContextMenuItem>

        {onRename && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => {
              setTimeout(() => startRenaming(), 100);
            }}>
              <Pencil className="mr-2 h-4 w-4" />
              Rename
            </ContextMenuItem>
          </>
        )}

        {onDelete && (
          <>
            {!onRename && <ContextMenuSeparator />}
            <ContextMenuItem
              onClick={() => onDelete(node)}
              className="text-muted-foreground focus:text-foreground"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

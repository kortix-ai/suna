'use client';

import { useTranslations } from 'next-intl';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { getFileIcon } from '@/features/workspace-files/components/file-icon';
import { cn } from '@/lib/utils';
import {
  WarningIcon as AlertTriangle,
  CaretRightIcon as ChevronRight,
  WarningCircleIcon as CircleAlert,
  ClipboardIcon as ClipboardCopy,
  CopyIcon as Copy,
  DownloadIcon as Download,
  ClockCounterClockwiseIcon as History,
  PencilSimpleIcon,
  ArrowClockwiseIcon as RefreshCw,
  ScissorsIcon as Scissors,
  TrashIcon as Trash2,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileNode } from '../types';

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

export function FileTreeItem({
  node,
  onClick,
  onDownload,
  onRename,
  onDelete,
  onHistory,
  onCopy,
  onCut,
  onDropMove,
  siblingNames,
  gitStatus,
  isCut,
  diagnosticCounts,
  isDownloadingItem,
}: FileTreeItemProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(DRAG_MIME, node.path);
      e.dataTransfer.setData('text/plain', node.name);
      e.dataTransfer.effectAllowed = 'move';
      setIsDragging(true);
    },
    [node.path, node.name],
  );

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  // --- Drop target handlers (directories only) ---
  const isDropTarget = node.type === 'directory' && !!onDropMove;

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isDropTarget) return;
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    },
    [isDropTarget],
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!isDropTarget) return;
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      dragCounterRef.current++;
      setIsDragOver(true);
    },
    [isDropTarget],
  );

  const handleDragLeave = useCallback(() => {
    if (!isDropTarget) return;
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, [isDropTarget]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
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
    },
    [isDropTarget, node.path, onDropMove],
  );

  const content = isRenaming ? (
    <div
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-sm',
        node.ignored && 'opacity-50',
      )}
    >
      {getNodeIcon(node)}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
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
            'bg-card focus:ring-primary/50 selection:bg-primary/15 selection:text-foreground h-7 w-full rounded-2xl border px-3 text-sm outline-none focus:ring-2',
            nameConflict && 'border-destructive focus:ring-destructive/30',
          )}
        />
        {nameConflict && (
          <p className="text-destructive text-xs">
            {tHardcodedUi.raw(
              'featuresProjectFilesComponentsFileTreeItem.line229JsxTextAFileOrFolderWithThatNameAlready',
            )}
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
        'flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm transition-colors',
        'hover:bg-muted/80',
        node.ignored && 'opacity-50',
        isCut && 'opacity-40',
        isDragging && 'opacity-30',
        isDragOver && 'bg-primary/15 ring-primary/40 ring-1',
      )}
    >
      {getNodeIcon(node)}
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
      {/* Right-side indicators: git status + diagnostics */}
      {(gitStatus ||
        (diagnosticCounts && (diagnosticCounts.errors > 0 || diagnosticCounts.warnings > 0))) && (
        <span className="inline-flex shrink-0 items-center gap-1.5">
          {diagnosticCounts && diagnosticCounts.errors > 0 && (
            <span className="text-destructive inline-flex items-center gap-0.5">
              <CircleAlert className="h-3 w-3" />
              <span className="text-xs leading-none font-semibold">{diagnosticCounts.errors}</span>
            </span>
          )}
          {diagnosticCounts && diagnosticCounts.warnings > 0 && (
            <span className="inline-flex items-center gap-0.5 text-yellow-500">
              <AlertTriangle className="h-3 w-3" />
              <span className="text-xs leading-none font-semibold">
                {diagnosticCounts.warnings}
              </span>
            </span>
          )}
          {gitStatus && (
            <span
              className={cn('text-xs leading-none font-semibold', gitStatusBadgeColor[gitStatus])}
            >
              {gitStatusLabel[gitStatus]}
            </span>
          )}
        </span>
      )}
      {node.type === 'directory' && (
        <ChevronRight className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
      )}
    </button>
  );

  if (!hasContextMenu) {
    return content;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{content}</ContextMenuTrigger>
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
            {tHardcodedUi.raw(
              'featuresProjectFilesComponentsFileTreeItem.line322JsxTextCheckpointHistory',
            )}
          </ContextMenuItem>
        )}

        <ContextMenuSeparator />

        {onCopy && (
          <ContextMenuItem onClick={() => onCopy(node)}>
            <ClipboardCopy className="mr-2 h-4 w-4" />
            Copy
          </ContextMenuItem>
        )}

        {onCut && (
          <ContextMenuItem onClick={() => onCut(node)}>
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
          {tHardcodedUi.raw('featuresProjectFilesComponentsFileTreeItem.line352JsxTextCopyPath')}
        </ContextMenuItem>

        {onRename && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => {
                setTimeout(() => startRenaming(), 100);
              }}
            >
              <PencilSimpleIcon className="mr-2 h-4 w-4" />
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

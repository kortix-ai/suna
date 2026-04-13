'use client';

import { useMemo, useCallback, useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  Folder,
  FolderOpen,
  FolderCog,
  MoreVertical,
  Download,
  History,
  Pencil,
  Trash2,
  Copy,
  Scissors,
  ClipboardCopy,
  RefreshCw,
  ExternalLink,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FileNode } from '../types';
import { getFileIcon } from './file-icon';
import { FileThumbnail } from './file-thumbnail';
import { DRAG_MIME } from './file-tree-item';
import type { GitStatusType } from './file-tree-item';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

// ─── Grid Item Props ────────────────────────────────────────────────────────

interface DriveGridItemProps {
  node: FileNode;
  onClick: () => void;
  onDoubleClick?: () => void;
  onDownload?: (node: FileNode) => void;
  onRename?: (node: FileNode, newName: string) => void;
  onDelete?: (node: FileNode) => void;
  onHistory?: (node: FileNode) => void;
  onCopy?: (node: FileNode) => void;
  onCut?: (node: FileNode) => void;
  onDropMove?: (sourcePath: string, targetDirPath: string) => void;
  onOpenInTab?: (node: FileNode) => void;
  isDownloadingItem?: boolean;
  gitStatus?: GitStatusType;
  isCut?: boolean;
}

// ─── Folder Card ────────────────────────────────────────────────────────────

function FolderCard({
  node,
  onClick,
  onDownload,
  onRename,
  onDelete,
  onCopy,
  onCut,
  onDropMove,
  isDownloadingItem,
  isCut,
}: DriveGridItemProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameName, setRenameName] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  const contextTriggerRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, node.path);
    e.dataTransfer.setData('text/plain', node.name);
    e.dataTransfer.effectAllowed = 'move';
    setIsDragging(true);
  }, [node.path, node.name]);

  const handleDragEnd = useCallback(() => setIsDragging(false), []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    dragCounterRef.current++;
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    const sourcePath = e.dataTransfer.getData(DRAG_MIME);
    if (!sourcePath || sourcePath === node.path || node.path.startsWith(sourcePath + '/')) return;
    onDropMove?.(sourcePath, node.path);
  }, [node.path, onDropMove]);

  const startRenaming = useCallback(() => {
    setRenameName(node.name);
    setIsRenaming(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      });
    });
  }, [node.name]);

  const confirmRename = useCallback(() => {
    const trimmed = renameName.trim();
    if (trimmed && trimmed !== node.name) {
      onRename?.(node, trimmed);
    }
    setIsRenaming(false);
  }, [renameName, node, onRename]);

  // Programmatically open context menu on 3-dot click
  const handleDotsClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const trigger = contextTriggerRef.current;
    if (trigger) {
      const rect = (e.target as HTMLElement).getBoundingClientRect();
      trigger.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: rect.left,
          clientY: rect.bottom,
        }),
      );
    }
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={contextTriggerRef}
          draggable={!isRenaming}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={isRenaming ? undefined : onClick}
          className={cn(
            'group flex items-center gap-2.5 h-10 px-3 rounded-lg border border-border/50 cursor-pointer select-none',
            'transition-colors duration-150',
            'hover:bg-muted/50 hover:border-border',
            'active:scale-[0.98]',
            isCut && 'opacity-40',
            isDragging && 'opacity-30',
            isDragOver && 'bg-primary/[0.08] border-primary/40',
          )}
        >
          <Folder className="h-4.5 w-4.5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0 h-full flex items-center">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                type="text"
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmRename();
                  if (e.key === 'Escape') setIsRenaming(false);
                }}
                onBlur={confirmRename}
                onClick={(e) => e.stopPropagation()}
                className="w-full text-[13px] bg-transparent border-b border-primary/50 py-0.5 outline-none"
              />
            ) : (
              <span className="text-[13px] truncate text-foreground">
                {node.name}
              </span>
            )}
          </div>
          {!isRenaming && (
            <Button
              onClick={handleDotsClick}
              variant="ghost"
              size="icon-xs"
              className="opacity-0 group-hover:opacity-100 shrink-0"
            >
              <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={onClick}>Open folder</ContextMenuItem>
        {onDownload && (
          <ContextMenuItem onClick={() => onDownload(node)} disabled={isDownloadingItem}>
            <Download className="mr-2 h-4 w-4" />
            {isDownloadingItem ? 'Zipping...' : 'Download as zip'}
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
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(node.path)}>
          <Copy className="mr-2 h-4 w-4" />
          Copy path
        </ContextMenuItem>
        <ContextMenuSeparator />
        {onRename && (
          <ContextMenuItem onClick={() => setTimeout(startRenaming, 100)}>
            <Pencil className="mr-2 h-4 w-4" />
            Rename
          </ContextMenuItem>
        )}
        {onDelete && (
          <ContextMenuItem onClick={() => onDelete(node)}>
            <Trash2 className="mr-2 h-4 w-4" />
            Remove
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ─── File Card ──────────────────────────────────────────────────────────────

function FileCard({
  node,
  onClick,
  onDoubleClick,
  onDownload,
  onRename,
  onDelete,
  onHistory,
  onCopy,
  onCut,
  onOpenInTab,
  isCut,
}: DriveGridItemProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameName, setRenameName] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const contextTriggerRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, node.path);
    e.dataTransfer.setData('text/plain', node.name);
    e.dataTransfer.effectAllowed = 'move';
    setIsDragging(true);
  }, [node.path, node.name]);

  const handleDragEnd = useCallback(() => setIsDragging(false), []);

  const startRenaming = useCallback(() => {
    setRenameName(node.name);
    setIsRenaming(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = renameInputRef.current;
        if (el) {
          el.focus();
          const dotIdx = el.value.lastIndexOf('.');
          el.setSelectionRange(0, dotIdx > 0 ? dotIdx : el.value.length);
        }
      });
    });
  }, [node.name]);

  const confirmRename = useCallback(() => {
    const trimmed = renameName.trim();
    if (trimmed && trimmed !== node.name) {
      onRename?.(node, trimmed);
    }
    setIsRenaming(false);
  }, [renameName, node, onRename]);

  // Programmatically open context menu on 3-dot click
  const handleDotsClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const trigger = contextTriggerRef.current;
    if (trigger) {
      const rect = (e.target as HTMLElement).getBoundingClientRect();
      trigger.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: rect.left,
          clientY: rect.bottom,
        }),
      );
    }
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={contextTriggerRef}
          draggable={!isRenaming}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onClick={isRenaming ? undefined : onClick}
          onDoubleClick={isRenaming ? undefined : onDoubleClick}
          className={cn(
            'group relative flex flex-col rounded-lg border border-border/50 cursor-pointer select-none overflow-hidden',
            'transition-colors duration-150',
            'hover:bg-muted/30 hover:border-border hover:shadow-sm',
            'active:scale-[0.98]',
            isCut && 'opacity-40',
            isDragging && 'opacity-30',
          )}
        >
          {/* Thumbnail area */}
          <FileThumbnail
            filePath={node.path}
            fileName={node.name}
            className="h-[100px]"
          />

          {/* Three-dot menu trigger */}
          {!isRenaming && (
            <Button
              onClick={handleDotsClick}
              variant="ghost"
              size="icon-xs"
              className="absolute top-1.5 right-1.5 h-6 w-6 bg-background/80 opacity-0 group-hover:opacity-100 z-10"
            >
              <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          )}

          {/* Name area */}
          <div className="px-2.5 py-2 border-t border-border/30 h-[38px] flex items-center">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                type="text"
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmRename();
                  if (e.key === 'Escape') setIsRenaming(false);
                }}
                onBlur={confirmRename}
                onClick={(e) => e.stopPropagation()}
                className="w-full text-[13px] bg-transparent border-b border-primary/50 py-0.5 outline-none"
              />
            ) : (
              <div className="flex items-center gap-1.5 min-w-0 w-full">
                {getFileIcon(node.name, { className: 'h-4 w-4 shrink-0', variant: 'monochrome' })}
                <span className="text-[13px] truncate text-foreground">{node.name}</span>
              </div>
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={onClick}>
          Preview
        </ContextMenuItem>
        {onOpenInTab && (
          <ContextMenuItem onClick={() => onOpenInTab(node)}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Open in tab
          </ContextMenuItem>
        )}
        {onDownload && (
          <ContextMenuItem onClick={() => onDownload(node)}>
            <Download className="mr-2 h-4 w-4" />
            Download
          </ContextMenuItem>
        )}
        {onHistory && (
          <ContextMenuItem onClick={() => onHistory(node)}>
            <History className="mr-2 h-4 w-4" />
            View history
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
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(node.path)}>
          <Copy className="mr-2 h-4 w-4" />
          Copy path
        </ContextMenuItem>
        <ContextMenuSeparator />
        {onRename && (
          <ContextMenuItem onClick={() => setTimeout(startRenaming, 100)}>
            <Pencil className="mr-2 h-4 w-4" />
            Rename
          </ContextMenuItem>
        )}
        {onDelete && (
          <ContextMenuItem onClick={() => onDelete(node)}>
            <Trash2 className="mr-2 h-4 w-4" />
            Remove
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ─── Main Grid View ─────────────────────────────────────────────────────────

/** Descriptions for elevated system directories */
const ELEVATED_DIR_META: Record<string, { description: string; icon: typeof FolderCog }> = {
  '.kortix': { description: 'Project config, tasks, context', icon: FolderCog },
  '.opencode': { description: 'Agents, skills, commands', icon: FolderCog },
};

interface DriveGridViewProps {
  elevatedDirs: FileNode[];
  dirs: FileNode[];
  files: FileNode[];
  onNavigateToDir: (node: FileNode) => void;
  onOpenFile: (node: FileNode) => void;
  onPreviewFile: (node: FileNode) => void;
  onDownload: (node: FileNode) => void;
  onDownloadDir: (node: FileNode) => void;
  onRename: (node: FileNode, newName: string) => void;
  onDelete: (node: FileNode) => void;
  onHistory: (node: FileNode) => void;
  onCopy: (node: FileNode) => void;
  onCut: (node: FileNode) => void;
  onDropMove: (sourcePath: string, targetDirPath: string) => void;
  onOpenInTab: (node: FileNode) => void;
  gitStatusMap: Map<string, GitStatusType>;
  clipboardPath?: string;
  clipboardOperation?: string;
  isDirDownloading: (path: string) => boolean;
}

export function DriveGridView({
  elevatedDirs,
  dirs,
  files,
  onNavigateToDir,
  onOpenFile,
  onPreviewFile,
  onDownload,
  onDownloadDir,
  onRename,
  onDelete,
  onHistory,
  onCopy,
  onCut,
  onDropMove,
  onOpenInTab,
  gitStatusMap,
  clipboardPath,
  clipboardOperation,
  isDirDownloading,
}: DriveGridViewProps) {
  return (
    <div className="p-4 space-y-6">
      {/* Elevated system directories */}
      {elevatedDirs.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3 px-1 flex items-center gap-1.5">
            <Sparkles className="h-3 w-3 text-primary/60" />
            System
          </h3>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {elevatedDirs.map((node) => {
              const meta = ELEVATED_DIR_META[node.name];
              const DirIcon = meta?.icon ?? FolderCog;
              return (
                <div
                  key={node.path}
                  onClick={() => onNavigateToDir(node)}
                  className={cn(
                    'group flex items-center gap-3 px-3.5 py-3 rounded-lg cursor-pointer select-none',
                    'border border-primary/20 bg-primary/[0.03]',
                    'hover:bg-primary/[0.06] hover:border-primary/30',
                    'transition-colors duration-150 active:scale-[0.98]',
                  )}
                >
                  <div className="shrink-0 h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center">
                    <DirIcon className="h-4 w-4 text-primary/70" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-[13px] font-medium text-foreground block truncate">
                      {node.name}
                    </span>
                    {meta?.description && (
                      <span className="text-[11px] text-muted-foreground/50 block truncate">
                        {meta.description}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Folders section */}
      {dirs.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3 px-1">
            Folders
          </h3>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
            {dirs.map((node) => (
              <FolderCard
                key={node.path}
                node={node}
                onClick={() => onNavigateToDir(node)}
                onDownload={onDownloadDir}
                isDownloadingItem={isDirDownloading(node.path)}
                onRename={onRename}
                onDelete={onDelete}
                onCopy={onCopy}
                onCut={onCut}
                onDropMove={onDropMove}
                isCut={clipboardOperation === 'cut' && clipboardPath === node.path}
              />
            ))}
          </div>
        </div>
      )}

      {/* Files section */}
      {files.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3 px-1">
            Files
          </h3>
          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
            {files.map((node) => (
              <FileCard
                key={node.path}
                node={node}
                onClick={() => onPreviewFile(node)}
                onDoubleClick={() => onOpenFile(node)}
                onDownload={onDownload}
                onRename={onRename}
                onDelete={onDelete}
                onHistory={onHistory}
                onCopy={onCopy}
                onCut={onCut}
                onOpenInTab={onOpenInTab}
                gitStatus={gitStatusMap.get(node.path)}
                isCut={clipboardOperation === 'cut' && clipboardPath === node.path}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {dirs.length === 0 && files.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <FolderOpen className="h-16 w-16 text-muted-foreground/20 mb-4" />
          <p className="text-sm text-muted-foreground">This folder is empty</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Drop files here or use the New button to get started
          </p>
        </div>
      )}
    </div>
  );
}

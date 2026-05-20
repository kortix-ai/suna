'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ChevronRight,
  ClipboardCopy,
  Copy,
  Download,
  ExternalLink,
  Folder,
  FolderCog,
  FolderOpen,
  History,
  MoreHorizontal,
  Pencil,
  Scissors,
  Trash2,
} from 'lucide-react';
import {
  Button,
  cn,
  springs,
  useProximityHover,
  useRegisterProximityItem,
} from '@kortix/design-system';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import type { FileNode } from '../types';
import { getFileIcon } from './file-icon';
import { DRAG_MIME } from './file-tree-item';
import type { GitStatusType } from './file-tree-item';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useFilesStore } from '../store/files-store';

const GIT_STATUS_TONE: Record<string, string> = {
  added: 'text-emerald-500',
  modified: 'text-amber-500',
  deleted: 'text-rose-500',
  renamed: 'text-sky-500',
  untracked: 'text-muted-foreground/70',
};

const GIT_STATUS_GLYPH: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

type RowKind = 'system' | 'folder' | 'file';

interface FlatRow {
  node: FileNode;
  kind: RowKind;
}

interface DriveGridViewProps {
  elevatedDirs: FileNode[];
  projectName: string;
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
  readOnly?: boolean;
}

export function DriveGridView({
  projectName,
  elevatedDirs,
  dirs,
  files,
  onNavigateToDir,
  onOpenFile,
  onPreviewFile,
  onDownload,
  onDownloadDir,
  onRename: rawOnRename,
  onDelete: rawOnDelete,
  onHistory,
  onCopy: rawOnCopy,
  onCut: rawOnCut,
  onDropMove: rawOnDropMove,
  onOpenInTab,
  gitStatusMap,
  clipboardPath,
  clipboardOperation,
  isDirDownloading,
  readOnly = false,
}: DriveGridViewProps) {
  const onRename = readOnly ? undefined : rawOnRename;
  const onDelete = readOnly ? undefined : rawOnDelete;
  const onCopy = readOnly ? undefined : rawOnCopy;
  const onCut = readOnly ? undefined : rawOnCut;
  const onDropMove = readOnly ? undefined : rawOnDropMove;

  const rows = useMemo<FlatRow[]>(
    () => [
      ...elevatedDirs.map((node) => ({ node, kind: 'system' as RowKind })),
      ...dirs.map((node) => ({ node, kind: 'folder' as RowKind })),
      ...files.map((node) => ({ node, kind: 'file' as RowKind })),
    ],
    [elevatedDirs, dirs, files],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const { activeIndex, setActiveIndex, itemRects, sessionRef, handlers, registerItem, measureItems } =
    useProximityHover<HTMLDivElement>(containerRef, { axis: 'y' });

  useEffect(() => {
    const onScroll = () => setActiveIndex(null);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, [setActiveIndex]);

  useEffect(() => {
    measureItems();
  }, [rows.length, measureItems]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => measureItems());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [measureItems]);

  const hoverRect = activeIndex !== null ? itemRects[activeIndex] : null;

  if (rows.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center justify-center px-4 py-24 text-center sm:px-6 lg:px-8">
        <FolderOpen className="size-5 text-muted-foreground/40" aria-hidden />
        <p className="mt-3 font-sans text-sm font-medium text-foreground">
          This folder is empty
        </p>
        <p className="mt-1 font-mono text-[0.68rem] text-muted-foreground">
          No files or subfolders at this path.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <PathBreadcrumb />
      <div className="mb-5 flex items-baseline justify-between gap-3 font-mono text-[0.6rem] uppercase tracking-[0.22em] text-muted-foreground/70">
        <div className="flex min-w-0 items-center gap-1.5">
          <UserAvatar email={projectName} size="md" />
          <span className="truncate font-sans text-xl font-semibold normal-case tracking-normal text-foreground">
            {projectName || 'Project'}
          </span>
        </div>
        <span className="shrink-0 tabular-nums">
          {(dirs.length + elevatedDirs.length).toString().padStart(2, '0')} folders ·{' '}
          {files.length.toString().padStart(2, '0')} files
        </span>
      </div>

      <div ref={containerRef} className="relative border-t border-border/50" {...handlers}>
        <AnimatePresence>
          {hoverRect ? (
            <motion.div
              key={`hover-${sessionRef.current}`}
              aria-hidden
              className="pointer-events-none absolute left-0 right-0 z-0 bg-muted-foreground/[0.05]"
              initial={{ top: hoverRect.top, height: hoverRect.height, opacity: 0 }}
              animate={{ top: hoverRect.top, height: hoverRect.height, opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={springs.moderate}
            />
          ) : null}
        </AnimatePresence>

        {rows.map((row, index) => {
          const { node, kind } = row;
          if (kind === 'system' || kind === 'folder') {
            return (
              <FolderRow
                key={node.path}
                proximityIndex={index}
                registerItem={registerItem}
                node={node}
                isSystem={kind === 'system'}
                isLast={index === rows.length - 1}
                onClick={() => onNavigateToDir(node)}
                onDownload={onDownloadDir}
                isDownloading={isDirDownloading(node.path)}
                onRename={onRename}
                onDelete={onDelete}
                onCopy={onCopy}
                onCut={onCut}
                onDropMove={onDropMove}
                isCut={clipboardOperation === 'cut' && clipboardPath === node.path}
              />
            );
          }
          return (
            <FileRow
              key={node.path}
              proximityIndex={index}
              registerItem={registerItem}
              node={node}
              isLast={index === rows.length - 1}
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
          );
        })}
      </div>
    </div>
  );
}

function RowShell({
  rowRef,
  draggable,
  onClick,
  onDoubleClick,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
  isDragging,
  isDragOver,
  isCut,
  isLast,
  children,
}: {
  rowRef: React.Ref<HTMLDivElement>;
  draggable?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragEnter?: (e: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent) => void;
  isDragging?: boolean;
  isDragOver?: boolean;
  isCut?: boolean;
  isLast?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={rowRef}
      draggable={draggable}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'group/row relative z-10 flex h-9 cursor-pointer items-center gap-3 px-3 text-left text-foreground outline-none',
        !isLast && 'border-b border-border/40',
        isCut && 'opacity-40',
        isDragging && 'opacity-30',
        isDragOver && 'bg-primary/[0.08]',
      )}
    >
      {children}
    </div>
  );
}

function FolderRow({
  node,
  proximityIndex,
  registerItem,
  isSystem,
  isLast,
  onClick,
  onDownload,
  isDownloading,
  onRename,
  onDelete,
  onCopy,
  onCut,
  onDropMove,
  isCut,
}: {
  node: FileNode;
  proximityIndex: number;
  registerItem: (index: number, element: HTMLElement | null) => void;
  isSystem: boolean;
  isLast: boolean;
  onClick: () => void;
  onDownload?: (node: FileNode) => void;
  isDownloading?: boolean;
  onRename?: (node: FileNode, newName: string) => void;
  onDelete?: (node: FileNode) => void;
  onCopy?: (node: FileNode) => void;
  onCut?: (node: FileNode) => void;
  onDropMove?: (sourcePath: string, targetDirPath: string) => void;
  isCut?: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useRegisterProximityItem(
    registerItem,
    proximityIndex,
    rowRef as unknown as RefObject<HTMLElement | null>,
  );

  const [isDragging, setIsDragging] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameName, setRenameName] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(DRAG_MIME, node.path);
      e.dataTransfer.setData('text/plain', node.name);
      e.dataTransfer.effectAllowed = 'move';
      setIsDragging(true);
    },
    [node.path, node.name],
  );
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    dragCounter.current += 1;
    setIsDragOver(true);
  }, []);
  const handleDragLeave = useCallback(() => {
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragOver(false);
    }
  }, []);
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setIsDragOver(false);
      const sourcePath = e.dataTransfer.getData(DRAG_MIME);
      if (!sourcePath || sourcePath === node.path || node.path.startsWith(sourcePath + '/'))
        return;
      onDropMove?.(sourcePath, node.path);
    },
    [node.path, onDropMove],
  );

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
    if (trimmed && trimmed !== node.name) onRename?.(node, trimmed);
    setIsRenaming(false);
  }, [renameName, node, onRename]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <RowShell
          rowRef={rowRef}
          draggable={!isRenaming}
          onClick={isRenaming ? undefined : onClick}
          onDragStart={handleDragStart}
          onDragEnd={() => setIsDragging(false)}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          isDragging={isDragging}
          isDragOver={isDragOver}
          isCut={isCut}
          isLast={isLast}
        >
          {isSystem ? (
            <FolderCog className="size-3.5 shrink-0 text-foreground/70" aria-hidden />
          ) : (
            <Folder className="size-3.5 shrink-0 text-sky-500/80" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmRename();
                  if (e.key === 'Escape') setIsRenaming(false);
                }}
                onBlur={confirmRename}
                onClick={(e) => e.stopPropagation()}
                className="w-full bg-transparent font-sans text-[0.82rem] outline-none"
              />
            ) : (
              <span className="truncate font-sans text-[0.82rem] text-foreground">
                {node.name}
              </span>
            )}
          </div>
          {isSystem ? (
            <span className="hidden font-mono text-[0.58rem] uppercase tracking-[0.16em] text-muted-foreground/60 md:inline">
              system
            </span>
          ) : null}
        </RowShell>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={onClick}>Open folder</ContextMenuItem>
        {onDownload ? (
          <ContextMenuItem onClick={() => onDownload(node)} disabled={isDownloading}>
            <Download className="mr-2 h-4 w-4" />
            {isDownloading ? 'Zipping…' : 'Download as zip'}
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        {onCopy ? (
          <ContextMenuItem onClick={() => onCopy(node)}>
            <ClipboardCopy className="mr-2 h-4 w-4" />
            Copy
          </ContextMenuItem>
        ) : null}
        {onCut ? (
          <ContextMenuItem onClick={() => onCut(node)}>
            <Scissors className="mr-2 h-4 w-4" />
            Cut
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(node.path)}>
          <Copy className="mr-2 h-4 w-4" />
          Copy path
        </ContextMenuItem>
        <ContextMenuSeparator />
        {onRename ? (
          <ContextMenuItem onClick={() => setTimeout(startRenaming, 100)}>
            <Pencil className="mr-2 h-4 w-4" />
            Rename
          </ContextMenuItem>
        ) : null}
        {onDelete ? (
          <ContextMenuItem onClick={() => onDelete(node)}>
            <Trash2 className="mr-2 h-4 w-4" />
            Remove
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function FileRow({
  node,
  proximityIndex,
  registerItem,
  isLast,
  onClick,
  onDoubleClick,
  onDownload,
  onRename,
  onDelete,
  onHistory,
  onCopy,
  onCut,
  onOpenInTab,
  gitStatus,
  isCut,
}: {
  node: FileNode;
  proximityIndex: number;
  registerItem: (index: number, element: HTMLElement | null) => void;
  isLast: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  onDownload?: (node: FileNode) => void;
  onRename?: (node: FileNode, newName: string) => void;
  onDelete?: (node: FileNode) => void;
  onHistory?: (node: FileNode) => void;
  onCopy?: (node: FileNode) => void;
  onCut?: (node: FileNode) => void;
  onOpenInTab?: (node: FileNode) => void;
  gitStatus?: GitStatusType;
  isCut?: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useRegisterProximityItem(
    registerItem,
    proximityIndex,
    rowRef as unknown as RefObject<HTMLElement | null>,
  );

  const [isDragging, setIsDragging] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameName, setRenameName] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData(DRAG_MIME, node.path);
      e.dataTransfer.setData('text/plain', node.name);
      e.dataTransfer.effectAllowed = 'move';
      setIsDragging(true);
    },
    [node.path, node.name],
  );

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
    if (trimmed && trimmed !== node.name) onRename?.(node, trimmed);
    setIsRenaming(false);
  }, [renameName, node, onRename]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <RowShell
          rowRef={rowRef}
          draggable={!isRenaming}
          onClick={isRenaming ? undefined : onClick}
          onDoubleClick={isRenaming ? undefined : onDoubleClick}
          onDragStart={handleDragStart}
          onDragEnd={() => setIsDragging(false)}
          isDragging={isDragging}
          isCut={isCut}
          isLast={isLast}
        >
          {getFileIcon(node.name, {
            className: 'size-3.5 shrink-0 text-muted-foreground',
            variant: 'monochrome',
          })}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmRename();
                  if (e.key === 'Escape') setIsRenaming(false);
                }}
                onBlur={confirmRename}
                onClick={(e) => e.stopPropagation()}
                className="w-full bg-transparent font-sans text-[0.82rem] outline-none"
              />
            ) : (
              <span className="truncate font-sans text-[0.82rem] text-foreground">
                {node.name}
              </span>
            )}
            {gitStatus ? (
              <span
                className={cn(
                  'shrink-0 font-mono text-[0.6rem] font-medium uppercase tracking-[0.08em]',
                  GIT_STATUS_TONE[gitStatus] ?? 'text-muted-foreground',
                )}
                title={gitStatus}
              >
                {GIT_STATUS_GLYPH[gitStatus] ?? '·'}
              </span>
            ) : null}
          </div>
          <span
            className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <FileRowKebab
              onPreview={onClick}
              onOpenInTab={onOpenInTab ? () => onOpenInTab(node) : undefined}
              onDownload={onDownload ? () => onDownload(node) : undefined}
              onHistory={onHistory ? () => onHistory(node) : undefined}
              onCopy={onCopy ? () => onCopy(node) : undefined}
              onCut={onCut ? () => onCut(node) : undefined}
              onCopyPath={() => navigator.clipboard.writeText(node.path)}
              onRename={onRename ? () => setTimeout(startRenaming, 100) : undefined}
              onDelete={onDelete ? () => onDelete(node) : undefined}
            />
          </span>
        </RowShell>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={onClick}>Preview</ContextMenuItem>
        {onOpenInTab ? (
          <ContextMenuItem onClick={() => onOpenInTab(node)}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Open in tab
          </ContextMenuItem>
        ) : null}
        {onDownload ? (
          <ContextMenuItem onClick={() => onDownload(node)}>
            <Download className="mr-2 h-4 w-4" />
            Download
          </ContextMenuItem>
        ) : null}
        {onHistory ? (
          <ContextMenuItem onClick={() => onHistory(node)}>
            <History className="mr-2 h-4 w-4" />
            Checkpoint history
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        {onCopy ? (
          <ContextMenuItem onClick={() => onCopy(node)}>
            <ClipboardCopy className="mr-2 h-4 w-4" />
            Copy
          </ContextMenuItem>
        ) : null}
        {onCut ? (
          <ContextMenuItem onClick={() => onCut(node)}>
            <Scissors className="mr-2 h-4 w-4" />
            Cut
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onClick={() => navigator.clipboard.writeText(node.path)}>
          <Copy className="mr-2 h-4 w-4" />
          Copy path
        </ContextMenuItem>
        <ContextMenuSeparator />
        {onRename ? (
          <ContextMenuItem onClick={() => setTimeout(startRenaming, 100)}>
            <Pencil className="mr-2 h-4 w-4" />
            Rename
          </ContextMenuItem>
        ) : null}
        {onDelete ? (
          <ContextMenuItem onClick={() => onDelete(node)}>
            <Trash2 className="mr-2 h-4 w-4" />
            Remove
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function FileRowKebab({
  onPreview,
  onOpenInTab,
  onDownload,
  onHistory,
  onCopy,
  onCut,
  onCopyPath,
  onRename,
  onDelete,
}: {
  onPreview: () => void;
  onOpenInTab?: () => void;
  onDownload?: () => void;
  onHistory?: () => void;
  onCopy?: () => void;
  onCut?: () => void;
  onCopyPath: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="File actions"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onPreview}>Preview</DropdownMenuItem>
        {onOpenInTab ? (
          <DropdownMenuItem onSelect={onOpenInTab}>
            <ExternalLink />
            Open in tab
          </DropdownMenuItem>
        ) : null}
        {onDownload ? (
          <DropdownMenuItem onSelect={onDownload}>
            <Download />
            Download
          </DropdownMenuItem>
        ) : null}
        {onHistory ? (
          <DropdownMenuItem onSelect={onHistory}>
            <History />
            Checkpoint history
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        {onCopy ? (
          <DropdownMenuItem onSelect={onCopy}>
            <ClipboardCopy />
            Copy
          </DropdownMenuItem>
        ) : null}
        {onCut ? (
          <DropdownMenuItem onSelect={onCut}>
            <Scissors />
            Cut
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onCopyPath}>
          <Copy />
          Copy path
        </DropdownMenuItem>
        {(onRename || onDelete) ? <DropdownMenuSeparator /> : null}
        {onRename ? (
          <DropdownMenuItem onSelect={onRename}>
            <Pencil />
            Rename
          </DropdownMenuItem>
        ) : null}
        {onDelete ? (
          <DropdownMenuItem onSelect={onDelete} variant="destructive">
            <Trash2 />
            Remove
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PathBreadcrumb() {
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const rootPath = useFilesStore((s) => s.rootPath);

  const homePath = rootPath || '/workspace';
  const homeLabel = rootPath
    ? rootPath.split('/').filter(Boolean).pop() || 'root'
    : 'workspace';

  const isRoot = currentPath === '/' || currentPath === '.' || currentPath === '';
  const allSegments = isRoot ? [] : currentPath.split('/').filter(Boolean);
  const rootSegments = rootPath ? rootPath.split('/').filter(Boolean) : [];
  const segments = rootPath ? allSegments.slice(rootSegments.length) : allSegments;
  const visibleSegments = rootPath
    ? segments
    : segments.filter((seg, i) => !(i === 0 && seg === 'workspace'));

  const handleSegmentClick = (visibleIndex: number) => {
    const actualIndex = !rootPath && segments[0] === 'workspace' ? visibleIndex + 1 : visibleIndex;
    const absoluteIndex = rootPath ? actualIndex + rootSegments.length : actualIndex;
    const pathToHere = '/' + allSegments.slice(0, absoluteIndex + 1).join('/');
    navigateToPath(pathToHere);
  };

  const atHome = visibleSegments.length === 0;

  return (
    <nav
      aria-label="Path"
      className="mb-3 flex items-center gap-0.5 font-mono text-[0.62rem] uppercase tracking-[0.18em]"
    >
      <button
        type="button"
        onClick={() => navigateToPath(homePath)}
        className={cn(
          'rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring',
          atHome
            ? 'text-foreground'
            : 'text-muted-foreground/70 hover:text-foreground',
        )}
      >
        {homeLabel}
      </button>
      {visibleSegments.map((segment, index) => {
        const isLast = index === visibleSegments.length - 1;
        return (
          <span key={index} className="flex min-w-0 items-center">
            <ChevronRight
              className="size-2.5 shrink-0 text-muted-foreground/30"
              aria-hidden
            />
            <button
              type="button"
              onClick={() => handleSegmentClick(index)}
              className={cn(
                'truncate rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring',
                isLast
                  ? 'text-foreground'
                  : 'text-muted-foreground/70 hover:text-foreground',
              )}
            >
              {segment}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

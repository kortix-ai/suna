'use client';

import { Button } from '@/components/ui/button';
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
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { Eye, Pencil, TrashSolid } from '@mynaui/icons-react';
import {
  ArrowUpRight,
  ClipboardCopy,
  Copy,
  Download,
  Folder,
  FolderCog,
  History,
  MoreVertical,
  Scissors,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState, type ComponentType, type ReactNode } from 'react';
import type { FileNode } from '../types';
import { getFileIcon } from './file-icon';
import { FileThumbnail } from './file-thumbnail';
import type { GitStatusType } from './file-tree-item';
import { DRAG_MIME } from './file-tree-item';

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
  isDownloadingItem?: boolean;
  gitStatus?: GitStatusType;
  isCut?: boolean;
}

type DriveMenuItemComponent = ComponentType<{
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}>;

type DriveMenuSeparatorComponent = ComponentType;

interface FolderDriveMenuProps {
  Item: DriveMenuItemComponent;
  Separator: DriveMenuSeparatorComponent;
  node: FileNode;
  onClick: () => void;
  onDownload?: (node: FileNode) => void;
  onCopy?: (node: FileNode) => void;
  onCut?: (node: FileNode) => void;
  onRename?: (node: FileNode, newName: string) => void;
  onDelete?: (node: FileNode) => void;
  startRenaming: () => void;
  isDownloadingItem?: boolean;
  openFolderLabel: string;
  copyPathLabel: string;
}

export function FolderDriveMenuItems({
  Item,
  Separator,
  node,
  onClick,
  onDownload,
  onCopy,
  onCut,
  onRename,
  onDelete,
  startRenaming,
  isDownloadingItem,
  openFolderLabel,
  copyPathLabel,
}: FolderDriveMenuProps) {
  const hasEditActions = Boolean(onRename || onDelete);

  return (
    <>
      <Item onClick={onClick}>
        <ArrowUpRight />
        {openFolderLabel}
      </Item>
      {onDownload && (
        <Item onClick={() => onDownload(node)} disabled={isDownloadingItem}>
          <Download />
          {isDownloadingItem ? 'Zipping...' : 'Download as zip'}
        </Item>
      )}
      <Separator />
      {onCopy && (
        <Item onClick={() => onCopy(node)}>
          <ClipboardCopy />
          Copy
        </Item>
      )}
      {onCut && (
        <Item onClick={() => onCut(node)}>
          <Scissors />
          Cut
        </Item>
      )}
      <Item onClick={() => navigator.clipboard.writeText(node.path)}>
        <Copy />
        {copyPathLabel}
      </Item>
      {hasEditActions && (
        <>
          <Separator />
          {onRename && (
            <Item onClick={() => setTimeout(startRenaming, 100)}>
              <Pencil />
              Rename
            </Item>
          )}
          {onDelete && (
            <Item onClick={() => onDelete(node)}>
              <TrashSolid />
              Remove
            </Item>
          )}
        </>
      )}
    </>
  );
}

interface FileDriveMenuProps {
  Item: DriveMenuItemComponent;
  Separator: DriveMenuSeparatorComponent;
  node: FileNode;
  onClick: () => void;
  onDownload?: (node: FileNode) => void;
  onHistory?: (node: FileNode) => void;
  onCopy?: (node: FileNode) => void;
  onCut?: (node: FileNode) => void;
  onRename?: (node: FileNode, newName: string) => void;
  onDelete?: (node: FileNode) => void;
  startRenaming: () => void;
  checkpointHistoryLabel: string;
  copyPathLabel: string;
}

export function FileDriveMenuItems({
  Item,
  Separator,
  node,
  onClick,
  onDownload,
  onHistory,
  onCopy,
  onCut,
  onRename,
  onDelete,
  startRenaming,
  checkpointHistoryLabel,
  copyPathLabel,
}: FileDriveMenuProps) {
  const hasEditActions = Boolean(onRename || onDelete);

  return (
    <>
      <Item onClick={onClick}>
        <Eye />
        Preview
      </Item>
      {onDownload && (
        <Item onClick={() => onDownload(node)}>
          <Download />
          Download
        </Item>
      )}
      {onHistory && (
        <Item onClick={() => onHistory(node)}>
          <History />
          {checkpointHistoryLabel}
        </Item>
      )}
      <Separator />
      {onCopy && (
        <Item onClick={() => onCopy(node)}>
          <ClipboardCopy />
          Copy
        </Item>
      )}
      {onCut && (
        <Item onClick={() => onCut(node)}>
          <Scissors />
          Cut
        </Item>
      )}
      <Item onClick={() => navigator.clipboard.writeText(node.path)}>
        <Copy />
        {copyPathLabel}
      </Item>
      {hasEditActions && (
        <>
          <Separator />
          {onRename && (
            <Item onClick={() => setTimeout(startRenaming, 100)}>
              <Pencil />
              Rename
            </Item>
          )}
          {onDelete && (
            <Item onClick={() => onDelete(node)}>
              <TrashSolid />
              Remove
            </Item>
          )}
        </>
      )}
    </>
  );
}

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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameName, setRenameName] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

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

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragOver(false);
      const sourcePath = e.dataTransfer.getData(DRAG_MIME);
      if (!sourcePath || sourcePath === node.path || node.path.startsWith(sourcePath + '/')) return;
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
    if (trimmed && trimmed !== node.name) {
      onRename?.(node, trimmed);
    }
    setIsRenaming(false);
  }, [renameName, node, onRename]);

  const openFolderLabel = tHardcodedUi.raw(
    'featuresProjectFilesComponentsDriveGridView.line209JsxTextOpenFolder',
  );
  const copyPathLabel = tHardcodedUi.raw(
    'featuresProjectFilesComponentsDriveGridView.line231JsxTextCopyPath',
  );
  const folderMenuProps = {
    node,
    onClick,
    onDownload,
    onCopy,
    onCut,
    onRename,
    onDelete,
    startRenaming,
    isDownloadingItem,
    openFolderLabel,
    copyPathLabel,
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          draggable={!isRenaming}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={isRenaming ? undefined : onClick}
          className={cn(
            'group border-border bg-popover hover:bg-foreground/4 flex h-11 cursor-pointer items-center gap-2.5 rounded-md border px-3 transition-colors select-none',
            isCut && 'opacity-40',
            isDragging && 'opacity-30',
            isDragOver && 'bg-primary/[0.08] border-primary/40',
          )}
        >
          <Folder className="text-muted-foreground size-4 shrink-0" />
          <div className="flex h-full min-w-0 flex-1 items-center">
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
                className="border-primary/50 w-full border-b bg-transparent py-0.5 text-sm outline-none"
              />
            ) : (
              <span className="text-foreground truncate text-sm font-medium">{node.name}</span>
            )}
          </div>
          {!isRenaming && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  onClick={(e) => e.stopPropagation()}
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 opacity-0 group-hover:opacity-100"
                >
                  <MoreVertical className="text-muted-foreground size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <FolderDriveMenuItems
                  Item={DropdownMenuItem}
                  Separator={DropdownMenuSeparator}
                  {...folderMenuProps}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <FolderDriveMenuItems
          Item={ContextMenuItem}
          Separator={ContextMenuSeparator}
          {...folderMenuProps}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

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
  isCut,
}: DriveGridItemProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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

  const copyPathLabel = tHardcodedUi.raw(
    'featuresProjectFilesComponentsDriveGridView.line420JsxTextCopyPath',
  );
  const checkpointHistoryLabel = tHardcodedUi.raw(
    'featuresProjectFilesComponentsDriveGridView.line402JsxTextCheckpointHistory',
  );
  const fileMenuProps = {
    node,
    onClick,
    onDownload,
    onHistory,
    onCopy,
    onCut,
    onRename,
    onDelete,
    startRenaming,
    checkpointHistoryLabel,
    copyPathLabel,
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          draggable={!isRenaming}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onClick={isRenaming ? undefined : onClick}
          onDoubleClick={isRenaming ? undefined : onDoubleClick}
          className={cn(
            'group border-border bg-popover hover:bg-foreground/4 relative flex cursor-pointer flex-col overflow-hidden rounded-md border select-none',
            isCut && 'opacity-40',
            isDragging && 'opacity-30',
          )}
        >
          <FileThumbnail filePath={node.path} fileName={node.name} className="h-[120px]" />

          {!isRenaming && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  onClick={(e) => e.stopPropagation()}
                  variant="secondary"
                  size="icon-sm"
                  className="absolute top-3 right-3"
                >
                  <MoreVertical className="text-muted-foreground size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <FileDriveMenuItems
                  Item={DropdownMenuItem}
                  Separator={DropdownMenuSeparator}
                  {...fileMenuProps}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <div className="border-border/40 bg-background flex items-center border-t px-3 py-2.5">
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
                className="border-primary/50 w-full border-b bg-transparent py-0.5 text-sm outline-none"
              />
            ) : (
              <div className="flex w-full min-w-0 items-center gap-1.5">
                {getFileIcon(node.name, {
                  className: 'size-3.5 shrink-0 text-muted-foreground',
                  variant: 'monochrome',
                })}
                <span className="text-foreground truncate text-sm font-medium">{node.name}</span>
              </div>
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <FileDriveMenuItems
          Item={ContextMenuItem}
          Separator={ContextMenuSeparator}
          {...fileMenuProps}
        />
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
  gitStatusMap: Map<string, GitStatusType>;
  clipboardPath?: string;
  clipboardOperation?: string;
  isDirDownloading: (path: string) => boolean;
  /** Hide mutation context-menu entries (delete/rename/cut/copy/history). */
  readOnly?: boolean;
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
  onRename: rawOnRename,
  onDelete: rawOnDelete,
  onHistory: rawOnHistory,
  onCopy: rawOnCopy,
  onCut: rawOnCut,
  onDropMove: rawOnDropMove,
  gitStatusMap,
  clipboardPath,
  clipboardOperation,
  isDirDownloading,
  readOnly = false,
}: DriveGridViewProps) {
  const onRename = readOnly ? undefined : rawOnRename;
  const onDelete = readOnly ? undefined : rawOnDelete;
  const onHistory = rawOnHistory;
  const onCopy = readOnly ? undefined : rawOnCopy;
  const onCut = readOnly ? undefined : rawOnCut;
  const onDropMove = readOnly ? undefined : rawOnDropMove;
  return (
    <div className="space-y-7 p-5">
      {elevatedDirs.length > 0 && (
        <section className="space-y-2">
          <SectionHeader label="System" count={elevatedDirs.length} />
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
          >
            {elevatedDirs.map((node) => {
              const meta = ELEVATED_DIR_META[node.name];
              const DirIcon = meta?.icon ?? FolderCog;
              return (
                <div
                  key={node.path}
                  onClick={() => onNavigateToDir(node)}
                  title={meta?.description}
                  className={cn(
                    'group border-border bg-popover hover:bg-foreground/4 flex h-11 cursor-pointer items-center gap-2.5 rounded-md border px-3 select-none',
                  )}
                >
                  <DirIcon className="text-muted-foreground size-4 shrink-0" />
                  <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                    {node.name}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {dirs.length > 0 && (
        <section className="space-y-2">
          <SectionHeader label="Folders" count={dirs.length} />
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
          >
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
        </section>
      )}

      {files.length > 0 && (
        <section className="space-y-2">
          <SectionHeader label="Files" count={files.length} />
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
          >
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
                gitStatus={gitStatusMap.get(node.path)}
                isCut={clipboardOperation === 'cut' && clipboardPath === node.path}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SectionHeader({
  label,
  count,
  icon,
}: {
  label: string;
  count: number;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex w-fit items-center justify-between gap-2 px-1">
      <Label className="text-foreground/90 flex items-center gap-2 text-sm font-medium">
        {icon}
        {label}
      </Label>
      <span className="text-muted-foreground text-[12px] tabular-nums">{count}</span>
    </div>
  );
}

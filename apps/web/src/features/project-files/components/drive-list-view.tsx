'use client';

import { Badge } from '@/components/ui/badge';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { chalkColors } from '@kortix/shared';
import { ArrowDown, ArrowUp, Folder, FolderCog, MoreVertical } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';
import { useFilesStore, type SortField } from '../store/files-store';
import type { FileNode } from '../types';
import { FileDriveMenuItems, FolderDriveMenuItems } from './drive-grid-view';
import { getFileIcon } from './file-icon';
import type { GitStatusType } from './file-tree-item';
import { DRAG_MIME } from './file-tree-item';

const ELEVATED_DIR_META: Record<string, string> = {
  '.kortix': 'Project config, tasks, context',
  '.opencode': 'Agents, skills, commands',
};

function ChalkBadge({ label }: { label: string }) {
  const chalk = chalkColors(label);

  return (
    <Badge
      variant="transparent"
      size="xs"
      className="border font-semibold tracking-wider uppercase backdrop-blur-sm"
      style={{
        backgroundColor: chalk.background,
        color: chalk.foreground,
        borderColor: chalk.border,
      }}
    >
      {label}
    </Badge>
  );
}
interface ListRowProps {
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

function ListRow({
  node,
  onClick,
  onDoubleClick,
  onDownload,
  onRename,
  onDelete,
  onHistory,
  onCopy,
  onCut,
  onDropMove,
  isDownloadingItem,
  isCut,
}: ListRowProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameName, setRenameName] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const isDir = node.type === 'directory';

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
      onDropMove?.(sourcePath, node.path);
    },
    [isDir, node.path, onDropMove],
  );

  const startRenaming = useCallback(() => {
    setRenameName(node.name);
    setIsRenaming(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = renameInputRef.current;
        if (el) {
          el.focus();
          if (isDir) {
            el.setSelectionRange(0, el.value.length);
          } else {
            const dotIdx = el.value.lastIndexOf('.');
            el.setSelectionRange(0, dotIdx > 0 ? dotIdx : el.value.length);
          }
        }
      });
    });
  }, [node.name, isDir]);

  const confirmRename = useCallback(() => {
    const trimmed = renameName.trim();
    if (trimmed && trimmed !== node.name) {
      onRename?.(node, trimmed);
    }
    setIsRenaming(false);
  }, [renameName, node, onRename]);

  const extLower =
    !isDir && node.name.includes('.') ? node.name.split('.').pop()?.toLowerCase() || '' : '';
  const ext = extLower ? extLower.toUpperCase() : '';

  const openFolderLabel = tHardcodedUi.raw(
    'featuresProjectFilesComponentsDriveGridView.line209JsxTextOpenFolder',
  );
  const copyPathLabel = tHardcodedUi.raw(
    'featuresProjectFilesComponentsDriveGridView.line231JsxTextCopyPath',
  );
  const checkpointHistoryLabel = tHardcodedUi.raw(
    'featuresProjectFilesComponentsDriveGridView.line402JsxTextCheckpointHistory',
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
        <TableRow
          draggable={!isRenaming}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={isRenaming ? undefined : onClick}
          onDoubleClick={isRenaming ? undefined : onDoubleClick}
          className={cn(
            'group cursor-pointer select-none',
            isCut && 'opacity-40',
            isDragging && 'opacity-30',
            isDragOver && 'bg-primary/8',
          )}
        >
          <TableCell>
            <div className="flex min-w-0 items-center gap-2.5">
              {isDir ? (
                <Folder className="text-muted-foreground size-4 shrink-0" />
              ) : (
                getFileIcon(node.name, {
                  className: 'size-4 shrink-0 text-muted-foreground',
                  variant: 'monochrome',
                })
              )}
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
                  className="border-border min-w-0 flex-1 border-b bg-transparent py-0.5 text-sm outline-none"
                />
              ) : (
                <span
                  className={cn(
                    'truncate text-sm font-medium',
                    node.ignored && 'opacity-50',
                    node.name.startsWith('.') && 'text-muted-foreground',
                  )}
                >
                  {node.name}
                </span>
              )}
            </div>
          </TableCell>
          <TableCell>
            {isDir ? (
              <ChalkBadge label="Folder" />
            ) : ext ? (
              <ChalkBadge label={ext} />
            ) : (
              <span className="text-muted-foreground text-sm">—</span>
            )}
          </TableCell>
          <TableCell className="text-muted-foreground text-sm">—</TableCell>
          <TableCell>
            {!isRenaming && (
              <div className="flex justify-end">
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
                    {isDir ? (
                      <FolderDriveMenuItems
                        Item={DropdownMenuItem}
                        Separator={DropdownMenuSeparator}
                        {...folderMenuProps}
                      />
                    ) : (
                      <FileDriveMenuItems
                        Item={DropdownMenuItem}
                        Separator={DropdownMenuSeparator}
                        {...fileMenuProps}
                      />
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </TableCell>
        </TableRow>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {isDir ? (
          <FolderDriveMenuItems
            Item={ContextMenuItem}
            Separator={ContextMenuSeparator}
            {...folderMenuProps}
          />
        ) : (
          <FileDriveMenuItems
            Item={ContextMenuItem}
            Separator={ContextMenuSeparator}
            {...fileMenuProps}
          />
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ElevatedDirRow({ node, onNavigate }: { node: FileNode; onNavigate: () => void }) {
  return (
    <TableRow onClick={onNavigate} className="cursor-pointer select-none">
      <TableCell>
        <div className="flex min-w-0 items-center gap-2.5">
          <FolderCog className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate text-sm font-medium">{node.name}</span>
          {ELEVATED_DIR_META[node.name] && (
            <span className="text-muted-foreground hidden truncate text-xs sm:inline">
              {ELEVATED_DIR_META[node.name]}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <ChalkBadge label="System" />
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">—</TableCell>
      <TableCell />
    </TableRow>
  );
}

interface DriveListViewProps {
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
  readOnly?: boolean;
}

export function DriveListView({
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
}: DriveListViewProps) {
  const onRename = readOnly ? undefined : rawOnRename;
  const onDelete = readOnly ? undefined : rawOnDelete;
  const onHistory = rawOnHistory;
  const onCopy = readOnly ? undefined : rawOnCopy;
  const onCut = readOnly ? undefined : rawOnCut;
  const onDropMove = readOnly ? undefined : rawOnDropMove;
  const sortBy = useFilesStore((s) => s.sortBy);
  const sortOrder = useFilesStore((s) => s.sortOrder);
  const setSortBy = useFilesStore((s) => s.setSortBy);
  const toggleSortOrder = useFilesStore((s) => s.toggleSortOrder);

  const handleHeaderClick = (field: SortField) => {
    if (sortBy === field) {
      toggleSortOrder();
    } else {
      setSortBy(field);
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortBy !== field) return null;
    return sortOrder === 'asc' ? (
      <ArrowUp className="ml-1 size-3" />
    ) : (
      <ArrowDown className="ml-1 size-3" />
    );
  };

  return (
    <div className="space-y-7 p-5">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>
              <Button
                onClick={() => handleHeaderClick('name')}
                variant="transparent"
                className="text-muted-foreground hover:text-foreground m-0 h-fit w-fit p-0 font-normal has-[>svg]:p-0"
              >
                Name
                <SortIcon field="name" />
              </Button>
            </TableHead>
            <TableHead>
              <Button
                onClick={() => handleHeaderClick('type')}
                variant="transparent"
                className="text-muted-foreground hover:text-foreground m-0 h-fit w-fit p-0 font-normal has-[>svg]:p-0"
              >
                Type
                <SortIcon field="type" />
              </Button>
            </TableHead>
            <TableHead>
              <Button
                onClick={() => handleHeaderClick('size')}
                variant="transparent"
                className="text-muted-foreground hover:text-foreground m-0 h-fit w-fit p-0 font-normal has-[>svg]:p-0"
              >
                Size
                <SortIcon field="size" />
              </Button>
            </TableHead>
            <TableHead className="w-[52px]">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {elevatedDirs.map((node) => (
            <ElevatedDirRow key={node.path} node={node} onNavigate={() => onNavigateToDir(node)} />
          ))}

          {dirs.map((node) => (
            <ListRow
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

          {files.map((node) => (
            <ListRow
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
        </TableBody>
      </Table>
    </div>
  );
}

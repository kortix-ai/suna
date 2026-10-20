'use client';

import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import type { DroppedEntry } from '../drop-tree';
import { useItemSelection } from './drive-selection';
import { SelectionCheck, SelectMenuItem } from './drive-selection-ui';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../../primitives/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../primitives/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../primitives/table';
import type { GitStatusType } from '../../tree/components/file-tree-item';
import { useFilesStore, type SortField } from '../../../internal/stores/files-store';
import type { FileNode } from '../../../internal/files/types';
import { cn } from '../../../lib/utils';
import Loading from '../../../primitives/loading';
import { chalkColors } from '@kortix/shared';
import {
  ArrowDownIcon as ArrowDown,
  ArrowUpIcon as ArrowUp,
  FolderIcon as Folder,
  FolderIcon as FolderCog,
  DotsThreeVerticalIcon as MoreVertical,
} from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { useDriveRowInteractions } from './use-drive-row-interactions';
import { FileDriveMenuItems, FolderDriveMenuItems } from './drive-grid-view';
import { getFileIcon } from './file-icon';
import { ownClicks } from './own-clicks';

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
      className="border font-semibold backdrop-blur-sm"
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
  /** External files dropped onto THIS folder row. Absent = read-only source. */
  onDropUpload?: (files: File[], targetDirPath: string, entries?: DroppedEntry[]) => void;
  isDownloadingItem?: boolean;
  gitStatus?: GitStatusType;
  isCut?: boolean;
  /** On the clipboard as a copy (a cut is `isCut`): both wear the focus ring. */
  isCopied?: boolean;
  /** Still on its way up: a spinner after the name until the server has it. */
  uploading?: boolean;
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
  onDropUpload,
  isDownloadingItem,
  isCut,
  isCopied,
  uploading,
}: ListRowProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tDrives = useTranslations('drives');
  const isDir = node.type === 'directory';
  const {
    isDragOver, isDragging, isRenaming, setIsRenaming, renameName, setRenameName,
    renameInputRef, handleDragStart, handleDragEnd, handleDragOver, handleDragEnter,
    handleDragLeave, handleDrop, startRenaming, confirmRename,
  } = useDriveRowInteractions({
    node, onRename, onDropMove, onDropUpload,
    selectRenameInput: (el) => {
      el.focus();
      if (isDir) {
        el.setSelectionRange(0, el.value.length);
      } else {
        const dotIdx = el.value.lastIndexOf('.');
        el.setSelectionRange(0, dotIdx > 0 ? dotIdx : el.value.length);
      }
    },
  });

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

  const { selection, selected, selectMode, onClick: onItemClick } = useItemSelection(node, onClick);
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
          onClick={isRenaming ? undefined : onItemClick}
          data-drive-item={node.path}
          onDoubleClick={isRenaming ? undefined : ownClicks(onDoubleClick)}
          className={cn(
            'group cursor-pointer select-none',
            isCut && 'opacity-60',
            // Copied, cut or selected: the focus border drawn inside the row (a
            // table row takes no border), its soft 15% as the row's fill.
            (isCut || isCopied || selected) && 'ring-ring bg-ring/15 ring-1 ring-inset',
            isDragging && 'opacity-30',
            isDragOver && 'bg-primary/8',
          )}
        >
          <TableCell>
            <div className="flex min-w-0 items-center gap-2.5">
              {selectMode ? <SelectionCheck selected={selected} className="shrink-0" /> : null}
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
                    if (e.key === 'Enter') {
                      if (e.nativeEvent.isComposing) return;
                      confirmRename();
                    }
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
              {uploading ? (
                <span role="status" aria-label={tDrives('uploadingFile', { name: node.name })} className="shrink-0">
                  <Loading variant="spokes" className="size-3.5" />
                </span>
              ) : null}
            </div>
          </TableCell>
          <TableCell>
            {isDir ? (
              <ChalkBadge label={tHardcodedUi.raw('i18nComplete.text74ccd4330384')} />
            ) : ext ? (
              <ChalkBadge label={ext} />
            ) : (
              <span className="text-muted-foreground text-sm">—</span>
            )}
          </TableCell>
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
        {selection?.selectionMenu(node, ContextMenuItem, ContextMenuSeparator) ?? (
        <>
        <SelectMenuItem selection={selection} node={node} Item={ContextMenuItem} Separator={ContextMenuSeparator} />
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
        </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ElevatedDirRow({ node, onNavigate }: { node: FileNode; onNavigate: () => void }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
        <ChalkBadge label={tI18nComplete.raw('text6725e7bbcd28')} />
      </TableCell>
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
  /** External files dropped onto a folder row upload into THAT folder. */
  onDropUpload?: (files: File[], targetDirPath: string, entries?: DroppedEntry[]) => void;
  gitStatusMap: Map<string, GitStatusType>;
  clipboardPath?: string;
  clipboardOperation?: string;
  isDirDownloading: (path: string) => boolean;
  readOnly?: boolean;
  /** Paths still uploading. */
  uploadingPaths?: ReadonlySet<string>;
  /**
   * The rows keep the server's name order (a partly loaded folder): the
   * column headers do not sort and show no arrow.
   */
  sortDisabled?: boolean;
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
  onDropUpload: rawOnDropUpload,
  gitStatusMap,
  clipboardPath,
  clipboardOperation,
  isDirDownloading,
  readOnly = false,
  uploadingPaths,
  sortDisabled = false,
}: DriveListViewProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const onRename = readOnly ? undefined : rawOnRename;
  const onDelete = readOnly ? undefined : rawOnDelete;
  const onHistory = rawOnHistory;
  const onCopy = readOnly ? undefined : rawOnCopy;
  const onCut = readOnly ? undefined : rawOnCut;
  const onDropMove = readOnly ? undefined : rawOnDropMove;
  const onDropUpload = readOnly ? undefined : rawOnDropUpload;
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
    if (sortDisabled || sortBy !== field) return null;
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
                disabled={sortDisabled}
                variant="transparent"
                className="text-muted-foreground hover:text-foreground m-0 h-fit w-fit p-0 font-normal has-[>svg]:p-0"
              >
                {tI18nComplete.raw('textdcd1d5223f73')}
                <SortIcon field="name" />
              </Button>
            </TableHead>
            <TableHead>
              <Button
                onClick={() => handleHeaderClick('type')}
                disabled={sortDisabled}
                variant="transparent"
                className="text-muted-foreground hover:text-foreground m-0 h-fit w-fit p-0 font-normal has-[>svg]:p-0"
              >
                {tI18nComplete.raw('textbaaddf70fb5d')}
                <SortIcon field="type" />
              </Button>
            </TableHead>
            <TableHead className="w-[52px]">
              <span className="sr-only">{tI18nComplete.raw('textff8059dc6752')}</span>
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
              onDropUpload={onDropUpload}
              isCut={clipboardOperation === 'cut' && clipboardPath === node.path}
              isCopied={clipboardOperation === 'copy' && clipboardPath === node.path}
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
              isCopied={clipboardOperation === 'copy' && clipboardPath === node.path}
              uploading={uploadingPaths?.has(node.path)}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

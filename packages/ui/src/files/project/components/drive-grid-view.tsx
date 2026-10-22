'use client';

import { Button } from '../../../primitives/button';
import type { DroppedEntry } from '../drop-tree';
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
import { Label } from '../../../primitives/label';
import type { GitStatusType } from '../../tree/components/file-tree-item';
import type { FileNode } from '../../../internal/files/types';
import { cn } from '../../../lib/utils';
import Loading from '../../../primitives/loading';
import { Copy } from '../../../icons/copy';
import {
  ArrowUpRightIcon as ArrowUpRight,
  ClipboardIcon as ClipboardCopy,
  EyeIcon as Eye,
  ClockCounterClockwiseIcon as History,
  DotsThreeIcon as MoreVertical,
  PencilSimpleIcon,
  ScissorsIcon as Scissors,
  TrashIcon,
} from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { type ComponentType, memo, type ReactNode } from 'react';
import { useDriveRowInteractions } from './use-drive-row-interactions';
import { DriveFolderThumbnail } from './drive-folder-thumbnail';
import { useItemSelection } from './drive-selection';
import { SelectionCheck, SelectMenuItem } from './drive-selection-ui';
import { FileThumbnail } from './file-thumbnail';
import { Download } from '../../../internal/icons/download';
import { ownClicks } from './own-clicks';

interface DriveGridItemProps {
  node: FileNode;
  // Take the node, so one stable handler serves every card and `memo` holds.
  onClick: (node: FileNode) => void;
  onDoubleClick?: (node: FileNode) => void;
  onDownload?: (node: FileNode) => void;
  onRename?: (node: FileNode, newName: string) => void;
  onDelete?: (node: FileNode) => void;
  onHistory?: (node: FileNode) => void;
  onCopy?: (node: FileNode) => void;
  onCut?: (node: FileNode) => void;
  onDropMove?: (sourcePath: string, targetDirPath: string) => void;
  /** External files dropped onto THIS folder card. Absent = read-only source. */
  onDropUpload?: (files: File[], targetDirPath: string, entries?: DroppedEntry[]) => void;
  isDownloadingItem?: boolean;
  gitStatus?: GitStatusType;
  isCut?: boolean;
  /** On the clipboard as a copy (a cut is `isCut`): both wear the focus ring. */
  isCopied?: boolean;
  /** Still on its way up: the card shows a spinner until the server has it. */
  uploading?: boolean;
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

/** Copy, cut, copy path, rename and delete: the same on a folder and a file. */
function DriveMenuSharedItems({
  Item,
  Separator,
  node,
  onCopy,
  onCut,
  onRename,
  onDelete,
  startRenaming,
  copyPathLabel,
}: Pick<
  FolderDriveMenuProps,
  | 'Item'
  | 'Separator'
  | 'node'
  | 'onCopy'
  | 'onCut'
  | 'onRename'
  | 'onDelete'
  | 'startRenaming'
  | 'copyPathLabel'
>) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const hasEditActions = Boolean(onRename || onDelete);

  return (
    <>
      {onCopy && (
        <Item onClick={() => onCopy(node)}>
          <ClipboardCopy />
          {tI18nComplete.raw('texte21f935f11d7')}
        </Item>
      )}
      {onCut && (
        <Item onClick={() => onCut(node)}>
          <Scissors />
          {tI18nComplete.raw('text1f45f02561f4')}
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
              <PencilSimpleIcon />
              {tI18nComplete.raw('text3064d79a295c')}
            </Item>
          )}
          {onDelete && (
            <Item onClick={() => onDelete(node)}>
              <TrashIcon />
              {tI18nComplete.raw('textc3812fc4acb8')}
            </Item>
          )}
        </>
      )}
    </>
  );
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');

  return (
    <>
      <Item onClick={onClick}>
        <ArrowUpRight />
        {openFolderLabel}
      </Item>
      {onDownload && (
        <Item onClick={() => onDownload(node)} disabled={isDownloadingItem}>
          <Download />
          {isDownloadingItem ? 'Zipping...' : tI18nComplete.raw('textdda839b13617')}
        </Item>
      )}
      <Separator />
      <DriveMenuSharedItems
        Item={Item}
        Separator={Separator}
        node={node}
        onCopy={onCopy}
        onCut={onCut}
        onRename={onRename}
        onDelete={onDelete}
        startRenaming={startRenaming}
        copyPathLabel={copyPathLabel}
      />
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');

  return (
    <>
      <Item onClick={onClick}>
        <Eye />
        {tI18nComplete.raw('text324b134f57c7')}
      </Item>
      {onDownload && (
        <Item onClick={() => onDownload(node)}>
          <Download />
          {tI18nComplete.raw('textd6eafe823591')}
        </Item>
      )}
      {onHistory && (
        <Item onClick={() => onHistory(node)}>
          <History />
          {checkpointHistoryLabel}
        </Item>
      )}
      <Separator />
      <DriveMenuSharedItems
        Item={Item}
        Separator={Separator}
        node={node}
        onCopy={onCopy}
        onCut={onCut}
        onRename={onRename}
        onDelete={onDelete}
        startRenaming={startRenaming}
        copyPathLabel={copyPathLabel}
      />
    </>
  );
}

function selectFolderRenameInput(el: HTMLInputElement) {
  el.focus();
  el.select();
}

function selectFileRenameInput(el: HTMLInputElement) {
  el.focus();
  const dotIdx = el.value.lastIndexOf('.');
  el.setSelectionRange(0, dotIdx > 0 ? dotIdx : el.value.length);
}

const FolderCard = memo(function FolderCard({
  node,
  onClick,
  onDownload,
  onRename,
  onDelete,
  onCopy,
  onCut,
  onDropMove,
  onDropUpload,
  isDownloadingItem,
  isCut,
  isCopied,
}: DriveGridItemProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const {
    isDragOver, isDragging, isRenaming, setIsRenaming, renameName, setRenameName,
    renameInputRef, handleDragStart, handleDragEnd, handleDragOver, handleDragEnter,
    handleDragLeave, handleDrop, startRenaming, confirmRename,
  } = useDriveRowInteractions({
    node, onRename, onDropMove, onDropUpload, selectRenameInput: selectFolderRenameInput,
  });

  const openFolderLabel = tHardcodedUi.raw(
    'featuresProjectFilesComponentsDriveGridView.line209JsxTextOpenFolder',
  );
  const copyPathLabel = tHardcodedUi.raw(
    'featuresProjectFilesComponentsDriveGridView.line231JsxTextCopyPath',
  );
  const open = () => onClick(node);
  const { selection, selected, selectMode, onClick: onItemClick } = useItemSelection(node, open);
  const folderMenuProps = {
    node,
    onClick: open,
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
          onClick={isRenaming ? undefined : onItemClick}
          data-drive-item={node.path}
          className={cn(
            'group relative flex cursor-pointer flex-col gap-2 select-none',
            isCut && 'opacity-60',
            isDragging && 'opacity-30',
          )}
        >
          <DriveFolderThumbnail
            path={node.path}
            className={cn(
              // Transparent at rest, so the marked border takes no space when it appears.
              'h-[120px] border border-transparent',
              // Copied, cut or selected: the focus border plus its soft 15% ring.
              (isCut || isCopied || selected) && 'border-ring ring-ring/15 ring-2',
              isDragOver && 'ring-primary ring-2',
            )}
          />
          {selectMode ? <SelectionCheck selected={selected} className="absolute top-2 left-2" /> : null}

          {!isRenaming && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  onClick={(e) => e.stopPropagation()}
                  aria-label={tHardcodedUi.raw('i18nComplete.textf8d46c2570e7')}
                  variant="secondary"
                  size="icon-sm"
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreVertical weight="bold" className="size-3.5" />
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

          <div className="flex min-w-0 items-center px-0.5">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                type="text"
                aria-label={tHardcodedUi.raw('i18nComplete.text3064d79a295c')}
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
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
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {selection?.selectionMenu(node, ContextMenuItem, ContextMenuSeparator) ?? (
          <>
            <SelectMenuItem selection={selection} node={node} Item={ContextMenuItem} Separator={ContextMenuSeparator} />
            <FolderDriveMenuItems
              Item={ContextMenuItem}
              Separator={ContextMenuSeparator}
              {...folderMenuProps}
            />
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

const FileCard = memo(function FileCard({
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
  isCopied,
  uploading,
}: DriveGridItemProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tDrives = useTranslations('drives');
  const {
    isDragging, isRenaming, setIsRenaming, renameName, setRenameName,
    renameInputRef, handleDragStart, handleDragEnd, startRenaming, confirmRename,
  } = useDriveRowInteractions({
    node, onRename, selectRenameInput: selectFileRenameInput,
  });

  const copyPathLabel = tHardcodedUi.raw(
    'featuresProjectFilesComponentsDriveGridView.line420JsxTextCopyPath',
  );
  const checkpointHistoryLabel = tHardcodedUi.raw(
    'featuresProjectFilesComponentsDriveGridView.line402JsxTextCheckpointHistory',
  );
  const open = () => onClick(node);
  const { selection, selected, selectMode, onClick: onItemClick } = useItemSelection(node, open);
  const fileMenuProps = {
    node,
    onClick: open,
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
          onClick={isRenaming ? undefined : onItemClick}
          data-drive-item={node.path}
          onDoubleClick={isRenaming || !onDoubleClick ? undefined : ownClicks(() => onDoubleClick(node))}
          className={cn(
            'group relative flex cursor-pointer flex-col gap-2 select-none',
            isCut && 'opacity-60',
            isDragging && 'opacity-30',
          )}
        >
          <FileThumbnail
            filePath={node.path}
            fileName={node.name}
            onOpen={open}
            className={cn(
              'border-border h-[120px] rounded-lg border',
              // Copied, cut or selected: the focus border plus its soft 15% ring.
              (isCut || isCopied || selected) && 'border-ring ring-ring/15 ring-2',
            )}
          />
          {selectMode && !uploading ? (
            <SelectionCheck selected={selected} className="absolute top-2 left-2 z-10" />
          ) : null}
          {uploading ? (
            <span
              role="status"
              aria-label={tDrives('uploadingFile', { name: node.name })}
              className="bg-popover border-border absolute top-2 left-2 z-10 flex size-7 items-center justify-center rounded-md border shadow-xs"
            >
              <Loading variant="spokes" className="size-4" />
            </span>
          ) : null}

          {!isRenaming && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  onClick={(e) => e.stopPropagation()}
                  aria-label={tHardcodedUi.raw('i18nComplete.textf8d46c2570e7')}
                  variant="secondary"
                  size="icon-sm"
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreVertical weight="bold" className="size-3.5" />
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

          <div className="flex min-w-0 items-center px-0.5">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                type="text"
                aria-label={tHardcodedUi.raw('i18nComplete.text3064d79a295c')}
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
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
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {selection?.selectionMenu(node, ContextMenuItem, ContextMenuSeparator) ?? (
          <>
            <SelectMenuItem selection={selection} node={node} Item={ContextMenuItem} Separator={ContextMenuSeparator} />
            <FileDriveMenuItems
              Item={ContextMenuItem}
              Separator={ContextMenuSeparator}
              {...fileMenuProps}
            />
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

// ─── Main Grid View ─────────────────────────────────────────────────────────

/** Descriptions for elevated system directories */
const ELEVATED_DIR_META: Record<string, { description: string }> = {
  '.kortix': { description: 'Project config, tasks, context' },
  '.opencode': { description: 'Agents, skills, commands' },
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
  /** External files dropped onto a folder card upload into THAT folder. */
  onDropUpload?: (files: File[], targetDirPath: string, entries?: DroppedEntry[]) => void;
  gitStatusMap: Map<string, GitStatusType>;
  clipboardPath?: string;
  clipboardOperation?: string;
  isDirDownloading: (path: string) => boolean;
  /** Hide mutation context-menu entries (delete/rename/cut/copy/history). */
  readOnly?: boolean;
  /** Folders that cannot be renamed, cut or deleted (see `ExplorerCapabilities.fixedAt`). */
  isFixed?: (path: string) => boolean;
  /** Paths still uploading. */
  uploadingPaths?: ReadonlySet<string>;
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
  onDropUpload: rawOnDropUpload,
  gitStatusMap,
  clipboardPath,
  clipboardOperation,
  isDirDownloading,
  readOnly = false,
  isFixed,
  uploadingPaths,
}: DriveGridViewProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const onRename = readOnly ? undefined : rawOnRename;
  const onDelete = readOnly ? undefined : rawOnDelete;
  const onHistory = rawOnHistory;
  const onCopy = readOnly ? undefined : rawOnCopy;
  const onCut = readOnly ? undefined : rawOnCut;
  const onDropMove = readOnly ? undefined : rawOnDropMove;
  const onDropUpload = readOnly ? undefined : rawOnDropUpload;
  return (
    <div className="space-y-7 p-5">
      {elevatedDirs.length > 0 && (
        <section className="space-y-2">
          <SectionHeader
            label={tI18nComplete.raw('text6725e7bbcd28')}
            count={elevatedDirs.length}
          />
          <div
            className="grid gap-x-4 gap-y-5"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))" }}
          >
            {elevatedDirs.map((node) => {
              const meta = ELEVATED_DIR_META[node.name];
              const description = meta
                ? tI18nComplete.raw(
                    node.name === '.kortix' ? 'text85231c543c71' : 'text96ef9c0ac0c9',
                  )
                : undefined;
              return (
                <button
                  type="button"
                  key={node.path}
                  onClick={() => onNavigateToDir(node)}
                  title={description}
                  className="group relative flex w-full min-w-0 cursor-pointer flex-col gap-2 text-left select-none"
                >
                  <DriveFolderThumbnail
                    path={node.path}
                    className="h-[120px]"
                  />
                  <span className="text-foreground truncate px-0.5 text-sm font-medium">
                    {node.name}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {dirs.length > 0 && (
        <section className="space-y-2">
          <SectionHeader label={tI18nComplete.raw('textc4d6bb200f4c')} count={dirs.length} />
          <div
            className="grid gap-x-4 gap-y-5"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))" }}
          >
            {dirs.map((node) => (
              <FolderCard
                key={node.path}
                node={node}
                onClick={onNavigateToDir}
                onDownload={onDownloadDir}
                isDownloadingItem={isDirDownloading(node.path)}
                onRename={isFixed?.(node.path) ? undefined : onRename}
                onDelete={isFixed?.(node.path) ? undefined : onDelete}
                onCopy={onCopy}
                onCut={isFixed?.(node.path) ? undefined : onCut}
                onDropMove={onDropMove}
                onDropUpload={onDropUpload}
                isCut={clipboardOperation === 'cut' && clipboardPath === node.path}
                isCopied={clipboardOperation === 'copy' && clipboardPath === node.path}
              />
            ))}
          </div>
        </section>
      )}

      {files.length > 0 && (
        <section className="space-y-2">
          <SectionHeader label={tI18nComplete.raw('textabc7e9892806')} count={files.length} />
          <div
            className="grid gap-x-4 gap-y-5"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))" }}
          >
            {files.map((node) => (
              <FileCard
                key={node.path}
                node={node}
                onClick={onPreviewFile}
                onDoubleClick={onOpenFile}
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
      <Label className="text-foreground flex items-center gap-2 text-sm font-medium">
        {icon}
        {label}
      </Label>
      <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
    </div>
  );
}

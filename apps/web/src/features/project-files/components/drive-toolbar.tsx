'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import type {
  SortField,
  SortOrder,
  ViewMode,
} from '@/features/file-browser/store/files-store';
import { isWithinRoot, useFilesStore } from '@/features/file-browser/store/files-store';
import { cn } from '@/lib/utils';
import {
  CaretRightIcon as ChevronRight,
  DownloadIcon as Download,
  DotsThreeIcon as DotsThree,
  FilePlusIcon,
  FolderPlusIcon,
  SquaresFourIcon as LayoutGrid,
  ListIcon as ListSolid,
  PlusIcon,
  ArrowClockwiseIcon as RefreshCw,
  MagnifyingGlassIcon as Search,
  UploadSimpleIcon,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';

/**
 * The Drive chrome, split into three pieces a surface composes itself.
 *
 * There used to be one `DriveToolbar` that owned all of it — breadcrumbs plus
 * eight always-visible controls — and it sat under a SECOND full-width header
 * on both surfaces that render it. Thirteen controls on the Files page, ten in
 * a ~400px session panel, before a single file is visible.
 *
 * The split ranks by frequency instead:
 *   • {@link DrivePathBar}  — navigation. Constant, so it stays in flow.
 *   • {@link DriveNewMenu}  — creating things. Frequent, so it stays a button.
 *   • {@link DriveViewMenu} — sort / view mode / dotfiles / search / refresh /
 *     download. All rare, all one `⋯` away.
 *
 * Each host then needs ONE header row, not two.
 */

/**
 * The one action row every Drive surface draws. `h-11` is the capability tab
 * row's height (`capability-tabs.tsx`), so Files reads at the same rhythm as
 * every other project surface.
 */
export const DRIVE_ACTION_ROW_CLASS =
  'border-border/60 flex h-11 shrink-0 items-center gap-1 border-b px-2';

/* ------------------------------------------------------------------ *
 * Path bar
 * ------------------------------------------------------------------ */

interface DrivePathBarProps {
  /**
   * Word for the root crumb. The standalone page passes its own page title
   * ("Files") because the crumb chain IS that page's header — see
   * {@link DriveHeader}. In a session panel the root is the sandbox workspace.
   */
  rootLabel?: string;
  /**
   * `inline` sits in a row the host already draws (the standalone page's
   * header, where the crumb chain IS the title).
   *
   * `row` draws its own bordered strip AND renders nothing at the root: a
   * lone root crumb is a whole strip that repeats what the surface above it
   * already said. Session panels take that deal; the standalone page, whose
   * root crumb is its page title, does not.
   */
  as?: 'inline' | 'row';
  className?: string;
}

/**
 * Breadcrumbs for the current directory, and nothing else.
 *
 * Double-clicking swaps the chain for a raw path input — the one power
 * affordance kept from the old toolbar, because it costs no pixels.
 */
export function DrivePathBar({ rootLabel, as = 'inline', className }: DrivePathBarProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const rootPath = useFilesStore((s) => s.rootPath);

  const homePath = rootPath || '/workspace';
  const homeLabel =
    rootLabel ?? (rootPath ? rootPath.split('/').filter(Boolean).pop() || 'root' : 'workspace');

  // Outside the home root (e.g. /tmp) the crumbs render as an absolute chain
  // instead of pretending the path nests under /workspace
  const outsideHome = !rootPath && !isWithinRoot(currentPath, homePath);

  const isRoot = currentPath === '/' || currentPath === '.' || currentPath === '';
  const allSegments = useMemo(
    () => (isRoot ? [] : currentPath.split('/').filter(Boolean)),
    [isRoot, currentPath],
  );

  const rootSegments = useMemo(
    () => (rootPath ? rootPath.split('/').filter(Boolean) : []),
    [rootPath],
  );
  const segments = useMemo(
    () => (rootPath ? allSegments.slice(rootSegments.length) : allSegments),
    [rootPath, allSegments, rootSegments],
  );

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDoubleClick = useCallback(() => {
    setEditValue(currentPath === '/' ? '' : currentPath);
    setIsEditing(true);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [currentPath]);

  useEffect(() => {
    if (!isEditing) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (!(e.target instanceof HTMLInputElement)) {
        setIsEditing(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [isEditing]);

  const handleSegmentClick = useCallback(
    (index: number) => {
      const absoluteIndex = rootPath ? index + rootSegments.length : index;
      const pathToHere = '/' + allSegments.slice(0, absoluteIndex + 1).join('/');
      navigateToPath(pathToHere);
    },
    [allSegments, rootSegments, rootPath, navigateToPath],
  );

  // Everything after the (skipped) implicit `workspace` segment. Drives the
  // hide-at-root decision so a path of exactly `/workspace` counts as root.
  const visibleSegments = useMemo(
    () =>
      segments.filter(
        (segment, index) => !(!rootPath && !outsideHome && index === 0 && segment === 'workspace'),
      ),
    [segments, rootPath, outsideHome],
  );

  const isRow = as === 'row';
  if (isRow && !isEditing && visibleSegments.length === 0) return null;

  const rowClass = isRow
    ? 'border-border/60 h-9 w-full shrink-0 border-b px-2'
    : 'min-w-0 flex-1';

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (e.nativeEvent.isComposing) return;
            navigateToPath(editValue.trim() || homePath);
            setIsEditing(false);
          }
          if (e.key === 'Escape') setIsEditing(false);
        }}
        onBlur={() => setIsEditing(false)}
        className={cn(
          'bg-card focus:ring-primary/50 h-8 min-w-0 rounded-md border px-3 font-mono text-sm outline-none focus:ring-2',
          // In `row` mode the parent is a COLUMN, so `flex-1` would stretch the
          // input vertically instead of filling the row.
          isRow ? 'mx-2 my-0.5 w-auto shrink-0' : 'flex-1',
          className,
        )}
        placeholder={homePath}
      />
    );
  }

  return (
    <div
      className={cn('flex items-center gap-0.5', rowClass, className)}
      onDoubleClick={handleDoubleClick}
      title={tHardcodedUi.raw(
        'featuresProjectFilesComponentsDriveToolbar.line191JsxAttrTitleDoubleClickToEditPath',
      )}
    >
      <Button
        onClick={() => navigateToPath(homePath)}
        variant="ghost"
        size="xs"
        className="text-foreground shrink-0 text-sm font-medium"
      >
        {homeLabel}
      </Button>

      {segments.length > 0 && (
        <FadedScrollArea
          orientation="horizontal"
          fadeColor="from-background"
          className="min-w-0 flex-1 overscroll-x-contain"
        >
          <nav className="flex w-max min-w-0 items-center gap-0.5">
            {segments.map((segment, index) => {
              if (!rootPath && !outsideHome && index === 0 && segment === 'workspace') return null;
              const isLast = index === segments.length - 1;
              // First crumb of an outside-home path anchors the absolute chain
              const isAbsoluteAnchor = outsideHome && index === 0;
              const pathKey = segments.slice(0, index + 1).join('/');

              return (
                <div key={pathKey} className="flex shrink-0 items-center gap-0.5">
                  {isAbsoluteAnchor ? (
                    <span className="text-muted-foreground/40 shrink-0 px-1 text-sm select-none">
                      ·
                    </span>
                  ) : (
                    <ChevronRight className="text-muted-foreground/50 size-3.5 shrink-0" />
                  )}
                  <Button
                    onClick={() => handleSegmentClick(index)}
                    variant="ghost"
                    size="xs"
                    className={cn(
                      'max-w-[140px] shrink-0 truncate text-sm sm:max-w-[200px]',
                      isLast ? 'text-foreground font-medium' : 'text-muted-foreground',
                      isAbsoluteAnchor && 'font-mono',
                    )}
                  >
                    {isAbsoluteAnchor ? `/${segment}` : segment}
                  </Button>
                </div>
              );
            })}
          </nav>
        </FadedScrollArea>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Overflow menu
 * ------------------------------------------------------------------ */

/** Submenu trigger summaries — the current value, shown without opening. */
const VIEW_LABEL: Record<ViewMode, string> = { list: 'List', grid: 'Grid' };

/**
 * Covers all four `SortField`s so a value persisted in `localStorage` still
 * gets a label, but only `name` and `type` are OFFERED below: the comparators
 * for `size` and `modified` fall through to a name compare
 * (`file-explorer-page.tsx`, `drive-explorer.tsx`), so listing them would be a
 * control that silently does nothing.
 */
const SORT_LABEL: Record<SortField, string> = {
  name: 'Name',
  type: 'Type',
  size: 'Size',
  modified: 'Modified',
};

export interface DriveViewMenuProps {
  onDownloadDir: () => void;
  onRefresh: () => void;
  isRefreshing?: boolean;
  isDownloading?: boolean;
  /** Offer the Cmd+P file-name search overlay. */
  showSearch?: boolean;
  /** Offer the dotfile visibility toggle (list is pre-filtered by the hook). */
  showHiddenToggle?: boolean;
}

/**
 * Every rare Drive control behind one `⋯`: view mode, sort, dotfiles, search,
 * refresh, download. Each of these was its own always-visible button; together
 * they were most of the crowding on both surfaces, and none of them is reached
 * more than once a session.
 */
export function DriveViewMenu({
  onDownloadDir,
  onRefresh,
  isRefreshing,
  isDownloading,
  showSearch = false,
  showHiddenToggle = false,
}: DriveViewMenuProps) {
  const viewMode = useFilesStore((s) => s.viewMode);
  const setViewMode = useFilesStore((s) => s.setViewMode);
  const sortBy = useFilesStore((s) => s.sortBy);
  const sortOrder = useFilesStore((s) => s.sortOrder);
  const setSortBy = useFilesStore((s) => s.setSortBy);
  const setSortOrder = useFilesStore((s) => s.setSortOrder);
  const showHidden = useFilesStore((s) => s.showHidden);
  const toggleHidden = useFilesStore((s) => s.toggleHidden);
  const toggleSearch = useFilesStore((s) => s.toggleSearch);

  return (
    <DropdownMenu>
      <Hint label="View options" side="bottom">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="View options"
            className="text-muted-foreground hover:text-foreground active:scale-[0.96]"
          >
            <DotsThree className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-56">
        {/* The two pickers are submenus, not eleven flat rows: each is a set
            of mutually exclusive options you touch once and forget, and the
            trigger already answers "what is it set to?" without opening. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="min-w-0 flex-1">View</span>
            <span className="text-muted-foreground/70">{VIEW_LABEL[viewMode]}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-40">
            <DropdownMenuRadioGroup
              value={viewMode}
              onValueChange={(v) => setViewMode(v as ViewMode)}
            >
              <DropdownMenuRadioItem value="list">
                <ListSolid />
                List
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="grid">
                <LayoutGrid />
                Grid
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="min-w-0 flex-1">Sort by</span>
            <span className="text-muted-foreground/70">{SORT_LABEL[sortBy]}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            <DropdownMenuRadioGroup value={sortBy} onValueChange={(v) => setSortBy(v as SortField)}>
              <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="type">Type</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            {/* Two named options, not one button labelled with the state it is
                NOT in. "Descending" as a single row read as both "it is
                descending" and "click to make it descending". */}
            <DropdownMenuRadioGroup
              value={sortOrder}
              onValueChange={(v) => setSortOrder(v as SortOrder)}
            >
              <DropdownMenuRadioItem value="asc">Ascending</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="desc">Descending</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />

        {showHiddenToggle && (
          // `reverse` puts the check on the RIGHT edge, where the radio rows
          // above already put theirs. One column for "this is the current
          // value", one column for action icons.
          <DropdownMenuCheckboxItem reverse checked={showHidden} onCheckedChange={toggleHidden}>
            Show hidden files
          </DropdownMenuCheckboxItem>
        )}
        {showSearch && (
          <DropdownMenuItem onClick={toggleSearch}>
            <Search />
            Find a file
            <DropdownMenuShortcut>⌘P</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? <Loading className="size-4 shrink-0" /> : <RefreshCw />}
          Refresh
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onDownloadDir} disabled={isDownloading}>
          {isDownloading ? <Loading className="size-4 shrink-0" /> : <Download />}
          Download folder
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ------------------------------------------------------------------ *
 * New menu
 * ------------------------------------------------------------------ */

interface DriveNewMenuProps {
  /**
   * Write affordances, rendered together. Read-only sources
   * (`capabilities.write === false`) pass none of them and the menu is absent —
   * a viewer must never see an action they cannot perform.
   */
  onUpload?: () => void;
  onNewFile?: () => void;
  onNewFolder?: () => void;
  /** Drop the label and render a `+` square. For narrow panels. */
  compact?: boolean;
}

/**
 * The "New" menu renders only when the explorer supplied all three write
 * handlers. Partial wiring is a bug, not a half-menu.
 */
export function hasWriteActions(
  props: Pick<DriveNewMenuProps, 'onUpload' | 'onNewFile' | 'onNewFolder'>,
): boolean {
  return Boolean(props.onUpload && props.onNewFile && props.onNewFolder);
}

type DriveMenuItemComponent = ComponentType<{
  onClick?: () => void;
  children: ReactNode;
}>;

/**
 * Contents of the "New" menu, injectable like `FolderDriveMenuItems` so the
 * entries can be rendered — and their handlers driven — without a live Radix
 * portal.
 */
export function DriveNewMenuItems({
  Item,
  Separator: MenuSeparator,
  onUpload,
  onNewFile,
  onNewFolder,
}: {
  Item: DriveMenuItemComponent;
  Separator: ComponentType;
  onUpload?: () => void;
  onNewFile?: () => void;
  onNewFolder?: () => void;
}) {
  return (
    <>
      <Item onClick={onUpload}>
        <UploadSimpleIcon className="size-3.5 shrink-0" />
        Upload files
      </Item>
      <MenuSeparator />
      <Item onClick={onNewFile}>
        <FilePlusIcon className="size-3.5 shrink-0" />
        New file
      </Item>
      <Item onClick={onNewFolder}>
        <FolderPlusIcon className="size-3.5 shrink-0" />
        New folder
      </Item>
    </>
  );
}

export function DriveNewMenu({ onUpload, onNewFile, onNewFolder, compact }: DriveNewMenuProps) {
  if (!hasWriteActions({ onUpload, onNewFile, onNewFolder })) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <Button variant="secondary" size="icon-sm" aria-label="New" className="active:scale-[0.96]">
            <PlusIcon className="size-4" />
          </Button>
        ) : (
          <Button variant="secondary" size="sm" className="gap-1.5 active:scale-[0.96]">
            <PlusIcon className="size-3.5 shrink-0" />
            New
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DriveNewMenuItems
          Item={DropdownMenuItem}
          Separator={DropdownMenuSeparator}
          onUpload={onUpload}
          onNewFile={onNewFile}
          onNewFolder={onNewFolder}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

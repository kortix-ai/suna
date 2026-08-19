'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import Loading from '@/components/ui/loading';
import { Separator } from '@/components/ui/separator';
import type { SortField } from '@/features/file-browser/store/files-store';
import { isWithinRoot, useFilesStore } from '@/features/file-browser/store/files-store';
import { cn } from '@/lib/utils';
import {
  ArrowsDownUpIcon as ArrowUpDown,
  CaretRightIcon as ChevronRight,
  DownloadIcon as Download,
  EyeIcon as Eye,
  EyeSlashIcon as EyeOff,
  FilePlusIcon,
  FolderPlusIcon,
  HouseIcon as HomeSolid,
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
import { VersionSelector } from './version-selector';

interface DriveToolbarProps {
  onDownloadDir: () => void;
  onRefresh: () => void;
  isRefreshing?: boolean;
  isDownloading?: boolean;
  showVersionSelector?: boolean;
  /** Toolbar button for the Cmd+P file-name search overlay. */
  showSearch?: boolean;
  /** Dotfile visibility toggle (list is pre-filtered by the data hook). */
  showHiddenToggle?: boolean;
  /**
   * Write affordances, rendered together in the "New" menu. Read-only sources
   * (`capabilities.write === false`) pass none of them and the menu is absent —
   * a viewer must never see an action they cannot perform.
   */
  onUpload?: () => void;
  onNewFile?: () => void;
  onNewFolder?: () => void;
}

/**
 * The "New" menu renders only when the explorer supplied all three write
 * handlers. Partial wiring is a bug, not a half-menu.
 */
export function hasWriteActions(
  props: Pick<DriveToolbarProps, 'onUpload' | 'onNewFile' | 'onNewFolder'>,
): boolean {
  return Boolean(props.onUpload && props.onNewFile && props.onNewFolder);
}

type DriveMenuItemComponent = ComponentType<{
  onClick?: () => void;
  children: ReactNode;
}>;

/**
 * Contents of the toolbar's "New" menu, injectable like
 * `FolderDriveMenuItems` so the entries can be rendered — and their handlers
 * driven — without a live Radix portal.
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

export function DriveToolbar({
  onDownloadDir,
  onRefresh,
  isRefreshing,
  isDownloading,
  showVersionSelector = false,
  showSearch = false,
  showHiddenToggle = false,
  onUpload,
  onNewFile,
  onNewFolder,
}: DriveToolbarProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const sortBy = useFilesStore((s) => s.sortBy);
  const sortOrder = useFilesStore((s) => s.sortOrder);
  const setSortBy = useFilesStore((s) => s.setSortBy);
  const toggleSortOrder = useFilesStore((s) => s.toggleSortOrder);
  const rootPath = useFilesStore((s) => s.rootPath);
  const showHidden = useFilesStore((s) => s.showHidden);
  const toggleHidden = useFilesStore((s) => s.toggleHidden);
  const toggleSearch = useFilesStore((s) => s.toggleSearch);

  const homePath = rootPath || '/workspace';
  const homeLabel = rootPath ? rootPath.split('/').filter(Boolean).pop() || 'root' : '/workspace';

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

  const showWriteActions = hasWriteActions({ onUpload, onNewFile, onNewFolder });

  const handleSegmentClick = useCallback(
    (index: number) => {
      const absoluteIndex = rootPath ? index + rootSegments.length : index;
      const pathToHere = '/' + allSegments.slice(0, absoluteIndex + 1).join('/');
      navigateToPath(pathToHere);
    },
    [allSegments, rootSegments, rootPath, navigateToPath],
  );

  return (
    <div className="border-border bg-background w-full min-w-0 shrink-0 border-b">
      <div className="flex w-full flex-col md:flex-row md:items-center md:gap-1.5 md:px-4 md:py-2">
        <div className="border-border/40 flex w-full min-w-0 items-center gap-1.5 border-b px-3 py-2 md:flex-1 md:border-b-0 md:px-0 md:py-0">
          {showVersionSelector && (
            <>
              <div className="max-w-36 shrink-0 md:max-w-none">
                <VersionSelector />
              </div>
              <Separator orientation="vertical" className="data-[orientation=vertical]:h-[70%]" />
            </>
          )}

          {isEditing ? (
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
              className="bg-card focus:ring-primary/50 h-8 min-w-0 flex-1 rounded-md border px-3 font-mono text-sm outline-none focus:ring-2"
              placeholder={homePath}
            />
          ) : (
            <div
              className="flex min-w-0 flex-1 items-center gap-0.5"
              onDoubleClick={handleDoubleClick}
              title={tHardcodedUi.raw(
                'featuresProjectFilesComponentsDriveToolbar.line191JsxAttrTitleDoubleClickToEditPath',
              )}
            >
              <Button
                onClick={() => navigateToPath(homePath)}
                variant="ghost"
                size="xs"
                className={cn('text-foreground shrink-0 font-medium')}
              >
                <HomeSolid weight="fill" className="size-4" />
                <span className="text-xs">{rootPath ? homeLabel : 'workspace'}</span>
              </Button>

              {segments.length > 0 && (
                <FadedScrollArea
                  orientation="horizontal"
                  fadeColor="from-background"
                  className="min-w-0 flex-1 overscroll-x-contain"
                >
                  <nav className="flex w-max min-w-0 items-center gap-0.5">
                    {segments.map((segment, index) => {
                      if (!rootPath && !outsideHome && index === 0 && segment === 'workspace')
                        return null;
                      const isLast = index === segments.length - 1;
                      // First crumb of an outside-home path anchors the absolute chain
                      const isAbsoluteAnchor = outsideHome && index === 0;
                      const pathKey = segments.slice(0, index + 1).join('/');

                      return (
                        <div key={pathKey} className="flex shrink-0 items-center gap-0.5">
                          {isAbsoluteAnchor ? (
                            <span className="text-muted-foreground/40 shrink-0 px-1 text-xs select-none">
                              ·
                            </span>
                          ) : (
                            <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
                          )}
                          <Button
                            onClick={() => handleSegmentClick(index)}
                            variant="ghost"
                            size="xs"
                            className={cn(
                              'max-w-[140px] shrink-0 truncate sm:max-w-[200px]',
                              isLast ? 'text-foreground font-medium' : 'text-muted-foreground',
                              isAbsoluteAnchor && 'font-mono text-xs',
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
          )}
        </div>

        <div className="flex w-full shrink-0 items-center gap-0.5 px-3 py-1.5 md:w-auto md:justify-end md:px-0 md:py-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" title="Sort">
                <ArrowUpDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsDriveToolbar.line262JsxTextSortBy',
                )}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={sortBy}
                onValueChange={(v) => setSortBy(v as SortField)}
              >
                <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="type">Type</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={toggleSortOrder} className="justify-between">
                {sortOrder === 'asc' ? 'Descending' : 'Ascending'}
                <ArrowUpDown className="size-4" />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {showHiddenToggle && (
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(!showHidden && 'text-muted-foreground')}
              onClick={toggleHidden}
              title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
            >
              {showHidden ? <Eye /> : <EyeOff />}
            </Button>
          )}

          {showSearch && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleSearch}
              title={tHardcodedUi.raw(
                'featuresFilesComponentsDriveToolbar.line270JsxAttrTitleSearchFilesCtrlP',
              )}
            >
              <Search />
            </Button>
          )}

          <Separator orientation="vertical" className="data-[orientation=vertical]:h-[70%]" />

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            disabled={isRefreshing}
            title="Refresh"
          >
            <RefreshCw className={cn(isRefreshing && 'animate-spin')} />
          </Button>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDownloadDir}
            disabled={isDownloading}
            title={tHardcodedUi.raw(
              'featuresProjectFilesComponentsDriveToolbar.line295JsxAttrTitleDownloadDirectoryAsZip',
            )}
          >
            {isDownloading ? <Loading /> : <Download />}
          </Button>

          {showWriteActions && (
            <>
              <Separator
                orientation="vertical"
                className="ml-0.5 data-[orientation=vertical]:h-[70%]"
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="sm" className="ml-1 gap-1.5">
                    <PlusIcon className="size-3.5 shrink-0" />
                    New
                  </Button>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

'use client';

import { Badge } from '@/components/ui/badge';
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
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { HomeSolid, ListSolid } from '@mynaui/icons-react';
import {
  ArrowUpDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  FilePlus,
  FolderPlus,
  GitCommitHorizontal,
  GitPullRequest,
  LayoutGrid,
  RefreshCw,
  Search,
  Upload,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SortField } from '../store/files-store';
import { isWithinRoot, useFilesStore } from '../store/files-store';
import { VersionSelector } from './version-selector';

interface DriveToolbarProps {
  onUpload: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onDownloadDir: () => void;
  onRefresh: () => void;
  isRefreshing?: boolean;
  isDownloading?: boolean;
  readOnly?: boolean;
  readOnlyLabel?: string;
  showVersionSelector?: boolean;
  /** Toolbar button for the Cmd+P file-name search overlay. */
  showSearch?: boolean;
  /** Dotfile visibility toggle (list is pre-filtered by the data hook). */
  showHiddenToggle?: boolean;
  checkpointsToggle?: { open: boolean; onToggle: () => void };
  changeRequestsToggle?: { open: boolean; onToggle: () => void; openCount?: number };
  openChangeRequestAction?: { onClick: () => void; disabled?: boolean };
}

export function DriveToolbar({
  onUpload,
  onNewFolder,
  onNewFile,
  onDownloadDir,
  onRefresh,
  isRefreshing,
  isDownloading,
  readOnly = false,
  readOnlyLabel: _readOnlyLabel = 'Read-only · backed by Git',
  showVersionSelector = false,
  showSearch = false,
  showHiddenToggle = false,
  checkpointsToggle,
  changeRequestsToggle,
  openChangeRequestAction,
}: DriveToolbarProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const viewMode = useFilesStore((s) => s.viewMode);
  const toggleViewMode = useFilesStore((s) => s.toggleViewMode);
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

  const handleSegmentClick = useCallback(
    (index: number) => {
      const absoluteIndex = rootPath ? index + rootSegments.length : index;
      const pathToHere = '/' + allSegments.slice(0, absoluteIndex + 1).join('/');
      navigateToPath(pathToHere);
    },
    [allSegments, rootSegments, rootPath, navigateToPath],
  );

  const sortLabel: Record<SortField, string> = {
    name: 'Name',
    modified: 'Last modified',
    size: 'File size',
    type: 'Type',
  };

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
                  navigateToPath(editValue.trim() || homePath);
                  setIsEditing(false);
                }
                if (e.key === 'Escape') setIsEditing(false);
              }}
              onBlur={() => setIsEditing(false)}
              className="bg-card focus:ring-primary/50 h-8 min-w-0 flex-1 rounded-2xl border px-3 font-mono text-sm outline-none focus:ring-2"
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
                <HomeSolid className="size-4" />
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

                      return (
                        <div key={index} className="flex shrink-0 items-center gap-0.5">
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

        <FadedScrollArea
          orientation="horizontal"
          fadeColor="from-background"
          className="w-full shrink-0 overscroll-x-contain md:w-auto"
        >
          <div className="flex w-max min-w-full items-center gap-0.5 px-3 py-1.5 md:w-auto md:min-w-0 md:justify-end md:px-0 md:py-0">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleViewMode}
              title={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
            >
              {viewMode === 'grid' ? <ListSolid /> : <LayoutGrid />}
            </Button>

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

            {!readOnly && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={tHardcodedUi.raw(
                      'featuresProjectFilesComponentsDriveToolbar.line312JsxAttrTitleNewFileOrFolder',
                    )}
                  >
                    <Icon.Plus className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onClick={onNewFolder}>
                    <FolderPlus className="size-4" />
                    {tHardcodedUi.raw(
                      'featuresProjectFilesComponentsDriveToolbar.line320JsxTextNewFolder',
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onNewFile}>
                    <FilePlus className="size-4" />
                    {tHardcodedUi.raw(
                      'featuresProjectFilesComponentsDriveToolbar.line324JsxTextNewFile',
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onUpload}>
                    <Upload />
                    {tHardcodedUi.raw(
                      'featuresProjectFilesComponentsDriveToolbar.line329JsxTextFileUpload',
                    )}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {openChangeRequestAction && (
              <>
                <Separator orientation="vertical" className="data-[orientation=vertical]:h-[70%]" />
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={openChangeRequestAction.onClick}
                  disabled={openChangeRequestAction.disabled}
                  title={tHardcodedUi.raw(
                    'featuresProjectFilesComponentsDriveToolbar.line348JsxAttrTitleOpenANewChangeRequest',
                  )}
                  className="shrink-0"
                >
                  <GitPullRequest className="size-4" />
                  <span className="hidden sm:inline">
                    {tHardcodedUi.raw(
                      'featuresProjectFilesComponentsDriveToolbar.line352JsxTextOpenCr',
                    )}
                  </span>
                </Button>
              </>
            )}

            {checkpointsToggle && (
              <>
                <Separator orientation="vertical" className="data-[orientation=vertical]:h-[70%]" />
                <Button
                  type="button"
                  variant={checkpointsToggle.open ? 'secondary' : 'ghost'}
                  size="xs"
                  onClick={checkpointsToggle.onToggle}
                  title={tHardcodedUi.raw(
                    'featuresProjectFilesComponentsDriveToolbar.line366JsxAttrTitleToggleCheckpointsPanel',
                  )}
                  className={cn(
                    'shrink-0',
                    !checkpointsToggle.open && 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <GitCommitHorizontal className="size-4" />
                  <span className="hidden sm:inline">Checkpoints</span>
                </Button>
              </>
            )}

            {changeRequestsToggle &&
              (() => {
                const count = changeRequestsToggle.openCount ?? 0;
                const hasOpen = count > 0;
                return (
                  <Button
                    type="button"
                    variant={changeRequestsToggle.open ? 'secondary' : 'ghost'}
                    size="xs"
                    onClick={changeRequestsToggle.onToggle}
                    title={
                      hasOpen
                        ? `${count} change request${count === 1 ? '' : 's'} waiting for review`
                        : 'Toggle Change Requests panel'
                    }
                    className={cn(
                      'shrink-0',
                      !changeRequestsToggle.open &&
                        (hasOpen
                          ? 'text-foreground'
                          : 'text-muted-foreground hover:text-foreground'),
                    )}
                  >
                    <span className="relative inline-flex">
                      <GitPullRequest className="size-4" />
                      {hasOpen && (
                        <span
                          className="ring-background absolute -top-1 -right-1 size-2 rounded-full bg-emerald-500 ring-2"
                          aria-hidden
                        />
                      )}
                    </span>
                    <span className="hidden sm:inline">
                      {tHardcodedUi.raw(
                        'featuresProjectFilesComponentsDriveToolbar.line412JsxTextChangeRequests',
                      )}
                    </span>
                    {hasOpen && (
                      <Badge variant="success" size="xs" className="ml-0.5 tabular-nums">
                        {count}
                      </Badge>
                    )}
                  </Button>
                );
              })()}
          </div>
        </FadedScrollArea>
      </div>
    </div>
  );
}

'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  LayoutGrid,
  List,
  Upload,
  FolderPlus,
  FilePlus,
  Plus,
  ArrowUpDown,
  RefreshCw,
  ChevronRight,
  Home,
  Download,
  GitCommitHorizontal,
  GitPullRequest,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { useFilesStore } from '../store/files-store';
import { useFileList } from '../hooks/use-file-list';
import { cn } from '@/lib/utils';
import type { SortField } from '../store/files-store';
import { VersionSelector } from './version-selector';

interface DriveToolbarProps {
  onUpload: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onDownloadDir: () => void;
  isDownloading?: boolean;
  /** When true, hides mutation buttons (New / Upload). */
  readOnly?: boolean;
  /**
   * @deprecated read-only state is no longer surfaced as a pill. Prop kept so
   *             existing callers don't break; the value is ignored.
   */
  readOnlyLabel?: string;
  /** When true, shows the Version (Git branch) switcher before breadcrumbs. */
  showVersionSelector?: boolean;
  /** When set, renders a Checkpoints toggle pill on the right. */
  checkpointsToggle?: { open: boolean; onToggle: () => void };
  /** When set, renders a Change Requests toggle pill on the right.
   *  `openCount` adds a numeric badge on the pill so the user can see at a
   *  glance how many CRs are waiting for review. */
  changeRequestsToggle?: { open: boolean; onToggle: () => void; openCount?: number };
  /** When set, renders a contextual "Open change request" button (only
   *  meaningful when the selected version is not the default branch). */
  openChangeRequestAction?: { onClick: () => void; disabled?: boolean };
}

/**
 * Google Drive-style toolbar.
 * 
 * Layout: [Breadcrumbs] ... [New +] [View Toggle] [Sort] [Search] [More]
 */
export function DriveToolbar({
  onUpload,
  onNewFolder,
  onNewFile,
  onDownloadDir,
  isDownloading,
  readOnly = false,
  readOnlyLabel: _readOnlyLabel = 'Read-only · backed by Git',
  showVersionSelector = false,
  checkpointsToggle,
  changeRequestsToggle,
  openChangeRequestAction,
}: DriveToolbarProps) {
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const viewMode = useFilesStore((s) => s.viewMode);
  const toggleViewMode = useFilesStore((s) => s.toggleViewMode);
  const sortBy = useFilesStore((s) => s.sortBy);
  const sortOrder = useFilesStore((s) => s.sortOrder);
  const setSortBy = useFilesStore((s) => s.setSortBy);
  const toggleSortOrder = useFilesStore((s) => s.toggleSortOrder);
  const rootPath = useFilesStore((s) => s.rootPath);

  const { refetch: refetchFiles, isFetching } = useFileList(currentPath);

  // Home destination: rootPath when sandboxed, otherwise /workspace
  const homePath = rootPath || '/workspace';
  const homeLabel = rootPath
    ? rootPath.split('/').filter(Boolean).pop() || 'root'
    : '/workspace';

  // Breadcrumb segments
  const isRoot = currentPath === '/' || currentPath === '.' || currentPath === '';
  const allSegments = useMemo(
    () => (isRoot ? [] : currentPath.split('/').filter(Boolean)),
    [isRoot, currentPath],
  );

  // When rootPath is set, only show segments at or below it
  const rootSegments = useMemo(
    () => (rootPath ? rootPath.split('/').filter(Boolean) : []),
    [rootPath],
  );
  const segments = useMemo(
    () => rootPath ? allSegments.slice(rootSegments.length) : allSegments,
    [rootPath, allSegments, rootSegments],
  );

  // Path editing
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
      // Offset by rootSegments length to reconstruct the full absolute path
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
    <div className="flex items-center gap-1.5 px-4 h-14 border-b border-border/40 bg-background shrink-0">
      {/* ── Version (Git branch) selector ── */}
      {showVersionSelector && (
        <>
          <VersionSelector />
          <div className="h-4 w-px bg-border/50 mx-1 shrink-0" />
        </>
      )}

      {/* ── Breadcrumbs ── */}
      <div className="flex items-center gap-0.5 min-w-0 flex-1 overflow-hidden">
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
            className="flex-1 min-w-0 h-8 px-3 text-sm bg-muted/40 border border-border/60 rounded-lg outline-none focus:ring-1 focus:ring-primary font-mono"
            placeholder={homePath}
          />
        ) : (
          <nav
            className="flex items-center gap-0.5 min-w-0 flex-1 overflow-x-auto"
            onDoubleClick={handleDoubleClick}
            title="Double-click to edit path"
          >
            {/* Home / root */}
            <Button
              onClick={() => navigateToPath(homePath)}
              variant="ghost"
              size="sm"
              className={cn(
                'gap-1.5 shrink-0',
                segments.length === 0 ? 'text-foreground font-medium' : 'text-muted-foreground',
              )}
            >
              <Home className="h-4 w-4" />
              <span className="font-mono text-xs">{rootPath ? homeLabel : '/workspace'}</span>
            </Button>

            {segments.map((segment, index) => {
              // Skip 'workspace' only when not sandboxed (rootPath null)
              if (!rootPath && index === 0 && segment === 'workspace') return null;
              const isLast = index === segments.length - 1;

              return (
                <div key={index} className="flex items-center gap-0.5 min-w-0 shrink-0">
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                  <Button
                    onClick={() => handleSegmentClick(index)}
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'truncate max-w-[200px]',
                      isLast ? 'text-foreground font-medium' : 'text-muted-foreground',
                    )}
                  >
                    {segment}
                  </Button>
                </div>
              );
            })}
          </nav>
        )}
      </div>

      {/* ── Right Actions ── */}
      <div className="flex items-center gap-0.5 shrink-0">
        {/* View / sort / dotfiles group */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={toggleViewMode}
          title={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
        >
          {viewMode === 'grid' ? (
            <List className="h-4 w-4" />
          ) : (
            <LayoutGrid className="h-4 w-4" />
          )}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              title="Sort"
            >
              <ArrowUpDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={sortBy} onValueChange={(v) => setSortBy(v as SortField)}>
              <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="type">Type</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={toggleSortOrder}>
              <ArrowUpDown className="mr-2 h-4 w-4" />
              {sortOrder === 'asc' ? 'Descending' : 'Ascending'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="h-4 w-px bg-border/50 mx-1 shrink-0" />

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={() => refetchFiles()}
          disabled={isFetching}
          title="Refresh"
        >
          <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
        </Button>

        {/* Download dir */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={onDownloadDir}
          disabled={isDownloading}
          title="Download directory as zip"
        >
          {isDownloading ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </Button>

        {/* New button — hidden in read-only project view */}
        {!readOnly && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                title="New file or folder"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={onNewFolder}>
                <FolderPlus className="mr-2 h-4 w-4" />
                New folder
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onNewFile}>
                <FilePlus className="mr-2 h-4 w-4" />
                New file
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onUpload}>
                <Upload className="mr-2 h-4 w-4" />
                File upload
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* Quick "+ Open CR" — opens the new-CR dialog with a branch picker.
            Subtle by design so it doesn't fight the Checkpoints / Change
            Requests pills, but always visible so opening a CR is reachable
            from any state. */}
        {openChangeRequestAction && (
          <>
            <div className="h-4 w-px bg-border/50 mx-1 shrink-0" />
            <button
              type="button"
              onClick={openChangeRequestAction.onClick}
              disabled={openChangeRequestAction.disabled}
              title="Open a new change request"
              className={cn(
                'inline-flex items-center gap-1.5 h-8 rounded-md px-2.5 text-xs font-medium',
                'transition-colors text-muted-foreground hover:text-foreground hover:bg-muted/60',
              )}
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              <span>Open CR</span>
            </button>
          </>
        )}

        {/* Checkpoints toggle — visual emphasis without harsh "active" state. */}
        {checkpointsToggle && (
          <>
            <div className="h-4 w-px bg-border/50 mx-1 shrink-0" />
            <button
              type="button"
              onClick={checkpointsToggle.onToggle}
              title="Toggle Checkpoints panel"
              className={cn(
                'inline-flex items-center gap-1.5 h-8 rounded-md px-2.5 text-xs font-medium',
                'transition-colors',
                checkpointsToggle.open
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
              )}
            >
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              <span>Checkpoints</span>
            </button>
          </>
        )}

        {/* Change Requests toggle — same visual treatment as Checkpoints,
            with a count badge when CRs are open so reviewers can spot them at
            a glance. */}
        {changeRequestsToggle && (() => {
          const count = changeRequestsToggle.openCount ?? 0;
          const hasOpen = count > 0;
          return (
            <button
              type="button"
              onClick={changeRequestsToggle.onToggle}
              title={
                hasOpen
                  ? `${count} change request${count === 1 ? '' : 's'} waiting for review`
                  : 'Toggle Change Requests panel'
              }
              className={cn(
                'inline-flex items-center gap-1.5 h-8 rounded-md px-2.5 text-xs font-medium',
                'transition-colors ml-1',
                changeRequestsToggle.open
                  ? 'bg-muted text-foreground'
                  : hasOpen
                    ? 'text-foreground hover:bg-muted/60'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
              )}
            >
              <span className="relative inline-flex">
                <GitPullRequest className="h-3.5 w-3.5" />
                {hasOpen && (
                  <span
                    className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-background"
                    aria-hidden
                  />
                )}
              </span>
              <span>Change requests</span>
              {hasOpen && (
                <span
                  className={cn(
                    'ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full',
                    'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 text-[10px] font-semibold tabular-nums',
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })()}
      </div>
    </div>
  );
}

'use client';

import {
  ArrowUpDown,
  Check,
  Download,
  FilePlus,
  FolderPlus,
  GitCommitHorizontal,
  GitPullRequest,
  LayoutGrid,
  List,
  MoreHorizontal,
  RefreshCw,
  Upload,
} from 'lucide-react';
import {
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@kortix/design-system';

import { useFilesStore } from '../store/files-store';
import { useFileList } from '../hooks/use-file-list';
import type { SortField } from '../store/files-store';
import { VersionSelector } from './version-selector';

interface DriveToolbarProps {
  onUpload: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onDownloadDir: () => void;
  isDownloading?: boolean;
  readOnly?: boolean;
  readOnlyLabel?: string;
  showVersionSelector?: boolean;
  checkpointsToggle?: { open: boolean; onToggle: () => void };
  changeRequestsToggle?: { open: boolean; onToggle: () => void; openCount?: number };
  openChangeRequestAction?: { onClick: () => void; disabled?: boolean };
}

export function DriveToolbar({
  onUpload,
  onNewFolder,
  onNewFile,
  onDownloadDir,
  isDownloading,
  readOnly = false,
  showVersionSelector = false,
  checkpointsToggle,
  changeRequestsToggle,
  openChangeRequestAction,
}: DriveToolbarProps) {
  const currentPath = useFilesStore((s) => s.currentPath);
  const viewMode = useFilesStore((s) => s.viewMode);
  const toggleViewMode = useFilesStore((s) => s.toggleViewMode);
  const sortBy = useFilesStore((s) => s.sortBy);
  const sortOrder = useFilesStore((s) => s.sortOrder);
  const setSortBy = useFilesStore((s) => s.setSortBy);
  const toggleSortOrder = useFilesStore((s) => s.toggleSortOrder);

  const { refetch: refetchFiles, isFetching } = useFileList(currentPath);

  const crCount = changeRequestsToggle?.openCount ?? 0;
  const hasOpenCrs = crCount > 0;

  return (
    <header className="sticky top-0 z-20 bg-background/70 backdrop-blur supports-[backdrop-filter]:bg-background/50">
      <div className="mx-auto flex h-12 max-w-4xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          {showVersionSelector ? <VersionSelector /> : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {openChangeRequestAction ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={openChangeRequestAction.onClick}
              disabled={openChangeRequestAction.disabled}
              title="Open a new change request"
            >
              <GitPullRequest className="size-3.5" />
              Open CR
            </Button>
          ) : null}

          {checkpointsToggle ? (
            <Button
              variant={checkpointsToggle.open ? 'soft' : 'ghost'}
              size="sm"
              onClick={checkpointsToggle.onToggle}
              title="Toggle Checkpoints"
            >
              <GitCommitHorizontal className="size-3.5" />
              Checkpoints
            </Button>
          ) : null}

          {changeRequestsToggle ? (
            <Button
              variant={changeRequestsToggle.open ? 'soft' : 'ghost'}
              size="sm"
              onClick={changeRequestsToggle.onToggle}
              title={
                hasOpenCrs
                  ? `${crCount} change request${crCount === 1 ? '' : 's'} waiting`
                  : 'Toggle Change Requests'
              }
              className={cn(hasOpenCrs && !changeRequestsToggle.open && 'text-foreground')}
            >
              <span className="relative inline-flex">
                <GitPullRequest className="size-3.5" />
                {hasOpenCrs ? (
                  <span
                    aria-hidden
                    className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-emerald-400 ring-2 ring-background"
                  />
                ) : null}
              </span>
              Change requests
              {hasOpenCrs ? (
                <Badge
                  variant="outline"
                  className="ml-0.5 h-4 min-w-4 rounded-full border-emerald-500/30 bg-emerald-500/10 px-1 font-mono text-[0.58rem] font-medium tabular-nums text-emerald-500"
                >
                  {crCount}
                </Badge>
              ) : null}
            </Button>
          ) : null}

          {(openChangeRequestAction || checkpointsToggle || changeRequestsToggle) ? (
            <span aria-hidden className="mx-1.5 h-4 w-px bg-border/50" />
          ) : null}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="View options"
                title="View, sort, refresh, download…"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={() => refetchFiles()} disabled={isFetching}>
                <RefreshCw className={cn('mr-2 size-3.5', isFetching && 'animate-spin')} />
                Refresh
              </DropdownMenuItem>
              <DropdownMenuItem onClick={toggleViewMode}>
                {viewMode === 'grid' ? (
                  <List className="mr-2 size-3.5" />
                ) : (
                  <LayoutGrid className="mr-2 size-3.5" />
                )}
                Switch to {viewMode === 'grid' ? 'list' : 'grid'} view
              </DropdownMenuItem>

              <DropdownMenuSeparator />
              <DropdownMenuLabel className="font-mono text-[0.58rem] uppercase tracking-[0.18em] text-muted-foreground/70">
                Sort
              </DropdownMenuLabel>
              <SortOption
                label="Name"
                active={sortBy === 'name'}
                onClick={() => setSortBy('name')}
              />
              <SortOption
                label="Type"
                active={sortBy === 'type'}
                onClick={() => setSortBy('type')}
              />
              <DropdownMenuItem onClick={toggleSortOrder}>
                <ArrowUpDown className="mr-2 size-3.5" />
                {sortOrder === 'asc' ? 'Descending order' : 'Ascending order'}
              </DropdownMenuItem>

              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDownloadDir} disabled={isDownloading}>
                {isDownloading ? (
                  <RefreshCw className="mr-2 size-3.5 animate-spin" />
                ) : (
                  <Download className="mr-2 size-3.5" />
                )}
                {isDownloading ? 'Zipping…' : 'Download as zip'}
              </DropdownMenuItem>

              {!readOnly ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onNewFolder}>
                    <FolderPlus className="mr-2 size-3.5" />
                    New folder
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onNewFile}>
                    <FilePlus className="mr-2 size-3.5" />
                    New file
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onUpload}>
                    <Upload className="mr-2 size-3.5" />
                    Upload file
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}

function SortOption({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <DropdownMenuItem onClick={onClick}>
      <span className="mr-2 inline-flex size-3.5 items-center justify-center">
        {active ? <Check className="size-3.5" /> : null}
      </span>
      {label}
    </DropdownMenuItem>
  );
}

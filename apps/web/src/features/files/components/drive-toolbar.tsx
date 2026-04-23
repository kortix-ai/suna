'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  LayoutGrid,
  List,
  Search,
  Upload,
  FolderPlus,
  FilePlus,
  Plus,
  ArrowUpDown,
  Eye,
  EyeOff,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Home,
  Download,
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
import { useCurrentProject } from '../hooks';
import { useInvalidateFileList } from '../hooks/use-file-list';
import { useWorkspaces, friendlyBreadcrumbs } from '../hooks/use-workspaces';
import { cn } from '@/lib/utils';
import type { SortField } from '../store/files-store';

interface DriveToolbarProps {
  onUpload: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onDownloadDir: () => void;
  isDownloading?: boolean;
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
}: DriveToolbarProps) {
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const viewMode = useFilesStore((s) => s.viewMode);
  const toggleViewMode = useFilesStore((s) => s.toggleViewMode);
  const sortBy = useFilesStore((s) => s.sortBy);
  const sortOrder = useFilesStore((s) => s.sortOrder);
  const setSortBy = useFilesStore((s) => s.setSortBy);
  const toggleSortOrder = useFilesStore((s) => s.toggleSortOrder);
  const showHidden = useFilesStore((s) => s.showHidden);
  const toggleHidden = useFilesStore((s) => s.toggleHidden);
  const toggleSearch = useFilesStore((s) => s.toggleSearch);
  const rootPath = useFilesStore((s) => s.rootPath);

  const invalidateFileList = useInvalidateFileList();

  // Home destination: rootPath when sandboxed, otherwise /workspace
  const homePath = rootPath || '/workspace';
  const { data: workspaces } = useWorkspaces();
  const friendly = useMemo(
    () => friendlyBreadcrumbs(workspaces, currentPath),
    [workspaces, currentPath],
  );

  const homeLabel = rootPath
    ? rootPath.split('/').filter(Boolean).pop() || 'root'
    : '/workspace';

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
    <div className="flex items-center gap-2 px-4 h-12 border-b border-border/40 bg-background shrink-0">
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
            {friendly.length > 0 ? (
              friendly.map((crumb, index) => {
                const isLast = index === friendly.length - 1;
                return (
                  <div key={crumb.path} className="flex items-center gap-0.5 min-w-0 shrink-0">
                    {index > 0 ? (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                    ) : null}
                    <Button
                      onClick={() => navigateToPath(crumb.path)}
                      variant="ghost"
                      size="sm"
                      className={cn(
                        'gap-1.5 shrink-0 truncate max-w-[220px]',
                        isLast ? 'text-foreground font-medium' : 'text-muted-foreground',
                      )}
                    >
                      {crumb.isRoot ? <Home className="h-4 w-4" /> : null}
                      <span className={crumb.isRoot ? 'text-xs' : 'text-xs'}>{crumb.label}</span>
                    </Button>
                  </div>
                );
              })
            ) : (
              <Button
                onClick={() => navigateToPath(homePath)}
                variant="ghost"
                size="sm"
                className="gap-1.5 shrink-0 text-foreground font-medium"
              >
                <Home className="h-4 w-4" />
                <span className="font-mono text-xs">{rootPath ? homeLabel : '/workspace'}</span>
              </Button>
            )}
          </nav>
        )}
      </div>

      {/* ── Right Actions ── */}
      <div className="flex items-center gap-1 shrink-0">
        {/* View toggle */}
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

        {/* Sort dropdown */}
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
              <DropdownMenuRadioItem value="modified">Last modified</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="size">File size</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="type">Type</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={toggleSortOrder}>
              <ArrowUpDown className="mr-2 h-4 w-4" />
              {sortOrder === 'asc' ? 'Descending' : 'Ascending'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Show/hide hidden files */}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-8 w-8 hover:text-foreground',
            showHidden ? 'text-foreground' : 'text-muted-foreground',
          )}
          onClick={toggleHidden}
          title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
        >
          {showHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        </Button>

        {/* Search */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={toggleSearch}
          title="Search files (Ctrl+P)"
        >
          <Search className="h-4 w-4" />
        </Button>

        {/* Refresh */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={() => invalidateFileList()}
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
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

        {/* New button - compact icon, far right */}
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
      </div>
    </div>
  );
}

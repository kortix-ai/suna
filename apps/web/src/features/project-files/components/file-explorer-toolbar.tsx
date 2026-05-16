'use client';

import { cn } from '@/lib/utils';
import {
  Search,
  PanelLeftClose,
  PanelLeft,
  RefreshCw,
  Eye,
  EyeOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFilesStore } from '../store/files-store';
import { useCurrentProject } from '../hooks';
import { useInvalidateFileList } from '../hooks/use-file-list';
import { getFileIcon } from './file-icon';

/**
 * Minimal top toolbar — sidebar toggle | file path | search + refresh
 */
export function FileExplorerToolbar() {
  const isSidebarCollapsed = useFilesStore((s) => s.isSidebarCollapsed);
  const toggleSidebar = useFilesStore((s) => s.toggleSidebar);
  const toggleSearch = useFilesStore((s) => s.toggleSearch);
  const selectedFilePath = useFilesStore((s) => s.selectedFilePath);
  const showHidden = useFilesStore((s) => s.showHidden);
  const toggleHidden = useFilesStore((s) => s.toggleHidden);

  const { data: project } = useCurrentProject();
  const invalidateFileList = useInvalidateFileList();

  const projectName = project?.name || project?.worktree?.split('/').pop() || 'Project';
  const fileName = selectedFilePath?.split('/').pop() || '';

  return (
    <div className="flex items-center gap-2 px-2 border-b border-border/50 bg-background shrink-0 h-10">
      {/* Sidebar toggle */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 text-muted-foreground/60 hover:text-foreground"
        onClick={toggleSidebar}
        title={isSidebarCollapsed ? 'Show explorer' : 'Hide explorer'}
      >
        {isSidebarCollapsed ? (
          <PanelLeft className="h-4 w-4" />
        ) : (
          <PanelLeftClose className="h-4 w-4" />
        )}
      </Button>

      {/* Separator */}
      <div className="w-px h-4 bg-border/40 shrink-0" />

      {/* Open file path / project name */}
      <div className="flex items-center gap-1.5 flex-1 min-w-0 text-sm">
        {selectedFilePath ? (
          <>
            {getFileIcon(fileName, { className: 'h-4 w-4 shrink-0' })}
            <span className="truncate text-muted-foreground/80">
              {selectedFilePath}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground/40 text-xs select-none">{projectName}</span>
        )}
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-0.5 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-7 w-7 hover:text-foreground', showHidden ? 'text-foreground' : 'text-muted-foreground/60')}
          onClick={toggleHidden}
          title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
        >
          {showHidden ? (
            <Eye className="h-4 w-4" />
          ) : (
            <EyeOff className="h-4 w-4" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground/60 hover:text-foreground"
          onClick={toggleSearch}
          title="Search files"
        >
          <Search className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground/60 hover:text-foreground"
          onClick={() => invalidateFileList()}
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

'use client';

import { useCallback, useMemo } from 'react';
import { ChevronRight, FolderRoot } from 'lucide-react';
import { useFilesStore, useFilesStoreApi } from '../store/files-store';
import { openTabAndNavigate } from '@/stores/tab-store';
import { cn } from '@/lib/utils';
import { getFileIcon } from './file-icon';

// ---------------------------------------------------------------------------
// Shared breadcrumb segment rendering — used by both modes
// ---------------------------------------------------------------------------

interface BreadcrumbSegmentsProps {
  /** All path segments (e.g. ['workspace', 'src', 'index.ts']) */
  segments: string[];
  /** Called when a directory segment is clicked */
  onSegmentClick: (index: number) => void;
  /** Called when the home/root button is clicked */
  onHomeClick: () => void;
  /** When true, the last segment is rendered as a non-clickable label (file mode) */
  fileMode?: boolean;
  /** File icon element to show before the filename in file mode */
  fileIcon?: React.ReactNode;
  /** Root path constraint — segments above this are hidden */
  rootPath?: string | null;
  /** Called on double-click (for edit mode) */
  onDoubleClick?: () => void;
  /** Extra content after the breadcrumb segments (e.g. edit button) */
  trailing?: React.ReactNode;
}

function BreadcrumbSegments({
  segments,
  onSegmentClick,
  onHomeClick,
  fileMode,
  fileIcon,
  rootPath,
  onDoubleClick,
  trailing,
}: BreadcrumbSegmentsProps) {
  // When rootPath is set, only show segments at or below it
  const rootSegmentCount = useMemo(
    () => (rootPath ? rootPath.split('/').filter(Boolean).length : 0),
    [rootPath],
  );
  const visibleSegments = useMemo(
    () => (rootPath ? segments.slice(rootSegmentCount) : segments),
    [rootPath, segments, rootSegmentCount],
  );

  return (
    <nav
      className="flex items-center gap-0.5 min-w-0 flex-1 overflow-x-auto"
      onDoubleClick={onDoubleClick}
      title={onDoubleClick ? 'Double-click to edit path' : undefined}
    >
      {/* Home / root */}
      <button
        onClick={onHomeClick}
        className={cn(
          'flex items-center gap-1 px-2 py-1 rounded-lg transition-colors cursor-pointer shrink-0',
          'hover:bg-muted',
          visibleSegments.length === 0
            ? 'text-foreground font-medium bg-muted/50'
            : 'text-muted-foreground',
        )}
      >
        <FolderRoot className="h-3.5 w-3.5" />
      </button>

      {visibleSegments.map((segment, visibleIndex) => {
        // Skip 'workspace' when not sandboxed (rootPath null)
        if (!rootPath && visibleIndex === 0 && segment === 'workspace') return null;

        const isLast = visibleIndex === visibleSegments.length - 1;
        // Recover the absolute index for the click handler
        const absoluteIndex = rootPath ? visibleIndex + rootSegmentCount : visibleIndex;
        const pathToHere = '/' + segments.slice(0, absoluteIndex + 1).join('/');

        return (
          <div key={pathToHere} className="flex items-center gap-0.5 min-w-0 shrink-0">
            <ChevronRight className="h-3 w-3 text-muted-foreground/50 shrink-0" />
            {isLast && fileMode ? (
              /* File name — non-clickable active segment with optional icon */
              <span className="inline-flex items-center gap-1.5 px-1.5 py-1 text-xs text-foreground font-medium bg-muted/30 rounded-lg truncate max-w-[200px]">
                {fileIcon}
                {segment}
              </span>
            ) : (
              <button
                onClick={() => onSegmentClick(absoluteIndex)}
                className={cn(
                  'px-1.5 py-1 rounded-lg transition-colors cursor-pointer truncate max-w-[180px] text-xs',
                  'hover:bg-muted',
                  isLast && !fileMode
                    ? 'text-foreground font-medium bg-muted/30'
                    : 'text-muted-foreground',
                )}
              >
                {segment}
              </button>
            )}
          </div>
        );
      })}

      {trailing}
    </nav>
  );
}

interface FilePathBreadcrumbsProps {
  /** Absolute path to the file being viewed */
  filePath: string;
  /** Optional className for the container */
  className?: string;
}

/**
 * Compact breadcrumb for the file viewer header.
 * Shows the full path to a file. Directory segments are clickable
 * and navigate to the Files tab. The filename segment shows the file icon
 * and is styled as the active/current item.
 */
export function FilePathBreadcrumbs({ filePath, className }: FilePathBreadcrumbsProps) {
  const filesStore = useFilesStoreApi();
  const rootPath = useFilesStore((s) => s.rootPath);
  const homePath = rootPath || '/workspace';

  const segments = useMemo(
    () => filePath.split('/').filter(Boolean),
    [filePath],
  );

  const fileName = segments[segments.length - 1] || '';

  const handleSegmentClick = useCallback(
    (index: number) => {
      const dirPath = '/' + segments.slice(0, index + 1).join('/');
      filesStore.getState().navigateToPath(dirPath);
      openTabAndNavigate({
        id: 'page:/files',
        title: 'Files',
        type: 'page',
        href: '/files',
      });
    },
    [filesStore, segments],
  );

  const handleHomeClick = useCallback(() => {
    filesStore.getState().navigateToPath(homePath);
    openTabAndNavigate({
      id: 'page:/files',
      title: 'Files',
      type: 'page',
      href: '/files',
    });
  }, [filesStore, homePath]);

  return (
    <div className={cn('min-w-0 flex-1', className)}>
      <BreadcrumbSegments
        segments={segments}
        onSegmentClick={handleSegmentClick}
        onHomeClick={handleHomeClick}
        fileMode
        fileIcon={getFileIcon(fileName, { className: 'h-3.5 w-3.5 shrink-0' })}
        rootPath={rootPath}
      />
    </div>
  );
}

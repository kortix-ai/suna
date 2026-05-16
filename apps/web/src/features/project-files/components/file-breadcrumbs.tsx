'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
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
          'flex items-center gap-1 px-2 py-1 rounded-md transition-colors cursor-pointer shrink-0',
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
              <span className="inline-flex items-center gap-1.5 px-1.5 py-1 text-xs text-foreground font-medium bg-muted/30 rounded-md truncate max-w-[200px]">
                {fileIcon}
                {segment}
              </span>
            ) : (
              <button
                onClick={() => onSegmentClick(absoluteIndex)}
                className={cn(
                  'px-1.5 py-1 rounded-md transition-colors cursor-pointer truncate max-w-[180px] text-xs',
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

// ---------------------------------------------------------------------------
// FileBreadcrumbs — directory mode (reads from files store)
// ---------------------------------------------------------------------------

/**
 * Full-featured breadcrumb for the file explorer.
 * Reads the current directory from the files store.
 * Matches the visual style of `FilePathBreadcrumbs` — a single
 * `BreadcrumbSegments` strip with no extra chrome.
 * Double-click to edit the path inline, keyboard nav (Backspace / Alt+←)
 * to jump up a level.
 */
export function FileBreadcrumbs() {
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const rootPath = useFilesStore((s) => s.rootPath);

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const homePath = rootPath || '/';

  const isRoot = currentPath === '/' || currentPath === '.' || currentPath === '';
  const segments = useMemo(
    () => (isRoot ? [] : currentPath.split('/').filter(Boolean)),
    [isRoot, currentPath],
  );

  const handleDoubleClick = useCallback(() => {
    setEditValue(currentPath === '/' ? '' : currentPath);
    setIsEditing(true);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [currentPath]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && isEditing) {
        navigateToPath(editValue.trim() || '/');
        setIsEditing(false);
      } else if (e.key === 'Escape' && isEditing) {
        setIsEditing(false);
      } else if (!isEditing) {
        if (e.key === 'Backspace' && !isRoot) {
          const lastSlash = currentPath.lastIndexOf('/');
          navigateToPath(lastSlash <= 0 ? '/' : currentPath.slice(0, lastSlash));
        }
        if (e.altKey && e.key === 'ArrowLeft' && !isRoot) {
          const lastSlash = currentPath.lastIndexOf('/');
          navigateToPath(lastSlash <= 0 ? '/' : currentPath.slice(0, lastSlash));
        }
      }
    },
    [isEditing, editValue, navigateToPath, isRoot, currentPath],
  );

  useEffect(() => {
    if (!isEditing) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target instanceof HTMLInputElement)) setIsEditing(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [isEditing]);

  const handleSegmentClick = useCallback(
    (index: number) => {
      navigateToPath('/' + segments.slice(0, index + 1).join('/'));
    },
    [segments, navigateToPath],
  );

  if (isEditing) {
    return (
      <div
        className="flex items-center gap-1 text-sm min-w-0 flex-1"
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { navigateToPath(editValue.trim() || '/'); setIsEditing(false); }
            if (e.key === 'Escape') setIsEditing(false);
          }}
          onBlur={() => { navigateToPath(editValue.trim() || '/'); setIsEditing(false); }}
          className={cn(
            'flex-1 min-w-0 h-7 px-2 text-sm bg-background border rounded-md',
            'outline-none focus:ring-1 focus:ring-primary font-mono',
          )}
          placeholder="/path/to/folder"
        />
      </div>
    );
  }

  return (
    <div
      className="min-w-0 flex-1"
      onKeyDown={handleKeyDown}
    >
      <BreadcrumbSegments
        segments={segments}
        onSegmentClick={handleSegmentClick}
        onHomeClick={() => navigateToPath(homePath)}
        rootPath={rootPath}
        onDoubleClick={handleDoubleClick}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilePathBreadcrumbs — file mode (receives filePath prop)
// ---------------------------------------------------------------------------

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

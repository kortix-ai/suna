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
import { cn } from '@/lib/utils';
import { HomeSolid } from '@mynaui/icons-react';
import { ArrowUpDown, ChevronRight, Download, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileList } from '../hooks/use-file-list';
import type { SortField } from '../store/files-store';
import { useFilesStore } from '../store/files-store';
import { VersionSelector } from './version-selector';

interface DriveToolbarProps {
  onDownloadDir: () => void;
  isDownloading?: boolean;
  showVersionSelector?: boolean;
}

export function DriveToolbar({
  onDownloadDir,
  isDownloading,
  showVersionSelector = false,
}: DriveToolbarProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const currentPath = useFilesStore((s) => s.currentPath);
  const navigateToPath = useFilesStore((s) => s.navigateToPath);
  const sortBy = useFilesStore((s) => s.sortBy);
  const sortOrder = useFilesStore((s) => s.sortOrder);
  const setSortBy = useFilesStore((s) => s.setSortBy);
  const toggleSortOrder = useFilesStore((s) => s.toggleSortOrder);
  const rootPath = useFilesStore((s) => s.rootPath);

  const { refetch: refetchFiles, isFetching } = useFileList(currentPath);

  const homePath = rootPath || '/workspace';
  const homeLabel = rootPath ? rootPath.split('/').filter(Boolean).pop() || 'root' : '/workspace';

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
                      if (!rootPath && index === 0 && segment === 'workspace') return null;
                      const isLast = index === segments.length - 1;

                      return (
                        <div key={index} className="flex shrink-0 items-center gap-0.5">
                          <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
                          <Button
                            onClick={() => handleSegmentClick(index)}
                            variant="ghost"
                            size="xs"
                            className={cn(
                              'max-w-[140px] shrink-0 truncate sm:max-w-[200px]',
                              isLast ? 'text-foreground font-medium' : 'text-muted-foreground',
                            )}
                          >
                            {segment}
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
                {tHardcodedUi.raw('featuresProjectFilesComponentsDriveToolbar.line262JsxTextSortBy')}
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

          <Separator orientation="vertical" className="data-[orientation=vertical]:h-[70%]" />

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => refetchFiles()}
            disabled={isFetching}
            title="Refresh"
          >
            {isFetching ? <Loading /> : <RefreshCw />}
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
        </div>
      </div>
    </div>
  );
}

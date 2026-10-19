'use client';

import { cn } from '../../../../lib/utils';

import { useFileExplorerSource } from '../explorer-source';
import { useNearViewport } from './file-thumbnail';

/** Two pages tilted out of the folder; widths are the faint preview lines on each. */
const PAGES = [
  { className: 'left-[24%] top-[18%] -rotate-[7deg]', lines: ['w-[70%]', 'w-1/2'] },
  { className: 'left-[33%] top-[13%] rotate-[6deg]', lines: ['w-1/2', 'w-[80%]', 'w-[60%]'] },
] as const;

/**
 * A folder in the grid: a neutral tile, two pages tilted out of a front
 * pocket, and the number of items on the pocket. Neutral on purpose: the list
 * and the grid read the same, and color is left for state (a drop target).
 */
export function DriveFolderThumbnail({ path, className }: { path: string; className?: string }) {
  const [nearRef, near] = useNearViewport<HTMLDivElement>();
  return (
    <div
      ref={nearRef}
      className={cn(
        'bg-card relative overflow-hidden rounded-lg',
        className,
      )}
    >
      {PAGES.map((page, i) => (
        <div
          key={i}
          aria-hidden
          className={cn(
            'bg-background border-border absolute flex h-[76%] w-[44%] flex-col gap-1.5 rounded-md border p-2.5',
            page.className,
          )}
        >
          {page.lines.map((w) => (
            <span key={w} className={cn('bg-muted h-[3px] rounded-full', w)} />
          ))}
        </div>
      ))}
      {/* Solid, so the pages stop at its edge instead of showing through. */}
      <div className="bg-muted absolute inset-x-0 bottom-0 flex h-[47%] items-end rounded-t-md px-3 pb-2.5">
        {/* The count lists the folder, so it waits until the tile is near the viewport. */}
        {near ? <FolderItemCount path={path} /> : null}
      </div>
    </div>
  );
}

function FolderItemCount({ path }: { path: string }) {
  const listing = useFileExplorerSource().useFileList(path);
  if (!listing.data) return null;
  const more = listing.hasNextPage || listing.truncated;
  return (
    <span className="text-muted-foreground text-xl leading-none font-semibold tabular-nums">
      {listing.data.length}
      {more ? '+' : ''}
    </span>
  );
}

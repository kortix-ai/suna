'use client';

import { cn } from '@/lib/utils';
import { chalkColors } from '@kortix/shared';

import { useFileExplorerSource } from '../explorer-source';
import { useNearViewport } from './file-thumbnail';

/** Two pages tilted out of the folder; widths are the faint preview lines on each. */
const PAGES = [
  { className: 'left-[24%] top-[18%] -rotate-[7deg]', lines: ['w-[70%]', 'w-1/2'] },
  { className: 'left-[33%] top-[13%] rotate-[6deg]', lines: ['w-1/2', 'w-[80%]', 'w-[60%]'] },
] as const;

/**
 * A folder in the grid: a neutral tile, two pages tilted out of a front
 * pocket, and the number of items on the pocket. The pages wear the folder's
 * chalk colour, picked from its name: one folder, one hue, the same on every
 * visit and for every member. The page in front is the darker tint, the one
 * behind it the lighter.
 */
export function DriveFolderThumbnail({ path, className }: { path: string; className?: string }) {
  const [nearRef, near] = useNearViewport<HTMLDivElement>();
  const chalk = chalkColors(path.split('/').filter(Boolean).pop() ?? path);
  // Back page (index 0): the light tint. Front page: the deeper one, its
  // edge and lines one step toward the hue's ink.
  const deeper = (share: number) =>
    `color-mix(in oklch, ${chalk.foreground} ${share}%, ${chalk.border})`;
  const tints = [
    { fill: chalk.background, edge: chalk.border, line: chalk.border },
    { fill: chalk.border, edge: deeper(25), line: deeper(40) },
  ] as const;
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
            'absolute flex h-[76%] w-[44%] flex-col gap-1.5 rounded-md border p-2.5',
            page.className,
          )}
          style={{ background: tints[i]!.fill, borderColor: tints[i]!.edge }}
        >
          {page.lines.map((w) => (
            <span
              key={w}
              className={cn('h-[3px] rounded-full', w)}
              style={{ background: tints[i]!.line }}
            />
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
    <span className="text-muted-foreground text-base leading-none font-semibold tabular-nums">
      {listing.data.length}
      {more ? '+' : ''}
    </span>
  );
}

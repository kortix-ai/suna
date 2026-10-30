'use client';

import { cn } from '../../../lib/utils';
import { chalkColors } from '@kortix/shared';

import { useFileExplorerSource } from '../explorer-source';
import { useNearViewport } from './file-thumbnail';

/** Lines one page holds; five fit the page's height with room to breathe. */
const LINES_PER_PAGE = 5;
/** Items each line of the back page stands for, so 50+ fills it. */
const ITEMS_PER_BACK_LINE = 10;

/**
 * How full the folder looks: the front page fills first, one line per item up
 * to five, then the back page takes one line per ten more items, up to five.
 *
 *   0 → none · 1 → 1 front · 5 → 5 front · 10 → 5 + 1 · 21 → 5 + 2 · 50+ → 5 + 5
 */
export function folderLines(count: number): { front: number; back: number } {
  const n = Math.max(0, Math.floor(count));
  return {
    front: Math.min(n, LINES_PER_PAGE),
    back: Math.min(Math.ceil(Math.max(0, n - LINES_PER_PAGE) / ITEMS_PER_BACK_LINE), LINES_PER_PAGE),
  };
}

/**
 * Line widths, like ragged text. Each page has its own rhythm so the two
 * never read as one striped block.
 */
const WIDTHS = {
  back: ['w-[60%]', 'w-[75%]', 'w-1/2', 'w-[65%]', 'w-[40%]'],
  front: ['w-[70%]', 'w-1/2', 'w-[80%]', 'w-[60%]', 'w-[45%]'],
} as const;

const PAGE = {
  back: 'left-[24%] top-[18%] -rotate-[7deg]',
  front: 'left-[33%] top-[13%] rotate-[6deg]',
} as const;

/**
 * A folder in the grid: a neutral tile, two pages tilted out of a front
 * pocket, and the number of items on the pocket. The pages wear the folder's
 * chalk colour, picked from its name: one folder, one hue, the same on every
 * visit and for every member. The front page is the deeper tint, the back one
 * the lighter. Their lines show how full the folder is (`folderLines`).
 */
export function DriveFolderThumbnail({ path, className }: { path: string; className?: string }) {
  const [nearRef, near] = useNearViewport<HTMLDivElement>();
  return (
    <div ref={nearRef} className={cn('bg-card relative overflow-hidden rounded-lg', className)}>
      {/* The listing waits until the tile is near the viewport; until then the
          pages show no lines rather than a guess. */}
      {near ? <FolderContents path={path} /> : <FolderPages name={path} count={null} />}
    </div>
  );
}

function FolderContents({ path }: { path: string }) {
  const listing = useFileExplorerSource().useFileList(path);
  const count = listing.data?.length ?? null;
  const more = listing.hasNextPage || listing.truncated;
  return (
    <>
      <FolderPages name={path} count={count} />
      {count !== null ? (
        <span className="text-muted-foreground absolute bottom-2.5 left-3 text-base leading-none font-semibold tabular-nums">
          {count}
          {more ? '+' : ''}
        </span>
      ) : null}
    </>
  );
}

export function FolderPages({
  name,
  count,
  pocket = true,
}: {
  name: string;
  count: number | null;
  /** The solid front pocket the pages sit in. Off: just the two pages. */
  pocket?: boolean;
}) {
  const chalk = chalkColors(name.split('/').filter(Boolean).pop() ?? name);
  // The front page's edge and lines sit one step toward the hue's ink.
  const deeper = (share: number) => `color-mix(in oklch, ${chalk.foreground} ${share}%, ${chalk.border})`;
  const lines = count === null ? { front: 0, back: 0 } : folderLines(count);
  const pages = [
    { key: 'back', fill: chalk.background, edge: chalk.border, line: chalk.border, n: lines.back },
    { key: 'front', fill: chalk.border, edge: deeper(25), line: deeper(40), n: lines.front },
  ] as const;
  return (
    <>
      {pages.map((page) => (
        <div
          key={page.key}
          aria-hidden
          className={cn(
            'absolute flex h-[76%] w-[44%] flex-col gap-1.5 rounded-md border p-2.5',
            PAGE[page.key],
          )}
          style={{ background: page.fill, borderColor: page.edge }}
        >
          {WIDTHS[page.key].slice(0, page.n).map((w) => (
            <span key={w} className={cn('h-[3px] shrink-0 rounded-full', w)} style={{ background: page.line }} />
          ))}
        </div>
      ))}
      {/* Solid, so the pages stop at its edge instead of showing through. */}
      {pocket ? <div className="bg-muted absolute inset-x-0 bottom-0 h-[47%] rounded-t-md" /> : null}
    </>
  );
}

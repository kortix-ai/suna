'use client';

import { CaretRightIcon } from '@phosphor-icons/react';

import type { SubprojectRun } from '@kortix/sdk';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { cn } from '@/lib/utils';
import { SubprojectRunAge } from './subproject-run-age';
import { SubprojectRunDot } from './subproject-run-dot';
import { subprojectReportHref, subprojectRunStrip, latestRun } from './subproject-runs';
import { subprojectVisual } from './subproject-visual';

/** How many circles survive at each breakpoint. The strip is `shrink-0` — it
 *  has to be, or the circles would squash into ellipses — so without this a
 *  12-run strip eats the whole row at 420px and crushes the subproject name down to
 *  a single letter. Verified: at 420px "Dependency Watch" rendered as "D".
 *
 *  The circles that drop are the OLDEST. On a phone the newest runs are the
 *  only ones worth the width, and the subproject's own page carries the full
 *  history. */
const STRIP_VISIBLE_BASE = 5;
const STRIP_VISIBLE_SM = 8;

/** Visibility class for a circle, by how far it sits from the newest run.
 *  Pure CSS: no measurement, no layout shift, no resize listener. */
function stripVisibilityClass(distanceFromNewest: number): string | undefined {
  if (distanceFromNewest < STRIP_VISIBLE_BASE) return undefined;
  if (distanceFromNewest < STRIP_VISIBLE_SM) return 'hidden sm:block';
  return 'hidden lg:block';
}

/**
 * One subproject's runs as a single row: the subproject on the left, its recent runs as
 * status circles on the right, the newest run's age last.
 *
 * TWO links, never one nested inside the other: the subproject name opens that
 * subproject's report page, each circle opens its own session. A row-wide link
 * wrapping the circles would be invalid HTML and would swallow every circle
 * click, which is the only interaction this surface exists for.
 *
 * Keyed on the subproject SLUG, and given its `title` directly, because a run report
 * must render for a subproject the store index no longer carries: an install is
 * recorded in the project's manifest and outlives its catalogue entry
 * (`project_subprojects.subproject_id` is `ON DELETE SET NULL` for exactly that reason).
 * Reading the title from the index would blank the row.
 *
 * The subproject's icon renders MUTED here, not in its tinted tile. On this surface
 * the status circles are the only thing that may spend color — a column of
 * tinted tiles down the left edge would compete with the green and red that
 * carry the actual information.
 */
export function SubprojectReportRow({
  projectId,
  slug,
  title,
  runs,
  runLimit,
  now,
  glass = false,
}: {
  projectId: string;
  slug: string;
  title: string;
  /** This subproject's runs, newest first, as the API returns them. */
  runs: readonly SubprojectRun[];
  /** How many of the most recent runs the strip shows. */
  runLimit: number;
  /** One clock for the whole list, so no two rows disagree by a minute. */
  now?: number;
  /** Translucent fill for surfaces painted over the wallpaper (project home). */
  glass?: boolean;
}) {
  const { Icon } = subprojectVisual(slug);
  const strip = subprojectRunStrip(runs, runLimit);
  const latest = latestRun(runs);

  return (
    <li
      className={cn(
        'hover:border-foreground/20 flex items-center gap-3 rounded-md border px-3 py-2 transition-colors duration-150',
        glass ? 'bg-background/60 backdrop-blur-sm' : 'bg-popover',
      )}
    >
      <HoverPrefetchLink
        href={subprojectReportHref(projectId, slug)}
        className="group/name text-foreground flex min-w-0 flex-1 items-center gap-2"
      >
        <Icon weight="fill" className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="truncate text-sm font-medium">{title}</span>
        <CaretRightIcon
          className="text-muted-foreground size-3 shrink-0 -translate-x-0.5 opacity-0 transition-[opacity,transform] duration-150 group-hover/name:translate-x-0 group-hover/name:opacity-100"
          aria-hidden
        />
      </HoverPrefetchLink>

      {/* Oldest → newest, left to right, so the newest circle sits beside the
          age column and the strip reads as a timeline. `-mr-1` pulls the last
          circle's 24px hit box back to the row's optical right edge. */}
      <ul className="-mr-1 flex shrink-0 items-center gap-1.5">
        {strip.map((run, index) => (
          <li key={run.execution_id} className={stripVisibilityClass(strip.length - 1 - index)}>
            <SubprojectRunDot projectId={projectId} run={run} now={now} />
          </li>
        ))}
      </ul>

      <SubprojectRunAge iso={latest?.created_at ?? null} now={now} heading="Time since last run" />
    </li>
  );
}

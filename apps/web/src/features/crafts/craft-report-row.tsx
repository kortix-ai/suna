'use client';

import { CaretRightIcon } from '@phosphor-icons/react';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { SESSION_DISPLAY_STATUS_LABELS } from '@/components/projects/session-label';
import { SessionStatusDot } from '@/components/projects/session-status-dot';
import { cn } from '@/lib/utils';
import {
  agoLabel,
  craftReportHref,
  craftRunHref,
  craftRunStrip,
  type CraftReport,
  type CraftRun,
} from './craft-runs';
import type { Craft } from './crafts-catalog';

/** Fixed-width relative-time column, so the strip's right edge never reflows
 *  row to row. Same idea and same `tabular-nums` as the sidebar's session
 *  time column. */
const AGO_COLUMN_CLASS = 'text-muted-foreground/60 w-8 shrink-0 text-right text-xs tabular-nums';

/** How many circles survive at each breakpoint. The strip is `shrink-0` — it
 *  has to be, or the circles would squash into ellipses — so without this a
 *  12-run strip eats the whole row at 420px and crushes the craft name down to
 *  a single letter. Verified: at 420px "Dependency Watch" rendered as "D".
 *
 *  The circles that drop are the OLDEST. On a phone the newest runs are the
 *  only ones worth the width, and the craft's own page carries the full
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
 * One status circle in a run strip. The circle IS the link to the run's
 * session — the whole point of the report surface. Its 24px box, not the 16px
 * glyph, is the hit area: a 16px target is under the 24px minimum and the
 * circles sit 6px apart.
 *
 * The tooltip carries the three things the glyph cannot: which state it is,
 * how long ago, and what the run delivered. Tooltip ground is `bg-foreground`,
 * so the secondary line is `text-background/60` — `text-muted-foreground`
 * would be muted against the WRONG ground and read as invisible.
 */
function CraftRunDot({ projectId, run }: { projectId: string; run: CraftRun }) {
  return (
    <HoverPrefetchLink
      href={craftRunHref(projectId, run)}
      aria-label={`${SESSION_DISPLAY_STATUS_LABELS[run.status]} — ${agoLabel(run.minutesAgo)} ago — ${run.summary}`}
      className="hover:bg-muted flex size-6 shrink-0 items-center justify-center rounded-sm transition-colors duration-150 active:scale-95"
    >
      <SessionStatusDot
        status={run.status}
        hintSide="top"
        label={
          <span className="block max-w-52 text-xs">
            <span className="font-medium">{SESSION_DISPLAY_STATUS_LABELS[run.status]}</span>
            <span className="text-background/60"> · {agoLabel(run.minutesAgo)} ago</span>
            <span className="text-background/60 mt-0.5 block text-pretty">{run.summary}</span>
          </span>
        }
      />
    </HoverPrefetchLink>
  );
}

/**
 * One craft's run report as a single row: the craft on the left, its recent
 * runs as session status circles on the right, the newest run's age last.
 *
 * TWO links, never one nested inside the other: the craft name opens that
 * craft's report page, each circle opens its own session. A row-wide link
 * wrapping the circles would be invalid HTML and would swallow every circle
 * click, which is the only interaction this surface exists for.
 *
 * The craft's icon renders MUTED here, not in its tinted `bgColor` tile. On
 * this surface the status circles are the only thing that may spend color —
 * nine tinted tiles down the left edge would compete with the green and red
 * that carry the actual information.
 */
export function CraftReportRow({
  projectId,
  craft,
  report,
  runLimit,
  glass = false,
}: {
  projectId: string;
  craft: Craft;
  report: CraftReport;
  /** How many of the most recent runs the strip shows. */
  runLimit: number;
  /** Translucent fill for surfaces painted over the wallpaper (project home). */
  glass?: boolean;
}) {
  const Icon = craft.icon;
  const strip = craftRunStrip(report, runLimit);
  const latest = report.runs[0];

  return (
    <li
      className={cn(
        'hover:border-foreground/20 flex items-center gap-3 rounded-md border px-3 py-2 transition-colors duration-150',
        glass ? 'bg-background/60 backdrop-blur-sm' : 'bg-popover',
      )}
    >
      <HoverPrefetchLink
        href={craftReportHref(projectId, craft.id)}
        className="group/name text-foreground flex min-w-0 flex-1 items-center gap-2"
      >
        <Icon weight="fill" className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="truncate text-sm font-medium">{craft.title}</span>
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
          <li key={run.sessionId} className={stripVisibilityClass(strip.length - 1 - index)}>
            <CraftRunDot projectId={projectId} run={run} />
          </li>
        ))}
      </ul>

      <span className={AGO_COLUMN_CLASS}>{latest ? agoLabel(latest.minutesAgo) : '—'}</span>
    </li>
  );
}

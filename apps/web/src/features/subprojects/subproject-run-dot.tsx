'use client';

import type { SubprojectRun } from '@kortix/sdk';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { SessionStatusDot } from '@/components/projects/session-status-dot';
import { agoLabel, subprojectRunHref, subprojectRunStatusLabel, runSummary } from './subproject-runs';

/**
 * One status circle in a run strip. The circle IS the link to the run's
 * session — the whole point of the report surface. Its 24px box, not the 16px
 * glyph, is the hit area: a 16px target is under the 24px minimum and the
 * circles sit 6px apart.
 *
 * A run with NO session is not a link. That is a real state, not an edge case:
 * a queued fire has not created one yet, a skipped fire never will, and the FK
 * is `ON DELETE SET NULL` so a cleaned-up session leaves the run behind. The
 * mock linked every circle to a synthetic id and every one of them 404'd; a
 * circle that cannot go anywhere must not look clickable.
 *
 * The tooltip carries the three things the glyph cannot: which state it is,
 * how long ago, and what the run delivered. Tooltip ground is `bg-foreground`,
 * so the secondary line is `text-background/60` — `text-muted-foreground`
 * would be muted against the WRONG ground and read as invisible.
 */
export function SubprojectRunDot({
  projectId,
  run,
  now,
}: {
  projectId: string;
  run: SubprojectRun;
  /** One clock for the whole render, so sibling rows never disagree by a minute. */
  now?: number;
}) {
  const href = subprojectRunHref(projectId, run);
  const status = subprojectRunStatusLabel(run.status);
  const ago = agoLabel(run.created_at, now);
  const summary = runSummary(run);

  const dot = (
    <SessionStatusDot
      status={run.status}
      hintSide="top"
      label={
        <span className="block max-w-52 text-xs">
          <span className="font-medium">{status}</span>
          <span className="text-background/60"> · {ago}</span>
          <span className="text-background/60 mt-0.5 block text-pretty">{summary}</span>
        </span>
      }
    />
  );

  if (!href) {
    return (
      <span
        aria-label={`${status} — ${ago} — ${summary}`}
        className="flex size-6 shrink-0 items-center justify-center rounded-sm"
      >
        {dot}
      </span>
    );
  }

  return (
    <HoverPrefetchLink
      href={href}
      aria-label={`${status} — ${ago} — ${summary}`}
      className="hover:bg-muted flex size-6 shrink-0 items-center justify-center rounded-sm transition-colors duration-150 active:scale-95"
    >
      {dot}
    </HoverPrefetchLink>
  );
}

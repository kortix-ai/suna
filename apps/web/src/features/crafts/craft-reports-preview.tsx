'use client';

import { ArrowRightIcon } from '@phosphor-icons/react';
import { useMemo } from 'react';

import { useProjectCraftRuns, useProjectCrafts } from '@kortix/sdk/react';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { useNow } from '@/hooks/use-now';
import { craftReportGroups } from './craft-report-groups';
import { CraftReportRow } from './craft-report-row';
import { craftReportsHref } from './craft-runs';

/** Five rows is the whole point of the home panel: enough to answer "did my
 *  crafts run, and did anything break" without turning the home page into a
 *  dashboard. Everything else is one click away at `/crafts/runs`. */
const HOME_REPORT_LIMIT = 5;
/** Six circles fit the 52rem hero box beside the longest craft title without
 *  the strip ever pushing the name into a truncation. */
const HOME_RUN_LIMIT = 6;

/**
 * The project-home craft-run panel — the five most recently run crafts, each
 * with its recent runs as status circles, plus the link to the full report
 * index. First panel under the composer, in the same 52rem hero box, with the
 * installable-crafts grid below it; shares that grid's `glass` treatment over
 * the wallpaper. `mt-10` is the clear air below the input.
 *
 * Renders nothing while loading, on error, or when no craft has run. On the
 * project home that is deliberate three times over: a skeleton row under the
 * composer draws the eye to furniture, an error panel here reports a failure
 * the reader did not ask about, and an empty panel is noise — the crafts grid
 * below already carries the "install something" call to action.
 */
export function CraftReportsPreview({ projectId }: { projectId: string }) {
  const runsQuery = useProjectCraftRuns(projectId);
  const installed = useProjectCrafts(projectId);

  const groups = useMemo(
    () =>
      craftReportGroups(runsQuery.data?.runs ?? [], installed.data?.crafts ?? []).slice(
        0,
        HOME_REPORT_LIMIT,
      ),
    [runsQuery.data, installed.data],
  );
  const now = useNow();

  if (groups.length === 0) return null;

  return (
    <div data-craft-reports-preview className="mt-10 w-full space-y-2.5">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          Recent craft runs
        </p>
        <HoverPrefetchLink
          href={craftReportsHref(projectId)}
          className="group text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-medium transition-colors duration-150"
        >
          View all runs
          <ArrowRightIcon
            className="size-3 transition-transform duration-150 group-hover:translate-x-0.5"
            aria-hidden
          />
        </HoverPrefetchLink>
      </div>

      <ul className="space-y-1.5">
        {groups.map((group) => (
          <CraftReportRow
            key={group.slug}
            projectId={projectId}
            slug={group.slug}
            title={group.title}
            runs={group.runs}
            runLimit={HOME_RUN_LIMIT}
            now={now}
            glass
          />
        ))}
      </ul>
    </div>
  );
}

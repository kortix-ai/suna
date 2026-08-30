'use client';

import { ArrowRightIcon } from '@phosphor-icons/react';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { craftReportEntries } from './craft-report-entries';
import { CraftReportRow } from './craft-report-row';
import { craftReportsHref } from './craft-runs';

/** Five rows is the whole point of the home panel: enough to answer "did my
 *  crafts run, and did anything break" without turning the home page into a
 *  dashboard. Everything else is one click away at `/craft-reports`. */
const HOME_REPORT_LIMIT = 5;
/** Six circles fit the 52rem hero box beside the longest craft title without
 *  the strip ever pushing the name into a truncation. */
const HOME_RUN_LIMIT = 6;

/**
 * The project-home craft-run panel — the five most recently run crafts, each
 * with its recent runs as session status circles, plus the link to the full
 * report index. First panel under the composer, in the same 52rem hero box,
 * with the installable-crafts grid below it; shares that grid's `glass`
 * treatment over the wallpaper. `mt-10` is the clear air below the input.
 *
 * Renders nothing when no craft has run: an empty panel on the project home
 * is noise, and the crafts grid above already carries the "install something"
 * call to action.
 */
export function CraftReportsPreview({ projectId }: { projectId: string }) {
  const entries = craftReportEntries().slice(0, HOME_REPORT_LIMIT);
  if (entries.length === 0) return null;

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
        {entries.map(({ craft, report }) => (
          <CraftReportRow
            key={craft.id}
            projectId={projectId}
            craft={craft}
            report={report}
            runLimit={HOME_RUN_LIMIT}
            glass
          />
        ))}
      </ul>
    </div>
  );
}

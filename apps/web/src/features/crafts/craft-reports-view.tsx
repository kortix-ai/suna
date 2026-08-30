'use client';

import { ArrowRightIcon } from '@phosphor-icons/react';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { craftReportEntries } from './craft-report-entries';
import { CraftReportRow } from './craft-report-row';
import { CraftRunLegend } from './craft-run-legend';
import { craftReportStats } from './craft-runs';

/** The index shows a wider window than the home panel — this page exists to
 *  look back, so it trades the hero box's width limit for run history. */
const INDEX_RUN_LIMIT = 12;

/**
 * `/projects/[id]/craft-reports` — every craft that has run in this project,
 * most recently run first, each as one row of session status circles.
 *
 * The header carries the three numbers that decide whether the page needs
 * attention at all: how many crafts ran, how many runs those were, and how
 * many failed. A failure count of 0 renders muted like the rest; only a real
 * failure earns red. Green is never spent here — the circles own it.
 *
 * UI phase: rows read the static `CRAFT_REPORTS` mock. There is no filter,
 * search, or date range yet, and adding them before the real data exists
 * would be guessing at the shape of a query nobody has written.
 */
export function CraftReportsView({ projectId }: { projectId: string }) {
  const entries = craftReportEntries();
  const totals = entries.reduce(
    (acc, entry) => {
      const stats = craftReportStats(entry.report);
      return { runs: acc.runs + stats.total, failed: acc.failed + stats.failed };
    },
    { runs: 0, failed: 0 },
  );

  return (
    <div data-craft-reports className="mx-auto w-full max-w-4xl space-y-8 px-4 pt-8 pb-16 sm:px-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-foreground text-2xl font-semibold tracking-tight">Craft runs</h1>
          <p className="text-muted-foreground max-w-xl text-sm text-balance">
            Every run each craft has made in this project. Open a circle to read the session it came
            from, or open a craft for its full history.
          </p>
        </div>
        <HoverPrefetchLink
          href={`/projects/${projectId}/crafts`}
          className="group text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 text-sm font-medium transition-colors duration-150"
        >
          Browse crafts
          <ArrowRightIcon
            className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5"
            aria-hidden
          />
        </HoverPrefetchLink>
      </header>

      {entries.length === 0 ? (
        <div className="bg-popover flex flex-col items-center rounded-md border px-4 py-10 text-center">
          <p className="text-foreground text-sm font-medium">No craft has run yet</p>
          <p className="text-muted-foreground mt-1 max-w-sm text-xs text-balance">
            Install a craft and its runs land here — one row per craft, one circle per run.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Counts and key on one line: both are page furniture, and stacking
              them would put two rows of chrome above the content. */}
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <CraftRunLegend />
            <p className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {entries.length} craft{entries.length === 1 ? '' : 's'} &middot; {totals.runs} runs
              &middot;{' '}
              <span className={totals.failed > 0 ? 'text-kortix-red' : undefined}>
                {totals.failed} failed
              </span>
            </p>
          </div>

          <ul className="space-y-1.5">
            {entries.map(({ craft, report }) => (
              <CraftReportRow
                key={craft.id}
                projectId={projectId}
                craft={craft}
                report={report}
                runLimit={INDEX_RUN_LIMIT}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

'use client';

import { ArrowRightIcon } from '@phosphor-icons/react';
import { useMemo } from 'react';

import { useProjectSubprojectRuns, useProjectSubprojects } from '@kortix/sdk/react';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useNow } from '@/hooks/use-now';
import { subprojectReportGroups } from './subproject-report-groups';
import { SubprojectReportRow } from './subproject-report-row';
import { SubprojectRunLegend } from './subproject-run-legend';
import { subprojectsHref } from './subproject-runs';
import { countLabel } from './subprojects-catalog';

/** The index shows a wider window than the home panel — this page exists to
 *  look back, so it trades the hero box's width limit for run history. */
const INDEX_RUN_LIMIT = 12;

/**
 * `/projects/[id]/subprojects/runs` — every subproject that has run in this project,
 * most recently run first, each as one row of status circles.
 *
 * The header carries the three numbers that decide whether the page needs
 * attention at all: how many subprojects ran, how many runs those were, and how
 * many failed. A failure count of 0 renders muted like the rest; only a real
 * failure earns red. Green is never spent here — the circles own it.
 *
 * There is no filter, search, or date range. The API paginates, so the honest
 * next step is a "load more" over `offset`, not a client-side filter over one
 * page that would silently exclude what it has not fetched.
 */
export function SubprojectReportsView({ projectId }: { projectId: string }) {
  const runsQuery = useProjectSubprojectRuns(projectId);
  const installed = useProjectSubprojects(projectId);

  const groups = useMemo(
    () => subprojectReportGroups(runsQuery.data?.runs ?? [], installed.data?.subprojects ?? []),
    [runsQuery.data, installed.data],
  );
  const totals = useMemo(
    () => ({
      runs: runsQuery.data?.total ?? 0,
      failed: (runsQuery.data?.runs ?? []).filter((run) => run.status === 'failed').length,
    }),
    [runsQuery.data],
  );
  const now = useNow();

  return (
    <div
      data-subproject-reports
      className="mx-auto w-full max-w-4xl space-y-8 px-4 pt-8 pb-16 sm:px-6"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-foreground text-2xl font-semibold tracking-tight">Subproject runs</h1>
          <p className="text-muted-foreground max-w-xl text-sm text-balance">
            Every run each subproject has made in this project. Open a circle to read the session it
            came from, or open a subproject for its full history.
          </p>
        </div>
        {/* The store, which is the Marketplace tab under Customize — this page
            is the only entry point back to it from a run report, so it goes
            through `subprojectsHref` rather than naming the segment. */}
        <HoverPrefetchLink
          href={subprojectsHref(projectId)}
          className="group text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 text-sm font-medium transition-colors duration-150"
        >
          Browse subprojects
          <ArrowRightIcon
            className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5"
            aria-hidden
          />
        </HoverPrefetchLink>
      </header>

      {runsQuery.isLoading ? (
        <ul className="space-y-1.5">
          {Array.from({ length: 5 }, (_, index) => (
            <li key={index}>
              <Skeleton className="h-11 w-full rounded-md" />
            </li>
          ))}
        </ul>
      ) : runsQuery.isError ? (
        <ErrorState
          size="sm"
          title="Could not load subproject runs"
          description={runsQuery.error instanceof Error ? runsQuery.error.message : undefined}
          action={
            <Button variant="outline" size="sm" onClick={() => void runsQuery.refetch()}>
              Retry
            </Button>
          }
        />
      ) : groups.length === 0 ? (
        <EmptyState
          size="sm"
          title="No subproject has run yet"
          description="Install a subproject and its runs land here — one row per subproject, one circle per run."
        />
      ) : (
        <div className="space-y-4">
          {/* Counts and key on one line: both are page furniture, and stacking
              them would put two rows of chrome above the content. */}
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <SubprojectRunLegend />
            <p className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {countLabel(groups.length, 'subproject')} &middot; {countLabel(totals.runs, 'run')}{' '}
              &middot;{' '}
              <span className={totals.failed > 0 ? 'text-kortix-red' : undefined}>
                {totals.failed} failed
              </span>
            </p>
          </div>

          <ul className="space-y-1.5">
            {groups.map((group) => (
              <SubprojectReportRow
                key={group.slug}
                projectId={projectId}
                slug={group.slug}
                title={group.title}
                runs={group.runs}
                runLimit={INDEX_RUN_LIMIT}
                now={now}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

'use client';

import { ArrowLeftIcon, ArrowSquareOutIcon, GitCommitIcon } from '@phosphor-icons/react';
import { useMemo } from 'react';

import { useCraftRuns, useProjectCrafts } from '@kortix/sdk/react';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { useNow } from '@/hooks/use-now';
import { SessionStatusDot } from '@/components/projects/session-status-dot';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { cn } from '@/lib/utils';
import { CraftRunAge } from './craft-run-age';
import { CraftRunDot } from './craft-run-dot';
import { CraftRunLegend } from './craft-run-legend';
import {
  agoLabel,
  avgDurationLabel,
  craftReportsHref,
  craftRunHref,
  craftRunStrip,
  craftRunStatusLabel,
  durationLabel,
  runSummary,
  successRateLabel,
} from './craft-runs';
import { craftVisual } from './craft-visual';

/** One header statistic. Value on top at panel-title scale, label under it —
 *  the number is what the reader came for, so it leads. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="space-y-0.5 px-4 py-3">
      <p className={cn('text-foreground text-lg font-semibold tabular-nums', tone)}>{value}</p>
      <p className="text-muted-foreground text-xs">{label}</p>
    </div>
  );
}

/**
 * `/projects/[id]/crafts/runs/[craftSlug]` — one craft's run history.
 *
 * Three layers, coarse to fine: the four numbers that summarize the craft, the
 * complete run strip (the same circles as every other surface, so the shape of
 * the history is legible at a glance), then one row per run with its summary,
 * length, and age.
 *
 * The run list repeats the circles rather than switching to text badges. A
 * second visual vocabulary for the same seven states is how a user ends up
 * having to learn this screen instead of reading it.
 *
 * Identity comes from the project's INSTALLED list, not the store index. The
 * craft may have been withdrawn from the index since it was installed, and this
 * page must still render its history — the runs are the project's, not the
 * catalogue's.
 */
export function CraftReportDetail({
  projectId,
  craftSlug,
}: {
  projectId: string;
  craftSlug: string;
}) {
  const report = useCraftRuns(projectId, craftSlug);
  const installed = useProjectCrafts(projectId);
  const entry = useMemo(
    () => (installed.data?.crafts ?? []).find((craft) => craft.slug === craftSlug) ?? null,
    [installed.data, craftSlug],
  );

  const { Icon, color, bgColor } = craftVisual(craftSlug);
  const runs = report.data?.runs ?? [];
  const stats = report.data?.stats;
  const strip = craftRunStrip(runs, runs.length);
  const now = useNow();

  return (
    <div data-craft-report className="mx-auto w-full max-w-4xl space-y-6 px-4 pt-8 pb-16 sm:px-6">
      <HoverPrefetchLink
        href={craftReportsHref(projectId)}
        className="group text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs font-medium transition-colors duration-150"
      >
        <ArrowLeftIcon
          className="size-3 transition-transform duration-150 group-hover:-translate-x-0.5"
          aria-hidden
        />
        Craft runs
      </HoverPrefetchLink>

      <header className="space-y-3">
        <div className="flex items-start gap-3">
          {/* The craft's tinted tile belongs HERE and only here: one craft on
              the page, so its color identifies the subject instead of
              competing with the status circles the way a column of tiles in a
              list would. */}
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-md',
              bgColor,
              color,
            )}
          >
            <Icon weight="fill" className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 space-y-1">
            <h1 className="text-foreground text-2xl font-semibold tracking-tight">
              {entry?.title || craftSlug}
            </h1>
            <p className="text-muted-foreground max-w-xl text-sm text-pretty">
              {entry
                ? `Installed from ${entry.repo}${entry.version ? ` (${entry.version})` : ''}.`
                : 'This craft is no longer in the project manifest. Its past runs are kept.'}
            </p>
          </div>
        </div>

        {/* Provenance: where it came from and the exact commit it was installed
            at. The sha is the answer to "which version of this craft ran", so
            it is shown rather than hidden behind the repo link. */}
        {entry ? (
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <a
              href={`https://github.com/${entry.repo}`}
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-foreground inline-flex items-center gap-1.5 transition-colors duration-150"
            >
              <span className="font-mono">{entry.repo}</span>
              <ArrowSquareOutIcon className="size-3" aria-hidden />
            </a>
            {entry.sha ? (
              <span className="inline-flex items-center gap-1">
                <GitCommitIcon className="size-3" aria-hidden />
                <span className="font-mono">{entry.sha.slice(0, 7)}</span>
              </span>
            ) : null}
            {entry.installed_at ? <span>installed {agoLabel(entry.installed_at, now)}</span> : null}
          </div>
        ) : null}
      </header>

      {report.isLoading ? (
        <div className="space-y-6">
          <Skeleton className="h-[74px] w-full rounded-md" />
          <Skeleton className="h-[46px] w-full rounded-md" />
        </div>
      ) : report.isError ? (
        <ErrorState
          size="sm"
          title="Could not load this craft's runs"
          description={report.error instanceof Error ? report.error.message : undefined}
          action={
              <Button variant="outline" size="sm" onClick={() => void report.refetch()}>
                Retry
              </Button>
            }
        />
      ) : (
        <>
          {/* Flat divided panel, not four cards: the numbers are one reading,
              and four bordered boxes would read as four unrelated facts. */}
          <div className="bg-popover grid grid-cols-2 divide-x divide-y rounded-md border sm:grid-cols-4 sm:divide-y-0">
            <Stat label="Runs" value={String(report.data?.total ?? 0)} />
            {/* "Success rate", not "Succeeded": the denominator is settled
                runs, so `100%` beside `6 Runs` must not read as "6 of 6
                succeeded" when two of those six are still open or were
                stopped by hand. */}
            <Stat label="Success rate" value={successRateLabel(stats?.successRate ?? null)} />
            <Stat
              label="Failed"
              value={String(stats?.failed ?? 0)}
              tone={(stats?.failed ?? 0) > 0 ? 'text-kortix-red' : undefined}
            />
            <Stat label="Avg length" value={avgDurationLabel(stats?.avgDurationSeconds ?? null)} />
          </div>

          {runs.length === 0 ? (
            <EmptyState
              size="sm"
              title="No runs yet"
              description="This craft's triggers have not fired in this project. A run appears here on the first fire."
            />
          ) : (
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                <h2 className="text-foreground text-sm font-medium">Run history</h2>
                <CraftRunLegend />
              </div>

              {/* The whole history as one strip — oldest left. This is where a
                  pattern shows itself: three reds in a row is a broken craft,
                  three reds spread over months is noise. */}
              <div className="bg-popover flex flex-wrap items-center gap-1.5 rounded-md border px-3 py-2.5">
                {strip.map((run) => (
                  <CraftRunDot key={run.execution_id} projectId={projectId} run={run} now={now} />
                ))}
              </div>

              {/* Newest first here: a list is read top-down, so the most recent
                  run is the first thing under the heading. The strip above is a
                  timeline and runs the other way — different job, different
                  order. */}
              <ul className="space-y-1.5">
                {runs.map((run) => {
                  const href = craftRunHref(projectId, run);
                  const body = (
                    <>
                      {/* No tooltip: the summary sits right beside the glyph,
                          so a hover repeating the status is noise. */}
                      <SessionStatusDot status={run.status} hint={false} />
                      <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                        {runSummary(run)}
                      </span>
                      <span className="text-muted-foreground hidden shrink-0 text-xs tabular-nums sm:block">
                        {durationLabel(run.duration_ms)}
                      </span>
                      <CraftRunAge iso={run.created_at} now={now} heading="Run queued" />
                    </>
                  );
                  const rowClass =
                    'bg-popover flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors duration-150';
                  return (
                    <li key={run.execution_id}>
                      {href ? (
                        <HoverPrefetchLink
                          href={href}
                          className={cn(rowClass, 'hover:border-foreground/20')}
                        >
                          {body}
                        </HoverPrefetchLink>
                      ) : (
                        // No session to open. A row that looked like a link and
                        // went nowhere is exactly the mock's 404 bug.
                        <div className={rowClass}>{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

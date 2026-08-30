'use client';

import { ArrowLeftIcon, ArrowSquareOutIcon, StarIcon } from '@phosphor-icons/react';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { SESSION_DISPLAY_STATUS_LABELS } from '@/components/projects/session-label';
import { SessionStatusDot } from '@/components/projects/session-status-dot';
import { cn } from '@/lib/utils';
import { notFound } from 'next/navigation';
import { craftReportEntry } from './craft-report-entries';
import { CraftRunLegend } from './craft-run-legend';
import {
  agoLabel,
  craftReportsHref,
  craftReportStats,
  craftRunHref,
  craftRunStrip,
  durationLabel,
} from './craft-runs';
import { craftRepoSlug, craftRepoUrl, formatCount } from './crafts-catalog';

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
 * `/projects/[id]/craft-reports/[craftId]` — one craft's full run history.
 *
 * Three layers, coarse to fine: the four numbers that summarize the craft, the
 * complete run strip (the same circles as every other surface, so the shape of
 * the history is legible at a glance), then one row per run with its summary,
 * length, and age.
 *
 * The run list repeats the circles rather than switching to text badges. A
 * second visual vocabulary for the same five states is how a user ends up
 * having to learn this screen instead of reading it.
 */
export function CraftReportDetail({ projectId, craftId }: { projectId: string; craftId: string }) {
  // The route already 404'd an unknown report through the catalog-free check;
  // the join runs here because the catalog cannot be imported from an RSC. A
  // null at this point means the mock and the catalog drifted, so `notFound`
  // is the honest answer rather than a half-rendered page.
  const entry = craftReportEntry(craftId);
  if (!entry) notFound();
  const { craft, report } = entry;
  const Icon = craft.icon;
  const stats = craftReportStats(report);
  const strip = craftRunStrip(report, report.runs.length);

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
              competing with the status circles the way nine tiles in a list
              would. */}
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-md',
              craft.bgColor,
              craft.color,
            )}
          >
            <Icon weight="fill" className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 space-y-1">
            <h1 className="text-foreground text-2xl font-semibold tracking-tight">{craft.title}</h1>
            <p className="text-muted-foreground max-w-xl text-sm text-pretty">
              {craft.description}
            </p>
          </div>
        </div>

        <a
          href={craftRepoUrl(craft)}
          target="_blank"
          rel="noreferrer noopener"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs transition-colors duration-150"
        >
          <span className="font-mono">{craftRepoSlug(craft)}</span>
          <span aria-hidden className="text-muted-foreground/40">
            &bull;
          </span>
          <span className="inline-flex items-center gap-1 tabular-nums">
            <StarIcon weight="fill" className="size-3" aria-hidden />
            {formatCount(craft.repo.stars)}
          </span>
          <ArrowSquareOutIcon className="size-3" aria-hidden />
        </a>
      </header>

      {/* Flat divided panel, not four cards: the numbers are one reading, and
          four bordered boxes would read as four unrelated facts. */}
      <div className="bg-popover grid grid-cols-2 divide-x divide-y rounded-md border sm:grid-cols-4 sm:divide-y-0">
        <Stat label="Runs" value={String(stats.total)} />
        {/* "Success rate", not "Succeeded": the denominator is settled runs,
            so `100%` beside `6 Runs` must not read as "6 of 6 succeeded" when
            two of those six are still open or were stopped by hand. */}
        <Stat
          label="Success rate"
          value={stats.successRate === null ? '—' : `${stats.successRate}%`}
        />
        <Stat
          label="Failed"
          value={String(stats.failed)}
          tone={stats.failed > 0 ? 'text-kortix-red' : undefined}
        />
        <Stat label="Avg length" value={durationLabel(stats.avgDurationMin)} />
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <h2 className="text-foreground text-sm font-medium">Run history</h2>
          <CraftRunLegend />
        </div>

        {/* The whole history as one strip — oldest left. This is where a
            pattern shows itself: three reds in a row is a broken craft, three
            reds spread over months is noise. */}
        <div className="bg-popover flex flex-wrap items-center gap-1.5 rounded-md border px-3 py-2.5">
          {strip.map((run) => (
            <HoverPrefetchLink
              key={run.sessionId}
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
                    <span className="text-background/60 mt-0.5 block text-pretty">
                      {run.summary}
                    </span>
                  </span>
                }
              />
            </HoverPrefetchLink>
          ))}
        </div>

        {/* Newest first here: a list is read top-down, so the most recent run
            is the first thing under the heading. The strip above is a timeline
            and runs the other way — different job, different order. */}
        <ul className="space-y-1.5">
          {report.runs.map((run) => (
            <li key={run.sessionId}>
              <HoverPrefetchLink
                href={craftRunHref(projectId, run)}
                className="bg-popover hover:border-foreground/20 flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors duration-150"
              >
                <SessionStatusDot status={run.status} hint={false} />
                <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                  {run.summary}
                </span>
                <span className="text-muted-foreground hidden shrink-0 text-xs tabular-nums sm:block">
                  {durationLabel(run.durationMin)}
                </span>
                <span className="text-muted-foreground/60 w-8 shrink-0 text-right text-xs tabular-nums">
                  {agoLabel(run.minutesAgo)}
                </span>
              </HoverPrefetchLink>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

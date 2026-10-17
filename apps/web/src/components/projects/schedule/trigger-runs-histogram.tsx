'use client';

/**
 * The Runs tab's histogram: the loaded runs over time, the Models page Logs
 * histogram (`LogHistogram` in `gateway-logs.tsx`) fed with trigger runs.
 * Same scale, spacing, colours, ticks, card and interaction: 48 equal time
 * slices, bar height = runs per slice, a red cap = the failed share, a card on
 * hover or keyboard focus, and a click narrows the list to that slice.
 */

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import {
  formatSessionCostCredits,
  formatSessionCostDuration,
} from '@/features/billing/session-cost-format';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ProjectTriggerRun } from '@kortix/sdk';
import { Fragment, type ReactNode, useMemo } from 'react';

import { type RunBucket, bucketRuns, medianDuration } from './trigger-runs-logic';

/** A bar's window, epoch ms (`LogTimeRange` in `gateway-logs.tsx`). */
export interface RunTimeRange {
  start: number;
  end: number;
}

/** "10:58 – 11:03 pm": the window's clock range (`fmtRange` in `gateway-logs.tsx`). */
export function fmtRange(range: RunTimeRange): string {
  const clock = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${clock(range.start)} – ${clock(range.end)}`;
}

/** Bars per histogram, as on the Models page. */
const HISTOGRAM_BUCKETS = 48;

const fmtDuration = (ms: number) => formatSessionCostDuration(ms / 1000);

/** What one bar holds, shown on hover or keyboard focus (`LogBucketCard`). */
function RunBucketCard({ bucket }: { bucket: RunBucket }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const stats: [string, ReactNode][] = [
    [
      t.raw('text7bd31a025d29'),
      <span key="failed" className={bucket.failed > 0 ? 'text-destructive' : undefined}>
        {bucket.failed.toLocaleString()}
      </span>,
    ],
    [t.raw('textfa14066e0399'), bucket.medianMs != null ? fmtDuration(bucket.medianMs) : '—'],
    ...(bucket.cost > 0
      ? [[t.raw('text0f046f7588f9'), formatSessionCostCredits(bucket.cost)] as [string, ReactNode]]
      : []),
  ];
  return (
    <div className="flex flex-col gap-2 tabular-nums">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-foreground font-medium whitespace-nowrap">{fmtRange(bucket)}</span>
        <span className="text-muted-foreground whitespace-nowrap">
          {bucket.total.toLocaleString()} {t('texte0ab721ade45', { count: bucket.total })}
        </span>
      </div>
      <div className="border-border border-t" />
      {bucket.total ? (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs">
          {stats.map(([label, value]) => (
            <Fragment key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-foreground text-right">{value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <p className="text-muted-foreground text-xs">{t.raw('text26735edf00f9')}</p>
      )}
    </div>
  );
}

export function RunHistogram({
  runs,
  live,
  onSelectRange,
}: {
  runs: ProjectTriggerRun[];
  /** The newest page is the only page: the last tick reads "Now". */
  live: boolean;
  onSelectRange: (range: RunTimeRange) => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const tLogs = useTranslations('gatewayLogs');
  const buckets = useMemo(() => bucketRuns(runs, HISTOGRAM_BUCKETS), [runs]);
  const failed = useMemo(() => buckets.reduce((n, b) => n + b.failed, 0), [buckets]);
  const median = useMemo(() => medianDuration(runs), [runs]);
  if (buckets.length === 0) return null;
  const peak = Math.max(1, ...buckets.map((b) => b.total));
  const tickAt = [0, 0.25, 0.5, 0.75].map((f) => Math.floor(f * (HISTOGRAM_BUCKETS - 1)));
  const clock = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <section
      aria-label={t.raw('textd2c58b300c07')}
      className="bg-surface ring-border flex flex-col gap-2 rounded-lg px-4 pt-3.5 pb-2.5 ring-1"
    >
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 tabular-nums">
        <span className="flex items-baseline gap-1.5">
          <span className="text-foreground text-sm font-medium">
            {runs.length.toLocaleString()}
          </span>
          <span className="text-muted-foreground text-xs">
            {t('texte0ab721ade45', { count: runs.length })}
          </span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span
            className={cn(
              'text-sm font-medium',
              failed > 0 ? 'text-destructive' : 'text-foreground',
            )}
          >
            {failed.toLocaleString()}
          </span>
          <span className="text-muted-foreground text-xs">
            {t('text611b8edf2e45', { count: failed })}
          </span>
        </span>
        {median != null ? (
          <span className="flex items-baseline gap-1.5">
            <span className="text-foreground text-sm font-medium">{fmtDuration(median)}</span>
            <span className="text-muted-foreground text-xs">{t.raw('textf1a06b0cb2ca')}</span>
          </span>
        ) : null}
      </div>
      {/* `min-w-0 flex-1` bars: the strip shrinks with the column, never scrolls. */}
      <div className="flex h-14 items-end gap-1.5">
        {buckets.map((b) => (
          <HoverCard key={b.start} openDelay={0} closeDelay={0}>
            <HoverCardTrigger asChild>
              <button
                type="button"
                aria-label={`${fmtRange(b)} · ${b.total} ${t('texte0ab721ade45', { count: b.total })}`}
                onClick={() => onSelectRange({ start: b.start, end: b.end })}
                className="group/bar flex h-full min-w-0 flex-1 cursor-pointer items-end outline-none"
              >
                <span
                  className={cn(
                    'flex w-full flex-col overflow-hidden rounded-xs transition-[background-color] duration-(--duration-normal)',
                    b.total
                      ? 'bg-muted-foreground/45 group-hover/bar:bg-foreground/70 group-focus-visible/bar:bg-foreground/70'
                      : 'bg-muted group-hover/bar:bg-muted-foreground/45 group-focus-visible/bar:bg-muted-foreground/45',
                  )}
                  style={{ height: b.total ? `${Math.max(4, (b.total / peak) * 100)}%` : 2 }}
                >
                  {b.failed > 0 ? (
                    <span
                      className="bg-destructive w-full shrink-0"
                      style={{ height: `${Math.max(14, (b.failed / b.total) * 100)}%` }}
                    />
                  ) : null}
                </span>
              </button>
            </HoverCardTrigger>
            <HoverCardContent
              side="bottom"
              align="center"
              sideOffset={6}
              collisionPadding={8}
              animated={false}
              className="w-60 p-3"
            >
              <RunBucketCard bucket={b} />
            </HoverCardContent>
          </HoverCard>
        ))}
      </div>
      <div className="text-muted-foreground flex justify-between text-xs tabular-nums" aria-hidden>
        {tickAt.map((i) => (
          <span key={i}>{clock(buckets[i]!.start)}</span>
        ))}
        <span>{live ? tLogs('now') : clock(buckets[buckets.length - 1]!.end)}</span>
      </div>
    </section>
  );
}

'use client';

/**
 * The Runs tab's histogram: the loaded runs over time, the Models page Logs
 * histogram (`LogHistogram` in `gateway-logs.tsx`) fed with trigger runs.
 * Same scale, spacing, colours, ticks, card and interaction: 48 equal time
 * slices, bar height = runs per slice, a red cap = the failed share, a card on
 * hover or keyboard focus, and a click narrows the list to that slice.
 */

import { HistogramBars } from '@/components/ui/histogram-bars';
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

/** The bucket card (Paper C15 `CH3-0`): range and run count, then Succeeded, Failed, Median duration, Cost. */
function RunBucketCard({ bucket }: { bucket: RunBucket }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const stats: [string, ReactNode][] = [
    [t.raw('text6d9a6f97a5fd'), bucket.succeeded.toLocaleString()],
    [
      t.raw('text031a8f0f659d'),
      <span key="failed" className={bucket.failed > 0 ? 'text-destructive' : undefined}>
        {bucket.failed.toLocaleString()}
      </span>,
    ],
    [t.raw('textfa14066e0399'), bucket.medianMs != null ? fmtDuration(bucket.medianMs) : '—'],
    [t.raw('text204a5eb2cd28'), formatSessionCostCredits(bucket.cost)],
  ];
  // An open card sliding over an empty bucket: the range and "No runs", one line.
  if (bucket.total === 0) {
    return (
      <div className="flex items-baseline justify-between gap-3 text-xs tabular-nums">
        <span className="text-foreground font-medium whitespace-nowrap">{fmtRange(bucket)}</span>
        <span className="text-muted-foreground whitespace-nowrap">{t.raw('text26735edf00f9')}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 tabular-nums">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-foreground font-medium whitespace-nowrap">{fmtRange(bucket)}</span>
        <span className="text-muted-foreground whitespace-nowrap">
          {bucket.total.toLocaleString()} {t('texte0ab721ade45', { count: bucket.total })}
        </span>
      </div>
      <div className="border-border border-t" />
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs">
        {stats.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-foreground text-right">{value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

/** One stat of the summary row: a 14 px value beside its 13 px muted label. */
function Stat({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={cn('text-sm font-medium', tone ?? 'text-foreground')}>{value}</span>
      <span className="text-muted-foreground text-xs">{label}</span>
    </span>
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
  const cost = useMemo(() => buckets.reduce((n, b) => n + b.cost, 0), [buckets]);
  const median = useMemo(() => medianDuration(runs), [runs]);
  if (buckets.length === 0) return null;
  const peak = Math.max(1, ...buckets.map((b) => b.total));
  const tickAt = [0, 0.25, 0.5, 0.75].map((f) => Math.floor(f * (HISTOGRAM_BUCKETS - 1)));
  const clock = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const credits = formatSessionCostCredits(cost);

  // Paper C15 (`CBT-0`): the Models logs histogram, fed with runs.
  return (
    <section
      aria-label={t.raw('textd2c58b300c07')}
      className="bg-surface ring-border flex flex-col gap-2 rounded-lg px-4 pt-3.5 pb-2.5 ring-1"
    >
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 tabular-nums">
        <Stat
          value={runs.length.toLocaleString()}
          label={t('texte0ab721ade45', { count: runs.length })}
        />
        <Stat
          value={failed.toLocaleString()}
          label={t('text4001631320f1', { count: failed })}
          tone={failed > 0 ? 'text-destructive' : undefined}
        />
        {median != null ? (
          <Stat value={fmtDuration(median)} label={t.raw('textf1a06b0cb2ca')} />
        ) : null}
        <Stat value={credits} label={t('textd835122c9dd1', { count: Math.round(cost * 100) })} />
      </div>
      {/* `min-w-0 flex-1` bars: the strip shrinks with the column, never scrolls. */}
      <HistogramBars
        className="flex h-14 items-end gap-1.5"
        onSelect={(i) => onSelectRange({ start: buckets[i]!.start, end: buckets[i]!.end })}
        renderCard={(i) => <RunBucketCard bucket={buckets[i]!} />}
        bars={buckets.map((b) => ({
          key: b.start,
          ariaLabel: `${fmtRange(b)} · ${b.total} ${t('texte0ab721ade45', { count: b.total })}`,
          empty: b.total === 0,
          bar: (
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
          ),
        }))}
      />
      <div className="text-muted-foreground flex justify-between text-xs tabular-nums" aria-hidden>
        {tickAt.map((i) => (
          <span key={i}>{clock(buckets[i]!.start)}</span>
        ))}
        <span>{live ? tLogs('now') : clock(buckets[buckets.length - 1]!.end)}</span>
      </div>
    </section>
  );
}

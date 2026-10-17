'use client';

/**
 * The trigger sheet's Runs tab, and the run list the Triggers page reuses for
 * its Failed runs filter. One row per run: status, source, when (relative,
 * the exact time on hover, in the viewer's time zone), the error, duration,
 * cost, the session it opened, and Replay on a failed or rejected fire.
 */

import { CopyButton } from '@/components/markdown/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Disclosure, DisclosureContent } from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import { InlineMeta } from '@/components/ui/inline-meta';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import {
  formatSessionCostCredits,
  formatSessionCostDuration,
} from '@/features/billing/session-cost-format';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { projectSessionHref } from '@/lib/navigation/session-href';
import { cn } from '@/lib/utils';
import {
  ApiError,
  type ProjectTrigger,
  type ProjectTriggerRun,
  type ProjectTriggerRunSource,
} from '@kortix/sdk';
import { useProjectTriggers, useTriggerRuns } from '@kortix/sdk/react';
import { ArrowCounterClockwiseIcon, ArrowUpRightIcon, WarningIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';

import { FoldTrigger } from './composer-parts';
import {
  BAR_COUNT,
  RUNS_POLL_MS,
  type RunState,
  type RunTone,
  canReplay,
  relativeRunTime,
  runBars,
  runState,
  runsInFlight,
} from './trigger-runs-logic';
import { fireResultToast } from './trigger-toast';

const absoluteFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/**
 * Status badge per state (Paper V03 run table): a /15 tint and a dot. Failed
 * and queued have no Badge variant, so they tint `outline` with the kortix
 * hue. Running and skipped draw a hollow ring, a static glyph, not a spinner.
 */
const STATE_BADGE = {
  queued: {
    variant: 'outline',
    tint: 'bg-kortix-yellow/15 ring-kortix-yellow/15',
    dot: 'bg-kortix-yellow',
  },
  running: { variant: 'success', tint: '', dot: 'border border-kortix-green' },
  started: { variant: 'success', tint: '', dot: 'bg-kortix-green' },
  succeeded: { variant: 'success', tint: '', dot: 'bg-kortix-green' },
  failed: { variant: 'outline', tint: 'bg-kortix-red/15 ring-kortix-red/15', dot: 'bg-kortix-red' },
  rejected: { variant: 'warning', tint: '', dot: 'bg-kortix-orange' },
  skipped: { variant: 'accent', tint: '', dot: 'border border-muted-foreground' },
} as const satisfies Record<RunState, { variant: string; tint: string; dot: string }>;

/** Bar and legend fill per tone (Paper 2.4). */
const TONE_FILL = {
  green: 'bg-kortix-green',
  red: 'bg-kortix-red',
  orange: 'bg-kortix-orange',
  yellow: 'bg-kortix-yellow',
  muted: 'bg-muted',
} as const satisfies Record<RunTone, string>;

/** The legend: the four outcomes a finished run can have (V03 order). */
const LEGEND = [
  ['green', 'text614aa365f41e'],
  ['red', 'text031a8f0f659d'],
  ['orange', 'textaea4a04a8042'],
  ['muted', 'text12698ce1ea5c'],
] as const;

const STATE_LABEL_KEY = {
  queued: 'text661ff40a07e0',
  running: 'textf4ccae29e1bb',
  started: 'textecbc89cd37a0',
  succeeded: 'text6d9a6f97a5fd',
  failed: 'text031a8f0f659d',
  rejected: 'textaea4a04a8042',
  skipped: 'text12698ce1ea5c',
} as const satisfies Record<RunState, string>;

const SOURCE_LABEL_KEY = {
  cron: 'textf4830a1dae29',
  webhook: 'text4814f62c108d',
  manual: 'textb0b9fe24ffa9',
  monitor: 'text4c2e1df4570b',
  reminder: 'text31757bbfa17e',
  event: 'text5441e7146193',
} as const satisfies Record<ProjectTriggerRunSource, string>;

/** What a run list needs from `useTriggerRuns` / `useProjectTriggerRuns`. */
type RunsQuery = Pick<
  ReturnType<typeof useTriggerRuns>,
  | 'data'
  | 'isLoading'
  | 'isError'
  | 'refetch'
  | 'fetchNextPage'
  | 'hasNextPage'
  | 'isFetchingNextPage'
>;

export function runsOf(query: Pick<RunsQuery, 'data'>): ProjectTriggerRun[] {
  return query.data?.pages.flatMap((p) => p.runs) ?? [];
}

/** The polling interval for a run list, from the runs it shows now. */
export function useRunsPoll() {
  const [inFlight, setInFlight] = useState(false);
  return {
    refetchInterval: inFlight ? RUNS_POLL_MS : (false as const),
    // Called during render with the runs on screen: the next render polls, or stops.
    observe(runs: ProjectTriggerRun[]) {
      const next = runsInFlight(runs);
      if (next !== inFlight) setInFlight(next);
    },
  };
}

export function TriggerRunsPanel({
  projectId,
  trigger,
  canFire,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  canFire: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const poll = useRunsPoll();
  // One page of 30: the duration bars draw the latest 30 runs from it.
  const query = useTriggerRuns(projectId, trigger.slug, {
    refetchInterval: poll.refetchInterval,
    limit: BAR_COUNT,
  });
  const runs = runsOf(query);
  poll.observe(runs);
  const { replay } = useProjectTriggers(projectId);
  const [confirmRun, setConfirmRun] = useState<ProjectTriggerRun | null>(null);

  const startReplay = (run: ProjectTriggerRun, confirmUnverified = false) => {
    if (!run.payload_verified && !confirmUnverified) {
      setConfirmRun(run);
      return;
    }
    replay.mutate(
      { slug: trigger.slug, runId: run.run_id, confirmUnverified },
      {
        onSuccess: (res) => {
          setConfirmRun(null);
          fireResultToast(res, trigger, projectId, t);
        },
        onError: (err) => {
          // The server is the judge of "unverified": ask, then retry with the confirmation.
          if (err instanceof ApiError && err.code === 'payload_unverified') {
            setConfirmRun(run);
            return;
          }
          setConfirmRun(null);
          errorToast(t.raw('text2f1b3ba06cfb'), { description: err.message });
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      {runs.length > 0 ? <RunBars runs={runs} /> : null}
      <RunList
        query={query}
        emptyTitle={t.raw('text91f7323997df')}
        actions={(run) =>
          canFire && canReplay(run) ? (
            <Button
              variant="outline"
              size="xs"
              disabled={replay.isPending}
              onClick={() => startReplay(run)}
            >
              {replay.isPending && replay.variables?.runId === run.run_id ? (
                <Loading className="size-3.5 shrink-0" />
              ) : (
                <ArrowCounterClockwiseIcon className="size-3.5 shrink-0" />
              )}
              {t.raw('text98c78fbb22fe')}
            </Button>
          ) : null
        }
        projectId={projectId}
      />
      <ConfirmDialog
        open={!!confirmRun}
        onOpenChange={(next) => {
          if (!next) setConfirmRun(null);
        }}
        title={t.raw('texta9cd409ba9ca')}
        description={t.raw('text776bb15115b3')}
        confirmLabel={t.raw('text98c78fbb22fe')}
        isPending={replay.isPending}
        onConfirm={() => confirmRun && startReplay(confirmRun, true)}
      />
    </div>
  );
}

/**
 * Paper V20 "Timeline strip": one bar per run, the latest 30, oldest on the
 * left. Height is the run's duration against the longest one shown; colour is
 * its state. Read-only (no click intent in the board): the strip is one image
 * with a text summary for screen readers, and each bar names its run on hover.
 */
function RunBars({ runs }: { runs: ProjectTriggerRun[] }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const bars = runBars(runs);
  const failed = bars.filter((b) => b.tone === 'red').length;
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2.5">
        <span className="text-foreground text-xs font-medium">{t.raw('text237112b89b77')}</span>
        <span className="text-muted-foreground text-xs">{t.raw('text9da843b113d4')}</span>
      </div>
      <div
        role="img"
        aria-label={t('texta36b75929fc3', { value0: bars.length, value1: failed })}
        className="bg-card border-border flex h-8 items-end gap-1 border-b"
      >
        {bars.map(({ run, tone, pct }) => {
          const state = runState(run);
          const label = [
            relativeRunTime(run.started_at, locale),
            t.raw(STATE_LABEL_KEY[state]),
            run.duration_ms != null ? formatSessionCostDuration(run.duration_ms / 1000) : null,
            run.cost_usd != null
              ? t('text8dcda9f17257', { value0: formatSessionCostCredits(run.cost_usd) })
              : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <Hint key={run.run_id} label={label} side="top">
              {/* Height is data, so it is the one inline style: a percent of the 26 px strip. */}
              <span
                className={cn('w-3.5 shrink-0 rounded-sm', TONE_FILL[tone])}
                style={{ height: `${pct}%` }}
              />
            </Hint>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {LEGEND.map(([tone, key]) => (
          <span key={tone} className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span className={cn('size-2 rounded-sm', TONE_FILL[tone])} aria-hidden />
            {t.raw(key)}
          </span>
        ))}
      </div>
    </section>
  );
}

export function RunList({
  projectId,
  query,
  emptyTitle,
  title,
  actions,
}: {
  projectId: string;
  query: RunsQuery;
  emptyTitle: string;
  /** A leading title per row (the project list names the trigger). */
  title?: (run: ProjectTriggerRun) => ReactNode;
  actions?: (run: ProjectTriggerRun) => ReactNode;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const runs = runsOf(query);

  if (query.isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Loading />
      </div>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        size="sm"
        title={t.raw('text398d270b036a')}
        action={
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>
            {t.raw('textd8b8392e2c54')}
          </Button>
        }
      />
    );
  }
  if (runs.length === 0 && !query.hasNextPage) {
    return <EmptyState size="sm" title={emptyTitle} />;
  }

  return (
    <div className="space-y-4">
      <ul className="divide-border divide-y">
        {runs.map((run) => (
          <RunRow
            key={run.run_id}
            projectId={projectId}
            run={run}
            title={title?.(run)}
            action={actions?.(run)}
          />
        ))}
      </ul>
      {/* A page can be short while more remain: the button follows the cursor, not the count. */}
      {query.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? <Loading className="size-3.5 shrink-0" /> : null}
          {t.raw('textac8991ef0101')}
        </Button>
      ) : null}
    </div>
  );
}

function RunRow({
  projectId,
  run,
  title,
  action,
}: {
  projectId: string;
  run: ProjectTriggerRun;
  title?: ReactNode;
  action?: ReactNode;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const state = runState(run);
  const error = run.error ?? run.run_error;
  const at = new Date(run.started_at);
  const payload = JSON.stringify(run.payload, null, 2);

  return (
    <li className="space-y-1.5 py-2 first:pt-0">
      <div className="flex min-w-0 items-center gap-2">
        {/* `font-sans normal-case`: the badge base is mono uppercase, which reads as code (trigger-status-badge.tsx). */}
        <Badge
          variant={STATE_BADGE[state].variant}
          size="sm"
          className={cn('font-sans normal-case', STATE_BADGE[state].tint)}
        >
          <span
            data-slot="status-dot"
            aria-hidden
            className={cn('rounded-full', STATE_BADGE[state].dot)}
          />
          {t.raw(STATE_LABEL_KEY[state])}
        </Badge>
        {title}
        <span className="text-muted-foreground shrink-0 text-xs">
          {t.raw(SOURCE_LABEL_KEY[run.source])}
        </span>
        {run.payload_verified ? null : (
          <Hint label={t.raw('text7f2b8f3a675c')} side="top">
            <Badge
              variant="outline"
              size="sm"
              className="[&>svg]:text-kortix-orange font-sans normal-case"
            >
              <WarningIcon />
              {t.raw('text9daf8e05c684')}
            </Badge>
          </Hint>
        )}
        <Hint label={absoluteFormatter.format(at)} side="top">
          <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
            {relativeRunTime(run.started_at, locale)}
          </span>
        </Hint>
      </div>

      {error ? (
        <p className="text-kortix-red font-mono text-xs tracking-tight break-words">{error}</p>
      ) : null}

      <div className="flex min-w-0 items-center gap-2">
        <InlineMeta className="flex-1">
          {run.duration_ms != null ? (
            <span className="tabular-nums">
              {formatSessionCostDuration(run.duration_ms / 1000)}
            </span>
          ) : null}
          {run.cost_usd != null ? (
            <span className="tabular-nums">
              {t('text8dcda9f17257', { value0: formatSessionCostCredits(run.cost_usd) })}
            </span>
          ) : null}
        </InlineMeta>
        {run.session_id || action ? (
          <ButtonGroup>
            {run.session_id ? (
              <Button variant="outline" size="xs" asChild>
                <Link href={projectSessionHref(projectId, run.session_id)}>
                  {t.raw('textb205bb47f81a')}
                  <ArrowUpRightIcon className="size-3.5 shrink-0" />
                </Link>
              </Button>
            ) : null}
            {action}
          </ButtonGroup>
        ) : null}
      </div>

      <Disclosure className="group">
        <FoldTrigger>{t.raw('text99733344956d')}</FoldTrigger>
        <DisclosureContent>
          <div className="relative pt-2">
            <pre className="bg-background max-h-64 overflow-auto rounded-md border px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap">
              {payload}
            </pre>
            <CopyButton
              code={payload}
              label={t.raw('text026c6dbbbec5')}
              className="absolute top-3 right-1"
            />
          </div>
        </DisclosureContent>
      </Disclosure>
    </li>
  );
}

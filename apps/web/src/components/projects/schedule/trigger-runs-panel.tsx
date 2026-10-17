'use client';

/**
 * The trigger sheet's Runs tab: the runs histogram, then one dense row per
 * run in the Models page Logs row style (`LogRow` in `gateway-logs.tsx`):
 * time, outcome, duration, cost, and the source when it is not the trigger's
 * own. A row with a session opens it. A failed row offers Replay on hover or
 * focus and carries its error as one muted line, in full on hover.
 */

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
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
import { ArrowCounterClockwiseIcon, WarningIcon, XIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { RunHistogram, type RunTimeRange, fmtRange } from './trigger-runs-histogram';
import {
  RUNS_POLL_MS,
  type RunState,
  canReplay,
  inRunRange,
  isDefaultSource,
  relativeRunTime,
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

/** The one status mark per row: a dot, as `StatusMark` in the Models logs. */
const STATE_DOT = {
  queued: 'bg-kortix-yellow',
  running: 'bg-kortix-green',
  started: 'bg-kortix-green',
  succeeded: 'bg-kortix-green',
  failed: 'bg-destructive',
  rejected: 'bg-kortix-orange',
  skipped: 'bg-muted-foreground/45',
} as const satisfies Record<RunState, string>;

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

/** Column widths, named once (the Models logs `LANE`). */
const LANE = {
  time: 'w-22 shrink-0 whitespace-nowrap',
  duration: 'w-14 shrink-0 text-right whitespace-nowrap',
  cost: 'w-16 shrink-0 text-right whitespace-nowrap @max-sm/runs:hidden',
} as const;

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
  const query = useTriggerRuns(projectId, trigger.slug, {
    refetchInterval: poll.refetchInterval,
  });
  const runs = runsOf(query);
  poll.observe(runs);
  // A bar click narrows the list to its window; the chip clears it.
  const [range, setRange] = useState<RunTimeRange | null>(null);
  const shown = useMemo(() => runs.filter((run) => inRunRange(run, range)), [runs, range]);
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

  let body;
  if (query.isLoading) {
    body = (
      <div className="flex justify-center py-6">
        <Loading />
      </div>
    );
  } else if (query.isError) {
    body = (
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
  } else if (shown.length === 0 && !query.hasNextPage) {
    body = (
      <EmptyState size="sm" title={range ? t.raw('text6de3a7d8e5db') : t.raw('text91f7323997df')} />
    );
  } else {
    body = (
      <div className="@container/runs flex flex-col">
        <div className="text-muted-foreground border-border flex h-8 items-center gap-3 border-b px-3 text-xs">
          <span className={LANE.time}>{t.raw('text33b93476cf59')}</span>
          <span className="min-w-0 flex-1">{t.raw('text920e413c7d41')}</span>
          <span className={LANE.duration}>{t.raw('text4fc52a3c4c55')}</span>
          <span className={LANE.cost}>{t.raw('text204a5eb2cd28')}</span>
        </div>
        <ul>
          {shown.map((run) => (
            <RunRow
              key={run.run_id}
              projectId={projectId}
              trigger={trigger}
              run={run}
              replay={
                canFire && canReplay(run)
                  ? {
                      pending: replay.isPending && replay.variables?.runId === run.run_id,
                      disabled: replay.isPending,
                      onReplay: () => startReplay(run),
                    }
                  : null
              }
            />
          ))}
        </ul>
        {/* A page can be short while more remain: the button follows the cursor, not the count. */}
        {query.hasNextPage ? (
          <div className="flex justify-center px-4 py-3">
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
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {runs.length > 0 ? (
        <RunHistogram runs={runs} live={!query.hasNextPage} onSelectRange={setRange} />
      ) : null}
      {range ? (
        <Button
          variant="secondary"
          size="sm"
          className="gap-1.5 tabular-nums"
          onClick={() => setRange(null)}
          aria-label={`${fmtRange(range)} ×`}
        >
          {fmtRange(range)}
          <XIcon className="size-3.5" />
        </Button>
      ) : null}
      {body}
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

function RunRow({
  projectId,
  trigger,
  run,
  replay,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  run: ProjectTriggerRun;
  replay: { pending: boolean; disabled: boolean; onReplay: () => void } | null;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const state = runState(run);
  const error = run.error ?? run.run_error;
  const failed = state === 'failed' || state === 'rejected';

  const cells = (
    <>
      <Hint label={absoluteFormatter.format(new Date(run.started_at))} side="top">
        <span className={cn(LANE.time, 'text-muted-foreground tabular-nums')}>
          {relativeRunTime(run.started_at, locale)}
        </span>
      </Hint>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', STATE_DOT[state])} />
        <span className="text-foreground truncate font-medium">
          {t.raw(STATE_LABEL_KEY[state])}
        </span>
        {isDefaultSource(trigger.type, run.source) ? null : (
          <span className="text-muted-foreground shrink-0 truncate">
            {t.raw(SOURCE_LABEL_KEY[run.source])}
          </span>
        )}
        {run.payload_verified ? null : (
          <Hint label={t.raw('text7f2b8f3a675c')} side="top">
            <WarningIcon
              aria-label={t.raw('text9daf8e05c684')}
              className="text-muted-foreground size-3.5 shrink-0"
            />
          </Hint>
        )}
      </span>
      <span className={cn(LANE.duration, 'text-foreground tabular-nums')}>
        {run.duration_ms != null ? formatSessionCostDuration(run.duration_ms / 1000) : '—'}
      </span>
      {/* No cost line for a run that spent nothing: "0 credits" reads like a measurement. */}
      <span className={cn(LANE.cost, 'text-foreground tabular-nums')}>
        {run.cost_usd ? formatSessionCostCredits(run.cost_usd) : null}
      </span>
    </>
  );
  const rowClass =
    'flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-xs transition-[background-color] duration-(--duration-normal)';

  return (
    <li className="group relative">
      {run.session_id ? (
        <Link
          href={projectSessionHref(projectId, run.session_id)}
          className={cn(rowClass, 'hover:bg-muted/60 focus-visible:bg-muted/60 outline-none')}
        >
          {cells}
        </Link>
      ) : (
        <div className={rowClass}>{cells}</div>
      )}
      {failed && error ? (
        <Hint label={error} side="top" className="max-w-80 text-pretty">
          <p className="text-muted-foreground truncate pr-3 pb-2 pl-28 text-xs">{error}</p>
        </Hint>
      ) : null}
      {replay ? (
        // Over the row's right edge; shown on hover or keyboard focus only.
        <span className="bg-background absolute top-1 right-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          <Button
            variant="outline"
            size="xs"
            className="gap-1.5"
            disabled={replay.disabled}
            onClick={replay.onReplay}
          >
            {replay.pending ? (
              <Loading className="size-3.5 shrink-0" />
            ) : (
              <ArrowCounterClockwiseIcon className="size-3.5 shrink-0" />
            )}
            {t.raw('text98c78fbb22fe')}
          </Button>
        </span>
      ) : null}
    </li>
  );
}

'use client';

/**
 * The trigger sheet's Runs tab: the runs histogram, then one dense row per
 * run in the Models page Logs row style (`LogRow` in `gateway-logs.tsx`):
 * time, outcome, duration, cost, and the source when it is not the trigger's
 * own. A row with a session opens it. A failed row offers Replay on hover or
 * focus and carries its error as one muted line, in full on hover.
 */

import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import { ConfirmDialog } from '../../../primitives/confirm-dialog';
import { SessionDotMatrix } from '../../../primitives/dot-matrix/session-dot-matrix';
import Hint from '../../../primitives/hint';
import Loading from '../../../primitives/loading';
import { errorToast, successToast } from '../../../primitives/toast';
import {
  formatSessionCostCredits,
  formatSessionCostDuration,
} from '../../../internal/billing/session-cost-format';
import { EmptyState } from '../../../primitives/empty-state';
import { ErrorState } from '../../../primitives/error-state';
import { useLocale, useTranslations } from '../../../i18n';
import { projectSessionHref } from '../../../internal/lib/navigation/session-href';
import { cn } from '../../../internal/lib/utils';
import { copyToClipboard } from '../../../internal/lib/utils/clipboard';
import {
  ApiError,
  type ProjectTrigger,
  type ProjectTriggerRun,
  type ProjectTriggerRunSource,
} from '@kortix/sdk';
import { useProjectTriggers, useTriggerRuns } from '@kortix/sdk/react';
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  PlayIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import { UiLink as Link, useUiRouter } from '../../../providers/ui-provider';
import { useMemo, useState } from 'react';

import { RunHistogram, type RunTimeRange, fmtRange } from './trigger-runs-histogram';
import {
  RUNS_POLL_MS,
  type RunState,
  canReplay,
  inRunRange,
  isDefaultSource,
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
  app: 'text0d04bfeb7d64',
} as const satisfies Record<ProjectTriggerRunSource, string>;

/** Column widths, named once (the Models logs `LANE`). */
const LANE = {
  // The outcome mark's slot: an 8 px dot, or the 14 px dot matrix while running.
  mark: 'flex w-3.5 shrink-0 justify-center',
  time: 'w-22 shrink-0 text-right whitespace-nowrap',
  duration: 'w-14 shrink-0 text-right whitespace-nowrap',
  cost: 'w-16 shrink-0 text-right whitespace-nowrap @max-sm/runs:hidden',
} as const;

/** "10:30:02": the clock of a run inside its day (`fmtClock` in the Models logs). */
function fmtClock(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** "Today", "Yesterday", else the date: once above the rows that share it (`DayDivider`). */
function fmtDay(
  iso: string,
  locale: string,
  t: (key: 'text2b065c7c9ce4' | 'text566181254b29') => string,
) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return t('text2b065c7c9ce4');
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return t('text566181254b29');
  return d.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
}

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
  onRun,
  running = false,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  canFire: boolean;
  /** The sheet's Run now, offered by the empty state. */
  onRun?: () => void;
  running?: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const router = useUiRouter();
  const locale = useLocale();
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
          fireResultToast(res, trigger, projectId, t, router);
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
  } else if (range && shown.length === 0) {
    body = <EmptyState size="sm" title={t.raw('text6de3a7d8e5db')} />;
  } else if (shown.length === 0 && !query.hasNextPage) {
    // Paper C06 / C14: one line, then Run now; no histogram.
    const nextIso = trigger.next_cron_at ?? trigger.next_fire_at;
    const next = nextIso ? Date.parse(nextIso) : Number.NaN;
    const line = !trigger.enabled
      ? t.raw('text75c4316dcad4')
      : Number.isFinite(next)
        ? t('textdf86da65c421', {
            value0: new Date(next).toLocaleString(locale, {
              timeZoneName: 'short',
              second: '2-digit',
              weekday: 'long',
              hour: '2-digit',
              minute: '2-digit',
            }),
          })
        : t.raw('text72a85758b69c');
    body = (
      <div className="flex flex-col items-start gap-3">
        <p className="text-muted-foreground text-sm">{line}</p>
        {canFire && onRun ? (
          <Button
            variant="secondary"
            size="xs"
            className="gap-1.5 text-xs"
            onClick={onRun}
            disabled={running}
          >
            {running ? (
              <SessionDotMatrix sessionId={trigger.slug} size={14} className="shrink-0" />
            ) : (
              <PlayIcon weight="fill" className="size-2.5 shrink-0" />
            )}
            {t.raw('text0991397702fa')}
          </Button>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="@container/runs flex flex-col">
        {/* C03 run table header: Run · Time · Duration · Cost. */}
        <div className="text-muted-foreground border-border flex h-8 items-center gap-3 border-b px-3 text-xs">
          <span className={LANE.mark} />
          <span className="min-w-0 flex-1">{t.raw('text00d60e31a4e6')}</span>
          <span className={LANE.time}>{t.raw('text33b93476cf59')}</span>
          <span className={LANE.duration}>{t.raw('text4fc52a3c4c55')}</span>
          <span className={LANE.cost}>{t.raw('text204a5eb2cd28')}</span>
        </div>
        <ul>
          {shown.map((run, i) => (
            <RunRow
              newDay={
                i === 0 ||
                new Date(shown[i - 1]!.started_at).toDateString() !==
                  new Date(run.started_at).toDateString()
              }
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

export function RunRow({
  projectId,
  trigger,
  run,
  newDay,
  replay,
  initialOpen = false,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  run: ProjectTriggerRun;
  /** The first row of its day: the day divider sits above it. */
  newDay: boolean;
  replay: { pending: boolean; disabled: boolean; onReplay: () => void } | null;
  /** Start expanded (a deep link to one run, and the render tests). */
  initialOpen?: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const [open, setOpen] = useState(initialOpen);
  const state = runState(run);
  const error = run.error ?? run.run_error;
  const failed = state === 'failed' || state === 'rejected';
  const source = t.raw(SOURCE_LABEL_KEY[run.source]);
  const replayButton = (className?: string) =>
    replay ? (
      <Button
        variant="outline"
        size="xs"
        className={cn('gap-1.5 text-xs', className)}
        disabled={replay.disabled}
        onClick={replay.onReplay}
      >
        {replay.pending ? (
          <Loading className="size-3 shrink-0" />
        ) : (
          <ArrowCounterClockwiseIcon className="size-3 shrink-0" />
        )}
        {t.raw('textc8dae6371b33')}
      </Button>
    ) : null;

  return (
    <>
      {newDay ? (
        <li className="text-muted-foreground px-3 pt-3.5 pb-1.5 text-xs font-medium">
          {fmtDay(run.started_at, locale, (key) => t.raw(key))}
        </li>
      ) : null}
      {/* C20 `D6V-0` + `D73-0`: the row toggles its detail inline. Only the
          panel's Open session leaves the page. */}
      <li className={cn('group relative rounded-md', open && 'bg-muted')}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && open) setOpen(false);
          }}
          className={cn(
            'flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-xs outline-none',
            'transition-[background-color] duration-(--duration-normal)',
            !open && 'hover:bg-muted/60 focus-visible:bg-muted/60',
          )}
        >
          <span className={LANE.mark}>
            {state === 'running' || state === 'queued' ? (
              <SessionDotMatrix sessionId={run.run_id} size={14} className="shrink-0" />
            ) : (
              <span aria-hidden className={cn('size-2 rounded-full', STATE_DOT[state])} />
            )}
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-2.5 overflow-hidden">
            <span className="text-foreground max-w-full shrink-0 truncate font-medium">
              {t.raw(STATE_LABEL_KEY[state])}
            </span>
            {failed && error ? (
              <span className="text-muted-foreground min-w-0 truncate">{error}</span>
            ) : run.replay_of ? (
              <Badge variant="secondary" size="sm" className="font-sans normal-case">
                {t.raw('textc8dae6371b33')}
              </Badge>
            ) : isDefaultSource(trigger.type, run.source) ? null : (
              <Badge variant="secondary" size="sm" className="font-sans normal-case">
                {source}
              </Badge>
            )}
            {run.payload_verified ? null : (
              <Hint label={t.raw('text7f2b8f3a675c')} side="top">
                <WarningIcon
                  aria-label={t.raw('text9daf8e05c684')}
                  className="text-muted-foreground size-3.5 shrink-0 self-center"
                />
              </Hint>
            )}
          </span>
          <Hint label={absoluteFormatter.format(new Date(run.started_at))} side="top">
            <span className={cn(LANE.time, 'text-muted-foreground tabular-nums')}>
              {fmtClock(run.started_at, locale)}
            </span>
          </Hint>
          <span className={cn(LANE.duration, 'text-foreground tabular-nums')}>
            {run.duration_ms != null ? formatSessionCostDuration(run.duration_ms / 1000) : null}
          </span>
          {/* No cost for a run that spent nothing: "0" reads like a measurement. */}
          <span className={cn(LANE.cost, 'text-foreground tabular-nums')}>
            {run.cost_usd ? formatSessionCostCredits(run.cost_usd) : null}
          </span>
        </button>

        {replay && !open ? (
          // Collapsed failed row: Replay on hover or keyboard focus, over the lanes.
          <span className="absolute top-1.5 right-2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
            {replayButton('bg-background')}
          </span>
        ) : null}

        {open ? (
          <div className="flex flex-col gap-5 pt-1 pr-3 pb-3.5 pl-8 @2xl/runs:flex-row">
            <div className="flex w-full shrink-0 flex-col gap-2 @2xl/runs:w-72">
              <div className="flex gap-3 text-xs">
                <span className="text-muted-foreground w-22 shrink-0">
                  {t.raw('textecbc89cd37a0')}
                </span>
                <span className="text-foreground tabular-nums">
                  {fmtClock(run.started_at, locale)} · {source.toLocaleLowerCase(locale)}
                </span>
              </div>
              {run.session_id ? (
                <div className="flex gap-3 text-xs">
                  <span className="text-muted-foreground w-22 shrink-0">
                    {t.raw('text6959b4159575')}
                  </span>
                  {/* Click to copy the full ID (the value truncates). */}
                  <button
                    type="button"
                    onClick={async () => {
                      if (!run.session_id) return;
                      if (await copyToClipboard(run.session_id)) {
                        successToast(t.raw('text4aaee10f3594'));
                      } else {
                        errorToast(t.raw('text4cb23f3c3b90'));
                      }
                    }}
                    className="text-foreground focus-visible:ring-ring min-w-0 cursor-pointer truncate rounded-sm text-left font-mono outline-none focus-visible:ring-2"
                  >
                    {run.session_id}
                  </button>
                </div>
              ) : null}
              {error ? (
                <div className="flex gap-3 text-xs">
                  <span className="text-muted-foreground w-22 shrink-0">
                    {t.raw('text54a0e8c17ebb')}
                  </span>
                  <span className="text-foreground min-w-0 break-words">{error}</span>
                </div>
              ) : null}
              {replay || run.session_id ? (
                <div className="flex gap-1 pt-1">
                  {replayButton()}
                  {run.session_id ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground gap-1.5 text-xs"
                      asChild
                    >
                      <Link href={projectSessionHref(projectId, run.session_id)}>
                        <ArrowSquareOutIcon className="size-3 shrink-0" />
                        {t.raw('textb205bb47f81a')}
                      </Link>
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <pre className="bg-surface text-foreground min-w-0 flex-1 overflow-auto rounded-md px-3.5 py-3 font-mono text-xs leading-normal whitespace-pre">
              {JSON.stringify(run.payload, null, 2)}
            </pre>
          </div>
        ) : null}
      </li>
    </>
  );
}

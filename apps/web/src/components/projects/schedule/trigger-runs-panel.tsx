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
import {
  ApiError,
  type ProjectTrigger,
  type ProjectTriggerRun,
  type ProjectTriggerRunSource,
} from '@kortix/sdk';
import { useProjectTriggers, useTriggerRuns } from '@kortix/sdk/react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';

import { FoldTrigger } from './composer-parts';
import {
  RUNS_POLL_MS,
  type RunState,
  canReplay,
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

const STATE_VARIANT = {
  queued: 'outline',
  running: 'outline',
  started: 'success',
  succeeded: 'success',
  failed: 'destructive',
  rejected: 'destructive',
  skipped: 'outline',
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
  const query = useTriggerRuns(projectId, trigger.slug, { refetchInterval: poll.refetchInterval });
  poll.observe(runsOf(query));
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
    <>
      <RunList
        query={query}
        emptyTitle={t.raw('text91f7323997df')}
        actions={(run) =>
          canFire && canReplay(run) ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={replay.isPending}
              onClick={() => startReplay(run)}
            >
              {replay.isPending && replay.variables?.runId === run.run_id ? (
                <Loading className="size-3.5 shrink-0" />
              ) : null}
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
    </>
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
    <li className="space-y-1.5 py-3 first:pt-0">
      <div className="flex min-w-0 items-center gap-2">
        {/* `font-sans normal-case`: the badge base is mono uppercase, which reads as code (trigger-status-badge.tsx). */}
        <Badge variant={STATE_VARIANT[state]} size="sm" className="font-sans normal-case">
          {t.raw(STATE_LABEL_KEY[state])}
        </Badge>
        {title}
        <span className="text-muted-foreground shrink-0 text-xs">
          {t.raw(SOURCE_LABEL_KEY[run.source])}
        </span>
        {run.payload_verified ? null : (
          <Hint label={t.raw('text7f2b8f3a675c')} side="top">
            <Badge variant="warning" size="sm" className="font-sans normal-case">
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

      {error ? <p className="text-destructive text-xs break-words">{error}</p> : null}

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
              <Button variant="ghost" size="xs" asChild>
                <Link href={projectSessionHref(projectId, run.session_id)}>
                  {t.raw('textb205bb47f81a')}
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

'use client';

import { Badge } from '../../../primitives/badge';
import { Hint } from '../../../primitives/hint';
import { TextShimmer } from '../../../primitives/text-shimmer';
import { errorToast } from '../../../primitives/toast';
import { SubagentDialog } from '../../agents/subagent-view';
import { GenericTool } from '../generic-tool';
import {
  BasicTool,
  partError,
  partMetadata,
  partOutput,
  partStatus,
  ToolOutcomeContext,
  ToolRunningContext,
  useToolIndent,
} from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';
import { useTranslations } from '../../../i18n';
import { ArrowUpRightIcon, TreeStructureIcon } from '@phosphor-icons/react';
import { AgentFailure } from '../../agents/agent-surface';
import { Button } from '../../../primitives/button';
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { qk, useProjectSession, useSessionChildren } from '@kortix/sdk/react';
import { stopProjectSession, type ProjectSession } from '@kortix/sdk';
import { useSessionIds } from '../../../providers/session-ids';
import { RunProgressRing, type AgentStopState } from './workflow-progress';
import { boardStateOf } from '../../agents/agent-model';
import { WorkflowRunCard } from './workflow-run-card';
import {
  isLargeRun,
  LargeRunBadge,
  useLiveWorkflowRun,
  useRestartAgent,
  WorkflowRunControls,
} from '../../agents/workflow-run-controls';
import {
  countAgents,
  elapsedMs,
  formatElapsed,
  isWorkflowTool,
  parseWorkflowResult,
  parseWorkflowRun,
  type WorkflowRun,
  type WorkflowRunAgent,
} from './workflow-run';

/**
 * The card of pi's `workflow` tool: one script that runs several agents, each in
 * its own child session. It is Claude Code's `/workflows` progress view, inside the chat.
 *
 * The run arrives as part metadata (`WorkflowRunMetadata` in
 * `packages/api-contract/src/kortix-tool-card.ts`), pushed live with every change.
 * The header says what runs and how far it got ("3 of 8 done · 1 failed · 2m 04s"),
 * with a "Large run" chip past 25 agents and a "Resumed" chip for a relaunch. The
 * body is the script's newest log lines, then the phases with their agents
 * (`workflow-progress.tsx`): a row opens that agent's session in place, as a task
 * row does (`SubagentDialog`), and a running row has a Stop button. A finished run
 * folds the script's result away under "Result".
 *
 * A run started with `background: true` returned at once: its progress lives in its
 * own runner session, so the card is one row that opens that session.
 *
 * A call that settled with metadata that is not a run renders as the generic card.
 */

function WorkflowTrigger({
  title,
  subtitle,
  chips,
  live,
}: {
  title: string;
  subtitle?: string;
  chips?: React.ReactNode;
  live: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-sm">
      {live ? (
        <TextShimmer duration={1} spread={2} className="min-w-0 truncate text-sm">
          {title}
        </TextShimmer>
      ) : (
        <span className="text-foreground min-w-0 truncate" title={title}>
          {title}
        </span>
      )}
      {chips}
      {subtitle && (
        <span className="text-muted-foreground min-w-0 flex-1 truncate tabular-nums" title={subtitle}>
          {subtitle}
        </span>
      )}
    </div>
  );
}

function RunChips({ run }: { run: WorkflowRun }) {
  const t = useTranslations('tools.workflow');
  const large = isLargeRun(run);
  if (!large && !run.resumedFrom) return null;
  return (
    <>
      {run.resumedFrom && (
        <Hint label={t('resumedHint')} side="top">
          <Badge variant="default">{t('resumed')}</Badge>
        </Hint>
      )}
      {large && <LargeRunBadge />}
    </>
  );
}


/** The current time, every second while `active`: a live run's elapsed labels tick. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * A live run read from this session's children: each `agent()` is a child session named after
 * its label, started after the call. Null until the first child exists.
 */
export function runFromChildren(children: ProjectSession[], startedMs: number, input: unknown): WorkflowRun | null {
  const mine = children.filter((child) => !Number.isFinite(startedMs) || Date.parse(child.created_at) >= startedMs - 5_000);
  if (mine.length === 0) return null;
  const description = typeof (input as { description?: unknown } | null)?.description === 'string' ? (input as { description: string }).description : '';
  return {
    runId: '',
    title: description,
    status: 'running',
    phases: [],
    logs: [],
    ...(Number.isFinite(startedMs) ? { startedAt: startedMs } : {}),
    agents: mine
      .slice()
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      .map((child, index): WorkflowRunAgent => {
        const status = child.status === 'completed' ? 'done' : child.status === 'failed' ? 'failed' : 'running';
        const created = Date.parse(child.created_at);
        return {
          id: `a${index + 1}`,
          label: (child.name ?? '').replace(/\s*\([^)]*\)\s*$/, '') || child.agent_name || child.session_id.slice(0, 8),
          ...(child.agent_name ? { agent: child.agent_name } : {}),
          status,
          sessionId: child.session_id,
          // A child that settled has no end time in the list: only a running one shows its elapsed time.
          ...(status === 'running' && Number.isFinite(created) ? { startedAt: created } : {}),
        };
      }),
  };
}

type OpenTarget = { sessionId: string; title: string };

export function WorkflowTool(props: ToolProps) {
  const { call, defaultOpen, forceOpen, locked } = props;
  const t = useTranslations('tools.workflow');
  const tm = useTranslations('multiAgent.workflow');
  const running = useContext(ToolRunningContext);
  const status = partStatus(call);
  const settled = status === 'completed' || status === 'error';
  const metadata = partMetadata(call);
  const parsed = useMemo(() => parseWorkflowRun(metadata), [metadata]);
  // The session log carries a running call's run document only once the call settles, so a
  // page that reads it (the v2 stream) has no live run. The run's agents are this session's
  // children started since the call began: list them until the document arrives.
  const ids = useSessionIds();
  const startedMs = call.started_at ? Date.parse(call.started_at) : NaN;
  const needChildren = !settled && !parsed && !!ids.projectId && !!ids.sessionId;
  const { sessions: children } = useSessionChildren(ids.projectId ?? '', ids.sessionId ?? '', { enabled: needChildren, limit: 20 });
  const cardRun = useMemo(
    () => parsed ?? (needChildren ? runFromChildren(children, startedMs, call.input) : null),
    [parsed, needChildren, children, startedMs, call.input],
  );
  // A background run's progress lives on its runner's box: read it from there, so the card
  // keeps updating after this session's turn ended (the call settled long ago).
  const { run, controlSessionId, fromRunner } = useLiveWorkflowRun(ids.projectId, ids.sessionId, cardRun);
  // A background run whose runner no longer answers its run list: the runner session's own state says how it ended.
  const runnerRow = useProjectSession(ids.projectId, run?.background?.sessionId, { enabled: !!run?.background && !fromRunner });
  const runnerEnded = runnerRow.data ? runnerOutcome(boardStateOf(runnerRow.data as ProjectSession)) : null;
  // Live: a foreground run while its call runs, or a background run its runner still runs.
  const live = !!run && run.status === 'running' && (fromRunner || (!settled && !run.background && running));
  const restart = useRestartAgent(ids.projectId, controlSessionId, live ? run : null);
  const now = useNow(live);
  const [open, setOpen] = useState<OpenTarget | null>(null);
  const onOpen = useCallback(
    (agent: WorkflowRunAgent) => {
      if (agent.sessionId) setOpen({ sessionId: agent.sessionId, title: agent.agent ? `${agent.label} · ${agent.agent}` : agent.label });
    },
    [],
  );

  // Claude Code's `x` on an agent: stop that child session. The run sees the child stop and
  // marks the agent `stopped`; until the next update the row shows the stop in flight.
  const queryClient = useQueryClient();
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const stopAgent = useMutation({
    mutationFn: (agent: WorkflowRunAgent) => stopProjectSession(ids.projectId!, agent.sessionId!),
    onSuccess: () => {
      if (ids.projectId) void queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(ids.projectId) });
    },
    onError: (error, agent) => {
      setStopping((previous) => {
        const next = new Set(previous);
        next.delete(agent.sessionId!);
        return next;
      });
      errorToast(t('stopFailed', { label: agent.label }), {
        description: error instanceof Error ? error.message : undefined,
      });
    },
  });
  const { mutate: mutateStop } = stopAgent;
  const { enabled: canRestart, restarting, restart: restartAgent } = restart;
  const stop = useMemo<AgentStopState>(
    () => ({
      enabled: !!ids.projectId,
      pending: stopping,
      stop: (agent) => {
        if (!agent.sessionId) return;
        setStopping((previous) => new Set(previous).add(agent.sessionId!));
        mutateStop(agent);
      },
      ...(canRestart ? { restart: { pending: restarting, run: restartAgent } } : {}),
    }),
    [ids.projectId, stopping, mutateStop, canRestart, restarting, restartAgent],
  );

  if (!isWorkflowTool(call.name) || (settled && !run)) {
    return <GenericTool call={call} defaultOpen={defaultOpen} forceOpen={forceOpen} locked={locked} />;
  }

  const icon = <TreeStructureIcon className="size-4 shrink-0" />;

  if (!run) {
    return (
      <BasicTool
        icon={icon}
        trigger={<WorkflowTrigger title={t('starting')} live={running} />}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        locked={locked}
      />
    );
  }

  const title = run.title || run.name || t('fallbackTitle');
  // The run's progress leads the card: a ring once it has agents, the workflow glyph before.
  const tally = countAgents(run.agents);
  const runIcon =
    tally.total > 0 ? <RunProgressRing done={tally.done} failed={tally.failed} total={tally.total} /> : icon;
  const modal = open && (
    <SubagentDialog
      open
      onOpenChange={(next) => {
        if (!next) setOpen(null);
      }}
      sessionId={open.sessionId}
      title={open.title}
    />
  );

  if (run.background && !fromRunner) {
    const runnerSession = run.background.sessionId;
    const openRunner = () => setOpen({ sessionId: runnerSession, title });
    return (
      <>
        {/* The run card's header, alone: its progress and its result live in the run's own session. */}
        <div
          data-testid="workflow-run-link"
          className="border-border bg-background mt-1.5 flex w-full min-w-0 items-start gap-2.5 rounded-lg border px-4 py-3 text-left text-xs"
        >
          <span className="flex h-5 shrink-0 items-center">
            {runnerEnded === 'done' ? (
              <RunProgressRing done={1} failed={0} total={1} ended="done" />
            ) : runnerEnded === 'stopped' ? (
              <RunProgressRing done={0} failed={0} total={1} ended="stopped" />
            ) : runnerEnded === 'failed' ? (
              <RunProgressRing done={0} failed={1} total={1} />
            ) : (
              <RunProgressRing done={tally.done} failed={tally.failed} total={Math.max(tally.total, 1)} />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="text-foreground min-w-0 truncate text-sm font-medium">{title}</span>
              <RunChips run={run} />
            </span>
            <span className="text-muted-foreground min-w-0 truncate">
              {runnerEnded === 'done'
                ? t('status.done')
                : runnerEnded === 'failed'
                  ? t('didntFinish')
                  : runnerEnded === 'stopped'
                    ? t('status.stopped')
                    : [t('status.running'), tally.total > 0 ? t('progress', { done: tally.done, total: tally.total }) : null].filter(Boolean).join(' · ')}
            </span>
          </span>
          {/* The one way in: a secondary button, on the title's line. */}
          <Button type="button" variant="secondary" size="xs" aria-label={t('openRunLabel')} onClick={openRunner} className="-my-1 shrink-0">
            {t('openRun')}
            <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0" />
          </Button>
        </div>
        {modal}
      </>
    );
  }

  const counts = countAgents(run.agents);
  const progress = counts.total > 0 ? t('progress', { done: counts.done, total: counts.total }) : undefined;
  const failedPart = counts.failed > 0 ? t('failedSuffix', { count: counts.failed }) : undefined;
  const runElapsed = elapsedMs(run, live, now);
  const elapsed = runElapsed !== undefined && runElapsed >= 1_000 ? formatElapsed(runElapsed) : undefined;
  const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ') || undefined;
  const paused = run.paused ? tm('paused') : undefined;
  const subtitle =
    run.status === 'running'
      ? // A call that returned while its run goes on: the run works on without this turn.
        settled || run.background
        ? join(paused ?? t('background'), progress, failedPart)
        : join(paused, progress, failedPart, elapsed)
      : run.status === 'failed'
        ? (run.error?.split('\n')[0] ?? (counts.total > 0 ? t('failedCount', { failed: counts.failed, total: counts.total }) : undefined))
        : run.status === 'stopped'
          ? join(t('status.stopped'), progress)
          : join(
              counts.total === 0 ? undefined : counts.failed > 0 ? t('failedCount', { failed: counts.failed, total: counts.total }) : t('agents', { count: counts.total }),
              elapsed,
            );
  // The card's second line names the phase at work: "Research 2 of 5 done · 6:10".
  const phase = run.phases.find((p) => p.status === 'running');
  const phaseAgents = phase ? run.agents.filter((agent) => agent.phase === phase.title) : [];
  const phaseCounts = countAgents(phaseAgents);
  const phaseLine =
    phase && phaseCounts.total > 0 ? t('phaseProgress', { phase: phase.title, done: phaseCounts.done, total: phaseCounts.total }) : undefined;
  // Ended, the card is one line that says how it ended (Paper F2, F4, F5).
  const cardSubtitle =
    run.status === 'running'
      ? join(paused ?? (settled || run.background ? t('background') : undefined), phaseLine ?? progress, failedPart, elapsed)
      : run.status === 'done'
        ? join(t('status.done'), counts.total > 0 ? t('agents', { count: counts.total }) : undefined, elapsed)
        : run.status === 'failed'
          ? join(t('didntFinish'), counts.total > 0 ? progress : undefined, failedPart, elapsed)
          : join(t('status.stopped'), counts.total > 0 ? progress : undefined, elapsed);
  const callError = status === 'error' ? partError(call) : undefined;
  const runError = run.error ?? callError;
  const output = status === 'completed' ? partOutput(call) : '';
  const result = output && run.status === 'done' ? parseWorkflowResult(output) : null;

  return (
    // A failed run leads with the shared failure triangle, as every failed call does. A
    // completed call whose run did not fail is not a failure, whatever its output says.
    <ToolOutcomeContext.Provider value={run.status === 'failed' || status === 'error' ? 'failed' : 'ok'}>
      {/* Never a fold: the run is the thing the person watches, running or done (Paper C19). */}
      <WorkflowRunCard
        run={run}
        title={title}
        subtitle={cardSubtitle}
        live={live}
        now={now}
        onOpen={onOpen}
        stop={stop}
        chips={<RunChips run={run} />}
        result={result ? <OutputBlock text={result.text} markdown={result.kind === 'markdown'} /> : undefined}
        actions={
          <>
            {(live || (!!run.runId && !run.name && !!ids.sessionId)) && (
              <WorkflowRunControls
                projectId={ids.projectId}
                controlSessionId={live ? controlSessionId : undefined}
                ownerSessionId={ids.sessionId}
                run={run}
                appearance="text"
              />
            )}
            {run.background && (
              <Button
                type="button"
                variant="secondary"
                size="xs"
                aria-label={t('openRunLabel')}
                onClick={() => setOpen({ sessionId: run.background!.sessionId, title })}
                className="ml-1"
              >
                {t('openRun')}
                <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0" />
              </Button>
            )}
          </>
        }
      />
      {runError && run.status !== 'running' && (
        <div className="mt-2 px-4 text-sm">
          {/* One sentence; the run's raw error (script or platform words) folds behind Details. */}
          <AgentFailure sentence={t('failedSentence')} raw={runError} />
        </div>
      )}
      {modal}
    </ToolOutcomeContext.Provider>
  );
}


/** How a background run ended, read from its runner session; null while it still runs. */
function runnerOutcome(state: ReturnType<typeof boardStateOf>): 'done' | 'failed' | 'stopped' | null {
  if (state === 'completed' || state === 'idle') return 'done';
  if (state === 'failed') return 'failed';
  if (state === 'stopped') return 'stopped';
  return null;
}

ToolRegistry.register('workflow', WorkflowTool);

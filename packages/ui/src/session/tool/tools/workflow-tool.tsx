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
import { FoldedSection, OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';
import { ToolError } from '../tool-error';
import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';
import { FlowArrowIcon } from '@phosphor-icons/react';
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { qk, useProjectSession, useSessionChildren } from '@kortix/sdk/react';
import { stopProjectSession, type ProjectSession } from '@kortix/sdk';
import { useSessionIds } from '../../../providers/session-ids';
import { WorkflowLogs, WorkflowProgress, type AgentStopState } from './workflow-progress';
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
  type WorkflowResult,
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

/**
 * The way into a run's own session, at the right edge of the header. A `span
 * role="button"`: the header renders inside the row's own `role="button"`, and a
 * button inside a button is invalid HTML (the task row's "Full view" is the same).
 */
function OpenRunAction({ onOpen }: { onOpen: () => void }) {
  const t = useTranslations('tools.workflow');
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={t('openRunLabel')}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
      className="text-muted-foreground hover:text-foreground cursor-pointer text-xs whitespace-nowrap underline-offset-2 hover:underline"
    >
      {t('openRun')}
    </span>
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
  // A background run's own session: whether it still works says what the header reads.
  const runner = useProjectSession(ids.projectId, run?.background?.sessionId, { enabled: !!run?.background && !fromRunner });
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

  const icon = <FlowArrowIcon className="size-4 shrink-0" />;

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
    const subtitle = runner.data?.working?.state === 'idle' ? t('backgroundIdle') : t('background');
    return (
      <>
        {/* The row is one way in: its progress and its result live in the run's own session. */}
        <BasicTool
          icon={icon}
          trigger={<WorkflowTrigger title={title} subtitle={subtitle} chips={<RunChips run={run} />} live={false} />}
          triggerAction={<OpenRunAction onOpen={openRunner} />}
          onClick={openRunner}
          locked={locked}
        />
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
  const callError = status === 'error' ? partError(call) : undefined;
  const runError = run.error ?? callError;
  const output = status === 'completed' ? partOutput(call) : '';
  const result = output && run.status === 'done' ? parseWorkflowResult(output) : null;
  // A failed or stopped run's output is its error block, which the error row above already says.
  const rawOutput = !result && output && !output.trimStart().startsWith('<workflow_error>') ? output : '';
  const hasProgress = run.agents.length > 0 || run.phases.length > 0;
  const facts = [
    run.name && run.name !== title ? t('savedName', { name: run.name }) : undefined,
    run.status === 'running' && run.maxAgents ? t('upTo', { count: run.maxAgents }) : undefined,
  ].filter((fact): fact is string => !!fact);

  return (
    // A failed run leads with the shared failure triangle, as every failed call does. A
    // completed call whose run did not fail is not a failure, whatever its output says.
    <ToolOutcomeContext.Provider value={run.status === 'failed' || status === 'error' ? 'failed' : 'ok'}>
      <BasicTool
        icon={icon}
        trigger={<WorkflowTrigger title={title} subtitle={subtitle} chips={<RunChips run={run} />} live={live} />}
        defaultOpen={defaultOpen}
        // A running run is the thing to watch, and a failure must not hide behind a closed
        // row: either opens itself, so the rows say which agent is at work or broke.
        forceOpen={forceOpen || (hasProgress && (run.status === 'running' || run.status === 'failed' || status === 'error'))}
        locked={locked}
      >
        <>
          <RunToolbar
            facts={facts}
            controls={
              live || (!!run.runId && !run.name && !!ids.sessionId) ? (
                <WorkflowRunControls
                  projectId={ids.projectId}
                  controlSessionId={live ? controlSessionId : undefined}
                  ownerSessionId={ids.sessionId}
                  run={run}
                />
              ) : null
            }
            onOpen={run.background ? () => setOpen({ sessionId: run.background!.sessionId, title }) : undefined}
          />
          <WorkflowLogs logs={run.logs} />
          {hasProgress && <WorkflowProgress run={run} live={live} now={now} onOpen={onOpen} stop={stop} />}
          {runError && run.status !== 'running' && <ToolError error={runError} toolName={call.name} />}
          {result ? <WorkflowResultFold result={result} /> : rawOutput ? <WorkflowDetails output={rawOutput} /> : null}
        </>
      </BasicTool>
      {modal}
    </ToolOutcomeContext.Provider>
  );
}

/** The facts line and the run's controls, above the progress. A background run opens its runner session here too. */
function RunToolbar({ facts, controls, onOpen }: { facts: string[]; controls: React.ReactNode; onOpen?: () => void }) {
  const t = useTranslations('tools.workflow');
  const indent = useToolIndent();
  if (facts.length === 0 && !controls && !onOpen) return null;
  return (
    <div className={cn('flex min-h-6 items-center gap-2 text-xs', indent && 'mt-1.5', indent)}>
      <p className="text-muted-foreground min-w-0 flex-1 truncate">{facts.join(' · ')}</p>
      {onOpen && (
        <button
          type="button"
          aria-label={t('openRunLabel')}
          onClick={onOpen}
          className="text-muted-foreground hover:text-foreground cursor-pointer whitespace-nowrap underline-offset-2 transition-colors hover:underline"
        >
          {t('openRun')}
        </button>
      )}
      {controls}
    </div>
  );
}

/** The script's return value, folded: pretty JSON in mono, anything else as Markdown. */
function WorkflowResultFold({ result }: { result: WorkflowResult }) {
  const t = useTranslations('tools.workflow');
  const indent = useToolIndent();
  return (
    <div className={cn(indent && 'mt-1.5', indent)}>
      <FoldedSection label={t('result')}>
        <OutputBlock text={result.text} markdown={result.kind === 'markdown'} />
      </FoldedSection>
    </div>
  );
}

function WorkflowDetails({ output }: { output: string }) {
  const t = useTranslations('tools.workflow');
  const indent = useToolIndent();
  return (
    <div className={cn(indent && 'mt-1.5', indent)}>
      <FoldedSection label={t('showDetails')}>
        <OutputBlock text={output.length > 8_000 ? `${output.slice(0, 8_000)}\n…` : output} />
      </FoldedSection>
    </div>
  );
}

ToolRegistry.register('workflow', WorkflowTool);

'use client';

import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { ButtonGroup } from '../../primitives/button-group';
import { CountBadge } from '../../primitives/count-badge';
import { Hint } from '../../primitives/hint';
import Loading from '../../primitives/loading';
import { StatusDot, type StatusTone } from '../../primitives/status';
import { errorToast } from '../../primitives/toast';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { SubSessionModal } from '../thread/sub-session-modal';
import { CaretRightIcon, ListChecksIcon, SquareIcon } from '@phosphor-icons/react';
import { useCallback, useId, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { stopProjectSession, type SessionTask, type WorkflowRunMetadata } from '@kortix/sdk';
import {
  qk,
  useFeatureFlag,
  usePeerMessages,
  useSessionChildren,
  useSessionWorkflows,
  useTeamTasks,
  useTeammates,
} from '@kortix/sdk/react';
import { countAgents, parseWorkflowRun, type WorkflowRun, type WorkflowRunAgent } from '../tool/tools/workflow-run';
import { WorkflowProgress, type AgentStopState } from '../tool/tools/workflow-progress';
import {
  foldIdle,
  isActive,
  moveSelection,
  stripCounts,
  stripGroups,
  stripKeyAction,
  type AgentRow,
  type AgentRowState,
} from './agent-model';
import { heldMessages, HeldMessageList } from './held-messages';
import { TasksPanel } from './tasks-panel';
import {
  isLargeRun,
  LargeRunBadge,
  useLiveWorkflowRun,
  useNow,
  useRestartAgent,
  WorkflowRunControls,
} from './workflow-run-controls';

/**
 * The agent strip under the session composer: Claude Code's agent panel.
 *
 * One row per agent this session started (its child sessions), the teammates
 * of a team it leads under "Team", and its workflow runs under "Workflows". A
 * row names the agent, its state and one line of what it does or produced; it
 * opens the agent's session in place and stops it. The header counts them
 * ("3 agents · 1 working") and folds the list; more than three idle agents fold
 * into one "N idle agents" row. Nothing here holds the composer: the agents
 * run in their own sessions, and the person keeps talking to this one.
 *
 * Keys while the strip has focus: ↑ ↓ move, Enter opens, x stops, Esc clears
 * the selection, Ctrl+T shows the team's task list.
 */

/** How often the child list polls while the strip is mounted. */
const CHILDREN_POLL_MS = 5_000;
/** A finished workflow run stays listed this long after it ended. */
const RECENT_RUN_MS = 60 * 60_000;
/** The strip lists at most this many runs. */
const MAX_RUNS = 5;

const STATE_TONE: Record<AgentRowState, StatusTone> = {
  working: 'success',
  needs_input: 'warning',
  idle: 'neutral',
  completed: 'success',
  failed: 'destructive',
  stopped: 'neutral',
};

function StateDot({ state }: { state: AgentRowState }) {
  const t = useTranslations('multiAgent.strip');
  return (
    <span className="flex size-3 shrink-0 items-center justify-center">
      <StatusDot
        tone={STATE_TONE[state]}
        pulse={state === 'working'}
        className={cn(state === 'working' && 'motion-reduce:animate-none', state === 'idle' && 'opacity-50')}
      />
      <span className="sr-only">{t(`state.${state}`)}</span>
    </span>
  );
}

export interface StripRunEntry {
  run: WorkflowRun;
}

/** The runs the strip lists: running ones, and ones that ended in the last hour; newest first. */
export function stripRuns(runs: readonly WorkflowRunMetadata[], now: number): WorkflowRun[] {
  const out: WorkflowRun[] = [];
  for (const raw of runs) {
    const run = parseWorkflowRun(raw);
    if (!run) continue;
    if (run.status !== 'running' && (run.endedAt === undefined || now - run.endedAt > RECENT_RUN_MS)) continue;
    out.push(run);
    if (out.length >= MAX_RUNS) break;
  }
  return out;
}

/** Every session a run owns: its runner and its agents. They show under the run, not as agent rows. */
export function runSessionIds(runs: readonly WorkflowRun[]): Set<string> {
  const ids = new Set<string>();
  for (const run of runs) {
    if (run.background) ids.add(run.background.sessionId);
    for (const agent of run.agents) if (agent.sessionId) ids.add(agent.sessionId);
  }
  return ids;
}

type OpenTarget = { sessionId: string; title: string };

export interface AgentStripViewProps {
  projectId: string | undefined;
  sessionId: string | undefined;
  agents: AgentRow[];
  team: AgentRow[];
  runs: WorkflowRun[];
  /** The team's tasks; `null` when this session leads no team (or `agent_teams` is off). */
  tasks: SessionTask[] | null;
  onOpen: (target: OpenTarget) => void;
  onStop: (row: AgentRow) => void;
  stopping: ReadonlySet<string>;
  /** First render state of the task list (tests). */
  defaultTasksOpen?: boolean;
}

export function AgentStripView({
  projectId,
  sessionId,
  agents,
  team,
  runs,
  tasks,
  onOpen,
  onStop,
  stopping,
  defaultTasksOpen = false,
}: AgentStripViewProps) {
  const t = useTranslations('multiAgent.strip');
  const listId = useId();
  const tasksId = useId();
  const [collapsed, setCollapsed] = useState(false);
  const [idleOpen, setIdleOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(defaultTasksOpen);
  const [selected, setSelected] = useState<string | null>(null);

  const agentFold = foldIdle(agents, idleOpen, selected);
  const teamFold = foldIdle(team, idleOpen, selected);
  const folded = agentFold.folded.length + teamFold.folded.length;
  const rows = useMemo(() => [...agentFold.shown, ...teamFold.shown], [agentFold.shown, teamFold.shown]);
  const counts = stripCounts([...agents, ...team]);
  const runningRuns = runs.filter((run) => run.status === 'running').length;
  const hasTasks = tasks !== null && (tasks.length > 0 || team.length > 0);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable="true"]')) return;
      const action = stripKeyAction(event);
      if (!action) return;
      const row = rows.find((candidate) => candidate.sessionId === selected) ?? null;
      switch (action) {
        case 'up':
        case 'down':
          setSelected((current) => moveSelection(rows.map((r) => r.sessionId), current, action));
          break;
        case 'open':
          // Enter on a focused button activates that button; the strip opens only its own selection.
          if (!row || target.closest('button')) return;
          onOpen({ sessionId: row.sessionId, title: row.handle });
          break;
        case 'stop':
          if (!row || !isActive(row.state)) return;
          onStop(row);
          break;
        case 'clear':
          if (!selected) return;
          setSelected(null);
          break;
        case 'toggleTasks':
          if (!hasTasks) return;
          setTasksOpen((open) => !open);
          break;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [rows, selected, onOpen, onStop, hasTasks],
  );

  if (agents.length === 0 && team.length === 0 && runs.length === 0 && !hasTasks) return null;

  const summary = [
    counts.agents > 0 ? t('agents', { count: counts.agents }) : undefined,
    counts.working > 0 ? t('working', { count: counts.working }) : undefined,
    counts.needsInput > 0 ? t('needsInput', { count: counts.needsInput }) : undefined,
    runs.length > 0 ? t('workflows', { count: runs.length, running: runningRuns }) : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  const renderRows = (list: AgentRow[]) => (
    <ul>
      {list.map((row) => (
        <AgentStripRow
          key={row.sessionId}
          row={row}
          selected={row.sessionId === selected}
          stopping={stopping.has(row.sessionId)}
          onSelect={() => setSelected(row.sessionId)}
          onOpen={() => onOpen({ sessionId: row.sessionId, title: row.handle })}
          onStop={() => onStop(row)}
        />
      ))}
    </ul>
  );

  return (
    <div
      data-agent-strip
      role="group"
      aria-label={t('label')}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSelected(null);
      }}
      className="bg-popover focus-visible:ring-ring/50 rounded-md border text-xs outline-none focus-visible:ring-2"
    >
      <div className="flex min-h-8 items-center gap-1 pr-1">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={listId}
          onClick={() => setCollapsed((value) => !value)}
          className="text-muted-foreground hover:text-foreground flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left tabular-nums transition-colors"
        >
          <CaretRightIcon
            aria-hidden
            className={cn('size-3 shrink-0 transition-transform motion-reduce:transition-none', !collapsed && 'rotate-90')}
          />
          <span className="min-w-0 truncate">{summary || t('label')}</span>
        </button>
        {hasTasks && (
          <Hint label={t('tasksHint')} side="top">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-expanded={tasksOpen}
              aria-controls={tasksId}
              onClick={() => setTasksOpen((open) => !open)}
              className={cn('text-muted-foreground hover:text-foreground', tasksOpen && 'text-foreground')}
            >
              <ListChecksIcon className="size-3.5 shrink-0" />
              {t('tasks')}
              {tasks && tasks.length > 0 && <CountBadge count={tasks.filter((task) => task.status !== 'completed').length} />}
            </Button>
          </Hint>
        )}
      </div>
      {!collapsed && (
        <div id={listId} className="space-y-1 border-t px-1 py-1">
          {hasTasks && tasksOpen && tasks && (
            <div className="border-b pb-1">
              <TasksPanel id={tasksId} tasks={tasks} />
            </div>
          )}
          {agentFold.shown.length > 0 && renderRows(agentFold.shown)}
          {teamFold.shown.length > 0 && (
            <div>
              <GroupLabel>{t('team')}</GroupLabel>
              {renderRows(teamFold.shown)}
            </div>
          )}
          {folded > 0 && (
            <button
              type="button"
              onClick={() => setIdleOpen(true)}
              className="text-muted-foreground hover:bg-muted/40 hover:text-foreground flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left transition-colors"
            >
              <StateDot state="idle" />
              {t('idleFolded', { count: folded })}
            </button>
          )}
          {idleOpen && folded === 0 && agents.concat(team).filter((row) => row.state === 'idle').length > 3 && (
            <button
              type="button"
              onClick={() => setIdleOpen(false)}
              className="text-muted-foreground hover:text-foreground w-full cursor-pointer rounded-sm px-2 py-1 text-left transition-colors"
            >
              {t('idleCollapse')}
            </button>
          )}
          {runs.length > 0 && (
            <div>
              <GroupLabel>{t('workflowsGroup')}</GroupLabel>
              <ul>
                {runs.map((run) => (
                  <WorkflowStripRow key={run.runId || run.title} projectId={projectId} sessionId={sessionId} run={run} onOpen={onOpen} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground px-2 pt-1 pb-0.5 text-xs font-medium">{children}</div>;
}

function AgentStripRow({
  row,
  selected,
  stopping,
  onSelect,
  onOpen,
  onStop,
}: {
  row: AgentRow;
  selected: boolean;
  stopping: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onStop: () => void;
}) {
  const t = useTranslations('multiAgent.strip');
  const line = row.state === 'needs_input' ? (row.line ?? t(`attention.${row.attention ?? 'question'}`)) : row.line;
  return (
    <li
      data-agent-row={row.sessionId}
      data-selected={selected || undefined}
      aria-current={selected || undefined}
      onMouseDown={onSelect}
      className={cn(
        'group flex min-w-0 items-center gap-1 rounded-sm transition-none',
        selected ? 'bg-muted' : 'hover:bg-muted/40',
      )}
    >
      <button
        type="button"
        aria-label={t('openAgent', { name: row.handle })}
        onClick={onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1 text-left"
      >
        <StateDot state={row.state} />
        <span className={cn('min-w-0 shrink truncate font-medium', row.state === 'idle' ? 'text-muted-foreground' : 'text-foreground')} title={row.handle}>
          {row.handle}
        </span>
        {row.agent && <span className="text-muted-foreground max-w-[30%] shrink-0 truncate">{row.agent}</span>}
        <span className="text-muted-foreground min-w-0 flex-1 truncate" title={line ?? undefined}>
          {line ?? t(`state.${row.state}`)}
        </span>
      </button>
      <span className="flex size-6 shrink-0 items-center justify-center">
        {stopping ? (
          <Loading className="text-muted-foreground size-3" />
        ) : isActive(row.state) ? (
          <Hint label={t('stopHint')} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('stopAgent', { name: row.handle })}
              onClick={onStop}
              className="text-muted-foreground hover:text-foreground"
            >
              <SquareIcon weight="fill" className="size-2.5" />
            </Button>
          </Hint>
        ) : null}
      </span>
    </li>
  );
}

const RUN_STATE: Record<WorkflowRun['status'], AgentRowState> = {
  running: 'working',
  done: 'completed',
  failed: 'failed',
  stopped: 'stopped',
};

/** One workflow run in the strip: its progress line and controls; it unfolds into its agents. */
function WorkflowStripRow({
  projectId,
  sessionId,
  run: listed,
  onOpen,
}: {
  projectId: string | undefined;
  sessionId: string | undefined;
  run: WorkflowRun;
  onOpen: (target: OpenTarget) => void;
}) {
  const t = useTranslations('multiAgent.strip');
  const tw = useTranslations('multiAgent.workflow');
  const [open, setOpen] = useState(false);
  const { run, controlSessionId } = useLiveWorkflowRun(projectId, sessionId, listed);
  const now = useNow(open && run?.status === 'running');
  const restart = useRestartAgent(projectId, controlSessionId, run);
  const queryClient = useQueryClient();
  const stopAgent = useMutation({
    mutationFn: (agent: WorkflowRunAgent) => stopProjectSession(projectId!, agent.sessionId!),
    onSuccess: () => projectId && queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) }),
    onError: (error) => errorToast(t('stopFailed'), { description: error instanceof Error ? error.message : undefined }),
  });
  if (!run) return null;
  const counts = countAgents(run.agents);
  const progress = counts.total > 0 ? t('runProgress', { done: counts.done, total: counts.total }) : undefined;
  const state =
    run.status === 'running'
      ? [run.paused ? tw('paused') : run.background ? t('runBackground') : t('runRunning'), progress]
      : [t(`runStatus.${run.status}`), progress];
  const line = state.filter(Boolean).join(' · ');
  const live = run.status === 'running';
  const stop: AgentStopState = {
    enabled: !!projectId,
    pending: new Set(stopAgent.isPending && stopAgent.variables?.sessionId ? [stopAgent.variables.sessionId] : []),
    stop: (agent) => agent.sessionId && stopAgent.mutate(agent),
    ...(restart.enabled ? { restart: { pending: restart.restarting, run: restart.restart } } : {}),
  };
  const title = run.title || run.name || t('runFallback');
  return (
    <li data-workflow-run={run.runId}>
      <div className="flex min-w-0 items-center gap-1 rounded-sm hover:bg-muted/40">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1 text-left"
        >
          <StateDot state={RUN_STATE[run.status]} />
          <span className="text-foreground min-w-0 shrink truncate font-medium" title={title}>
            {title}
          </span>
          {isLargeRun(run) && <LargeRunBadge />}
          <span className="text-muted-foreground min-w-0 flex-1 truncate tabular-nums">{line}</span>
        </button>
        {run.background && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onOpen({ sessionId: run.background!.sessionId, title })}
            className="text-muted-foreground hover:text-foreground"
          >
            {t('openRun')}
          </Button>
        )}
        <WorkflowRunControls
          projectId={projectId}
          controlSessionId={live ? controlSessionId : undefined}
          ownerSessionId={sessionId}
          run={run}
        />
      </div>
      {open && run.agents.length > 0 && (
        <div className="pl-5">
          <WorkflowProgress
            run={run}
            live={live}
            now={now}
            onOpen={(agent) =>
              agent.sessionId && onOpen({ sessionId: agent.sessionId, title: agent.agent ? `${agent.label} · ${agent.agent}` : agent.label })
            }
            stop={stop}
          />
        </div>
      )}
      {open && run.agents.length === 0 && (
        <Badge variant="muted" size="sm" className="ml-7">
          {t('runNoAgents')}
        </Badge>
      )}
    </li>
  );
}

/**
 * The strip of one session, read live: its children (polled every 5 s), its
 * teammates and team tasks (flag `agent_teams`), its workflow runs, and the
 * held messages waiting for the person above it.
 */
export function AgentStrip({
  projectId,
  sessionId,
  className,
}: {
  projectId: string | undefined;
  sessionId: string | undefined;
  /** The wrapper's classes; the strip renders nothing (no wrapper) while it has nothing to show. */
  className?: string;
}) {
  const t = useTranslations('multiAgent.strip');
  const pid = projectId ?? '';
  const sid = sessionId ?? '';
  const ready = !!projectId && !!sessionId;
  const teams = useFeatureFlag(projectId, 'agent_teams').enabled;
  const childList = useSessionChildren(pid, sid, { enabled: ready, refetchInterval: CHILDREN_POLL_MS, limit: 50 });
  const children = childList.sessions;
  const { data: teammates, dataUpdatedAt: teammatesAt } = useTeammates(projectId, sessionId, { enabled: ready && teams });
  const { data: tasks } = useTeamTasks(projectId, sessionId, { enabled: ready && teams });
  const { data: runData, dataUpdatedAt: runsAt } = useSessionWorkflows(projectId, sessionId, { enabled: ready });
  const peer = usePeerMessages(projectId, sessionId, 'in');
  const [open, setOpen] = useState<OpenTarget | null>(null);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const queryClient = useQueryClient();
  const stopMutation = useMutation({
    mutationFn: (row: AgentRow) => stopProjectSession(pid, row.sessionId),
    onSettled: (_data, _error, row) => {
      setStopping((previous) => {
        const next = new Set(previous);
        next.delete(row.sessionId);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(pid) });
    },
    onError: (error, row) =>
      errorToast(t('stopAgentFailed', { name: row.handle }), { description: error instanceof Error ? error.message : undefined }),
  });

  // "Recent" is measured at the newest answer, not at each render: the lists re-derive when data arrives.
  const now = Math.max(childList.dataUpdatedAt, teammatesAt, runsAt);
  const runs = useMemo(() => stripRuns(runData ?? [], now), [runData, now]);
  const groups = useMemo(
    () =>
      stripGroups({
        leadSessionId: sid,
        children,
        teammates: teammates ?? [],
        exclude: runSessionIds(runs),
        now,
      }),
    [sid, children, teammates, runs, now],
  );
  const leadsTeam = teams && ((teammates?.length ?? 0) > 0 || (tasks?.length ?? 0) > 0);

  const hasHeld = heldMessages(peer.data).length > 0;
  const empty = groups.agents.length === 0 && groups.team.length === 0 && runs.length === 0 && !leadsTeam;
  if (!ready || (empty && !hasHeld && !open)) return null;
  return (
    <div className={cn('space-y-1.5', className)}>
      <HeldMessageList messages={peer.data} approve={peer.approve} deny={peer.deny} />
      <AgentStripView
        projectId={projectId}
        sessionId={sessionId}
        agents={groups.agents}
        team={groups.team}
        runs={runs}
        tasks={leadsTeam ? (tasks ?? []) : null}
        onOpen={setOpen}
        onStop={(row) => {
          setStopping((previous) => new Set(previous).add(row.sessionId));
          stopMutation.mutate(row);
        }}
        stopping={stopping}
      />
      {open && (
        <SubSessionModal
          open
          onOpenChange={(next) => {
            if (!next) setOpen(null);
          }}
          sessionId={open.sessionId}
          title={open.title}
        />
      )}
    </div>
  );
}

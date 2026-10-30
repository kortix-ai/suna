'use client';

import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { CountBadge } from '../../primitives/count-badge';
import { Hint } from '../../primitives/hint';
import Loading from '../../primitives/loading';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { StatusDot, type StatusTone } from '../../primitives/status';
import { Tabs, TabsContent, TabsListCompact, TabsTriggerCompact } from '../../primitives/tabs';
import { errorToast } from '../../primitives/toast';
import { useTranslations } from '../../i18n';
import { agentDisplayName } from '../../internal/components/agent-mark';
import { cn } from '../../lib/utils';
import { SubagentDialog } from './subagent-view';
import { ArrowUpRightIcon, CaretUpIcon, CheckIcon, SquareIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { stopProjectSession, type SessionTask, type WorkflowRunMetadata } from '@kortix/sdk';
import {
  qk,
  useFeatureFlag,
  useSessionChildren,
  useSessionWorkflows,
  useTeamTasks,
  useTeammates,
} from '@kortix/sdk/react';
import { countAgents, parseWorkflowRun, type WorkflowRun, type WorkflowRunAgent } from '../tool/tools/workflow-run';
import { WorkflowProgress, type AgentStopState } from '../tool/tools/workflow-progress';
import {
  isActive,
  lineSummary,
  shortElapsed,
  stripGroups,
  type AgentRow,
  type AgentRowState,
  type LineMark,
} from './agent-model';
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
 * The agents line: one muted control in the composer's under-row, right of the
 * agent picker (Claude Code's agent panel, folded to one line).
 *
 *   ● 2 agents · 1 working ⌃        ✓ 2 agents · poet done ⌃
 *
 * It names the state of what this session started (its child sessions, the
 * teammates of a team it leads, its workflow runs) and opens a popover above
 * the line with one row per agent: open its session, stop it while it works,
 * and the Tasks tab of a team it leads. It renders nothing while the session
 * started nothing, and it never holds the composer: the agents run in their own
 * sessions, and the person keeps talking to this one.
 */

/** How often the child list polls while the line is mounted. */
const CHILDREN_POLL_MS = 5_000;
/** A finished workflow run stays listed this long after it ended. */
const RECENT_RUN_MS = 60 * 60_000;
/** The popover lists at most this many runs. */
const MAX_RUNS = 5;

const DOT_TONE: Record<Exclude<AgentRowState, 'idle' | 'completed'>, StatusTone> = {
  working: 'success',
  needs_input: 'warning',
  failed: 'destructive',
  stopped: 'neutral',
};

/**
 * The state mark of a row or of the line: the live dot while it works, the
 * attention dot while it waits on the person, a check once its turn ended.
 * The words beside it say the state; the mark repeats it.
 */
function StateMark({ state }: { state: AgentRowState }) {
  const t = useTranslations('multiAgent.strip');
  return (
    <span className="flex size-3 shrink-0 items-center justify-center">
      {state === 'idle' || state === 'completed' ? (
        <CheckIcon aria-hidden weight="bold" className="text-kortix-green size-3" />
      ) : (
        <StatusDot
          tone={DOT_TONE[state]}
          pulse={state === 'working'}
          className={cn(state === 'working' && 'motion-reduce:animate-none')}
        />
      )}
      <span className="sr-only">{t(`state.${state}`)}</span>
    </span>
  );
}

const LINE_STATE: Record<LineMark, AgentRowState> = {
  needs_input: 'needs_input',
  working: 'working',
  failed: 'failed',
  done: 'completed',
};

/** The runs the line lists: running ones, and ones that ended in the last hour; newest first. */
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

export type OpenTarget = { sessionId: string; title: string };

export interface AgentsLineViewProps {
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
  /** The line shows the mark and the count only: a narrow toolbar (a channel's thread panel). */
  compact?: boolean;
  /** First render state of the popover (tests). */
  defaultOpen?: boolean;
}

/** The text of the line: `2 agents · 1 working`, `2 agents · poet done`, `1 workflow running`. */
function useLineText(rows: readonly AgentRow[], runs: readonly WorkflowRun[], compact: boolean) {
  const t = useTranslations('multiAgent.strip');
  const summary = lineSummary(rows, runs);
  const parts: string[] = [];
  if (summary.agents > 0) parts.push(t('agents', { count: summary.agents }));
  if (summary.runs > 0) {
    parts.push(
      summary.runningRuns > 0
        ? t('workflowsRunning', { count: summary.runningRuns })
        : t('workflows', { count: summary.runs }),
    );
  }
  if (!compact && summary.agents > 0) {
    if (summary.needsInput > 0) parts.push(t('state.needs_input'));
    else if (summary.working > 0) parts.push(t('working', { count: summary.working }));
    else if (summary.newest) parts.push(t('newest', { name: summary.newest.handle, state: t(`state.${summary.newest.state}`) }));
  }
  return { summary, text: parts.join(' · ') };
}

export function AgentsLineView({
  projectId,
  sessionId,
  agents,
  team,
  runs,
  tasks,
  onOpen,
  onStop,
  stopping,
  compact = false,
  defaultOpen = false,
}: AgentsLineViewProps) {
  const t = useTranslations('multiAgent.strip');
  const [open, setOpen] = useState(defaultOpen);
  const rows = useMemo(() => [...agents, ...team], [agents, team]);
  const { summary, text } = useLineText(rows, runs, compact);

  if (rows.length === 0 && runs.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="agents-line"
          aria-label={compact ? `${t('label')}: ${text}` : undefined}
          className="text-muted-foreground hit-area-y-3 min-w-0 shrink gap-1.5 rounded-lg px-2 text-xs font-normal tabular-nums"
        >
          <StateMark state={LINE_STATE[summary.mark]} />
          <span className="max-w-64 min-w-0 truncate">{text}</span>
          <CaretUpIcon aria-hidden className={cn('size-3 shrink-0', open && 'rotate-180')} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        aria-label={t('label')}
        data-testid="agents-line-popover"
        tabIndex={-1}
        // Focus the panel, not its first row action: a focused action opens its
        // tooltip, and the first Escape would close the tooltip, not the popover.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        className="flex w-[min(360px,calc(100vw-1.5rem))] flex-col p-0"
      >
        <AgentsPanel
          projectId={projectId}
          sessionId={sessionId}
          agents={agents}
          team={team}
          runs={runs}
          tasks={tasks}
          onOpen={(target) => {
            setOpen(false);
            onOpen(target);
          }}
          onStop={onStop}
          stopping={stopping}
          live={open}
        />
      </PopoverContent>
    </Popover>
  );
}

export interface AgentsPanelProps extends Omit<AgentsLineViewProps, 'compact' | 'defaultOpen'> {
  /** The popover is open: a working row's elapsed time ticks. */
  live: boolean;
}

/** The popover body: Agents, Team, Workflows, and a Tasks tab when this session leads a team. */
export function AgentsPanel({ projectId, sessionId, agents, team, runs, tasks, onOpen, onStop, stopping, live }: AgentsPanelProps) {
  const t = useTranslations('multiAgent.strip');
  const anyWorking = live && [...agents, ...team].some((row) => row.state === 'working');
  const now = useNow(anyWorking);
  const sections = [agents.length > 0, team.length > 0, runs.length > 0].filter(Boolean).length;

  const renderRows = (list: AgentRow[], teammate: boolean) => (
    <ul>
      {list.map((row) => (
        <AgentLineRow
          key={row.sessionId}
          row={row}
          teammate={teammate}
          now={now}
          stopping={stopping.has(row.sessionId)}
          onOpen={() => onOpen({ sessionId: row.sessionId, title: row.handle })}
          onStop={() => onStop(row)}
        />
      ))}
    </ul>
  );

  const list = (
    <div className="max-h-96 overflow-y-auto p-1">
      {agents.length > 0 && (
        <section aria-label={t('label')}>
          {sections > 1 && <GroupLabel>{t('label')}</GroupLabel>}
          {renderRows(agents, false)}
        </section>
      )}
      {team.length > 0 && (
        <section aria-label={t('team')}>
          <GroupLabel>{t('team')}</GroupLabel>
          {renderRows(team, true)}
        </section>
      )}
      {runs.length > 0 && (
        <section aria-label={t('workflowsGroup')}>
          <GroupLabel>{t('workflowsGroup')}</GroupLabel>
          <ul>
            {runs.map((run) => (
              <WorkflowLineRow key={run.runId || run.title} projectId={projectId} sessionId={sessionId} run={run} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );

  if (tasks === null) return list;
  const openTasks = tasks.filter((task) => task.status !== 'completed').length;
  return (
    <Tabs defaultValue="agents" className="gap-0">
      <TabsContent value="agents">{list}</TabsContent>
      <TabsContent value="tasks" className="max-h-96 overflow-y-auto p-1">
        <TasksPanel tasks={tasks} />
      </TabsContent>
      <div className="border-t p-1">
        <TabsListCompact animate="none" className="w-full">
          <TabsTriggerCompact value="agents">{t('label')}</TabsTriggerCompact>
          <TabsTriggerCompact value="tasks" className="gap-1.5">
            {t('tasks')}
            {openTasks > 0 && <CountBadge count={openTasks} />}
          </TabsTriggerCompact>
        </TabsListCompact>
      </div>
    </Tabs>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground px-2 pt-1.5 pb-0.5 text-xs font-medium">{children}</div>;
}

/** Row actions: shown on hover and on keyboard focus, always on a touch screen. */
const ROW_ACTIONS =
  'flex shrink-0 items-center opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100';

/** The short state of a row: `working · 1m`, `done`, `needs you`, `failed`. */
function rowState(row: AgentRow, now: number, t: ReturnType<typeof useTranslations<'multiAgent.strip'>>): string {
  if (row.state === 'working' && row.workingSinceMs !== null) {
    return t('workingFor', { elapsed: shortElapsed(now - row.workingSinceMs) });
  }
  return t(`state.${row.state}`);
}

function AgentLineRow({
  row,
  teammate,
  now,
  stopping,
  onOpen,
  onStop,
}: {
  row: AgentRow;
  teammate: boolean;
  now: number;
  stopping: boolean;
  onOpen: () => void;
  onStop: () => void;
}) {
  const t = useTranslations('multiAgent.strip');
  // The result, or what it waits for: one line on hover, never inline.
  const detail = row.state === 'needs_input' ? (row.line ?? t(`attention.${row.attention ?? 'question'}`)) : row.line;
  const handle = (
    <span className="text-foreground min-w-0 truncate font-medium" title={teammate ? undefined : row.handle}>
      {row.handle}
    </span>
  );
  const state = (
    <span className="text-muted-foreground shrink-0 tabular-nums">{rowState(row, now, t)}</span>
  );
  return (
    <li
      data-testid="agents-line-row"
      data-agent-row={row.sessionId}
      className="group/row hover:bg-hover focus-within:bg-hover flex min-w-0 items-center gap-1 rounded-sm"
    >
      <div onClick={onOpen} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pl-2 text-xs">
        <StateMark state={row.state} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            {teammate ? (
              <Hint label={t('teamRole')} side="top">
                {handle}
              </Hint>
            ) : (
              handle
            )}
            {detail ? (
              <Hint label={<span className="block max-w-72 truncate">{detail}</span>} side="top">
                {state}
              </Hint>
            ) : (
              state
            )}
          </div>
          {row.named && row.agent && (
            <p className="text-muted-foreground truncate">{t('runsAs', { agent: agentDisplayName(row.agent) })}</p>
          )}
        </div>
      </div>
      <div className={cn(ROW_ACTIONS, 'pr-1', stopping && 'opacity-100')}>
        <Hint label={t('openAgent', { name: row.handle })} side="top">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('openAgent', { name: row.handle })}
            onClick={onOpen}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowUpRightIcon className="size-3.5 shrink-0" />
          </Button>
        </Hint>
        {stopping ? (
          <span className="flex size-6 items-center justify-center">
            <Loading className="text-muted-foreground size-3" />
          </span>
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
      </div>
    </li>
  );
}

const RUN_STATE: Record<WorkflowRun['status'], AgentRowState> = {
  running: 'working',
  done: 'completed',
  failed: 'failed',
  stopped: 'stopped',
};

/** One workflow run: its live progress and controls; it unfolds into its agents. */
function WorkflowLineRow({
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
  // A background run's progress is read from its runner, so it keeps moving after this turn ended.
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
  const line = (
    run.status === 'running'
      ? [run.paused ? tw('paused') : run.background ? t('runBackground') : t('runRunning'), progress]
      : [progress]
  )
    .filter(Boolean)
    .join(' · ');
  const live = run.status === 'running';
  const stop: AgentStopState = {
    enabled: !!projectId,
    pending: new Set(stopAgent.isPending && stopAgent.variables?.sessionId ? [stopAgent.variables.sessionId] : []),
    stop: (agent) => agent.sessionId && stopAgent.mutate(agent),
    ...(restart.enabled ? { restart: { pending: restart.restarting, run: restart.restart } } : {}),
  };
  const title = run.title || run.name || t('runFallback');
  return (
    <li data-testid="agents-line-row" data-workflow-run={run.runId}>
      <div className="group/row hover:bg-hover focus-within:bg-hover flex min-w-0 items-center gap-1 rounded-sm">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pl-2 text-left text-xs outline-none"
        >
          <StateMark state={RUN_STATE[run.status]} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="text-foreground min-w-0 truncate font-medium" title={title}>
                {title}
              </span>
              <span className="text-muted-foreground shrink-0">{t(`state.${RUN_STATE[run.status]}`)}</span>
            </div>
            {line && <p className="text-muted-foreground truncate tabular-nums">{line}</p>}
          </div>
        </button>
        {isLargeRun(run) && <LargeRunBadge />}
        <div className={cn(ROW_ACTIONS, 'pr-1')}>
          {run.background && (
            <Hint label={t('openRun')} side="top">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('openRun')}
                onClick={() => onOpen({ sessionId: run.background!.sessionId, title })}
                className="text-muted-foreground hover:text-foreground"
              >
                <ArrowUpRightIcon className="size-3.5 shrink-0" />
              </Button>
            </Hint>
          )}
          <WorkflowRunControls
            projectId={projectId}
            controlSessionId={live ? controlSessionId : undefined}
            ownerSessionId={sessionId}
            run={run}
          />
        </div>
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
 * The agents of one session, read live: its children (polled every 5 s), its
 * teammates and team tasks (flag `agent_teams`) and its workflow runs; and the
 * stop of one agent.
 */
export function useAgentsLine(projectId: string | undefined, sessionId: string | undefined) {
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
  return {
    ready,
    agents: groups.agents,
    team: groups.team,
    runs,
    tasks: leadsTeam ? (tasks ?? []) : null,
    stopping,
    stop: (row: AgentRow) => {
      setStopping((previous) => new Set(previous).add(row.sessionId));
      stopMutation.mutate(row);
    },
  };
}

/**
 * The agents line of one session, for the composer's under-row
 * (`SessionChatInputProps.underbarSlot`). Nothing renders while the session
 * started no agent and no workflow run.
 */
export function AgentsLine({
  projectId,
  sessionId,
  compact = false,
}: {
  projectId: string | undefined;
  sessionId: string | undefined;
  compact?: boolean;
}) {
  const line = useAgentsLine(projectId, sessionId);
  const [open, setOpen] = useState<OpenTarget | null>(null);
  if (!line.ready) return null;
  return (
    <>
      <AgentsLineView
        projectId={projectId}
        sessionId={sessionId}
        agents={line.agents}
        team={line.team}
        runs={line.runs}
        tasks={line.tasks}
        onOpen={setOpen}
        onStop={line.stop}
        stopping={line.stopping}
        compact={compact}
      />
      {open && (
        <SubagentDialog
          open
          onOpenChange={(next) => {
            if (!next) setOpen(null);
          }}
          projectId={projectId}
          sessionId={open.sessionId}
          title={open.title}
        />
      )}
    </>
  );
}

/**
 * The model behind `/agents`, `/workflows`, `/tasks` and the agents segment of
 * the tray: which child sessions a session shows, in which group and order,
 * what a workflow run's progress line says, and what the tray says.
 *
 * The rules match the web agents line (`packages/ui/src/session/agents/
 * agent-model.ts`) so one session reads the same in both clients: a
 * teammate is a child too, the sessions a workflow run owns show under the
 * run and not as agents, and a settled row older than an hour leaves the tray.
 *
 * Pure: no React, no SDK client, `now` is a parameter.
 */

import {
  heldMessages as heldOldestFirst,
  type PeerMessage,
  type ProjectSession,
  type SessionBoardState,
  type SessionTask,
  type WorkflowRunAgent,
  type WorkflowRunMetadata,
} from '@kortix/sdk';

import { printable } from '../../lib/printable.ts';

/** A settled agent or an ended run older than this leaves the tray. */
export const RECENT_MS = 60 * 60_000;

export interface AgentRow {
  sessionId: string;
  /** The agent handle, else the session name, else the agent slug, never empty. */
  handle: string;
  agent: string | null;
  state: SessionBoardState;
  attention: 'question' | 'approval' | null;
  /** One line: the result excerpt, else the session name when the handle is not it. */
  line: string | null;
  /** Epoch ms of its newest activity. */
  activityMs: number;
  /** Epoch ms its current turn started, while it works. */
  workingSinceMs: number | null;
  /** A teammate of the team this session leads. */
  teammate: boolean;
}

export type AgentGroupId = 'needs_you' | 'working' | 'done';

export type AgentGroups = Record<AgentGroupId, AgentRow[]>;

export const AGENT_GROUP_TITLE: Record<AgentGroupId, string> = {
  needs_you: 'Needs you',
  working: 'Working',
  done: 'Done',
};

/** The groups in panel order: what waits on the person first. */
export const AGENT_GROUP_ORDER: readonly AgentGroupId[] = ['needs_you', 'working', 'done'];

/** Board state of a session row: `board_state`, else derived from the older fields. */
export function boardStateOf(session: ProjectSession): SessionBoardState {
  if (session.board_state) return session.board_state;
  if (session.attention) return 'needs_input';
  switch (session.status) {
    case 'failed':
      return 'failed';
    case 'completed':
      return 'completed';
    case 'stopped':
      return 'stopped';
    case 'queued':
    case 'branching':
    case 'provisioning':
      return 'working';
    default:
      return session.working?.state === 'working' ? 'working' : 'idle';
  }
}

export function groupOf(state: SessionBoardState): AgentGroupId {
  if (state === 'needs_input') return 'needs_you';
  if (state === 'working') return 'working';
  return 'done';
}

/** True while an agent works or waits on its person: it can be stopped. */
export function isActive(state: SessionBoardState): boolean {
  return state === 'working' || state === 'needs_input';
}

/** pi named a child `<description> (@agent subagent)` until 2026-10-31. */
function subagentTitle(name: string): string {
  return name.replace(/\s*\(@[^)]*\)\s*$/, '').trim();
}

function oneLine(text: string | null | undefined): string | null {
  const flat = text ? printable(text).replace(/\s+/g, ' ').trim() : '';
  return flat || null;
}

export function agentRowOf(session: ProjectSession, teammate = false): AgentRow {
  const name = session.name ? subagentTitle(oneLine(session.name) ?? '') : '';
  const own = oneLine(session.agent_handle) ?? name;
  const agent = session.agent_name?.trim() || null;
  const handle = own || agent || session.session_id.slice(0, 8);
  const activity = Date.parse(session.last_activity_at ?? session.updated_at ?? session.created_at);
  const state = boardStateOf(session);
  const since =
    state === 'working' && session.working?.since ? Date.parse(session.working.since) : Number.NaN;
  return {
    sessionId: session.session_id,
    handle,
    agent,
    state,
    attention: session.attention ?? null,
    line: oneLine(session.result_excerpt) ?? (name && name !== handle ? name : null),
    activityMs: Number.isFinite(activity) ? activity : 0,
    workingSinceMs: Number.isFinite(since) ? since : null,
    teammate,
  };
}

/**
 * The agents of a session: its children and its teammates, each once, by
 * group, newest activity first. `exclude` holds the sessions a workflow run
 * owns (its agents and its runner).
 */
export function agentGroups(input: {
  leadSessionId: string;
  children: readonly ProjectSession[];
  teammates: readonly ProjectSession[];
  exclude: ReadonlySet<string>;
}): AgentGroups {
  const groups: AgentGroups = { needs_you: [], working: [], done: [] };
  const seen = new Set<string>();
  const teammateIds = new Set(input.teammates.map((session) => session.session_id));
  for (const session of [...input.teammates, ...input.children]) {
    const id = session?.session_id;
    if (!id || seen.has(id) || input.exclude.has(id) || id === input.leadSessionId) continue;
    seen.add(id);
    const teammate =
      teammateIds.has(id) || session.team_lead_session_id === input.leadSessionId;
    const row = agentRowOf(session, teammate);
    groups[groupOf(row.state)].push(row);
  }
  for (const id of AGENT_GROUP_ORDER) groups[id].sort((a, b) => b.activityMs - a.activityMs);
  return groups;
}

export function allAgents(groups: AgentGroups): AgentRow[] {
  return AGENT_GROUP_ORDER.flatMap((id) => groups[id]);
}

export interface RunRow {
  runId: string;
  title: string;
  status: WorkflowRunMetadata['status'];
  paused: boolean;
  agents: WorkflowRunAgent[];
  /** The runner session of a background run: its box runs the run. */
  runnerSessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  counts: { done: number; running: number; failed: number; total: number };
}

/** A run as the panel draws it, or null for a malformed one. */
export function runRowOf(run: WorkflowRunMetadata): RunRow | null {
  if (!run || typeof run.runId !== 'string' || !run.runId) return null;
  const agents = Array.isArray(run.agents) ? run.agents.filter((agent) => agent && agent.id) : [];
  return {
    runId: run.runId,
    title: oneLine(run.title) ?? oneLine(run.name) ?? 'Workflow',
    status: run.status,
    paused: run.paused === true,
    agents,
    runnerSessionId: run.background?.sessionId ?? null,
    startedAt: run.startedAt,
    endedAt: typeof run.endedAt === 'number' ? run.endedAt : null,
    counts: {
      done: agents.filter((agent) => agent.status === 'done').length,
      running: agents.filter((agent) => agent.status === 'running').length,
      failed: agents.filter((agent) => agent.status === 'failed').length,
      total: agents.length,
    },
  };
}

/** `3 of 8 done · 1 running · 1 failed`. A starting agent counts in the total only. */
export function runProgress(run: RunRow): string {
  const { done, running, failed, total } = run.counts;
  if (total === 0) return 'No agents yet';
  const parts = [`${done} of ${total} done`];
  if (running > 0) parts.push(`${running} running`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(' · ');
}

/** Every session a run owns: its runner and its agents. They show under the run. */
export function runSessionIds(runs: readonly RunRow[]): Set<string> {
  const ids = new Set<string>();
  for (const run of runs) {
    if (run.runnerSessionId) ids.add(run.runnerSessionId);
    for (const agent of run.agents) if (agent.sessionId) ids.add(agent.sessionId);
  }
  return ids;
}

/** The held messages `sessionId` received, oldest first: the order they arrived. */
export function heldMessages(
  messages: readonly PeerMessage[] | undefined,
  sessionId: string,
): PeerMessage[] {
  if (!Array.isArray(messages)) return [];
  return heldOldestFirst(messages.filter((message) => message?.to_session_id === sessionId));
}

/** The tray's view: settled agents and ended runs of the last hour, live ones always. */
export function recentOnly(
  groups: AgentGroups,
  runs: readonly RunRow[],
  now: number,
): { groups: AgentGroups; runs: RunRow[] } {
  return {
    groups: {
      needs_you: groups.needs_you,
      working: groups.working,
      done: groups.done.filter((row) => now - row.activityMs <= RECENT_MS),
    },
    runs: runs.filter(
      (run) => run.status === 'running' || (run.endedAt !== null && now - run.endedAt <= RECENT_MS),
    ),
  };
}

export type SummaryMark = 'needs_input' | 'working' | 'failed' | 'done';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * What the tray says: `2 agents · 1 working`, `1 agent · poet done`,
 * `1 workflow running`, `1 message held`. Null text when the session started
 * nothing and nothing waits.
 */
export function agentsSummary(
  groups: AgentGroups,
  runs: readonly RunRow[],
  heldCount: number,
): { text: string | null; mark: SummaryMark } {
  const rows = allAgents(groups);
  const runningRuns = runs.filter((run) => run.status === 'running').length;
  const parts: string[] = [];
  if (rows.length > 0) parts.push(plural(rows.length, 'agent', 'agents'));
  if (runs.length > 0) {
    parts.push(
      runningRuns > 0
        ? plural(runningRuns, 'workflow running', 'workflows running')
        : plural(runs.length, 'workflow', 'workflows'),
    );
  }
  let newest: AgentRow | null = null;
  for (const row of rows) if (!newest || row.activityMs > newest.activityMs) newest = row;
  if (rows.length > 0) {
    if (groups.needs_you.length > 0) parts.push('needs you');
    else if (groups.working.length > 0) parts.push(`${groups.working.length} working`);
    else if (newest) parts.push(`${newest.handle} ${newest.state === 'failed' ? "didn't finish" : newest.state === 'stopped' ? 'stopped' : 'done'}`);
  }
  if (heldCount > 0) parts.push(plural(heldCount, 'message held', 'messages held'));
  const mark: SummaryMark =
    groups.needs_you.length > 0 || heldCount > 0
      ? 'needs_input'
      : groups.working.length > 0 || runningRuns > 0
        ? 'working'
        : newest?.state === 'failed'
          ? 'failed'
          : 'done';
  return { text: parts.length > 0 ? parts.join(' · ') : null, mark };
}

// ── The panel's rows ─────────────────────────────────────────────────────

export type PanelRow =
  | { kind: 'header'; id: string; title: string }
  | { kind: 'agent'; id: string; agent: AgentRow }
  | { kind: 'run'; id: string; run: RunRow; expanded: boolean }
  | { kind: 'run-agent'; id: string; run: RunRow; agent: WorkflowRunAgent }
  | { kind: 'held'; id: string; message: PeerMessage }
  | { kind: 'empty'; id: string; text: string };

export type PanelScope = 'all' | 'workflows';

/** The flat list the panel draws and moves through. Headers and the empty line are not choices. */
export function panelRows(input: {
  groups: AgentGroups;
  runs: readonly RunRow[];
  held: readonly PeerMessage[];
  expanded: ReadonlySet<string>;
  only: PanelScope;
}): PanelRow[] {
  const rows: PanelRow[] = [];
  if (input.only === 'all') {
    for (const id of AGENT_GROUP_ORDER) {
      const list = input.groups[id];
      if (list.length === 0) continue;
      rows.push({ kind: 'header', id: `h:${id}`, title: `${AGENT_GROUP_TITLE[id]} · ${list.length}` });
      for (const agent of list) rows.push({ kind: 'agent', id: `a:${agent.sessionId}`, agent });
    }
  }
  if (input.runs.length > 0) {
    rows.push({ kind: 'header', id: 'h:runs', title: `Workflows · ${input.runs.length}` });
    for (const run of input.runs) {
      const expanded = input.expanded.has(run.runId);
      rows.push({ kind: 'run', id: `r:${run.runId}`, run, expanded });
      if (!expanded) continue;
      for (const agent of run.agents)
        rows.push({ kind: 'run-agent', id: `ra:${run.runId}:${agent.id}`, run, agent });
    }
  }
  if (input.only === 'all' && input.held.length > 0) {
    rows.push({ kind: 'header', id: 'h:held', title: `Held messages · ${input.held.length}` });
    for (const message of input.held) rows.push({ kind: 'held', id: `m:${message.id}`, message });
  }
  if (rows.length === 0) {
    rows.push({
      kind: 'empty',
      id: 'empty',
      text:
        input.only === 'workflows'
          ? 'Workflow runs this session starts will show up here.'
          : 'Agents and workflow runs this session starts will show up here.',
    });
  }
  return rows;
}

export function isChoice(row: PanelRow | undefined): boolean {
  return Boolean(row && row.kind !== 'header' && row.kind !== 'empty');
}

// ── Team tasks ───────────────────────────────────────────────────────────

export interface TaskRow {
  seq: number;
  subject: string;
  status: SessionTask['status'];
  glyph: string;
  /** `@tester`, or empty for an unowned task. */
  owner: string;
  ownerSessionId: string | null;
  /** `blocked by #1, #2` while a blocker is open, else empty. */
  note: string;
}

const TASK_ORDER: Record<SessionTask['status'], number> = { in_progress: 0, pending: 1, completed: 2 };
const TASK_GLYPH: Record<SessionTask['status'], string> = { in_progress: '●', pending: '○', completed: '✓' };

/** In progress first, then pending, then done; each in task-number order. */
export function taskRows(tasks: readonly SessionTask[] | undefined): TaskRow[] {
  if (!Array.isArray(tasks)) return [];
  return [...tasks]
    .filter((task): task is SessionTask => Boolean(task) && typeof task.seq === 'number')
    .sort((a, b) => (TASK_ORDER[a.status] ?? 1) - (TASK_ORDER[b.status] ?? 1) || a.seq - b.seq)
    .map((task) => ({
      seq: task.seq,
      subject: oneLine(task.subject) ?? `Task ${task.seq}`,
      status: task.status,
      glyph: TASK_GLYPH[task.status] ?? '○',
      owner: task.owner_handle ? `@${task.owner_handle}` : '',
      ownerSessionId: task.owner_session_id,
      note:
        task.blocked && task.status !== 'completed' && task.blocked_by.length > 0
          ? `blocked by ${task.blocked_by.map((seq) => `#${seq}`).join(', ')}`
          : '',
    }));
}

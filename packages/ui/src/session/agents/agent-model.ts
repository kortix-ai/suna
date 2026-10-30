/**
 * The agent strip's model: which child sessions it lists, in which group, in
 * which order, and which rows fold. Pure, so the rules are tested without a
 * render tree.
 *
 * Claude Code's agent panel lists the agents a session started (subagents and
 * teammates) under the prompt; Kortix lists the child sessions of this session.
 * A teammate (`team_lead_session_id` = this session) goes under "Team". The
 * sessions a workflow run started are that run's agents, so they stay out of
 * the agent rows: the "Workflows" group shows the run instead.
 */
import type { ProjectSession, SessionBoardState } from '@kortix/sdk';

/** The states the strip draws, Claude's agent view states. */
export type AgentRowState = SessionBoardState;

export interface AgentRow {
  sessionId: string;
  /** What the strip calls it: the agent handle, else the session name, else the agent. */
  handle: string;
  /** The project agent it runs as, when it differs from the handle. */
  agent: string | null;
  state: AgentRowState;
  /** What it waits for, when `needs_input`. */
  attention: 'question' | 'approval' | null;
  /** One line: the result excerpt, else the session title. */
  line: string | null;
  /** Epoch ms of its newest activity, for the order inside a state. */
  activityMs: number;
}

/** A child older than this that has settled is no longer "recent": it leaves the strip. */
export const RECENT_MS = 60 * 60_000;
/** More idle rows than this fold into one "N idle agents" row, as in Claude Code. */
export const IDLE_FOLD_FROM = 3;
/** The strip lists at most this many agent rows per group. */
export const MAX_ROWS = 20;

const STATE_ORDER: Record<AgentRowState, number> = {
  needs_input: 0,
  working: 1,
  failed: 2,
  idle: 3,
  completed: 4,
  stopped: 5,
};

/** Board state of a session row: the API's `board_state`, else derived from the older fields. */
export function boardStateOf(session: ProjectSession): AgentRowState {
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

/** True while a row works or waits on its person: a reason to keep the strip open. */
export function isActive(state: AgentRowState): boolean {
  return state === 'working' || state === 'needs_input';
}

function stripTitleSuffix(name: string): string {
  // A spawned child is named `<description> (@agent subagent)`: the strip shows the agent apart.
  return name.replace(/\s*\(@[^)]*\)\s*$/, '').trim();
}

export function agentRowOf(session: ProjectSession): AgentRow {
  const name = session.name ? stripTitleSuffix(session.name) : '';
  const handle = session.agent_handle?.trim() || name || session.agent_name || session.session_id.slice(0, 8);
  const agent = session.agent_name && session.agent_name !== handle ? session.agent_name : null;
  const excerpt = session.result_excerpt?.replace(/\s+/g, ' ').trim() || null;
  const activity = Date.parse(session.last_activity_at ?? session.updated_at ?? session.created_at);
  return {
    sessionId: session.session_id,
    handle,
    agent,
    state: boardStateOf(session),
    attention: session.attention ?? null,
    line: excerpt ?? (name && name !== handle ? name : null),
    activityMs: Number.isFinite(activity) ? activity : 0,
  };
}

export interface StripGroups {
  agents: AgentRow[];
  team: AgentRow[];
}

/**
 * The agent rows of a session: its children and its teammates, each once.
 * `exclude` holds the sessions a workflow run owns (its agents and its runner).
 * A settled row older than {@link RECENT_MS} leaves the strip.
 */
export function stripGroups(input: {
  leadSessionId: string;
  children: readonly ProjectSession[];
  teammates: readonly ProjectSession[];
  exclude: ReadonlySet<string>;
  now: number;
}): StripGroups {
  const seen = new Set<string>();
  const agents: AgentRow[] = [];
  const team: AgentRow[] = [];
  for (const session of [...input.teammates, ...input.children]) {
    if (seen.has(session.session_id) || input.exclude.has(session.session_id)) continue;
    if (session.session_id === input.leadSessionId) continue;
    seen.add(session.session_id);
    const row = agentRowOf(session);
    if (!isActive(row.state) && row.state !== 'idle' && input.now - row.activityMs > RECENT_MS) continue;
    const isTeammate = session.team_lead_session_id === input.leadSessionId || input.teammates.includes(session);
    (isTeammate ? team : agents).push(row);
  }
  const order = (a: AgentRow, b: AgentRow) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.activityMs - a.activityMs;
  return { agents: agents.sort(order).slice(0, MAX_ROWS), team: team.sort(order).slice(0, MAX_ROWS) };
}

export interface FoldedRows {
  /** The rows drawn on their own. */
  shown: AgentRow[];
  /** The idle rows folded into one "N idle agents" row (empty when nothing folds). */
  folded: AgentRow[];
}

/**
 * Claude Code: when more than three agents are idle, the idle rows beyond the
 * first three fold into one row that counts them. A working, failed or
 * waiting row keeps its own row, and so does the selected one.
 */
export function foldIdle(rows: readonly AgentRow[], expanded: boolean, selected?: string | null): FoldedRows {
  const idle = rows.filter((row) => row.state === 'idle');
  if (expanded || idle.length <= IDLE_FOLD_FROM) return { shown: [...rows], folded: [] };
  const keep = new Set(idle.slice(0, IDLE_FOLD_FROM).map((row) => row.sessionId));
  if (selected) keep.add(selected);
  return {
    shown: rows.filter((row) => row.state !== 'idle' || keep.has(row.sessionId)),
    folded: idle.filter((row) => !keep.has(row.sessionId)),
  };
}

export interface StripCounts {
  agents: number;
  working: number;
  needsInput: number;
}

export function stripCounts(rows: readonly AgentRow[]): StripCounts {
  return {
    agents: rows.length,
    working: rows.filter((row) => row.state === 'working').length,
    needsInput: rows.filter((row) => row.state === 'needs_input').length,
  };
}

/** What a key does while the strip has focus. Claude Code's agent panel keys, plus Ctrl+T for the task list. */
export type StripKeyAction = 'up' | 'down' | 'open' | 'stop' | 'clear' | 'toggleTasks' | null;

export function stripKeyAction(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }): StripKeyAction {
  if (event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 't' || event.key === 'T')) return 'toggleTasks';
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'Enter':
      return 'open';
    case 'x':
    case 'X':
      return event.shiftKey ? null : 'stop';
    case 'Escape':
      return 'clear';
    default:
      return null;
  }
}

/** The next selected row id after an up or down move; wraps at neither end. */
export function moveSelection(ids: readonly string[], current: string | null, direction: 'up' | 'down'): string | null {
  if (ids.length === 0) return null;
  const index = current ? ids.indexOf(current) : -1;
  if (index === -1) return direction === 'down' ? ids[0]! : ids[ids.length - 1]!;
  const next = index + (direction === 'down' ? 1 : -1);
  return ids[Math.max(0, Math.min(ids.length - 1, next))]!;
}

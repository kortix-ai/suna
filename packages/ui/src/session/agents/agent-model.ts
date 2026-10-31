/**
 * The agents line's model: which child sessions it lists, in which group and
 * in which order, and what the one line under the composer says. Pure, so the
 * rules are tested without a render tree.
 *
 * Claude Code's agent panel lists the agents a session started (subagents and
 * teammates) under the prompt; Kortix lists the child sessions of this session.
 * A teammate (`team_lead_session_id` = this session) goes under "Team". The
 * sessions a workflow run started are that run's agents, so they stay out of
 * the agent rows: the "Workflows" group shows the run instead.
 */
import type { ProjectSession, SessionBoardState } from '@kortix/sdk';
import { agentDisplayName } from '../../internal/components/agent-mark';

/** The states a row draws, Claude's agent view states. */
export type AgentRowState = SessionBoardState;

export interface AgentRow {
  sessionId: string;
  /**
   * What the line calls it: the agent handle, else the session name, else the
   * agent's display name (`kortix` → "Kortix"), never a raw slug.
   */
  handle: string;
  /** The project agent slug it runs as. */
  agent: string | null;
  /** The handle is a name of its own (a handle or a session name), so "runs as <agent>" adds something. */
  named: boolean;
  state: AgentRowState;
  /** What it waits for, when `needs_input`. */
  attention: 'question' | 'approval' | null;
  /** One line: the result excerpt, else the session title. */
  line: string | null;
  /** Epoch ms of its newest activity, for the order inside a state. */
  activityMs: number;
  /** Epoch ms its current turn started, while it works and the API says when. */
  workingSinceMs: number | null;
}

/** A child older than this that has settled is no longer "recent": it leaves the line. */
export const RECENT_MS = 60 * 60_000;
/** The popover lists at most this many agent rows per group. */
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

/** True while a row works or waits on its person: it can be stopped. */
export function isActive(state: AgentRowState): boolean {
  return state === 'working' || state === 'needs_input';
}

function stripTitleSuffix(name: string): string {
  // A spawned child is named `<description> (@agent subagent)`: the row shows the agent apart.
  return name.replace(/\s*\(@[^)]*\)\s*$/, '').trim();
}

export function agentRowOf(session: ProjectSession): AgentRow {
  const name = session.name ? stripTitleSuffix(session.name) : '';
  const own = session.agent_handle?.trim() || name;
  const agent = session.agent_name?.trim() || null;
  const handle = own || (agent ? agentDisplayName(agent) : session.session_id.slice(0, 8));
  const excerpt = session.result_excerpt?.replace(/\s+/g, ' ').trim() || null;
  const activity = Date.parse(session.last_activity_at ?? session.updated_at ?? session.created_at);
  const state = boardStateOf(session);
  const since = state === 'working' && session.working?.since ? Date.parse(session.working.since) : NaN;
  return {
    sessionId: session.session_id,
    handle,
    agent,
    named: !!own,
    state,
    attention: session.attention ?? null,
    line: excerpt ?? (name && name !== handle ? name : null),
    activityMs: Number.isFinite(activity) ? activity : 0,
    workingSinceMs: Number.isFinite(since) ? since : null,
  };
}

export interface StripGroups {
  agents: AgentRow[];
  team: AgentRow[];
}

/**
 * The agent rows of a session: its children and its teammates, each once.
 * `exclude` holds the sessions a workflow run owns (its agents and its runner).
 * A settled row older than {@link RECENT_MS} leaves the line.
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

/**
 * The one mark at the head of the agents line: needs you (an agent waits on the
 * person), working (an agent or a workflow run works), failed (the newest agent
 * did not finish), done (everything else: every agent ended its turn).
 */
export type LineMark = 'needs_input' | 'working' | 'failed' | 'done';

export interface LineSummary extends StripCounts {
  mark: LineMark;
  /** Workflow runs listed, and how many of them run. */
  runs: number;
  runningRuns: number;
  /** The agent with the newest activity, named on the line while nothing works. */
  newest: AgentRow | null;
}

/** What the agents line says: `2 agents · 1 working`, `2 agents · poet done`, `1 workflow running`. */
export function lineSummary(rows: readonly AgentRow[], runs: readonly { status: string }[]): LineSummary {
  const counts = stripCounts(rows);
  const runningRuns = runs.filter((run) => run.status === 'running').length;
  let newest: AgentRow | null = null;
  for (const row of rows) if (!newest || row.activityMs > newest.activityMs) newest = row;
  const mark: LineMark =
    counts.needsInput > 0
      ? 'needs_input'
      : counts.working > 0 || runningRuns > 0
        ? 'working'
        : newest?.state === 'failed'
          ? 'failed'
          : 'done';
  return { ...counts, mark, runs: runs.length, runningRuns, newest };
}

/** `12s`, `4m`, `2h`: the short elapsed time of a working row. */
export function shortElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

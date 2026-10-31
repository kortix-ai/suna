/**
 * The `data` of a multi-agent tool result, parsed defensively for its card body.
 *
 * The shapes are in `packages/api-contract/src/multi-agent.ts` (`PeerMessageSendResult`,
 * `ReachableAgents`, `SessionTask`). `@kortix/ui` does not depend on that package, so
 * only the fields a card draws are mirrored here, and every one is checked. A value
 * that does not parse is `null`: the card then draws its own rows, as every platform
 * card does.
 */

export type PeerSendStatus = 'delivered' | 'held' | 'refused' | 'denied' | 'expired' | 'dropped';
export type AgentBoardState = 'working' | 'needs_input' | 'idle' | 'completed' | 'failed' | 'stopped';
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed';

export interface PeerSendSummary {
  status: PeerSendStatus;
  /** The receiver's handle, without `@`. */
  to: string | null;
  /** The message text the sender wrote. */
  message: string | null;
  summary: string | null;
  /** The sentence the API wrote for the sending agent ("Not sent: reviewer refuses messages."). */
  note: string | null;
}

export interface ReachableAgentRow {
  handle: string;
  sessionId: string;
  title: string | null;
  agentName: string | null;
  relation: string;
  state: AgentBoardState | null;
  canReceive: boolean;
}

/** `task_stop`: `StopChildResult` (apps/kortix-sandbox-agent-server/src/harness/pi/cloud-subagent.ts). */
export interface StoppedChild {
  sessionId: string;
  handle: string | null;
  title: string | null;
  /** False: it had already ended, and nothing was stopped. */
  stopped: boolean;
}

export interface TeamTaskRow {
  seq: number;
  subject: string;
  status: TeamTaskStatus;
  owner: string | null;
  blockedBy: number[];
  blocked: boolean;
}

const PEER_STATUSES = new Set<PeerSendStatus>(['delivered', 'held', 'refused', 'denied', 'expired', 'dropped']);
const BOARD_STATES = new Set<AgentBoardState>(['working', 'needs_input', 'idle', 'completed', 'failed', 'stopped']);
const TASK_STATUSES = new Set<TeamTaskStatus>(['pending', 'in_progress', 'completed']);
/** A card body is a short list; a longer one is the tool's mistake, not a page to render. */
const MAX_ROWS = 50;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const positiveInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
const handle = (value: unknown): string | null => text(value)?.replace(/^@/, '') ?? null;

/** `send_message`: `PeerMessageSendResult`. */
export function parsePeerSend(data: unknown): PeerSendSummary | null {
  if (!isObject(data) || !PEER_STATUSES.has(data.status as PeerSendStatus)) return null;
  const message = isObject(data.message) ? data.message : null;
  const to = isObject(data.to) ? handle(data.to.handle) : null;
  return {
    status: data.status as PeerSendStatus,
    to: to ?? (message ? handle(message.to_handle) : null),
    message: message ? text(message.message) : null,
    summary: message ? text(message.summary) : null,
    note: text(data.note),
  };
}

function agentRow(value: unknown): ReachableAgentRow | null {
  if (!isObject(value)) return null;
  const name = handle(value.handle);
  const sessionId = text(value.session_id);
  if (!name || !sessionId) return null;
  return {
    handle: name,
    sessionId,
    title: text(value.title),
    agentName: text(value.agent_name),
    relation: text(value.relation) ?? 'session',
    state: BOARD_STATES.has(value.state as AgentBoardState) ? (value.state as AgentBoardState) : null,
    canReceive: value.can_receive !== false,
  };
}

/** `list_agents`: `ReachableAgents` (the asking session itself is left out). */
export function parseReachable(data: unknown): ReachableAgentRow[] | null {
  if (!isObject(data) || !Array.isArray(data.agents)) return null;
  const rows: ReachableAgentRow[] = [];
  for (const entry of data.agents.slice(0, MAX_ROWS)) {
    const row = agentRow(entry);
    if (row && row.relation !== 'self') rows.push(row);
  }
  return rows;
}

function taskRow(value: unknown): TeamTaskRow | null {
  if (!isObject(value)) return null;
  const seq = positiveInt(value.seq);
  const subject = text(value.subject);
  if (seq === null || !subject || !TASK_STATUSES.has(value.status as TeamTaskStatus)) return null;
  const blockedBy = Array.isArray(value.blocked_by)
    ? value.blocked_by.map(positiveInt).filter((n): n is number => n !== null)
    : [];
  return {
    seq,
    subject,
    status: value.status as TeamTaskStatus,
    owner: handle(value.owner_handle),
    blockedBy,
    blocked: value.blocked === true,
  };
}

/** `task_*`: one `SessionTask`, or `{ tasks: SessionTask[] }`. */
export function parseTasks(data: unknown): TeamTaskRow[] | null {
  if (!isObject(data)) return null;
  if (Array.isArray(data.tasks)) {
    return data.tasks
      .slice(0, MAX_ROWS)
      .map(taskRow)
      .filter((row): row is TeamTaskRow => row !== null);
  }
  if (isObject(data.task)) {
    const row = taskRow(data.task);
    return row ? [row] : null;
  }
  const row = taskRow(data);
  return row ? [row] : null;
}

/** `task_stop`: the child it stopped, or null. */
export function parseStoppedChild(data: unknown): StoppedChild | null {
  if (!isObject(data) || typeof data.stopped !== 'boolean') return null;
  const sessionId = text(data.sessionId);
  if (!sessionId) return null;
  return { sessionId, handle: handle(data.handle), title: text(data.title), stopped: data.stopped };
}

/**
 * True when a running call's input has the shape of pi's `task_*` tools
 * (apps/kortix-sandbox-agent-server/src/harness/pi/extensions/team-tasks.ts):
 * `task_create { subject, … }`, `task_get { seq }`, `task_update { seq, … }`.
 * The older plugin tools that share these names take neither. pi's
 * `task_list {}` has no input to tell: its output decides once it settles.
 */
export function looksLikeTeamTaskInput(input: unknown): boolean {
  if (!isObject(input)) return false;
  return typeof input.subject === 'string' || typeof input.seq === 'number';
}

/**
 * MyKortix multi-agent messaging and team tools, as mobile draws them. Port of
 * apps/web `session/tool/tools/multi-agent-tool-data.ts` (the result parsers),
 * `session/turn/peer-message-row.tsx` (`peerMessagePreview`) and
 * `session/agents/held-messages.tsx` (`heldPreview`, `heldMessages`). Copy is
 * web's English locale (`multiAgent.tools`, `multiAgent.peer`, `multiAgent.held`).
 */

import type { PeerMessageKind, PeerMessagePromptInfo } from '@kortix/shared';
import type { PeerMessage } from '@kortix/sdk';
import type { SessionDisplayStatus } from '@/lib/session/session-list';

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

/** The preview line of a delivered message: its summary, else its first line; an idle notice, its last answer. */
export function peerMessagePreview(info: Pick<PeerMessagePromptInfo, 'summary' | 'text'> & { kind?: PeerMessageKind }): string {
  if (info.summary?.trim()) return info.summary.trim();
  const lines = info.text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (info.kind === 'idle_notice') {
    const answer = lines.find((line) => line.startsWith('Its last answer:'));
    if (answer) return answer.slice('Its last answer:'.length).trim();
    return lines[0] && !/finished its turn and is idle\.?$/.test(lines[0]) ? lines[0] : '';
  }
  return lines[0] ?? '';
}

/** Web `multiAgent.peer`: the headline a delivered message draws. */
export function peerHeadline(kind: PeerMessageKind, from: string): string {
  switch (kind) {
    case 'idle_notice':
      return `${from} finished`;
    case 'shutdown_request':
      return `Shutdown request from ${from}`;
    case 'shutdown_response':
      return `Shutdown answer from ${from}`;
    default:
      return `Message from ${from}`;
  }
}

/** The preview line of a held message: the sender's summary, else the message's first line. */
export function heldPreview(message: Pick<PeerMessage, 'summary' | 'message'>): string {
  const summary = message.summary?.trim();
  if (summary) return summary;
  const first = message.message.trim().split('\n')[0] ?? '';
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

/** The messages that wait for the person, oldest first. */
export function heldMessages(messages: readonly PeerMessage[] | undefined): PeerMessage[] {
  return (messages ?? [])
    .filter((message) => message.status === 'held')
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** Web `multiAgent.tools.peerStatus`. */
export const PEER_STATUS_LABEL: Record<PeerSendStatus, string> = {
  delivered: 'Delivered',
  held: 'Waiting for approval',
  refused: 'Not sent',
  denied: 'Declined',
  expired: 'Expired',
  dropped: 'Not sent again',
};

/** A team task's status as a session-list glyph. A blocked open task is the stopped ring. */
export function taskGlyph(task: Pick<TeamTaskRow, 'status' | 'blocked'>): SessionDisplayStatus {
  if (task.status === 'completed') return 'done';
  if (task.status === 'in_progress') return 'running';
  return task.blocked ? 'stopped' : 'starting';
}

/** An agent's board state as a session-list glyph. */
export function agentStateGlyph(state: AgentBoardState): SessionDisplayStatus {
  switch (state) {
    case 'working':
      return 'running';
    case 'needs_input':
      return 'needs-you';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      return 'done';
  }
}

/** Web `multiAgent.strip.state`. */
export const AGENT_STATE_LABEL: Record<AgentBoardState, string> = {
  working: 'working',
  needs_input: 'needs you',
  idle: 'done',
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

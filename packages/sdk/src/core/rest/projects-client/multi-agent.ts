// Multi-agent: cross-session messages, the agents a session can reach, a
// team's shared task list, and the board state of a session. The wire is
// `packages/api-contract/src/multi-agent.ts`; the SDK owns its own copy of the
// types (`src/contract-drift.test.ts` holds the two equal) and never imports
// the contract at runtime.
//
// Every route acts as the caller. A refusal (`refused`, `denied`) is a result
// the API answers with, never a silent drop.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** Largest message body a session may send another, in characters. */
export const PEER_MESSAGE_MAX_CHARS = 16_000;
/** Agents in one workflow run above which a client warns "Large workflow". */
export const WORKFLOW_LARGE_AGENT_COUNT = 25;

/**
 * Who may send a session a message.
 * `accept`: delivered at the next step boundary, or a new turn starts.
 * `hold`: each message waits for the person to approve it.
 * `refuse`: the sender is told "Not sent".
 */
export type SessionInbound = 'accept' | 'hold' | 'refuse';

/** Board state of a session, as Claude Code's agent view groups them. */
export type SessionBoardState = 'working' | 'needs_input' | 'idle' | 'completed' | 'failed' | 'stopped';

/** What a session waits for from its person, or null. */
export type SessionAttention = 'question' | 'approval' | null;

/** How a reachable session relates to the asking session. */
export type AgentRelation = 'self' | 'parent' | 'child' | 'lead' | 'teammate' | 'session';

/** `mine` = parent, children, lead, teammates; `project` = every live session of the project. */
export type ReachableScope = 'mine' | 'project';

export interface ReachableAgent {
  /** The name `send_message` takes: the agent handle, else the agent name + short id. */
  handle: string;
  session_id: string;
  /** First 8 characters of `session_id`. */
  short_id: string;
  project_id: string;
  agent_name: string | null;
  title: string | null;
  relation: AgentRelation;
  state: SessionBoardState;
  inbound: SessionInbound;
  /** False when the session refuses messages or the caller may not prompt it. */
  can_receive: boolean;
}

export interface ReachableAgents {
  self: ReachableAgent;
  agents: ReachableAgent[];
}

export type PeerMessageType = 'message' | 'shutdown_request' | 'shutdown_response';

/**
 * `delivered`: in the receiver's turn, or a new turn started. `held`: waits for
 * the receiver's person. `refused`: the receiver refuses messages, or the
 * caller may not prompt it. `denied`: the receiver's person declined it.
 * `expired`: a held message nobody approved. `dropped`: a duplicate.
 */
export type PeerMessageStatus = 'delivered' | 'held' | 'refused' | 'denied' | 'expired' | 'dropped';

export interface PeerMessageSendBody {
  /** A handle, a session id or 8+ character prefix, `parent`/`main`, or `@name`. */
  to: string;
  message: string;
  /** The one-line preview (at most 200 characters). */
  summary?: string;
  /** One notice back to the sender when the receiver's turn ends. */
  notify_when_idle?: boolean;
  type?: PeerMessageType;
  /** `shutdown_response` only: true stops the responding session. */
  approve?: boolean;
  /** Resolve `to` in this project instead of the sender's own. */
  project_id?: string;
}

export interface PeerMessage {
  id: string;
  project_id: string;
  from_session_id: string;
  from_handle: string;
  to_session_id: string;
  to_handle: string;
  type: PeerMessageType;
  message: string;
  summary: string | null;
  status: PeerMessageStatus;
  notify_when_idle: boolean;
  created_at: string;
  decided_at: string | null;
}

export interface PeerMessageSendResult {
  status: PeerMessageStatus;
  message: PeerMessage | null;
  to: ReachableAgent | null;
  /** One sentence for the sending agent, e.g. "Not sent: reviewer refuses messages." */
  note: string;
}

export type SessionTaskStatus = 'pending' | 'in_progress' | 'completed';

export interface SessionTask {
  /** Task number in this team, shown as `#3`. */
  seq: number;
  lead_session_id: string;
  subject: string;
  description: string;
  status: SessionTaskStatus;
  owner_handle: string | null;
  owner_session_id: string | null;
  /** Task numbers this task waits for. */
  blocked_by: number[];
  /** True while one task in `blocked_by` is not completed. */
  blocked: boolean;
  created_by_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionTaskCreateBody {
  subject: string;
  description?: string;
  blocked_by?: number[];
  /** A teammate handle. */
  owner?: string;
}

export interface SessionTaskUpdateBody {
  status?: SessionTaskStatus;
  /** A teammate handle, or null to release the task. */
  owner?: string | null;
  subject?: string;
  description?: string;
  add_blocked_by?: number[];
  /** Take the task for the calling session: only a pending, unowned, unblocked task (`409 task_taken` otherwise). */
  claim?: boolean;
}

// ── Workflow runs (served by the session's box, `/kortix/runtime/workflows`) ──

export type WorkflowRunStatus = 'running' | 'done' | 'failed' | 'stopped';
export type WorkflowAgentStatus = 'starting' | 'running' | 'done' | 'failed' | 'stopped';

export interface WorkflowRunPhase {
  title: string;
  /** `pending`: declared in the script's `meta.phases`, not started yet. */
  status: WorkflowRunStatus | 'pending';
}

export interface WorkflowRunAgent {
  /** Stable per run: `a1`, `a2`, … in start order. */
  id: string;
  label: string;
  agent?: string;
  phase?: string;
  status: WorkflowAgentStatus;
  /** The child Kortix session, once it exists. */
  sessionId?: string;
  summary?: string;
  cached?: true;
  model?: string;
  structured?: true;
  attempt?: number;
  /** Epoch ms. */
  startedAt?: number;
  endedAt?: number;
}

export interface WorkflowRunMetadata {
  runId: string;
  title: string;
  status: WorkflowRunStatus;
  phases: WorkflowRunPhase[];
  agents: WorkflowRunAgent[];
  startedAt: number;
  endedAt?: number;
  error?: string;
  maxAgents?: number;
  /** A saved workflow run by name (`meta.name`). */
  name?: string;
  logs?: string[];
  /** More than `WORKFLOW_LARGE_AGENT_COUNT` agents planned or started. */
  large?: true;
  resumedFrom?: string;
  background?: { sessionId: string };
  /** The person paused the run: no new agent starts until `resume`; running agents finish. */
  paused?: boolean;
}

/**
 * - `pause`: no new `agent()` starts; running agents finish.
 * - `resume`: starts resume.
 * - `restart_agent`: stop that agent's session (`session_id`) and start it again.
 * - `stop`: stop every agent and end the run.
 */
export interface WorkflowControlBody {
  action: 'pause' | 'resume' | 'restart_agent' | 'stop';
  /** `restart_agent` only: the agent's child session id. */
  session_id?: string;
}

export interface WorkflowControlResult {
  ok: true;
  paused: boolean;
}

// ── Routes ────────────────────────────────────────────────────────────────

const session = (projectId: string, sessionId: string) =>
  `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;

/** The agents this session can message: `mine` (default) or every live session of the project. */
export async function getSessionReachableAgents(
  projectId: string,
  sessionId: string,
  options: { scope?: ReachableScope } = {},
): Promise<ReachableAgents> {
  const query = options.scope && options.scope !== 'mine' ? `?scope=${options.scope}` : '';
  return unwrap(
    await backendApi.get<ReachableAgents>(`${session(projectId, sessionId)}/reachable${query}`, { showErrors: false }),
  );
}

/** Send a message from `sessionId` to another session. A refusal is a result (`status: 'refused'`). */
export async function sendPeerMessage(
  projectId: string,
  sessionId: string,
  body: PeerMessageSendBody,
): Promise<PeerMessageSendResult> {
  return unwrap(await backendApi.post<PeerMessageSendResult>(`${session(projectId, sessionId)}/peer-messages`, body));
}

/** The messages this session received (`in`), sent (`out`), or both, newest first. */
export async function listPeerMessages(
  projectId: string,
  sessionId: string,
  options: { direction?: 'in' | 'out' } = {},
): Promise<{ messages: PeerMessage[] }> {
  const query = options.direction ? `?direction=${options.direction}` : '';
  return unwrap(
    await backendApi.get<{ messages: PeerMessage[] }>(`${session(projectId, sessionId)}/peer-messages${query}`, {
      showErrors: false,
    }),
  );
}

/** Deliver a held message (`sessionId` = the receiver). */
export async function approvePeerMessage(projectId: string, sessionId: string, messageId: string): Promise<PeerMessage> {
  return unwrap(
    await backendApi.post<PeerMessage>(
      `${session(projectId, sessionId)}/peer-messages/${encodeURIComponent(messageId)}/approve`,
      {},
    ),
  );
}

/** Drop a held message (`sessionId` = the receiver). */
export async function denyPeerMessage(projectId: string, sessionId: string, messageId: string): Promise<PeerMessage> {
  return unwrap(
    await backendApi.post<PeerMessage>(
      `${session(projectId, sessionId)}/peer-messages/${encodeURIComponent(messageId)}/deny`,
      {},
    ),
  );
}

/** Who may send this session a message. */
export async function setSessionInbound(
  projectId: string,
  sessionId: string,
  inbound: SessionInbound,
): Promise<{ inbound: SessionInbound }> {
  return unwrap(await backendApi.put<{ inbound: SessionInbound }>(`${session(projectId, sessionId)}/inbound`, { inbound }));
}

/** The shared task list of the team `leadSessionId` leads (flag `agent_teams`). */
export async function listSessionTasks(projectId: string, leadSessionId: string): Promise<{ tasks: SessionTask[] }> {
  return unwrap(
    await backendApi.get<{ tasks: SessionTask[] }>(`${session(projectId, leadSessionId)}/tasks`, { showErrors: false }),
  );
}

export async function createSessionTask(
  projectId: string,
  leadSessionId: string,
  body: SessionTaskCreateBody,
): Promise<SessionTask> {
  return unwrap(await backendApi.post<SessionTask>(`${session(projectId, leadSessionId)}/tasks`, body));
}

/** Change a task. `claim: true` takes it atomically; the loser of a race gets `409 task_taken`. */
export async function updateSessionTask(
  projectId: string,
  leadSessionId: string,
  seq: number,
  body: SessionTaskUpdateBody,
): Promise<SessionTask> {
  return unwrap(await backendApi.patch<SessionTask>(`${session(projectId, leadSessionId)}/tasks/${seq}`, body));
}

export async function deleteSessionTask(
  projectId: string,
  leadSessionId: string,
  seq: number,
): Promise<{ deleted: true }> {
  return unwrap(await backendApi.delete<{ deleted: true }>(`${session(projectId, leadSessionId)}/tasks/${seq}`));
}

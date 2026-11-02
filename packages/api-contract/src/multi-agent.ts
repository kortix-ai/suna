/**
 * Multi-agent wire contract: cross-session messages, the agents a session can
 * reach, a team's shared task list, the board state of a session, and the
 * workflow run controls. One contract for every surface: the pi tools in
 * kortixd (`send_message`, `list_agents`, `task_*`), the API routes, the SDK,
 * the CLI and the web cards.
 *
 * | Route | Body | Answer |
 * | --- | --- | --- |
 * | `GET /projects/:id/sessions/:sid/reachable?scope=&project_id=` | none | `200 ReachableAgents`; `project_id` (with `scope=project`) lists another project of the account as the caller's person sees it |
 * | `POST /projects/:id/sessions/:sid/peer-messages` (`:sid` = sender) | `PeerMessageSendBody` | `200 PeerMessageSendResult`; `409` ambiguous `to` |
 * | `GET /projects/:id/sessions/:sid/peer-messages?direction=in\|out` | none | `200 { messages: PeerMessage[] }` |
 * | `POST /projects/:id/sessions/:sid/peer-messages/:mid/approve` (`:sid` = receiver) | none | `200 PeerMessage` |
 * | `POST /projects/:id/sessions/:sid/peer-messages/:mid/deny` | none | `200 PeerMessage` |
 * | `PUT /projects/:id/sessions/:sid/inbound` | `{ inbound: SessionInbound }` | `200 { inbound }` |
 * | `GET /projects/:id/sessions/:lead/tasks` | none | `200 { tasks: SessionTask[] }` |
 * | `POST /projects/:id/sessions/:lead/tasks` | `SessionTaskCreateBody` | `201 SessionTask` |
 * | `PATCH /projects/:id/sessions/:lead/tasks/:seq` | `SessionTaskUpdateBody` | `200 SessionTask`; `409 { code: 'task_taken' \| 'task_blocked' }` |
 * | `DELETE /projects/:id/sessions/:lead/tasks/:seq` | none | `200 { deleted: true }` |
 *
 * Every route acts as the caller. A session token may message a session only
 * where its person may prompt that session; a refusal is a result, never a
 * silent drop.
 */
import { z } from 'zod';

// ── Limits ───────────────────────────────────────────────────────────────

/** Largest message body, in characters. Same as a room message. */
export const PEER_MESSAGE_MAX_CHARS = 16_000;
/** Largest `summary` (the preview line), in characters. */
export const PEER_MESSAGE_SUMMARY_MAX_CHARS = 200;
/** Messages one sender session may send in one minute. Same as a room. */
export const PEER_MESSAGE_PER_MINUTE = 30;
/** The same text to the same session within this window is dropped. */
export const PEER_MESSAGE_DUPLICATE_WINDOW_MS = 60_000;
/** A held message the receiver has not approved expires after this. */
export const PEER_MESSAGE_HOLD_TTL_MS = 5 * 60_000;
/** Held messages one session may have waiting. */
export const PEER_MESSAGE_MAX_HELD = 100;
/** A `notify_when_idle` watch lapses after this. */
export const PEER_IDLE_WATCH_TTL_MS = 12 * 60 * 60_000;

// ── Session metadata keys ────────────────────────────────────────────────

/**
 * Session metadata key: the name an agent gave a child with `agent({ name })`.
 * Unique among one lead's live children; `send_message` resolves `to` by it.
 */
export const AGENT_HANDLE_KEY = 'agent_handle' as const;
/** Session metadata key: the lead session of a teammate (agent teams). */
export const TEAM_LEAD_KEY = 'team_lead' as const;
/** Session metadata key: who may send this session a message (`SessionInbound`). */
export const SESSION_INBOUND_KEY = 'inbound' as const;

// ── Reachable agents (`list_agents`) ─────────────────────────────────────

/**
 * - `accept`: messages arrive at the next step boundary, or start a turn.
 * - `hold`: each message waits for the person to approve it in the session.
 * - `refuse`: the sender is told `Not sent`.
 */
export const SessionInboundSchema = z.enum(['accept', 'hold', 'refuse']);
export type SessionInbound = z.infer<typeof SessionInboundSchema>;

/** Board state of a session, as Claude Code's agent view groups them. */
export const SessionBoardStateSchema = z.enum([
  'working',
  'needs_input',
  'idle',
  'completed',
  'failed',
  'stopped',
]);
export type SessionBoardState = z.infer<typeof SessionBoardStateSchema>;

/** What a session waits for from its person, or null. */
export const SessionAttentionSchema = z.enum(['question', 'approval']).nullable();
export type SessionAttention = z.infer<typeof SessionAttentionSchema>;

/** How a reachable session relates to the asking session. */
export const AgentRelationSchema = z.enum(['self', 'parent', 'child', 'lead', 'teammate', 'session']);
export type AgentRelation = z.infer<typeof AgentRelationSchema>;

export const ReachableAgentSchema = z.object({
  /** The name `send_message` takes: the agent handle, else the agent name + short id. */
  handle: z.string(),
  session_id: z.string(),
  /** First 8 characters of `session_id`; `send_message` accepts any unique prefix of 8+. */
  short_id: z.string(),
  project_id: z.string(),
  agent_name: z.string().nullable(),
  title: z.string().nullable(),
  relation: AgentRelationSchema,
  state: SessionBoardStateSchema,
  inbound: SessionInboundSchema,
  /** False when the session refuses messages or the caller may not prompt it. */
  can_receive: z.boolean(),
});
export type ReachableAgent = z.infer<typeof ReachableAgentSchema>;

export const ReachableAgentsSchema = z.object({
  self: ReachableAgentSchema,
  agents: z.array(ReachableAgentSchema),
});
export type ReachableAgents = z.infer<typeof ReachableAgentsSchema>;

/** `mine` = parent, children, lead, teammates; `project` = every live session of the project. */
export const ReachableScopeSchema = z.enum(['mine', 'project']);
export type ReachableScope = z.infer<typeof ReachableScopeSchema>;

// ── Peer messages (`send_message`) ───────────────────────────────────────

export const PeerMessageTypeSchema = z.enum(['message', 'shutdown_request', 'shutdown_response']);
export type PeerMessageType = z.infer<typeof PeerMessageTypeSchema>;

export const PeerMessageSendBodySchema = z
  .object({
    /** A handle, a session id or 8+ character prefix, `parent`/`main`, or `@name`. */
    to: z.string().trim().min(1).max(200),
    message: z.string().min(1).max(PEER_MESSAGE_MAX_CHARS),
    summary: z.string().trim().max(PEER_MESSAGE_SUMMARY_MAX_CHARS).optional(),
    /** One notice back to the sender when the receiver's turn ends. */
    notify_when_idle: z.boolean().optional(),
    type: PeerMessageTypeSchema.optional(),
    /** `shutdown_response` only: true stops the responding session. */
    approve: z.boolean().optional(),
    /** Resolve `to` in this project instead of the sender's own. */
    project_id: z.string().optional(),
  })
  .strict();
export type PeerMessageSendBody = z.infer<typeof PeerMessageSendBodySchema>;

/**
 * - `delivered`: in the receiver's turn, or a new turn started.
 * - `held`: waiting for the receiver's person; expires after `PEER_MESSAGE_HOLD_TTL_MS`.
 * - `refused`: the receiver refuses messages, or the caller may not prompt it.
 * - `denied`: the receiver's person declined a held message.
 * - `expired`: a held message nobody approved.
 * - `dropped`: a duplicate within `PEER_MESSAGE_DUPLICATE_WINDOW_MS`.
 */
export const PeerMessageStatusSchema = z.enum(['delivered', 'held', 'refused', 'denied', 'expired', 'dropped']);
export type PeerMessageStatus = z.infer<typeof PeerMessageStatusSchema>;

export const PeerMessageSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  from_session_id: z.string(),
  from_handle: z.string(),
  to_session_id: z.string(),
  to_handle: z.string(),
  type: PeerMessageTypeSchema,
  message: z.string(),
  summary: z.string().nullable(),
  status: PeerMessageStatusSchema,
  notify_when_idle: z.boolean(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
});
export type PeerMessage = z.infer<typeof PeerMessageSchema>;

export const PeerMessageSendResultSchema = z.object({
  status: PeerMessageStatusSchema,
  message: PeerMessageSchema.nullable(),
  to: ReachableAgentSchema.nullable(),
  /** One sentence for the sending agent, e.g. "Not sent: reviewer refuses messages." */
  note: z.string(),
});
export type PeerMessageSendResult = z.infer<typeof PeerMessageSendResultSchema>;

/** `409` body when `to` names more than one session. */
export const PeerMessageAmbiguousSchema = z.object({
  error: z.literal(true),
  code: z.literal('ambiguous_recipient'),
  message: z.string(),
  candidates: z.array(ReachableAgentSchema),
});
export type PeerMessageAmbiguous = z.infer<typeof PeerMessageAmbiguousSchema>;

// ── Team tasks (`task_*`, flag `agent_teams`) ────────────────────────────

export const SessionTaskStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
export type SessionTaskStatus = z.infer<typeof SessionTaskStatusSchema>;

export const SessionTaskSchema = z.object({
  /** Task number in this team, shown as `#3`. */
  seq: z.number().int().positive(),
  lead_session_id: z.string(),
  subject: z.string(),
  description: z.string(),
  status: SessionTaskStatusSchema,
  owner_handle: z.string().nullable(),
  owner_session_id: z.string().nullable(),
  /** Task numbers this task waits for. */
  blocked_by: z.array(z.number().int().positive()),
  /** True while one task in `blocked_by` is not completed. */
  blocked: z.boolean(),
  created_by_session_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SessionTask = z.infer<typeof SessionTaskSchema>;

export const SessionTaskCreateBodySchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    description: z.string().max(8_000).optional(),
    blocked_by: z.array(z.number().int().positive()).max(50).optional(),
    /** A teammate handle. */
    owner: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export type SessionTaskCreateBody = z.infer<typeof SessionTaskCreateBodySchema>;

export const SessionTaskUpdateBodySchema = z
  .object({
    status: SessionTaskStatusSchema.optional(),
    /** A teammate handle, or null to release the task. */
    owner: z.string().trim().min(1).max(100).nullable().optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(8_000).optional(),
    add_blocked_by: z.array(z.number().int().positive()).max(50).optional(),
    /**
     * Take the task for the calling session, atomically: only a pending,
     * unowned, unblocked task. The loser of a race gets `409 task_taken`.
     */
    claim: z.boolean().optional(),
  })
  .strict();
export type SessionTaskUpdateBody = z.infer<typeof SessionTaskUpdateBodySchema>;

export const SESSION_TASK_TAKEN_CODE = 'task_taken' as const;
export const SESSION_TASK_BLOCKED_CODE = 'task_blocked' as const;

// ── Workflow run controls ────────────────────────────────────────────────

/**
 * `POST /kortix/runtime/workflows/:runId/control` on the box that runs the
 * workflow (the parent session, or its background runner).
 *
 * - `pause`: no new `agent()` starts; running agents finish.
 * - `resume`: starts resume.
 * - `restart_agent`: stop that agent's session and start it again.
 * - `stop`: stop every agent and end the run.
 */
export const WorkflowControlBodySchema = z
  .object({
    action: z.enum(['pause', 'resume', 'restart_agent', 'stop']),
    /** `restart_agent` only: the agent's child session id. */
    session_id: z.string().optional(),
  })
  .strict();
export type WorkflowControlBody = z.infer<typeof WorkflowControlBodySchema>;

/** Agents in one run above which the card warns "Large workflow". */
export const WORKFLOW_LARGE_AGENT_COUNT = 25;

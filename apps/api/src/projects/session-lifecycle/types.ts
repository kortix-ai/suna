import type { ProjectRow, ProjectSessionRow, RequestAuditContext } from '../lib/serializers';
import type { PromptOverridesWire, PromptPartWire } from './store';
import type { SessionCreateError } from '../lib/sessions';
import type { SessionStartResult } from '../routes/shared';

export type SessionInvocationSource =
  | 'ui'
  | 'mobile'
  | 'cli'
  | 'slack'
  | 'email'
  | 'telegram'
  | 'teams'
  | 'trigger:webhook'
  | 'trigger:cron'
  | 'trigger:manual'
  | 'trigger:monitor'
  | 'system:sandbox-build-fix'
  | 'system:approval-resume'
  | 'system:secret-submitted'
  | 'system:connector-connected'
  | 'admin';

export type QueuePolicy = 'never' | 'on_backpressure' | 'always';

export type SessionLifecyclePostCreateAction =
  | {
      type: 'bind_chat_thread';
      platform: 'slack' | 'telegram' | string;
      workspaceId: string;
      threadId: string;
    }
  | {
      type: 'deliver_prompt';
      source: SessionInvocationSource;
      text: string;
      userId?: string | null;
    }
  | {
      /** Resolve at execution time so queued creates never capture stale access. */
      type: 'apply_trigger_session_access';
      triggerSlug: string;
    };

export type SessionLifecycleStatus =
  | 'created'
  | 'ready'
  | 'continued'
  | 'queued'
  | 'pending'
  | 'deduped'
  | 'failed'
  | 'deleted';

export interface CreateSessionCommand {
  source: SessionInvocationSource;
  project: ProjectRow;
  userId: string;
  requestingPrincipalType: 'human' | 'service_account';
  body: Record<string, unknown>;
  visibility?: 'private' | 'project' | 'restricted';
  mayManageSystemConnections?: boolean;
  metadata?: Record<string, unknown>;
  extraEnvVars?: Record<string, string>;
  enforceAccountCap?: boolean;
  request?: RequestAuditContext;
  idempotencyKey?: string | null;
  queuePolicy?: QueuePolicy;
  postCreate?: SessionLifecyclePostCreateAction[];
  // Caller's token kind (auth.ts `authType`) + apiKeyType + whether the token
  // operates from inside a running session (`inSession`: session-bound or
  // agent-scoped); used only to derive the session origin (a not-in-session
  // service_account / pat / 'user' apiKey → backend). Never trusted from the
  // request body. See session-origin.ts.
  authType?: string | null;
  apiKeyType?: string | null;
  inSession?: boolean | null;
  callerSessionId?: string | null;
}

export interface QueuedCreateSessionPayload {
  body: Record<string, unknown>;
  /** Absent on commands persisted before principal type was added. */
  requestingPrincipalType?: 'human' | 'service_account';
  metadata?: Record<string, unknown>;
  extraEnvVars?: Record<string, string>;
  visibility?: 'private' | 'project' | 'restricted';
  mayManageSystemConnections?: boolean;
  enforceAccountCap?: boolean;
  postCreate?: SessionLifecyclePostCreateAction[];
  // Origin-derivation signals captured at ENQUEUE time. Without them a queued
  // backend create would replay as origin 'user'. Absent on rows queued before
  // this field existed means 'user', matching their pre-origin behavior.
  authType?: string | null;
  apiKeyType?: string | null;
  inSession?: boolean | null;
  callerSessionId?: string | null;
}

export interface ContinueSessionCommand {
  source: SessionInvocationSource;
  sessionId: string;
  /** Legacy plain-text form. Ignored when `parts` is present. */
  text: string;
  userId?: string | null;
  /** Allow-listed env applied to OpenCode before server-side prompt delivery. */
  opencodeEnv?: Record<string, string | null>;
  /** The full prompt body, when the producer has one (the prompt inbox). Text-only
   *  producers keep sending `text` and get the same single-part body as before. */
  parts?: PromptPartWire[];
  /** Agent/model/variant/directory captured at submit time — see PromptOverridesWire. */
  overrides?: PromptOverridesWire;
  /**
   * Sent verbatim as the body's `messageID`.
   *
   * It binds the turn record (`extractTurnIdentity` reads it off the POST body,
   * so the turn becomes message-scoped instead of root-scoped) and it outranks
   * the content hash in the proxy's dedupe precedence. Omitted by producers
   * that hold no transcript and therefore cannot place an id correctly.
   */
  wireMessageId?: string;
  /** Stable lifecycle row identity used only for deterministic workspace paths. */
  materializationKey?: string;
  /** Skip legacy first-message repair only for the pending-first row itself. */
  isPendingFirstPrompt?: boolean;
}

/** JSON metadata used to gate the one-time repair of pre-materialization prompts. */
export interface LegacyInlineAttachmentRepairMetadata extends Record<string, unknown> {
  pending_prompt?: {
    attachment_names?: unknown;
  };
  legacy_inline_attachments_repaired_at?: unknown;
}

export interface StartSessionCommand {
  source: SessionInvocationSource;
  loaded: { row: ProjectRow; userId: string };
  visible: {
    row: {
      status: string;
      sandboxProvider: string;
      baseRef: string | null;
      agentName: string | null;
      opencodeSessionId: string | null;
      accountId: string;
      metadata?: Record<string, unknown> | null;
    };
  };
  projectId: string;
  sessionId: string;
  /** Optional server-side long-poll budget (ms). When set, startSession keeps
   *  re-resolving readiness until ready/terminal or this deadline, so the client
   *  learns `ready` the instant it flips instead of on its own poll tick.
   *  Bounded server-side (START_AWAIT_MAX_MS); omit/0 = original one-shot. */
  waitMs?: number;
}

/**
 * How one hand-off of a prompt to the runtime ended.
 *
 * The RETRY CLASS is the whole point of the split:
 *  - `delivered`     — OpenCode holds the message. Terminal, success.
 *  - `pending`       — the runtime did not become ready inside this attempt's
 *                      budget. Worth another pass soon.
 *  - `unreachable`   — the RUNTIME is down: the provider has the box stopped,
 *                      the session row is parked `failed`, or the resolved
 *                      target reports a dead stage. Nothing about the prompt is
 *                      wrong; it must wait for the runtime to come back rather
 *                      than be given up on. Bounded (see
 *                      `MAX_RUNTIME_UNREACHABLE_RETRIES`).
 *  - `no-session`    — the session does not exist, or the user deleted it.
 *                      Terminal: there is nothing to deliver to, ever.
 *  - `failed`        — a genuine delivery refusal that re-trying cannot fix.
 *                      Terminal.
 *
 * `unreachable` exists because everything that produced `failed` on this path
 * was in fact a down runtime, and the drain treated it as terminal: a queued
 * prompt delivered while the box was unreachable went `dead_lettered` on its
 * FIRST attempt and was never re-tried when the box came back minutes later
 * (Essentia, 2026-08-26: `state:failed, attempts:1,
 * last_error:"delivery outcome: failed"`).
 */
export type SessionDeliveryOutcome =
  | 'delivered'
  | 'pending'
  | 'unreachable'
  | 'no-session'
  | 'failed'
  /** The runtime ACCEPTED the prompt and then never wrote the message. Not a
   *  retry under the same key: the proxy's dedupe claim would answer that
   *  `duplicate` and the row would close as delivered again. The row goes
   *  back on the queue with a fresh attempt, a fresh key and a fresh wire id. */
  | 'not-landed';

export interface SessionLifecycleResult {
  status: SessionLifecycleStatus;
  commandId?: string;
  sessionId?: string;
  row?: ProjectSessionRow;
  start?: SessionStartResult;
  delivery?: SessionDeliveryOutcome;
  deduped?: boolean;
  retryable?: boolean;
  reason?: string;
  error?: SessionCreateError | { status: number; body: Record<string, unknown> };
  headers?: Record<string, string>;
}

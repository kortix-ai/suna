/**
 * The closed value sets the session wire carries, defined once.
 *
 * Each set is a `const` tuple, its type is derived from it, and each decision a
 * client makes on a value is a function here, so no client compares a free
 * string of its own. No zod and no import: `@kortix/sdk` keeps a byte-equal
 * copy (`packages/sdk/src/core/wire-values.ts`, held by
 * `wire-values.test.ts` there), and apps/api, kortixd and the schemas in this
 * package import this file.
 */

// ─── Thread status ───────────────────────────────────────────────────────────

/**
 * What a session thread does now. This is the base set. `log.status` carries
 * it whole; the other wires carry a projection of it:
 * - `GET /kortix/runtime/pending` (`RuntimeThreadStatus`): `retry` reads `busy`.
 * - the v1 `session.status` frame (`KortixSessionStatus`): `compacting` reads `busy`.
 * - kortixd's own turn flag (`ThreadActivity`): a turn runs, or none does.
 */
export const THREAD_STATUSES = ['idle', 'busy', 'retry', 'compacting'] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

/** kortixd's turn flag: `busy` from the start of a turn to its end. */
export type ThreadActivity = Extract<ThreadStatus, 'idle' | 'busy'>;

/** `GET /kortix/runtime/pending`: a retry is still the turn, so it reads `busy`. */
export type RuntimeThreadStatus = Exclude<ThreadStatus, 'retry'>;

/** The `type` of the v1 `session.status` frame: a compaction runs inside a turn, so it reads `busy`. */
export type KortixSessionStatusType = Exclude<ThreadStatus, 'compacting'>;

export function toRuntimeThreadStatus(status: ThreadStatus): RuntimeThreadStatus {
  return status === 'retry' ? 'busy' : status;
}

export function toKortixSessionStatusType(status: ThreadStatus): KortixSessionStatusType {
  return status === 'compacting' ? 'busy' : status;
}

/** Every status except `idle` is work in progress: the Stop control shows for it. */
export function isThreadWorking(status: ThreadStatus): boolean {
  return status !== 'idle';
}

// ─── Runtime capabilities ────────────────────────────────────────────────────

/**
 * A session feature a runtime may or may not serve. The daemon lists the ones it
 * serves in `GET /kortix/health` `capabilities`; a client gates the control on
 * the list, never on the harness.
 */
export const RUNTIME_CAPABILITIES = [
  /** Revert to a message and restore it (`/session/:id/revert`, `/unrevert`). */
  'session.rewind',
  /** Summarize the conversation on demand (`/session/:id/summarize`). */
  'session.compact',
  /** Project slash commands (`GET /command`, `/session/:id/command`). */
  'session.commands',
  /** Fork a session at a message. */
  'session.fork',
  /** Subagent child sessions, readable while the parent drives them. */
  'session.subagents',
  /** MCP servers the runtime connects itself. */
  'session.mcp',
  /** The runtime's todo list (`/session/:id/todo`). */
  'session.todo',
  /** A shell command run as a turn (`/session/:id/shell`). */
  'session.shell',
  /** Attach the harness's own terminal client to the session runtime. */
  'session.attach',
  /** A runtime config document a client may read and patch (`/global/config`). */
  'session.config',
  /**
   * A message sent during a turn is read by that turn at its next step
   * boundary (`POST /kortix/runtime/sessions/:id/steer`). The turn does not stop.
   */
  'session.steer',
  /**
   * `GET /kortix/runtime/events?schema=v2` streams the session log
   * (`kortix.session/2`) as `log.*` frames (`@kortix/api-contract/session-log`
   * `SESSION_LOG_EVENTS`). Without `schema` the stream is the v1 stream.
   */
  'session.log.v2',
  /**
   * Cross-session messages: the `send_message` and `list_agents` tools
   * (`@kortix/api-contract/multi-agent`).
   */
  'session.messaging',
  /** A team's shared task list: the `task_*` tools (flag `agent_teams`). */
  'session.team_tasks',
  /**
   * A full context, and `/session/:id/summarize`, reset onto the session's searchable record:
   * nothing is summarized (kortixd `extensions/context-record.ts`). Absent: a summary.
   */
  'session.context_record',
] as const;
export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

// ─── Session stream frames (`GET .../sessions/:sid/events`) ─────────────────

/**
 * The control-channel snapshot frames. Each carries its subsystem's whole state,
 * in one `cseq` space.
 */
export const SESSION_CONTROL_FRAME_TYPES = [
  /** The whole turn verdict: the object `GET .../turn` serves. */
  'kortix.control.turn',
  /** The whole prompt queue: the rows `GET .../prompts` serves. */
  'kortix.control.queue',
  /** Runtime reachability and wake progress, as the control plane sees it. */
  'kortix.control.runtime',
  /**
   * The session's audit and approval watermark: the count of unresolved
   * connector-gated approvals and the newest create and resolve instants. Not
   * the rows: a client re-reads `GET .../audit` when it changes.
   */
  'kortix.control.audit',
  /** @deprecated The OpenCode daemon's `/kortix/opencode/state` projection. A pi box never has one. */
  'kortix.control.runtime_state',
  /** The session's title, the project's secrets version and the model pin version. */
  'kortix.control.session',
] as const;
export type SessionControlFrameType = (typeof SESSION_CONTROL_FRAME_TYPES)[number];

/** The stream's own frames, outside the control `cseq` space and the runtime log. */
export const SESSION_STREAM_FRAME_TYPES = [
  /** The first frame of a connection: the cursors the server resumes at. */
  'kortix.stream.hello',
  /** Liveness, every 15 s. */
  'kortix.stream.heartbeat',
  /** The caller lost access to the session. The server closes the stream; a client must not reconnect. */
  'kortix.stream.revoked',
  /** The control cursor could not be replayed: every snapshot follows again. */
  'kortix.control.resync',
  /** Whether the API is attached to the box (`state`, `reason`, `parked`). */
  'kortix.runtime.status',
  /** The box's `GET /kortix/health` document, pushed on change. */
  'kortix.runtime.health',
] as const;
export type SessionStreamFrameType = (typeof SESSION_STREAM_FRAME_TYPES)[number];

/**
 * Does a `kortix.runtime.status {state:'down'}` reason say the box is PARKED (its
 * row is not running, and only a send resumes it), not a transient attach
 * failure? A new frame carries the answer as `parked`; this rule reads a frame
 * from an API that sends only `reason`.
 */
export function isParkedRuntimeDownReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && (reason.startsWith('sandbox_') || reason === 'no_sandbox');
}

// ─── `/start` reasons ────────────────────────────────────────────────────────

/**
 * `starting` reasons that describe the API's view of the box, not the box: a
 * probe that timed out, a provider status call that failed, one unconfirmed
 * `stopped` read. A client that already saw `ready` keeps the session live
 * through them.
 */
export const SESSION_START_TRANSPORT_REASONS = [
  'unreachable',
  'runtime_status_unknown',
  'runtime_stop_unconfirmed',
] as const;
export type SessionStartTransportReason = (typeof SESSION_START_TRANSPORT_REASONS)[number];

export function isSessionStartTransportReason(reason: string | null | undefined): reason is SessionStartTransportReason {
  return (SESSION_START_TRANSPORT_REASONS as readonly string[]).includes(reason ?? '');
}

/** `starting` reasons that mean a provider operation moves this box, not a boot. */
export const SESSION_START_RESUMING_REASONS = [
  'runtime_waking',
  'runtime_wake_cooldown',
  'runtime_status_unknown',
  'runtime_stop_unconfirmed',
  'runtime_restoring_in_place',
  'runtime_recovered_in_place',
  'runtime_recovery_in_progress',
  'runtime_removed_checking',
] as const;
export type SessionStartResumingReason = (typeof SESSION_START_RESUMING_REASONS)[number];

// ─── Prompt reasons ──────────────────────────────────────────────────────────

/**
 * Why a prompt row is in its state (`SessionPrompt.reason`):
 * - `turn_active`, `older_prompt_pending`, `answer_unverified`: admission waits (`waiting`).
 * - `held`: Stop parked it; only the user sends it again (`waiting`). It is not live work.
 * - `forwarded`: the runtime holds it behind the turn in flight (`delivering`).
 * - `runtime_unreachable`: parked on a down runtime; the server retries it (`queued`).
 */
export const SESSION_PROMPT_REASONS = [
  'turn_active',
  'older_prompt_pending',
  'answer_unverified',
  'held',
  'forwarded',
  'runtime_unreachable',
] as const;
export type SessionPromptReason = (typeof SESSION_PROMPT_REASONS)[number];

/** The admission reasons: the ones stored in a row's `result.admission_reason`. */
export type SessionPromptAdmissionReason = Extract<SessionPromptReason, 'turn_active' | 'older_prompt_pending' | 'answer_unverified'>;

export function isSessionPromptReason(reason: unknown): reason is SessionPromptReason {
  return typeof reason === 'string' && (SESSION_PROMPT_REASONS as readonly string[]).includes(reason);
}

// ─── Billing ─────────────────────────────────────────────────────────────────

/**
 * `credit_accounts.payment_status`: every value the billing writers store
 * (Stripe and RevenueCat webhooks, subscriptions, account deletion). `null` is
 * an account with no billing state yet.
 */
export const CREDIT_ACCOUNT_PAYMENT_STATUSES = ['active', 'cancelling', 'past_due', 'failed', 'deleted'] as const;
export type CreditAccountPaymentStatus = (typeof CREDIT_ACCOUNT_PAYMENT_STATUSES)[number];


import { projectSessions, sessionLifecycleCommands } from '@kortix/db';
import { type SQL, and, asc, eq, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import type {
  CreateSessionCommand,
  QueuedCreateSessionPayload,
  SessionInvocationSource,
  SessionLifecycleResult,
} from './types';

export type SessionLifecycleCommandRow = typeof sessionLifecycleCommands.$inferSelect;

/**
 * `payload.deliveryAttempt + 1`, merged into the payload expression given.
 *
 * WHY A COUNTER AT ALL: the proxy claims `idem:<sandbox>\0<session>\0<key>` for
 * `DEDUPE_TTL_MS` (10 min) on every prompt delivery, and `executeQueuedContinue`
 * derives that key from the command id. A row that goes back on the queue after
 * it has ALREADY BEEN POSTED — a redelivery, a released Stop, "send now" on a
 * stop-paused row — would re-POST under the same key and be answered
 * `200 {"deduplicated": true}`, which `postPrompt` reads as delivered. OpenCode
 * never receives the message and the row is force-closed ten minutes later with
 * nothing logged but "no proof it was consumed".
 *
 * WHY NOT `redeliveries`: that counter is the reaper's BUDGET
 * (`MAX_PROMPT_REDELIVERIES` dead-letters past it). Spending it on a user
 * pressing Stop and re-sending would take away the automatic repair that exists
 * for a prompt a turn really did drop.
 *
 * Every writer that puts a POSTed row back on the queue must call this. It is
 * the only reason `executeQueuedContinue`'s idempotency key ever changes.
 */
export function withNextDeliveryAttempt(payload: SQL): SQL {
  return sql`jsonb_set(
    ${payload},
    '{deliveryAttempt}',
    to_jsonb(COALESCE((${sessionLifecycleCommands.payload}->>'deliveryAttempt')::int, 0) + 1))`;
}

export function createSessionCommandPayload(command: CreateSessionCommand): QueuedCreateSessionPayload {
  return {
    body: command.body,
    requestingPrincipalType: command.requestingPrincipalType,
    metadata: command.metadata,
    extraEnvVars: command.extraEnvVars,
    visibility: command.visibility,
    mayManageSystemConnections: command.mayManageSystemConnections,
    enforceAccountCap: command.enforceAccountCap,
    postCreate: command.postCreate,
    authType: command.authType,
    apiKeyType: command.apiKeyType,
    inSession: command.inSession,
    callerSessionId: command.callerSessionId,
  };
}

/** One part of a prompt body, in OpenCode's own `/prompt_async` shape. */
export interface PromptPartWire {
  type: 'text' | 'file' | 'agent';
  text?: string;
  mime?: string;
  url?: string;
  filename?: string;
  name?: string;
  source?: unknown;
}

/** The per-prompt picks the producer captured at submit time. Applied verbatim
 *  on delivery, so a prompt queued behind a live turn still runs with the
 *  agent/model the user chose then, not whatever is current when it drains. */
export interface PromptOverridesWire {
  agent?: string | null;
  model?: { providerID: string; modelID: string } | null;
  variant?: string | null;
  directory?: string | null;
}

export interface QueuedContinueSessionPayload {
  /** Legacy single-text form. Still written by every non-inbox producer
   *  (triggers, Slack, approval-resume). Read when `parts` is absent. */
  text: string;
  /** When set, the drain SKIPS delivery if this execution's decision was
   *  already consumed in-band (a live held/poll request resumed the turn) —
   *  the follow-up prompt would just be noise. */
  executionId?: string | null;
  /** Which trigger fired this prompt — diagnostics only, carried into the
   *  dead-letter alert so "which automation lost its prompt" is answerable
   *  from the log line alone. */
  triggerSlug?: string | null;

  // ── Prompt-inbox fields. Absent on every row enqueued before the inbox
  //    existed, which is why every reader below falls back to `text`.

  /** The host's stable submission name. Same id = same logical send, which is
   *  what makes `prompt:<sessionId>:<clientMessageId>` a real idempotency key. */
  clientMessageId?: string;
  /**
   * The CLIENT-minted OpenCode wire id, used VERBATIM on first delivery.
   *
   * The client mints it because the client is the process holding the
   * transcript: OpenCode decides "has this prompt already been answered?" by id
   * order, so an id has to be placed above everything already on record. The
   * control plane mints one only on redelivery, where it re-reads the
   * transcript first (see `wire-message-id.ts`).
   */
  wireMessageId?: string;
  /**
   * The id this prompt was ACTUALLY delivered under, when it is not
   * `wireMessageId`.
   *
   * Two paths write it, for the same reason — the client's id is only correctly
   * placed while nothing newer has been written to the transcript: a redelivery
   * (N >= 1), and a first delivery that WAITED behind a live turn. Persisted
   * before the POST, so a crash between mint and delivery reuses one id.
   */
  redeliveredMessageId?: string;
  /** How many times a PROVEN-abandoned delivery has been requeued. Capped by
   *  `MAX_PROMPT_REDELIVERIES`. */
  redeliveries?: number;
  /** How many times this row has already been POSTed to OpenCode. Suffixes the
   *  delivery's idempotency key — see `withNextDeliveryAttempt`. */
  deliveryAttempt?: number;
  /**
   * This row did NOT go out on its first claim, so the client's wire id can no
   * longer be trusted to sort above the transcript.
   *
   * Written by every path that puts a row back in line — an admission refusal,
   * a hold, a "send now"/retry — and NEVER cleared, because "was overtaken
   * once" stays true. It lives in the payload rather than in `result` because
   * `result` is replaced wholesale by the retry that most needs this fact.
   *
   * A PRODUCER may also set it at enqueue time (`remint_on_delivery` on
   * `POST .../prompts`) when it knows its id was minted somewhere the live
   * transcript could not be read — the one-time localStorage migration, which
   * mints at page load for a message typed before the last reload.
   */
  remintOnDelivery?: boolean;
  /** The sender tab's clock at Enter — the SEND order across surfaces whose
   *  POSTs race (boot shell vs chat during the crossfade). */
  clientSentAtMs?: number;
  parts?: PromptPartWire[];
  overrides?: PromptOverridesWire;
}

/**
 * Enqueue a durable "deliver this follow-up into the session" command —
 * drained by the leader's scheduler tick, retried with backoff, dead-lettered
 * after 5 attempts. Survives the enqueueing pod dying, unlike a detached
 * promise. `availableAt` in the future = a scheduled grace window.
 */
export interface EnqueueContinueSessionCommandInput {
  source: SessionInvocationSource;
  projectId: string;
  accountId: string;
  sessionId: string;
  actorUserId: string | null;
  text: string;
  executionId?: string | null;
  triggerSlug?: string | null;
  availableAt?: Date;
  /** Dedupe key — a repeat enqueue (double-resolve race) is a no-op. */
  idempotencyKey?: string | null;
  // ── Prompt-inbox fields; see QueuedContinueSessionPayload. ──
  clientMessageId?: string;
  wireMessageId?: string;
  /** The producer already knows its wire id is stale — see
   *  `QueuedContinueSessionPayload.remintOnDelivery`. */
  remintOnDelivery?: boolean;
  /** The sender tab's clock at Enter — the SEND order across surfaces whose
   *  POSTs race (boot shell vs chat during the crossfade). */
  clientSentAtMs?: number;
  parts?: PromptPartWire[];
  overrides?: PromptOverridesWire;
}

/** Build one durable callback row. Exported for transaction-bound outbox writes. */
export function buildContinueSessionCommandValues(input: EnqueueContinueSessionCommandInput) {
  const now = new Date();
  const payload: QueuedContinueSessionPayload = {
    text: input.text,
    executionId: input.executionId ?? null,
    triggerSlug: input.triggerSlug ?? null,
    // Omitted rather than nulled: absence is what tells every reader "this row
    // predates the inbox / did not come from it", and a null would read as
    // "came from the inbox with no id", which is a different thing.
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
    ...(input.wireMessageId ? { wireMessageId: input.wireMessageId } : {}),
    ...(input.remintOnDelivery ? { remintOnDelivery: true } : {}),
    ...(typeof input.clientSentAtMs === 'number' ? { clientSentAtMs: input.clientSentAtMs } : {}),
    ...(input.parts ? { parts: input.parts } : {}),
    ...(input.overrides ? { overrides: input.overrides } : {}),
  };
  return {
    commandType: 'continue_session',
    source: input.source,
    status: 'queued' as const,
    projectId: input.projectId,
    accountId: input.accountId,
    actorUserId: input.actorUserId,
    sessionId: input.sessionId,
    idempotencyKey: input.idempotencyKey ?? null,
    payload: payload as unknown as Record<string, unknown>,
    result: {},
    availableAt: input.availableAt ?? now,
    updatedAt: now,
  };
}

/** The row this enqueue names — inserted now, or the one the idempotency key
 *  already points at. The inbox answers `POST /prompts` out of it, which is why
 *  the enqueue no longer returns void. */
export interface EnqueuedContinueSessionCommand {
  row: SessionLifecycleCommandRow;
  /** The key already existed: this call inserted nothing. */
  deduped: boolean;
}

export async function enqueueContinueSessionCommand(
  input: EnqueueContinueSessionCommandInput,
): Promise<EnqueuedContinueSessionCommand> {
  const values = buildContinueSessionCommandValues(input);
  if (!input.idempotencyKey) {
    const [row] = await db.insert(sessionLifecycleCommands).values(values).returning();
    return { row, deduped: false };
  }
  const inserted = await db
    .insert(sessionLifecycleCommands)
    .values(values)
    .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey })
    .returning();
  if (inserted[0]) return { row: inserted[0], deduped: false };

  const [existing] = await db
    .select()
    .from(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (!existing) {
    throw new Error(
      `continue_session ${input.idempotencyKey} conflicted but could not be loaded`,
    );
  }
  return { row: existing, deduped: true };
}

/**
 * Put a claimed row back WITHOUT counting the claim as an attempt.
 *
 * `claimDueLifecycleCommands` increments `attempts` on every claim, and
 * `markCommandFailed` dead-letters at 5. An admission refusal is not a failure
 * — the session was simply busy — so a prompt that waits out a long turn must
 * not spend its dead-letter budget doing so. Giving the increment back (floored
 * at 0, because a concurrent writer may already have reset it) is what keeps
 * "waiting" and "failing" different states.
 *
 * The reason is stamped into `result.admission_reason` so `GET /prompts` can
 * say WHY a row is still queued, and `result.admission_refusals` counts them so
 * the next refusal can back off further (`admissionBackoffMs`).
 * `markCommandSucceeded`/`markCommandFailed` both overwrite `result` wholesale,
 * so both markers clear themselves the moment the row stops waiting.
 *
 * `payload.remintOnDelivery` is the SAME fact written where it SURVIVES.
 * `result` is cleared by everything downstream — a retry, a "send now", a
 * success — and one of those clears (`retryInboxPrompt`) happens precisely when
 * the row is about to be delivered, which is when the drain needs to know that
 * the client's wire id has been overtaken by the turn this prompt waited out.
 * Reading a display marker to make a correctness decision is how the id got
 * sent stale; the payload merge (`||`) is the durable half.
 */
export async function requeueForAdmission(
  commandId: string,
  reason: 'older_prompt_pending',
  availableAt: Date,
): Promise<void> {
  await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'queued',
      availableAt,
      lockedBy: null,
      lockedUntil: null,
      attempts: sql`GREATEST(${sessionLifecycleCommands.attempts} - 1, 0)`,
      result: sql`COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb)
        || ${JSON.stringify({ admission_reason: reason })}::jsonb
        || jsonb_build_object('admission_refusals',
             COALESCE((${sessionLifecycleCommands.result}->>'admission_refusals')::int, 0) + 1)`,
      payload: sql`${sessionLifecycleCommands.payload} || '{"remintOnDelivery": true}'::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(sessionLifecycleCommands.commandId, commandId));
}

/**
 * Make the session's NEXT queued inbox row due now.
 *
 * Called the instant a delivery lands (forwarded or delivered). Without it the
 * next row waited out whatever `requeueForAdmission` backoff it had accrued
 * while its sibling was in flight — visible dead air between two messages the
 * user typed one after the other. Only rows the admission gate put back
 * (`admission_reason` set) or plain queued rows; never a HELD row (Stop parked
 * it) and never a row whose `available_at` is a deliberate future schedule
 * without a refusal marker. Returns the promoted row's idempotency key so the
 * caller can drain exactly it.
 */
export async function promoteNextInboxRow(sessionId: string): Promise<string | null> {
  const [next] = await db
    .select({
      commandId: sessionLifecycleCommands.commandId,
      idempotencyKey: sessionLifecycleCommands.idempotencyKey,
    })
    .from(sessionLifecycleCommands)
    .where(
      and(
        eq(sessionLifecycleCommands.sessionId, sessionId),
        eq(sessionLifecycleCommands.commandType, 'continue_session'),
        eq(sessionLifecycleCommands.status, 'queued'),
        sql`COALESCE(${sessionLifecycleCommands.result}->>'held', '') <> 'true'`,
        sql`(${sessionLifecycleCommands.result} ? 'admission_reason' OR ${sessionLifecycleCommands.availableAt} <= now())`,
      ),
    )
    .orderBy(asc(sessionLifecycleCommands.createdAt))
    .limit(1);
  if (!next) return null;
  await db
    .update(sessionLifecycleCommands)
    .set({ availableAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(sessionLifecycleCommands.commandId, next.commandId),
        eq(sessionLifecycleCommands.status, 'queued'),
      ),
    );
  return next.idempotencyKey ?? null;
}

export async function claimCreateSessionCommand(
  command: CreateSessionCommand,
  opts: { initialStatus: 'queued' | 'running'; reason?: string | null },
): Promise<{ row: SessionLifecycleCommandRow; existing: boolean }> {
  const now = new Date();
  const values = {
    commandType: 'create_session',
    source: command.source,
    status: opts.initialStatus,
    projectId: command.project.projectId,
    accountId: command.project.accountId,
    actorUserId: command.userId,
    idempotencyKey: command.idempotencyKey ?? null,
    payload: createSessionCommandPayload(command) as unknown as Record<string, unknown>,
    result: opts.reason ? { reason: opts.reason } : {},
    availableAt: now,
    updatedAt: now,
  };

  if (!command.idempotencyKey) {
    const [row] = await db.insert(sessionLifecycleCommands).values(values).returning();
    return { row, existing: false };
  }

  const inserted = await db
    .insert(sessionLifecycleCommands)
    .values(values)
    .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey })
    .returning();

  if (inserted[0]) return { row: inserted[0], existing: false };

  const [existing] = await db
    .select()
    .from(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.idempotencyKey, command.idempotencyKey))
    .limit(1);

  if (!existing) {
    throw new Error(`Idempotent command ${command.idempotencyKey} conflicted but could not be loaded`);
  }
  return { row: existing, existing: true };
}

export function resultFromExistingCommand(row: SessionLifecycleCommandRow): SessionLifecycleResult {
  const result = (row.result ?? {}) as Record<string, unknown>;
  const sessionId =
    row.sessionId ??
    (typeof result.session_id === 'string' ? result.session_id : null) ??
    (typeof result.sessionId === 'string' ? result.sessionId : null);
  const reason = typeof result.reason === 'string' ? result.reason : undefined;
  const error =
    typeof row.lastError === 'string'
      ? { status: 500, body: { error: row.lastError } }
      : undefined;

  if (row.status === 'succeeded') {
    return {
      status: 'deduped',
      commandId: row.commandId,
      sessionId: sessionId ?? undefined,
      deduped: true,
      reason,
    };
  }
  if (row.status === 'queued') {
    return {
      status: 'queued',
      commandId: row.commandId,
      sessionId: sessionId ?? undefined,
      deduped: true,
      retryable: true,
      reason,
    };
  }
  if (row.status === 'running') {
    return {
      status: 'pending',
      commandId: row.commandId,
      sessionId: sessionId ?? undefined,
      deduped: true,
      retryable: true,
      reason,
    };
  }
  return {
    status: 'failed',
    commandId: row.commandId,
    sessionId: sessionId ?? undefined,
    deduped: true,
    retryable: false,
    reason,
    error,
  };
}

export async function markCommandQueued(
  commandId: string,
  reason: string | null,
): Promise<void> {
  await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'queued',
      result: reason ? { reason } : {},
      availableAt: new Date(),
      lockedBy: null,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(sessionLifecycleCommands.commandId, commandId));
}

export async function markCommandSucceeded(
  commandId: string,
  result: Record<string, unknown>,
  sessionId?: string | null,
): Promise<void> {
  await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'succeeded',
      sessionId: sessionId ?? null,
      result,
      lockedBy: null,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(sessionLifecycleCommands.commandId, commandId));
}

/**
 * The row went to OpenCode. It is NOT finished.
 *
 * `markCommandSucceeded` used to run here, and "succeeded" was a lie in the one
 * way that matters to the person watching: OpenCode PERSISTS a prompt and
 * queues its execution behind the turn in flight, so between the POST and the
 * turn there is a real interval in which the message exists, belongs to the
 * transcript, and has not run. Closing the row there left the composer with
 * nothing to show for it.
 *
 * So the row stays OPEN — `succeeded` for the drain, which must never re-claim
 * it, and `result.status = 'forwarded'` for every reader that answers the user:
 * `listInboxPrompts` keeps it, `promptState` calls it `delivering`, and only
 * `confirmInboxPromptConsumed` — the `session_turns` ledger naming this exact
 * wire id — closes it.
 *
 * IT ALSO LANDS THE TWO THINGS THAT HAPPENED WHILE THE ROW WAS CLAIMED, both
 * written into the PAYLOAD because this statement replaces `result` wholesale:
 *
 *  - `consumedOnDelivery` — a turn ACCEPTED the message. Acceptance happens
 *    inside the POST (`forwardToSandbox` awaits `acceptSandboxTurn` before it
 *    returns), so `confirmInboxPromptConsumed` reaches this row while the drain
 *    still owns it and cannot close it there. Landing it here is what closes
 *    the row at acceptance instead of at the end of the whole turn.
 *  - `stopPausedOnDelivery` — the user pressed Stop while the row was inside
 *    `continueSession`, which nothing can recall. The delivery comes back
 *    stop-paused instead of unheld. Otherwise the one prompt the user pressed
 *    Stop to get ahead of is the one the hold misses.
 *
 * ACCEPTANCE WINS over the stop mark. A message a turn took is running in the
 * transcript; calling it stop-paused would render it as a parked queue row with
 * a "send now" button, keep it out of the sweep, and let the next release
 * deliver it a SECOND time. Stop cannot unsend a POST — it can only stop what
 * the POST started, and that is the abort's job, not this row's.
 *
 * Both markers are CONSUMED here. Leaving one behind re-lands it on every later
 * delivery of the same row — a freshly re-sent prompt coming back held, with no
 * hold in force.
 */
export async function markCommandForwarded(
  commandId: string,
  sessionId: string,
  wireMessageId: string,
): Promise<void> {
  const forwarded = {
    status: 'forwarded',
    forwarded_at: new Date().toISOString(),
    // The id the ledger will key the confirmation on — readable from the
    // row alone, without re-deriving which of the payload's two ids this
    // attempt actually used.
    forwarded_message_id: wireMessageId,
  };
  await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'succeeded',
      sessionId,
      result: sql`${JSON.stringify(forwarded)}::jsonb || CASE
        WHEN COALESCE(${sessionLifecycleCommands.payload}->>'consumedOnDelivery', '') = 'true'
        THEN '{"status": "delivered"}'::jsonb
        WHEN COALESCE(${sessionLifecycleCommands.payload}->>'stopPausedOnDelivery', '') = 'true'
        THEN '{"stop_paused": true, "held": true}'::jsonb
        ELSE '{}'::jsonb
      END`,
      payload: sql`${sessionLifecycleCommands.payload} - 'consumedOnDelivery' - 'stopPausedOnDelivery'`,
      lockedBy: null,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(sessionLifecycleCommands.commandId, commandId));
}

export async function markCommandFailed(
  commandId: string,
  error: string,
  opts: {
    retryable: boolean;
    attempts: number;
    sessionId?: string | null;
    result?: Record<string, unknown>;
  },
): Promise<void> {
  const retry = opts.retryable && opts.attempts < 5;
  const [row] = await db
    .update(sessionLifecycleCommands)
    .set({
      status: retry ? 'queued' : 'dead_lettered',
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.result ? { result: opts.result } : {}),
      attempts: opts.attempts,
      availableAt: new Date(Date.now() + Math.min(60_000, 2_000 * Math.max(opts.attempts, 1))),
      lockedBy: null,
      lockedUntil: null,
      lastError: error,
      updatedAt: new Date(),
    })
    .where(eq(sessionLifecycleCommands.commandId, commandId))
    .returning();
  if (retry || !row) return;

  // Dead-lettered = this command's work is being ABANDONED. That used to be a
  // console.warn deep in the drain — invisible to alerting while the user's
  // session sat "queued — agent picking up" forever. Make it a real error.
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  logger.error('[session-lifecycle] command dead-lettered — giving up after retries', {
    command_id: row.commandId,
    command_type: row.commandType,
    source: row.source,
    project_id: row.projectId,
    account_id: row.accountId,
    session_id: row.sessionId,
    trigger_slug: typeof payload.triggerSlug === 'string' ? payload.triggerSlug : undefined,
    idempotency_key: row.idempotencyKey,
    attempts: opts.attempts,
    error,
  });

  // A prompt the USER typed must never park their session. The park exists so a
  // `session_mode: "reuse"` TRIGGER aims its next fire at a fresh session
  // instead of a wedged one; an inbox prompt has a person watching, a visible
  // failed row, and a retry button, and marking the session `failed` under them
  // takes a working session away over one lost delivery.
  const isInboxPrompt =
    typeof (row.payload as { clientMessageId?: unknown } | null)?.clientMessageId === 'string';
  if (row.commandType === 'continue_session' && row.sessionId && !isInboxPrompt) {
    // Park the target session 'failed': findReusableTriggerSession skips failed
    // sessions, so a `session_mode = "reuse"` trigger's next fire creates a
    // FRESH session instead of re-aiming prompts at a wedged one — the proven
    // lossless self-heal. Status re-check in the UPDATE predicate (same pattern
    // as reconcileStuckActiveSessions) so a concurrent transition isn't
    // clobbered by a stale dead-letter.
    try {
      await db
        .update(projectSessions)
        .set({
          status: 'failed',
          error: `prompt delivery dead-lettered: ${error}`.slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(
          and(eq(projectSessions.sessionId, row.sessionId), ne(projectSessions.status, 'failed')),
        );
    } catch (err) {
      console.warn('[session-lifecycle] failed to park session after dead-letter', {
        sessionId: row.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * How long past its expired lock a `running` row waits before another worker
 * takes it.
 *
 * A row goes `running` at claim time and stays there for the whole delivery,
 * which can be a full cold-boot wait. If the pod handling it dies in that
 * window — a rollout, an OOM — nothing ever puts the row back: the claim only
 * ever looked at `queued`. Its session's inbox then wedges for ever, because
 * `older_prompt_pending` counts `running`.
 *
 * The grace sits ON TOP of the 5-minute lock, so a worker that is merely slow
 * has ten minutes before anyone else touches its row, and a duplicate delivery
 * would still be absorbed by the proxy's `Idempotency-Key` claim.
 */
export const LIFECYCLE_RUNNING_RECLAIM_GRACE_MS = 5 * 60_000;

export async function claimDueLifecycleCommands(input: {
  workerId: string;
  limit: number;
  now?: Date;
  /** Claim only the callback with this durable idempotency key. */
  idempotencyKey?: string;
  /** Claim only commands that came due before this instant (default: now).
   *  Lets the starvation reconciler target rows the scheduler drain should
   *  have taken long ago, without racing it for freshly-due ones. */
  availableBefore?: Date;
}): Promise<SessionLifecycleCommandRow[]> {
  const now = input.now ?? new Date();
  const staleRunningBefore = new Date(now.getTime() - LIFECYCLE_RUNNING_RECLAIM_GRACE_MS);
  const rows = await db
    .select()
    .from(sessionLifecycleCommands)
    .where(
      and(
        or(
          and(
            eq(sessionLifecycleCommands.status, 'queued'),
            or(
              isNull(sessionLifecycleCommands.lockedUntil),
              lte(sessionLifecycleCommands.lockedUntil, now),
            ),
          ),
          // ABANDONED CLAIM. A `running` row whose lock expired a full grace
          // ago has no live worker: the pod that claimed it is gone. Left
          // alone it wedges its session's inbox for ever.
          and(
            eq(sessionLifecycleCommands.status, 'running'),
            lte(sessionLifecycleCommands.lockedUntil, staleRunningBefore),
          ),
        ),
        input.idempotencyKey
          ? eq(sessionLifecycleCommands.idempotencyKey, input.idempotencyKey)
          : undefined,
        lte(sessionLifecycleCommands.availableAt, input.availableBefore ?? now),
      ),
    )
    .orderBy(asc(sessionLifecycleCommands.availableAt), asc(sessionLifecycleCommands.createdAt))
    .limit(input.limit);

  const claimed: SessionLifecycleCommandRow[] = [];
  for (const row of rows) {
    const [locked] = await db
      .update(sessionLifecycleCommands)
      .set({
        status: 'running',
        attempts: row.attempts + 1,
        lockedBy: input.workerId,
        lockedUntil: new Date(now.getTime() + 5 * 60_000),
        updatedAt: now,
      })
      // CAS on the exact state this row was read in — its status AND its lock
      // OWNER. For a `queued` row the status flip alone is exclusive, as it
      // always was. For a reclaimed `running` row there is no flip to rely on,
      // so the owner is what makes it exclusive: the first worker to write its
      // own id takes the row, and the second no longer matches. (The lock
      // TIMESTAMP cannot serve here — Postgres keeps microseconds that a JS
      // `Date` has already rounded away, so an equality on it never matches.)
      .where(
        and(
          eq(sessionLifecycleCommands.commandId, row.commandId),
          eq(sessionLifecycleCommands.status, row.status),
          row.lockedBy
            ? eq(sessionLifecycleCommands.lockedBy, row.lockedBy)
            : isNull(sessionLifecycleCommands.lockedBy),
        ),
      )
      .returning();
    if (locked) claimed.push(locked);
  }
  return claimed;
}

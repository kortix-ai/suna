import { projectSessions, sessionLifecycleCommands } from "@kortix/db";
import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { db } from "../../shared/db";
import type {
  CreateSessionCommand,
  QueuedCreateSessionPayload,
  SessionInvocationSource,
  SessionLifecycleResult,
} from "./types";

export type SessionLifecycleCommandRow =
  typeof sessionLifecycleCommands.$inferSelect;

export interface LifecycleCommandClaim {
  lockedBy: string;
  /** Monotonically increasing claim generation. This fences the same worker ID after reclaim. */
  attempt: number;
}

// A continue command can spend 5 minutes waiting for runtime readiness and then
// 45 seconds delivering. The extra 75 seconds covers DB/network scheduling.
export const LIFECYCLE_COMMAND_LEASE_MS = 7 * 60_000;
export const LIFECYCLE_COMMAND_HEARTBEAT_MS = 60_000;

export function lifecycleCommandClaim(
  row: Pick<SessionLifecycleCommandRow, "lockedBy" | "attempts">,
): LifecycleCommandClaim {
  if (!row.lockedBy)
    throw new Error("Claimed lifecycle command is missing lock owner");
  return { lockedBy: row.lockedBy, attempt: row.attempts };
}

function claimedCommandWhere(commandId: string, claim?: LifecycleCommandClaim) {
  return claim
    ? and(
        eq(sessionLifecycleCommands.commandId, commandId),
        eq(sessionLifecycleCommands.status, "running"),
        eq(sessionLifecycleCommands.lockedBy, claim.lockedBy),
        eq(sessionLifecycleCommands.attempts, claim.attempt),
      )
    : eq(sessionLifecycleCommands.commandId, commandId);
}

export function createSessionCommandPayload(
  command: CreateSessionCommand,
): QueuedCreateSessionPayload {
  return {
    body: command.body,
    requestingPrincipalType: command.requestingPrincipalType,
    metadata: command.metadata,
    platformMetaGoalPush: command.platformMetaGoalPush,
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

export interface QueuedContinueSessionPayload {
  text: string;
  /** Stable OpenCode message ID for idempotent retry after a process crash. */
  messageId?: string | null;
  /** When set, the drain SKIPS delivery if this execution's decision was
   *  already consumed in-band (a live held/poll request resumed the turn) —
   *  the follow-up prompt would just be noise. */
  executionId?: string | null;
  /** Which trigger fired this prompt — diagnostics only, carried into the
   *  dead-letter alert so "which automation lost its prompt" is answerable
   *  from the log line alone. */
  triggerSlug?: string | null;
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
  messageId?: string | null;
  executionId?: string | null;
  triggerSlug?: string | null;
  availableAt?: Date;
  /** Dedupe key — a repeat enqueue (double-resolve race) is a no-op. */
  idempotencyKey?: string | null;
}

/** Build one durable callback row. Exported for transaction-bound outbox writes. */
export function buildContinueSessionCommandValues(
  input: EnqueueContinueSessionCommandInput,
) {
  const now = new Date();
  const payload: QueuedContinueSessionPayload = {
    text: input.text,
    messageId: input.messageId ?? null,
    executionId: input.executionId ?? null,
    triggerSlug: input.triggerSlug ?? null,
  };
  return {
    commandType: "continue_session",
    source: input.source,
    status: "queued" as const,
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

/**
 * Repair lifecycle prompts persisted before OpenCode 1.17.11 required IDs to
 * start with `msg`. Queued rows are normalized in place. Dead-lettered rows are
 * requeued because the invalid ID can be the only reason all delivery attempts
 * failed before this deployment.
 */
export async function repairLegacyLifecycleMessageIds(): Promise<number> {
  const now = new Date();
  const repaired = await db
    .update(sessionLifecycleCommands)
    .set({
      payload: sql`jsonb_set(
        ${sessionLifecycleCommands.payload},
        '{messageId}',
        to_jsonb('msg_' || (${sessionLifecycleCommands.payload}->>'messageId')),
        true
      )`,
      status: sql`case
        when ${sessionLifecycleCommands.status} = 'dead_lettered' then 'queued'
        else ${sessionLifecycleCommands.status}
      end`,
      attempts: sql`case
        when ${sessionLifecycleCommands.status} = 'dead_lettered' then 0
        else ${sessionLifecycleCommands.attempts}
      end`,
      availableAt: sql`case
        when ${sessionLifecycleCommands.status} = 'dead_lettered' then ${now}
        else ${sessionLifecycleCommands.availableAt}
      end`,
      lockedBy: null,
      lockedUntil: null,
      lastError: sql`case
        when ${sessionLifecycleCommands.status} = 'dead_lettered' then null
        else ${sessionLifecycleCommands.lastError}
      end`,
      updatedAt: now,
    })
    .where(
      and(
        eq(sessionLifecycleCommands.commandType, "continue_session"),
        inArray(sessionLifecycleCommands.status, ["queued", "dead_lettered"]),
        sql`${sessionLifecycleCommands.payload}->>'messageId' is not null`,
        sql`left(${sessionLifecycleCommands.payload}->>'messageId', 3) <> 'msg'`,
      ),
    )
    .returning({ commandId: sessionLifecycleCommands.commandId });
  return repaired.length;
}

export async function enqueueContinueSessionCommand(
  input: EnqueueContinueSessionCommandInput,
): Promise<{ commandId: string }> {
  const values = buildContinueSessionCommandValues(input);
  if (!input.idempotencyKey) {
    const [created] = await db
      .insert(sessionLifecycleCommands)
      .values(values)
      .returning({ commandId: sessionLifecycleCommands.commandId });
    if (!created) throw new Error('continue-session command insert returned no row');
    return created;
  }
  const [created] = await db
    .insert(sessionLifecycleCommands)
    .values(values)
    .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey })
    .returning({ commandId: sessionLifecycleCommands.commandId });
  if (created) return created;
  const [existing] = await db
    .select({ commandId: sessionLifecycleCommands.commandId })
    .from(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (!existing) throw new Error('continue-session command idempotency lookup returned no row');
  return existing;
}

export async function claimCreateSessionCommand(
  command: CreateSessionCommand,
  opts: { initialStatus: "queued" | "running"; reason?: string | null },
): Promise<{ row: SessionLifecycleCommandRow; existing: boolean }> {
  const now = new Date();
  const values = {
    commandType: "create_session",
    source: command.source,
    status: opts.initialStatus,
    projectId: command.project.projectId,
    accountId: command.project.accountId,
    actorUserId: command.userId,
    idempotencyKey: command.idempotencyKey ?? null,
    payload: createSessionCommandPayload(command) as unknown as Record<
      string,
      unknown
    >,
    result: opts.reason ? { reason: opts.reason } : {},
    availableAt: now,
    updatedAt: now,
  };

  if (!command.idempotencyKey) {
    const [row] = await db
      .insert(sessionLifecycleCommands)
      .values(values)
      .returning();
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
    throw new Error(
      `Idempotent command ${command.idempotencyKey} conflicted but could not be loaded`,
    );
  }
  return { row: existing, existing: true };
}

export function resultFromExistingCommand(
  row: SessionLifecycleCommandRow,
): SessionLifecycleResult {
  const result = (row.result ?? {}) as Record<string, unknown>;
  const sessionId =
    row.sessionId ??
    (typeof result.session_id === "string" ? result.session_id : null) ??
    (typeof result.sessionId === "string" ? result.sessionId : null);
  const reason = typeof result.reason === "string" ? result.reason : undefined;
  const error =
    typeof row.lastError === "string"
      ? { status: 500, body: { error: row.lastError } }
      : undefined;

  if (row.status === "succeeded") {
    return {
      status: "deduped",
      commandId: row.commandId,
      sessionId: sessionId ?? undefined,
      deduped: true,
      reason,
    };
  }
  if (row.status === "queued") {
    return {
      status: "queued",
      commandId: row.commandId,
      sessionId: sessionId ?? undefined,
      deduped: true,
      retryable: true,
      reason,
    };
  }
  if (row.status === "running") {
    return {
      status: "pending",
      commandId: row.commandId,
      sessionId: sessionId ?? undefined,
      deduped: true,
      retryable: true,
      reason,
    };
  }
  return {
    status: "failed",
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
  claim?: LifecycleCommandClaim,
): Promise<boolean> {
  const rows = await db
    .update(sessionLifecycleCommands)
    .set({
      status: "queued",
      result: reason ? { reason } : {},
      availableAt: new Date(),
      lockedBy: null,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(claimedCommandWhere(commandId, claim))
    .returning({ commandId: sessionLifecycleCommands.commandId });
  return rows.length > 0;
}

/** Requeue a claimed command behind a durable prerequisite without spending its retry budget. */
export async function deferLifecycleCommand(
  commandId: string,
  claim: LifecycleCommandClaim,
  reason: string,
  availableAt = new Date(Date.now() + 2_000),
): Promise<boolean> {
  const rows = await db
    .update(sessionLifecycleCommands)
    .set({
      status: "queued",
      result: { reason },
      availableAt,
      lockedBy: null,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(claimedCommandWhere(commandId, claim))
    .returning({ commandId: sessionLifecycleCommands.commandId });
  return rows.length > 0;
}

export async function markCommandSucceeded(
  commandId: string,
  result: Record<string, unknown>,
  sessionId?: string | null,
  claim?: LifecycleCommandClaim,
): Promise<boolean> {
  const rows = await db
    .update(sessionLifecycleCommands)
    .set({
      status: "succeeded",
      sessionId: sessionId ?? null,
      result,
      lockedBy: null,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(claimedCommandWhere(commandId, claim))
    .returning({ commandId: sessionLifecycleCommands.commandId });
  return rows.length > 0;
}

export async function markCommandFailed(
  commandId: string,
  error: string,
  opts: {
    retryable: boolean;
    attempts: number;
    sessionId?: string | null;
    result?: Record<string, unknown>;
    /** Stop commands are safety fences and must not expire before convergence. */
    unbounded?: boolean;
    /** Required for queue-drain mutations. Inline commands are never reclaimable. */
    claim?: LifecycleCommandClaim;
  },
): Promise<boolean> {
  const retry = opts.retryable && (opts.unbounded || opts.attempts < 5);
  const [row] = await db
    .update(sessionLifecycleCommands)
    .set({
      status: retry ? "queued" : "dead_lettered",
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.result ? { result: opts.result } : {}),
      attempts: opts.attempts,
      availableAt: new Date(
        Date.now() + Math.min(60_000, 2_000 * Math.max(opts.attempts, 1)),
      ),
      lockedBy: null,
      lockedUntil: null,
      lastError: error,
      updatedAt: new Date(),
    })
    .where(claimedCommandWhere(commandId, opts.claim))
    .returning();
  if (!row) return false;
  if (retry) return true;

  // Dead-lettered = this command's work is being ABANDONED. That used to be a
  // console.warn deep in the drain — invisible to alerting while the user's
  // session sat "queued — agent picking up" forever. Make it a real error.
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  logger.error(
    "[session-lifecycle] command dead-lettered — giving up after retries",
    {
      command_id: row.commandId,
      command_type: row.commandType,
      source: row.source,
      project_id: row.projectId,
      account_id: row.accountId,
      session_id: row.sessionId,
      trigger_slug:
        typeof payload.triggerSlug === "string"
          ? payload.triggerSlug
          : undefined,
      idempotency_key: row.idempotencyKey,
      attempts: opts.attempts,
      error,
    },
  );

  if (row.commandType === "continue_session" && row.sessionId) {
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
          status: "failed",
          error: `prompt delivery dead-lettered: ${error}`.slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(projectSessions.sessionId, row.sessionId),
            ne(projectSessions.status, "failed"),
          ),
        );
    } catch (err) {
      console.warn(
        "[session-lifecycle] failed to park session after dead-letter",
        {
          sessionId: row.sessionId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
  return true;
}

export async function renewLifecycleCommandLease(
  commandId: string,
  claim: LifecycleCommandClaim,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(sessionLifecycleCommands)
    .set({
      lockedUntil: new Date(now.getTime() + LIFECYCLE_COMMAND_LEASE_MS),
      updatedAt: now,
    })
    .where(claimedCommandWhere(commandId, claim))
    .returning({ commandId: sessionLifecycleCommands.commandId });
  return rows.length > 0;
}

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
  const rows = await db
    .select()
    .from(sessionLifecycleCommands)
    .where(
      and(
        or(
          eq(sessionLifecycleCommands.status, "queued"),
          and(
            eq(sessionLifecycleCommands.status, "running"),
            lte(sessionLifecycleCommands.lockedUntil, now),
          ),
        ),
        input.idempotencyKey
          ? eq(sessionLifecycleCommands.idempotencyKey, input.idempotencyKey)
          : undefined,
        lte(sessionLifecycleCommands.availableAt, input.availableBefore ?? now),
        or(
          isNull(sessionLifecycleCommands.lockedUntil),
          lte(sessionLifecycleCommands.lockedUntil, now),
        ),
      ),
    )
    .orderBy(
      asc(sessionLifecycleCommands.availableAt),
      asc(sessionLifecycleCommands.createdAt),
    )
    .limit(input.limit);

  const claimed: SessionLifecycleCommandRow[] = [];
  for (const row of rows) {
    const [locked] = await db
      .update(sessionLifecycleCommands)
      .set({
        status: "running",
        attempts: row.attempts + 1,
        lockedBy: input.workerId,
        lockedUntil: new Date(now.getTime() + LIFECYCLE_COMMAND_LEASE_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(sessionLifecycleCommands.commandId, row.commandId),
          or(
            eq(sessionLifecycleCommands.status, "queued"),
            and(
              eq(sessionLifecycleCommands.status, "running"),
              lte(sessionLifecycleCommands.lockedUntil, now),
            ),
          ),
        ),
      )
      .returning();
    if (locked) claimed.push(locked);
  }
  return claimed;
}

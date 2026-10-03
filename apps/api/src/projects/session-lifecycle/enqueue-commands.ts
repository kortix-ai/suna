import { projectSessions, sessionLifecycleCommands } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../../shared/db';
import { LIFECYCLE_CLAIM_LOCK_MS } from './command-lease';
import type { CreateSessionCommand, QueuedCreateSessionPayload, SessionInvocationSource, SessionLifecycleResult } from './types';
import type { PromptOverridesWire, PromptPartWire, QueuedContinueSessionPayload } from './prompt-payload';
type SessionLifecycleCommandRow = typeof sessionLifecycleCommands.$inferSelect;

function createSessionCommandPayload(command: CreateSessionCommand): QueuedCreateSessionPayload {
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
  placement?: 'transcript' | 'composer';
  /** Enqueue HELD — see `enqueueReleasingHold`. Pass `availableAt` with it. */
  held?: boolean;
  parts?: PromptPartWire[];
  overrides?: PromptOverridesWire;
  /** `actorUserId` is the person who sent this prompt — see
   *  `QueuedContinueSessionPayload.bindTurnIdentity`. */
  bindTurnIdentity?: boolean;
  authorSessionId?: string | null;
  noReply?: boolean;
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
    ...(input.placement ? { placement: input.placement } : {}),
    ...(input.overrides ? { overrides: input.overrides } : {}),
    ...(input.bindTurnIdentity ? { bindTurnIdentity: true } : {}),
    ...(input.authorSessionId ? { authorSessionId: input.authorSessionId } : {}),
    ...(input.noReply ? { noReply: true } : {}),
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
    result: input.held ? { held: true } : {},
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
  // Legacy callers retain their existing write path. Handle-bearing prompts
  // atomically commit both the queue row and the storage references.
  if (input.parts?.some((part) => part.attachment_id)) {
    return db.transaction(async (tx) => {
      const [row] = await tx.insert(sessionLifecycleCommands).values(values)
        .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey }).returning();
      if (row) {
        const { bindPromptAttachments } = await import('../prompt-attachments');
        await bindPromptAttachments(tx, row);
        return { row, deduped: false };
      }
      const [existing] = await tx.select().from(sessionLifecycleCommands)
        .where(eq(sessionLifecycleCommands.idempotencyKey, input.idempotencyKey!)).limit(1);
      if (!existing || existing.projectId !== input.projectId || existing.accountId !== input.accountId || existing.actorUserId !== input.actorUserId) throw new Error('Prompt idempotency conflict');
      return { row: existing, deduped: true };
    });
  }
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

/** Load the durable first prompt and every exact runtime message id it used. */
export async function loadLegacyPendingFirstPrompt(sessionId: string): Promise<{
  commandId: string;
  deliveredMessageIds: string[];
  parts: PromptPartWire[];
} | null> {
  const [row] = await db
    .select({
      commandId: sessionLifecycleCommands.commandId,
      payload: sessionLifecycleCommands.payload,
      result: sessionLifecycleCommands.result,
    })
    .from(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.idempotencyKey, `prompt:${sessionId}:pending-first`))
    .limit(1);
  if (!row) return null;

  const payload = row.payload as unknown as QueuedContinueSessionPayload;
  const result = row.result as { forwarded_message_id?: unknown };
  const deliveredMessageIds = [
    result.forwarded_message_id,
    payload.redeliveredMessageId,
    ...(payload.redeliveredMessageIds ?? []).slice().reverse(),
    payload.wireMessageId,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  return {
    commandId: row.commandId,
    deliveredMessageIds: [...new Set(deliveredMessageIds)],
    parts: Array.isArray(payload.parts) ? payload.parts : [],
  };
}

/** Record completion without replacing unrelated session metadata. */
export async function markLegacyInlineAttachmentsRepaired(sessionId: string): Promise<void> {
  await db
    .update(projectSessions)
    .set({
      metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({
        legacy_inline_attachments_repaired_at: new Date().toISOString(),
      })}::jsonb`,
    })
    .where(eq(projectSessions.sessionId, sessionId));
}

/**
 * The row a create claim inserts. An inline create is claimed `running` by
 * THIS process, so it carries the same lock a drained row does: without one,
 * `locked_until` stays NULL, the reclaim arm (`locked_until <= now - grace`)
 * never matches it, and a pod that dies mid-create leaves the idempotency key
 * answering `pending` for ever.
 */
function buildCreateSessionCommandValues(
  command: CreateSessionCommand,
  opts: { initialStatus: 'queued' | 'running'; reason?: string | null },
  now: Date,
) {
  const inlineLock =
    opts.initialStatus === 'running'
      ? {
          // Unique per claim: the lock owner is the lease's fencing token.
          lockedBy: `session-lifecycle-inline:${process.pid}:${randomUUID()}`,
          lockedUntil: new Date(now.getTime() + LIFECYCLE_CLAIM_LOCK_MS),
        }
      : {};
  return {
    commandType: 'create_session',
    source: command.source,
    status: opts.initialStatus,
    ...inlineLock,
    projectId: command.project.projectId,
    accountId: command.project.accountId,
    actorUserId: command.userId,
    idempotencyKey: command.idempotencyKey ?? null,
    payload: createSessionCommandPayload(command) as unknown as Record<string, unknown>,
    result: opts.reason ? { reason: opts.reason } : {},
    availableAt: now,
    updatedAt: now,
  };
}

export async function claimCreateSessionCommand(
  command: CreateSessionCommand,
  opts: { initialStatus: 'queued' | 'running'; reason?: string | null },
): Promise<{ row: SessionLifecycleCommandRow; existing: boolean }> {
  const values = buildCreateSessionCommandValues(command, opts, new Date());

  if (!command.idempotencyKey) {
    const pending = command.body.pending_prompt as { parts?: PromptPartWire[] } | undefined;
    if (pending?.parts?.some((part) => part.attachment_id)) {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(sessionLifecycleCommands).values(values).returning();
        const { bindPromptAttachments } = await import('../prompt-attachments');
        await bindPromptAttachments(tx, row);
        return { row, existing: false };
      });
    }
    const [row] = await db.insert(sessionLifecycleCommands).values(values).returning();
    return { row, existing: false };
  }

  const pending = command.body.pending_prompt as { parts?: PromptPartWire[] } | undefined;
  if (pending?.parts?.some((part) => part.attachment_id)) {
    return db.transaction(async (tx) => {
      const [row] = await tx.insert(sessionLifecycleCommands).values(values)
        .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey }).returning();
      if (row) {
        const { bindPromptAttachments } = await import('../prompt-attachments');
        await bindPromptAttachments(tx, row);
        return { row, existing: false };
      }
      const [existing] = await tx.select().from(sessionLifecycleCommands)
        .where(eq(sessionLifecycleCommands.idempotencyKey, command.idempotencyKey!)).limit(1);
      if (!existing) throw new Error('Create command idempotency conflict');
      return { row: existing, existing: true };
    });
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
      ? { status: 500 as const, body: { error: row.lastError } }
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

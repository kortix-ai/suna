import { sessionLifecycleCommands } from '@kortix/db';
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import { db } from '../../shared/db';
import type {
  CreateSessionCommand,
  QueuedCreateSessionPayload,
  SessionLifecycleResult,
} from './types';

export type SessionLifecycleCommandRow = typeof sessionLifecycleCommands.$inferSelect;

export function createSessionCommandPayload(command: CreateSessionCommand): QueuedCreateSessionPayload {
  return {
    body: command.body,
    metadata: command.metadata,
    extraEnvVars: command.extraEnvVars,
    visibility: command.visibility,
    enforceAccountCap: command.enforceAccountCap,
    postCreate: command.postCreate,
  };
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
  await db
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
    .where(eq(sessionLifecycleCommands.commandId, commandId));
}

export async function claimDueLifecycleCommands(input: {
  workerId: string;
  limit: number;
  now?: Date;
}): Promise<SessionLifecycleCommandRow[]> {
  const now = input.now ?? new Date();
  const rows = await db
    .select()
    .from(sessionLifecycleCommands)
    .where(
      and(
        eq(sessionLifecycleCommands.status, 'queued'),
        lte(sessionLifecycleCommands.availableAt, now),
        or(isNull(sessionLifecycleCommands.lockedUntil), lte(sessionLifecycleCommands.lockedUntil, now)),
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
      .where(
        and(
          eq(sessionLifecycleCommands.commandId, row.commandId),
          eq(sessionLifecycleCommands.status, 'queued'),
        ),
      )
      .returning();
    if (locked) claimed.push(locked);
  }
  return claimed;
}

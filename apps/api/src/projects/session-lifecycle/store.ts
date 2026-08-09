import type { Database } from '@kortix/db';
import {
  accountTokens,
  projectGoalEvaluations,
  projectSessions,
  projectTasks,
  sessionLifecycleCommands,
} from '@kortix/db/schema';
import { AGI_AGENT_NAME } from '@kortix/shared';
import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import type {
  CreateSessionCommand,
  QueuedCreateSessionPayload,
  SessionInvocationSource,
  SessionLifecycleResult,
} from './types';
import { normalizeOpenCodeMessageId } from './opencode-message-id';

export type SessionLifecycleCommandRow = typeof sessionLifecycleCommands.$inferSelect;

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
  row: Pick<SessionLifecycleCommandRow, 'lockedBy' | 'attempts'>,
): LifecycleCommandClaim {
  if (!row.lockedBy) throw new Error('Claimed lifecycle command is missing lock owner');
  return { lockedBy: row.lockedBy, attempt: row.attempts };
}

function claimedCommandWhere(commandId: string, claim?: LifecycleCommandClaim) {
  return claim
    ? and(
        eq(sessionLifecycleCommands.commandId, commandId),
        eq(sessionLifecycleCommands.status, 'running'),
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
    platformAgiGoalPush: command.platformAgiGoalPush,
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

export interface EnqueueCreateSessionLifecycleCommandInput {
  source: SessionInvocationSource;
  projectId: string;
  accountId: string;
  actorUserId: string | null;
  idempotencyKey: string;
  payload: QueuedCreateSessionPayload;
}

/** Queue one server-owned create command without inventing a human actor. */
export async function enqueueCreateSessionLifecycleCommand(
  database: Database,
  input: EnqueueCreateSessionLifecycleCommandInput,
): Promise<{ row: SessionLifecycleCommandRow; existing: boolean }> {
  const now = new Date();
  const values = {
    commandType: 'create_session',
    source: input.source,
    status: 'queued' as const,
    projectId: input.projectId,
    accountId: input.accountId,
    actorUserId: input.actorUserId,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload as unknown as Record<string, unknown>,
    result: {},
    availableAt: now,
    updatedAt: now,
  };
  const [created] = await database
    .insert(sessionLifecycleCommands)
    .values(values)
    .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey })
    .returning();
  if (created) return { row: created, existing: false };

  const [existing] = await database
    .select()
    .from(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (!existing) {
    throw new Error(`Create command ${input.idempotencyKey} conflicted but could not be loaded`);
  }
  if (
    existing.commandType !== 'create_session' ||
    existing.projectId !== input.projectId ||
    existing.accountId !== input.accountId
  ) {
    throw new Error(
      `Create command idempotency key ${input.idempotencyKey} belongs to another job`,
    );
  }
  return { row: existing, existing: true };
}

/** Build one durable callback row. Exported for transaction-bound outbox writes. */
export function buildContinueSessionCommandValues(input: EnqueueContinueSessionCommandInput) {
  const now = new Date();
  const payload: QueuedContinueSessionPayload = {
    text: input.text,
    messageId: input.messageId ?? null,
    executionId: input.executionId ?? null,
    triggerSlug: input.triggerSlug ?? null,
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

export type ClaimReadyTaskPostCreateResult =
  | {
      ok: true;
      deduped: boolean;
      promptCommandId: string;
    }
  | {
      ok: false;
      code: 'TASK_READY_STALE';
      retryable: false;
      error: string;
    };

/**
 * Claim a ready task for a newly-created AGI coordinator and persist its first
 * prompt in the same transaction. A replay performs no second task update and
 * converges on the same prompt command.
 */
export async function claimReadyTaskAndEnqueuePrompt(
  database: Database,
  input: {
    projectId: string;
    taskId: string;
    sessionId: string;
    leaseSeconds: number;
    prompt: string;
    now?: Date;
  },
): Promise<ClaimReadyTaskPostCreateResult> {
  if (!Number.isSafeInteger(input.leaseSeconds) || input.leaseSeconds <= 0) {
    throw new RangeError('leaseSeconds must be a positive safe integer');
  }
  if (!input.prompt.trim()) throw new RangeError('prompt must not be empty');
  const now = input.now ?? new Date();
  const claimExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1_000);
  const promptIdempotencyKey =
    `task-ready-prompt:${input.projectId}:${input.taskId}:${input.sessionId}`;
  const promptMessageId = normalizeOpenCodeMessageId(promptIdempotencyKey);
  const stale = (error: string): ClaimReadyTaskPostCreateResult => ({
    ok: false,
    code: 'TASK_READY_STALE',
    retryable: false,
    error,
  });

  try {
    return await database.transaction(async (tx) => {
      // The session row serializes coordinator ownership across different task rows.
      await tx.execute(sql`select session_id from ${projectSessions}
        where project_id = ${input.projectId} and session_id = ${input.sessionId}
        for update`);
      const [session] = await tx
        .select()
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.projectId, input.projectId),
            eq(projectSessions.sessionId, input.sessionId),
          ),
        )
        .limit(1);
      const sessionMetadata = (session?.metadata ?? {}) as Record<string, unknown>;
      if (
        !session ||
        session.agentName !== AGI_AGENT_NAME ||
        typeof sessionMetadata.deletedAt === 'string' ||
        typeof sessionMetadata.spawned_by_session === 'string'
      ) {
        return stale('ready task requires a live AGI coordinator in the same project');
      }

      await tx.execute(sql`select task_id from ${projectTasks}
        where project_id = ${input.projectId} and task_id = ${input.taskId}
        for update`);
      const [task] = await tx
        .select()
        .from(projectTasks)
        .where(
          and(eq(projectTasks.projectId, input.projectId), eq(projectTasks.taskId, input.taskId)),
        )
        .limit(1);
      if (!task) return stale('ready task no longer exists');

      const replay =
        task.claimSessionId === input.sessionId &&
        ['doing', 'review', 'done'].includes(task.status);
      if (!replay) {
        const [claimed] = await tx
          .update(projectTasks)
          .set({
            status: 'doing',
            claimSessionId: input.sessionId,
            claimedAt: now,
            claimExpiresAt,
            updatedAt: now,
          })
          .where(
            and(
              eq(projectTasks.projectId, input.projectId),
              eq(projectTasks.taskId, input.taskId),
              eq(projectTasks.status, 'todo'),
              isNull(projectTasks.claimSessionId),
              sql`(${projectTasks.assigneeAgent} is null or ${projectTasks.assigneeAgent} = ${session.agentName})`,
              sql`(${projectTasks.assigneeUserId} is null or ${projectTasks.assigneeUserId} = ${session.createdBy})`,
              sql`not exists (
                select 1 from ${projectTasks} active_claim
                where active_claim.project_id = ${input.projectId}
                  and active_claim.claim_session_id = ${input.sessionId}
                  and active_claim.status in (
                    'doing'::kortix.project_task_status,
                    'review'::kortix.project_task_status
                  )
                  and active_claim.task_id <> ${input.taskId}
              )`,
              sql`not exists (
                select 1
                from unnest(${projectTasks.blockedBy}) blocker(task_id)
                left join ${projectTasks} dependency
                  on dependency.project_id = ${input.projectId}
                 and dependency.task_id = blocker.task_id
                where dependency.status is distinct from 'done'::kortix.project_task_status
              )`,
            ),
          )
          .returning({ taskId: projectTasks.taskId });
        if (!claimed) {
          return stale(
            'ready task was claimed, blocked, reassigned, or changed before session creation',
          );
        }
      }

      const values = buildContinueSessionCommandValues({
        source: 'system:task-ready-reconciler',
        projectId: input.projectId,
        accountId: session.accountId,
        sessionId: input.sessionId,
        actorUserId: session.createdBy,
        text: input.prompt,
        messageId: promptMessageId,
        triggerSlug: 'task-ready-reconciler',
        idempotencyKey: promptIdempotencyKey,
      });
      const [created] = await tx
        .insert(sessionLifecycleCommands)
        .values(values)
        .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey })
        .returning({ commandId: sessionLifecycleCommands.commandId });
      const [promptCommand] = created
        ? [created]
        : await tx
            .select({
              commandId: sessionLifecycleCommands.commandId,
              commandType: sessionLifecycleCommands.commandType,
              projectId: sessionLifecycleCommands.projectId,
              sessionId: sessionLifecycleCommands.sessionId,
            })
            .from(sessionLifecycleCommands)
            .where(eq(sessionLifecycleCommands.idempotencyKey, promptIdempotencyKey))
            .limit(1);
      if (
        !promptCommand ||
        ('commandType' in promptCommand && promptCommand.commandType !== 'continue_session') ||
        ('projectId' in promptCommand && promptCommand.projectId !== input.projectId) ||
        ('sessionId' in promptCommand && promptCommand.sessionId !== input.sessionId)
      ) {
        throw new Error('ready-task prompt idempotency key belongs to another delivery');
      }
      return {
        ok: true,
        deduped: !created,
        promptCommandId: promptCommand.commandId,
      };
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code === '23505') {
      return stale('ready task lost a concurrent claim race');
    }
    throw error;
  }
}

/**
 * Retire an AGI coordinator that lost the ready-task claim race. The database
 * revokes authority before the typed stale error returns. Provider teardown is
 * durable through the existing lifecycle outbox.
 */
export async function retireStaleReadyTaskCoordinator(
  database: Database,
  input: { projectId: string; sessionId: string; reason: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  return database.transaction(async (tx) => {
    await tx.execute(sql`select session_id from ${projectSessions}
      where project_id = ${input.projectId} and session_id = ${input.sessionId}
      for update`);
    const [session] = await tx
      .select()
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.projectId, input.projectId),
          eq(projectSessions.sessionId, input.sessionId),
        ),
      )
      .limit(1);
    const metadata = (session?.metadata ?? {}) as Record<string, unknown>;
    if (
      !session ||
      session.agentName !== AGI_AGENT_NAME ||
      metadata.task_ready_reconciler !== true
    ) {
      return false;
    }

    await tx
      .update(accountTokens)
      .set({ status: 'revoked', revokedAt: now })
      .where(
        and(
          eq(accountTokens.accountId, session.accountId),
          eq(accountTokens.sessionId, input.sessionId),
          eq(accountTokens.status, 'active'),
        ),
      );
    await tx
      .update(projectSessions)
      .set({
        status: 'stopped',
        metadata: {
          ...metadata,
          deletedAt: now.toISOString(),
          deletedBy: 'system:task-ready-reconciler',
          taskReadyRetiredReason: input.reason,
        },
        updatedAt: now,
      })
      .where(
        and(
          eq(projectSessions.projectId, input.projectId),
          eq(projectSessions.sessionId, input.sessionId),
        ),
      );
    await tx
      .insert(sessionLifecycleCommands)
      .values({
        commandType: 'stop_session',
        source: 'system:task-ready-reconciler',
        status: 'queued',
        projectId: input.projectId,
        accountId: session.accountId,
        sessionId: input.sessionId,
        idempotencyKey: `task-ready-stale-stop:${input.projectId}:${input.sessionId}`,
        payload: { reason: input.reason },
        result: {},
        availableAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
    return true;
  });
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
        when ${sessionLifecycleCommands.status} = 'dead_lettered' then ${now.toISOString()}::timestamptz
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
        eq(sessionLifecycleCommands.commandType, 'continue_session'),
        inArray(sessionLifecycleCommands.status, ['queued', 'dead_lettered']),
        sql`${sessionLifecycleCommands.payload}->>'messageId' is not null`,
        sql`left(${sessionLifecycleCommands.payload}->>'messageId', 3) <> 'msg'`,
      ),
    )
    .returning({ commandId: sessionLifecycleCommands.commandId });
  return repaired.length;
}

export async function enqueueContinueSessionCommand(
  input: EnqueueContinueSessionCommandInput,
): Promise<{
  commandId: string;
  commandType: 'continue_session';
  projectId: string;
  sessionId: string;
  status: SessionLifecycleCommandRow['status'];
  deduped: boolean;
}> {
  const values = buildContinueSessionCommandValues(input);
  if (!input.idempotencyKey) {
    const [created] = await db.insert(sessionLifecycleCommands).values(values).returning({
      commandId: sessionLifecycleCommands.commandId,
      commandType: sessionLifecycleCommands.commandType,
      projectId: sessionLifecycleCommands.projectId,
      sessionId: sessionLifecycleCommands.sessionId,
      status: sessionLifecycleCommands.status,
    });
    if (!created) throw new Error('continue-session command insert returned no row');
    return {
      ...created,
      commandType: 'continue_session',
      projectId: input.projectId,
      sessionId: input.sessionId,
      deduped: false,
    };
  }
  const [created] = await db
    .insert(sessionLifecycleCommands)
    .values(values)
    .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey })
    .returning({
      commandId: sessionLifecycleCommands.commandId,
      commandType: sessionLifecycleCommands.commandType,
      projectId: sessionLifecycleCommands.projectId,
      sessionId: sessionLifecycleCommands.sessionId,
      status: sessionLifecycleCommands.status,
    });
  if (created) {
    return {
      ...created,
      commandType: 'continue_session',
      projectId: input.projectId,
      sessionId: input.sessionId,
      deduped: false,
    };
  }
  const [existing] = await db
    .select({
      commandId: sessionLifecycleCommands.commandId,
      commandType: sessionLifecycleCommands.commandType,
      projectId: sessionLifecycleCommands.projectId,
      sessionId: sessionLifecycleCommands.sessionId,
      status: sessionLifecycleCommands.status,
    })
    .from(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (!existing) throw new Error('continue-session command idempotency lookup returned no row');
  if (
    existing.commandType !== 'continue_session' ||
    existing.projectId !== input.projectId ||
    !existing.sessionId
  ) {
    throw new Error('continue-session idempotency key belongs to another delivery');
  }
  return {
    ...existing,
    commandType: 'continue_session',
    sessionId: existing.sessionId,
    deduped: true,
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
    throw new Error(
      `Idempotent command ${command.idempotencyKey} conflicted but could not be loaded`,
    );
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
    typeof row.lastError === 'string' ? { status: 500, body: { error: row.lastError } } : undefined;

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
  claim?: LifecycleCommandClaim,
): Promise<boolean> {
  const rows = await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'queued',
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
      status: 'queued',
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
  const now = new Date();
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(sessionLifecycleCommands)
      .set({
        status: 'succeeded',
        sessionId: sessionId ?? null,
        result,
        lockedBy: null,
        lockedUntil: null,
        updatedAt: now,
      })
      .where(claimedCommandWhere(commandId, claim))
      .returning({ commandId: sessionLifecycleCommands.commandId });
    if (rows.length === 0) return false;
    await tx
      .update(projectGoalEvaluations)
      .set({
        state: 'fired',
        firedAt: now,
        ...(sessionId === undefined ? {} : { sessionId }),
        updatedAt: now,
      })
      .where(
        and(
          eq(projectGoalEvaluations.lifecycleCommandId, commandId),
          eq(projectGoalEvaluations.state, 'queued'),
        ),
      );
    return true;
  });
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
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(sessionLifecycleCommands)
      .set({
        status: retry ? 'queued' : 'dead_lettered',
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.result ? { result: opts.result } : {}),
        attempts: opts.attempts,
        availableAt: new Date(now.getTime() + Math.min(60_000, 2_000 * Math.max(opts.attempts, 1))),
        lockedBy: null,
        lockedUntil: null,
        lastError: error,
        updatedAt: now,
      })
      .where(claimedCommandWhere(commandId, opts.claim))
      .returning();
    if (updated && !retry) {
      await tx
        .update(projectGoalEvaluations)
        .set({ state: 'failed', firedAt: null, updatedAt: now })
        .where(
          and(
            eq(projectGoalEvaluations.lifecycleCommandId, commandId),
            eq(projectGoalEvaluations.state, 'queued'),
          ),
        );
    }
    return updated;
  });
  if (!row) return false;
  if (retry) return true;

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

  if (row.commandType === 'continue_session' && row.sessionId) {
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
          eq(sessionLifecycleCommands.status, 'queued'),
          and(
            eq(sessionLifecycleCommands.status, 'running'),
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
        lockedUntil: new Date(now.getTime() + LIFECYCLE_COMMAND_LEASE_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(sessionLifecycleCommands.commandId, row.commandId),
          or(
            eq(sessionLifecycleCommands.status, 'queued'),
            and(
              eq(sessionLifecycleCommands.status, 'running'),
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

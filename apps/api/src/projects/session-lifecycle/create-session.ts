/**
 * Create a session: inline, or as a durable `create_session` command that the
 * drain executes, followed by the command's post-create actions.
 */

import { projectSessions, projects, serviceAccounts } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { bindChatThread } from '../../channels/core/threads';
import { logger } from '../../lib/logger';
import { mayRequeueFailedCreate } from './requeue-policy';
import { db } from '../../shared/db';
import { connectorBindingPayloadConflicts } from '../lib/session-connector-bindings';
import { secretsAllowlistPayloadConflicts } from '../secrets';
import { providerPoolConflicts, runtimeContextConflicts } from './idempotency-conflicts';
import { createProjectSession } from '../lib/sessions';
import { applyTriggerSessionAccess } from '../trigger-session-access';
import { resolveProjectAutomationActor } from './actor';
import { sessionBackpressureState } from './backpressure';
import {
  type SessionLifecycleCommandRow,
  claimCreateSessionCommand,
  markCommandFailed,
  markCommandQueued,
  markCommandSucceeded,
  resultFromExistingCommand,
} from './store';
import { crossAccountIdempotencyResult } from './idempotency-guard';
import { withCommandLeaseHeartbeat } from './command-lease';
import type {
  CreateSessionCommand,
  QueuedCreateSessionPayload,
  SessionLifecyclePostCreateAction,
  SessionLifecycleResult,
} from './types';
import { deliverThroughQueue } from './follow-up-delivery';
import { drainSessionLifecycleQueue } from './drain';

export async function createSession(
  command: CreateSessionCommand,
): Promise<SessionLifecycleResult> {
  const queuePolicy = command.queuePolicy ?? 'never';
  const backpressure =
    queuePolicy === 'never'
      ? null
      : await sessionBackpressureState(command.project.projectId);
  const shouldQueue =
    queuePolicy === 'always' || (queuePolicy === 'on_backpressure' && backpressure?.shouldQueue);
  const reason = shouldQueue ? (backpressure?.reason ?? 'queued by policy') : null;

  if (!command.idempotencyKey && !shouldQueue) {
    const result = await executeCreateSession(command);
    if (result.status === 'created' && result.sessionId) {
      const postCreate = await applyPostCreateActions({
        projectId: command.project.projectId,
        sessionId: result.sessionId,
        actions: command.postCreate,
      });
      if (!postCreate.ok) {
        return {
          status: 'failed',
          sessionId: result.sessionId,
          row: result.row,
          retryable: false,
          error: { status: 500, body: { error: postCreate.error } },
        };
      }
    }
    return result;
  }

  const claimed = await claimCreateSessionCommand(command, {
    initialStatus: shouldQueue ? 'queued' : 'running',
    reason,
  });
  if (claimed.existing) {
    // Cross-tenant guard: a colliding idempotency key that is not the caller's
    // OWN create_session for this account+project must never return the foreign
    // command/session — see crossAccountIdempotencyResult.
    const crossAccount = crossAccountIdempotencyResult(
      {
        accountId: claimed.row.accountId,
        projectId: claimed.row.projectId,
        commandType: claimed.row.commandType,
      },
      { accountId: command.project.accountId, projectId: command.project.projectId },
    );
    if (crossAccount) return crossAccount;
    const existingPayload = (claimed.row.payload ?? {}) as Record<string, unknown>;
    const existingBody =
      existingPayload.body && typeof existingPayload.body === 'object'
        ? (existingPayload.body as Record<string, unknown>)
        : {};
    const conflicts = [
      [() => connectorBindingPayloadConflicts(existingBody.connector_bindings, command.body.connector_bindings), 'IDEMPOTENCY_BINDING_CONFLICT', 'different connector bindings'],
      [() => providerPoolConflicts(existingBody.provider_secret_pools, command.body.provider_secret_pools), 'IDEMPOTENCY_PROVIDER_POOL_CONFLICT', 'different provider secret pools'],
      [() => secretsAllowlistPayloadConflicts(existingBody.secrets as string[] | null | undefined, command.body.secrets as string[] | null | undefined), 'IDEMPOTENCY_SECRETS_CONFLICT', 'a different secrets allowlist'],
      [() => runtimeContextConflicts(existingBody.runtime_context, command.body.runtime_context), 'IDEMPOTENCY_CONTEXT_CONFLICT', 'a different runtime_context'],
    ] as const;
    for (const [hasConflict, code, suffix] of conflicts) {
      if (hasConflict()) {
        return {
          status: 'failed', commandId: claimed.row.commandId, retryable: false,
          error: { status: 409, body: { error: `Idempotency key was already used with ${suffix}`, code } },
        };
      }
    }
    const existingResult = resultFromExistingCommand(claimed.row);
    if (existingResult.sessionId) {
      const [row] = await db
        .select()
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, existingResult.sessionId))
        .limit(1);
      if (row) {
        // A soft-deleted session is gone — deleteSession() stamps
        // metadata.deletedAt and leaves status 'stopped'. Handing the tombstone
        // back as a create "success" poisons the key forever (every follow-up
        // continueSession → no-session). Treat it as spent: 409, use a new key.
        const rowMeta = (row.metadata ?? {}) as Record<string, unknown>;
        if (typeof rowMeta.deletedAt === 'string') {
          return {
            status: 'failed',
            commandId: claimed.row.commandId,
            retryable: false,
            error: {
              status: 409,
              body: {
                error: 'Idempotency key maps to a deleted session — use a new key',
                code: 'IDEMPOTENCY_KEY_SESSION_DELETED',
              },
            },
          };
        }
        existingResult.row = row;
      }
    }
    return existingResult;
  }
  if (shouldQueue) {
    await markCommandQueued(claimed.row.commandId, reason);
    return {
      status: 'queued',
      commandId: claimed.row.commandId,
      retryable: true,
      reason: reason ?? undefined,
    };
  }

  // The create can take a while: a provider create, then a first prompt
  // delivered into the new session. The lease is renewed for as long as it
  // runs, so the drain never reclaims a row this request still holds.
  return withCommandLeaseHeartbeat(claimed.row, () => runInlineCreate(command, claimed.row));
}

/** The inline create, under the lease `claimCreateSessionCommand` returned. */
async function runInlineCreate(
  command: CreateSessionCommand,
  row: SessionLifecycleCommandRow,
): Promise<SessionLifecycleResult> {
  let result: SessionLifecycleResult;
  try {
    result = await executeCreateSession({
      ...command,
      attachmentSourceCommandId: row.commandId,
      createCommandId: row.commandId,
    });
  } catch (err) {
    // `executeCreateSession` -> `createProjectSession` ->
    // `loadProjectAgents({ rethrowReadErrors: true })` -> `refreshMirror` can
    // THROW a `GitOperationError` (e.g. a cold `git clone --bare` that times
    // out, `git/mirror.ts`) rather than return `{ error }`. This inline path
    // holds a REAL lease on `row` (`claimCreateSessionCommand` set
    // `lockedBy`/`lockedUntil` so the drain's reclaim arm can take the row
    // over if this pod dies mid-create — c30b60d038). Left uncaught, the
    // throw skipped `markCommandFailed`: the row sat `running` under that
    // lease for the full lock period before the drain's abandoned-claim
    // reclaim even saw it, and — until the `drain.ts` create_session branch
    // was ALSO hardened — retried the same doomed clone forever afterward.
    // Finalize here instead: the caller gets a structured retryable error
    // immediately, and the row is queued for backoff / dead-lettered per the
    // normal 5-attempt budget rather than left dangling on a lease.
    const message = err instanceof Error ? err.message : String(err);
    await markCommandFailed(row, message, {
      retryable: true,
      attempts: row.attempts + 1,
    });
    return {
      status: 'failed',
      commandId: row.commandId,
      retryable: true,
      error: { status: 503, body: { error: message } },
    };
  }
  if (result.status === 'created' && result.sessionId) {
    const postCreate = await applyPostCreateActions({
      projectId: command.project.projectId,
      sessionId: result.sessionId,
      actions: command.postCreate,
      commandId: row.commandId,
    });
    if (!postCreate.ok) {
      await markCommandFailed(row, postCreate.error, {
        retryable: true,
        attempts: row.attempts + 1,
        sessionId: result.sessionId,
        result: {
          status: 'created',
          session_id: result.sessionId,
          source: command.source,
          post_create_error: postCreate.error,
        },
      });
      return {
        status: 'failed',
        commandId: row.commandId,
        sessionId: result.sessionId,
        row: result.row,
        retryable: true,
        error: { status: 500, body: { error: postCreate.error } },
      };
    }
    await markCommandSucceeded(
      row,
      {
        status: 'created',
        session_id: result.sessionId,
        source: command.source,
      },
      result.sessionId,
    );
    return { ...result, commandId: row.commandId };
  }

  const message = String(result.error?.body?.error ?? result.reason ?? 'Failed to create session');
  // This is the INLINE path — the queued branch returned above — so `result` is
  // about to be handed to a waiting caller. Marking it retryable would leave the
  // command row queued for the drainer as well, and the caller (told by the
  // guide that a 429/503 is worth retrying) retries with a fresh key: two billed
  // sandboxes for one intent, both running initial_prompt.
  await markCommandFailed(row, message, {
    retryable: mayRequeueFailedCreate({
      answeredSynchronously: true,
      errorIsRetryable: result.retryable ?? false,
    }),
    attempts: row.attempts + 1,
  });
  return { ...result, commandId: row.commandId };
}

export async function executeQueuedCreate(
  row: SessionLifecycleCommandRow,
): Promise<SessionLifecycleResult> {
  const payload = row.payload as unknown as QueuedCreateSessionPayload;
  if (row.sessionId) {
    const [session] = await db
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, row.sessionId))
      .limit(1);
    if (session) {
      return {
        status: 'created',
        commandId: row.commandId,
        sessionId: row.sessionId,
        row: session,
        retryable: true,
      };
    }
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, row.projectId))
    .limit(1);
  if (!project) {
    return {
      status: 'failed',
      commandId: row.commandId,
      retryable: false,
      error: { status: 404, body: { error: 'Project not found' } },
    };
  }
  const userId = row.actorUserId ?? (await resolveProjectAutomationActor(project.accountId));
  if (!userId) {
    return {
      status: 'failed',
      commandId: row.commandId,
      retryable: false,
      error: { status: 409, body: { error: 'No account owner available to own the session' } },
    };
  }
  let requestingPrincipalType = payload.requestingPrincipalType;
  if (requestingPrincipalType !== 'human' && requestingPrincipalType !== 'service_account') {
    const [serviceAccount] = row.actorUserId
      ? await db
          .select({ serviceAccountId: serviceAccounts.serviceAccountId })
          .from(serviceAccounts)
          .where(
            and(
              eq(serviceAccounts.serviceAccountId, row.actorUserId),
              eq(serviceAccounts.accountId, project.accountId),
            ),
          )
          .limit(1)
      : [];
    requestingPrincipalType = serviceAccount ? 'service_account' : 'human';
  }
  return executeCreateSession({
    attachmentSourceCommandId: row.commandId,
    createCommandId: row.commandId,
    source: row.source as CreateSessionCommand['source'],
    project,
    userId,
    requestingPrincipalType,
    body: payload.body ?? {},
    metadata: payload.metadata,
    extraEnvVars: payload.extraEnvVars,
    visibility: payload.visibility,
    mayManageSystemConnections: payload.mayManageSystemConnections,
    queuePolicy: 'never',
    postCreate: payload.postCreate,
    // Replay the origin-derivation signals captured at enqueue time so a
    // queued backend create keeps origin 'backend'.
    authType: payload.authType,
    apiKeyType: payload.apiKeyType,
    inSession: payload.inSession,
    callerSessionId: payload.callerSessionId,
  });
}

async function executeCreateSession(
  command: CreateSessionCommand,
): Promise<SessionLifecycleResult> {
  // A deleted workspace starts no session (KRTX-1714). Every create path meets
  // here, and the chat channels load the project by id with no status filter.
  if (command.project.status === 'archived') {
    return {
      status: 'failed',
      retryable: false,
      error: { status: 404, body: { error: 'This workspace was deleted', code: 'project_archived' } },
    };
  }
  const metadata = {
    source: command.source,
    ...(command.metadata ?? {}),
  };
  const result = await createProjectSession({
    attachmentSourceCommandId: command.attachmentSourceCommandId,
    createCommandId: command.createCommandId,
    project: command.project,
    userId: command.userId,
    requestingPrincipalType: command.requestingPrincipalType,
    body: command.body,
    metadata,
    extraEnvVars: command.extraEnvVars,
    request: command.request,
    visibility: command.visibility,
    authType: command.authType,
    apiKeyType: command.apiKeyType,
    inSession: command.inSession,
    callerSessionId: command.callerSessionId,
    mayManageSystemConnections: command.mayManageSystemConnections,
  });

  if (result.error) {
    return {
      status: 'failed',
      error: result.error,
      retryable: isRetryableCreateError(result.error.status),
    };
  }
  if (result.pendingPromptIdempotencyKey) {
    void drainSessionLifecycleQueue({
      idempotencyKey: result.pendingPromptIdempotencyKey,
    }).catch((error) => {
      logger.error('[session-lifecycle] first prompt targeted drain failed', {
        sessionId: result.row!.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return {
    status: 'created',
    sessionId: result.row!.sessionId,
    row: result.row,
    retryable: true,
  };
}

export async function applyPostCreateActions(input: {
  projectId: string;
  sessionId: string;
  actions?: SessionLifecyclePostCreateAction[];
  // ponytail: unused since `deliver_prompt` is a queue row keyed by the session
  // (`post-create:<sessionId>`); drop it with its two call sites.
  commandId?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.actions?.length) return { ok: true };
  try {
    for (const action of input.actions) {
      if (action.type === 'bind_chat_thread') {
        await bindChatThread({
          projectId: input.projectId,
          platform: action.platform,
          workspaceId: action.workspaceId,
          threadId: action.threadId,
          sessionId: input.sessionId,
        });
      } else if (action.type === 'deliver_prompt') {
        // One initial prompt per session: a retried create dedupes on the key.
        const outcome = await deliverThroughQueue({
          source: action.source,
          idempotencyKey: `post-create:${input.sessionId}`,
          sessionId: input.sessionId,
          text: action.text,
          userId: action.userId ?? undefined,
        });
        if (outcome !== 'delivered' && outcome !== 'queued') {
          return { ok: false, error: `initial prompt delivery ${outcome}` };
        }
      } else if (action.type === 'apply_trigger_session_access') {
        await applyTriggerSessionAccess({
          projectId: input.projectId,
          sessionId: input.sessionId,
          triggerSlug: action.triggerSlug,
        });
      }
    }
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn('[session-lifecycle] post-create action failed', {
      sessionId: input.sessionId,
      error,
    });
    return { ok: false, error };
  }
}

export function isRetryableCreateError(status?: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

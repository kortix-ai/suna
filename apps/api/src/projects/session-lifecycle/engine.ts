import { eq } from 'drizzle-orm';
import { chatThreads, projects, projectSessions } from '@kortix/db';
import { config } from '../../config';
import { forwardToSandbox } from '../../sandbox-proxy/routes/preview';
import { db } from '../../shared/db';
import { createProjectSession } from '../lib/sessions';
import { openSession } from '../routes/shared';
import { awaitTerminalStage } from './await-stage';
import { resolveProjectAutomationActor } from './actor';
import { sessionBackpressureState } from './backpressure';
import {
  claimCreateSessionCommand,
  claimDueLifecycleCommands,
  markCommandFailed,
  markCommandQueued,
  markCommandSucceeded,
  resultFromExistingCommand,
  type SessionLifecycleCommandRow,
} from './store';
import type {
  ContinueSessionCommand,
  CreateSessionCommand,
  QueuedCreateSessionPayload,
  SessionDeliveryOutcome,
  SessionLifecyclePostCreateAction,
  SessionLifecycleResult,
  StartSessionCommand,
} from './types';

const WORKSPACE = '/workspace';
const DAEMON_PORT = 8000;
const READY_DEADLINE_MS = 300_000;
const POLL_INTERVAL_MS = 3_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createSession(command: CreateSessionCommand): Promise<SessionLifecycleResult> {
  const queuePolicy = command.queuePolicy ?? 'never';
  const backpressure =
    queuePolicy === 'never'
      ? null
      : await sessionBackpressureState(command.project.accountId, command.project.projectId);
  const shouldQueue =
    queuePolicy === 'always' || (queuePolicy === 'on_backpressure' && backpressure?.shouldQueue);
  const reason = shouldQueue ? backpressure?.reason ?? 'queued by policy' : null;

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
    const existingResult = resultFromExistingCommand(claimed.row);
    if (existingResult.sessionId) {
      const [row] = await db
        .select()
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, existingResult.sessionId))
        .limit(1);
      if (row) existingResult.row = row;
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

  const result = await executeCreateSession(command);
  if (result.status === 'created' && result.sessionId) {
    const postCreate = await applyPostCreateActions({
      projectId: command.project.projectId,
      sessionId: result.sessionId,
      actions: command.postCreate,
    });
    if (!postCreate.ok) {
      await markCommandFailed(claimed.row.commandId, postCreate.error, {
        retryable: true,
        attempts: claimed.row.attempts + 1,
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
        commandId: claimed.row.commandId,
        sessionId: result.sessionId,
        row: result.row,
        retryable: true,
        error: { status: 500, body: { error: postCreate.error } },
      };
    }
    await markCommandSucceeded(
      claimed.row.commandId,
      {
        status: 'created',
        session_id: result.sessionId,
        source: command.source,
      },
      result.sessionId,
    );
    return { ...result, commandId: claimed.row.commandId };
  }

  const message = String(result.error?.body?.error ?? result.reason ?? 'Failed to create session');
  await markCommandFailed(claimed.row.commandId, message, {
    retryable: result.retryable ?? false,
    attempts: claimed.row.attempts + 1,
  });
  return { ...result, commandId: claimed.row.commandId };
}

export async function startSession(command: StartSessionCommand) {
  const first = await openSession({
    loaded: command.loaded,
    visible: command.visible,
    projectId: command.projectId,
    sessionId: command.sessionId,
  });
  // Optional long-poll: re-resolve (re-reading the live session row each tick,
  // like continueSession) until ready/terminal or the bounded deadline, so the
  // client learns `ready` immediately instead of on its ~800ms poll tick.
  // waitMs<=0 or an already-terminal first result → returns `first` unchanged,
  // so the warm-claim fast path and every non-long-poll caller are untouched.
  const start = await awaitTerminalStage(
    first,
    async () => {
      const [fresh] = await db
        .select({
          status: projectSessions.status,
          sandboxProvider: projectSessions.sandboxProvider,
          baseRef: projectSessions.baseRef,
          agentName: projectSessions.agentName,
          opencodeSessionId: projectSessions.opencodeSessionId,
          accountId: projectSessions.accountId,
          metadata: projectSessions.metadata,
        })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, command.sessionId))
        .limit(1);
      if (!fresh) return null;
      return openSession({
        loaded: command.loaded,
        visible: { row: fresh },
        projectId: command.projectId,
        sessionId: command.sessionId,
      });
    },
    { waitMs: command.waitMs ?? 0 },
  );
  return {
    status: start.stage === 'ready' ? 'ready' : 'pending',
    sessionId: command.sessionId,
    start,
    retryable: start.retriable,
  } satisfies SessionLifecycleResult;
}

export async function continueSession(
  command: ContinueSessionCommand,
): Promise<SessionDeliveryOutcome> {
  const { sessionId, text } = command;
  const [session] = await db
    .select({
      accountId: projectSessions.accountId,
      projectId: projectSessions.projectId,
      status: projectSessions.status,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);

  if (!session) return 'no-session';
  if (session.status === 'failed') return 'failed';

  const userId = command.userId ?? await resolveProjectAutomationActor(session.accountId);
  if (!userId) {
    console.warn('[session-lifecycle] no actor for follow-up delivery', { sessionId });
    return 'pending';
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, session.projectId))
    .limit(1);
  if (!project) return 'no-session';

  if (session.status === 'stopped' || session.status === 'completed') {
    await db
      .update(projectSessions)
      .set({ status: 'running', error: null, updatedAt: new Date() })
      .where(eq(projectSessions.sessionId, sessionId));
  }

  const loaded = { row: project, userId };
  const openOnce = async () => {
    const [fresh] = await db
      .select({
        status: projectSessions.status,
        sandboxProvider: projectSessions.sandboxProvider,
        baseRef: projectSessions.baseRef,
        agentName: projectSessions.agentName,
        opencodeSessionId: projectSessions.opencodeSessionId,
        accountId: projectSessions.accountId,
        metadata: projectSessions.metadata,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    if (!fresh) return null;
    return openSession({
      loaded,
      visible: { row: fresh },
      projectId: session.projectId,
      sessionId,
    });
  };

  const deadline = Date.now() + READY_DEADLINE_MS;
  let opened: Awaited<ReturnType<typeof openOnce>>;
  for (;;) {
    opened = await openOnce();
    if (!opened) return 'no-session';
    if (opened.stage === 'ready') break;
    if (opened.stage === 'failed' || opened.stage === 'stopped') return 'failed';
    if (Date.now() >= deadline) {
      console.warn('[session-lifecycle] runtime not ready before delivery deadline', {
        sessionId,
        stage: opened.stage,
      });
      return 'pending';
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const externalId = sandboxExternalId(opened);
  if (!externalId || !opened.opencode_session_id) return 'pending';
  if (await postPrompt(externalId, opened.opencode_session_id, text, userId)) return 'delivered';

  const healed = await openOnce();
  const healedId = healed?.opencode_session_id;
  if (healed?.stage === 'ready' && healedId && healedId !== opened.opencode_session_id) {
    if (await postPrompt(sandboxExternalId(healed) ?? externalId, healedId, text, userId)) {
      return 'delivered';
    }
  }
  return 'pending';
}

export async function drainSessionLifecycleQueue(input: {
  workerId?: string;
  limit?: number;
} = {}): Promise<{ claimed: number; succeeded: number; failed: number; queued: number }> {
  const workerId = input.workerId ?? `session-lifecycle:${process.pid}:${Date.now()}`;
  const rows = await claimDueLifecycleCommands({ workerId, limit: input.limit ?? 10 });
  const out = { claimed: rows.length, succeeded: 0, failed: 0, queued: 0 };
  for (const row of rows) {
    if (row.commandType !== 'create_session') {
      await markCommandFailed(row.commandId, `Unsupported command type: ${row.commandType}`, {
        retryable: false,
        attempts: row.attempts,
      });
      out.failed += 1;
      continue;
    }
    const result = await executeQueuedCreate(row);
    if (result.status === 'created' && result.sessionId) {
      const payload = row.payload as unknown as QueuedCreateSessionPayload;
      const postCreate = await applyPostCreateActions({
        projectId: row.projectId,
        sessionId: result.sessionId,
        actions: payload.postCreate,
      });
      if (!postCreate.ok) {
        await markCommandFailed(row.commandId, postCreate.error, {
          retryable: true,
          attempts: row.attempts,
          sessionId: result.sessionId,
          result: {
            status: 'created',
            session_id: result.sessionId,
            source: row.source,
            post_create_error: postCreate.error,
          },
        });
        out.queued += 1;
        continue;
      }
      await markCommandSucceeded(
        row.commandId,
        { status: 'created', session_id: result.sessionId, source: row.source },
        result.sessionId,
      );
      out.succeeded += 1;
    } else {
      const message = String(result.error?.body?.error ?? result.reason ?? 'Failed to create queued session');
      const retryable = result.retryable ?? isRetryableCreateError(result.error?.status);
      await markCommandFailed(row.commandId, message, { retryable, attempts: row.attempts });
      if (retryable) out.queued += 1;
      else out.failed += 1;
    }
  }
  return out;
}

async function executeQueuedCreate(row: SessionLifecycleCommandRow): Promise<SessionLifecycleResult> {
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
  const userId = row.actorUserId ?? await resolveProjectAutomationActor(project.accountId);
  if (!userId) {
    return {
      status: 'failed',
      commandId: row.commandId,
      retryable: false,
      error: { status: 409, body: { error: 'No account owner available to own the session' } },
    };
  }
  return executeCreateSession({
    source: row.source as CreateSessionCommand['source'],
    project,
    userId,
    body: payload.body ?? {},
    metadata: payload.metadata,
    extraEnvVars: payload.extraEnvVars,
    visibility: payload.visibility,
    enforceAccountCap: payload.enforceAccountCap,
    queuePolicy: 'never',
    postCreate: payload.postCreate,
  });
}

async function executeCreateSession(command: CreateSessionCommand): Promise<SessionLifecycleResult> {
  const metadata = {
    source: command.source,
    ...(command.metadata ?? {}),
  };
  const result = await createProjectSession({
    project: command.project,
    userId: command.userId,
    body: command.body,
    enforceAccountCap: command.enforceAccountCap,
    metadata,
    extraEnvVars: command.extraEnvVars,
    request: command.request,
    visibility: command.visibility,
  });

  if (result.error) {
    return {
      status: 'failed',
      error: result.error,
      headers: result.headers,
      retryable: isRetryableCreateError(result.error.status),
    };
  }
  return {
    status: 'created',
    sessionId: result.row!.sessionId,
    row: result.row,
    headers: result.headers,
    retryable: true,
  };
}

async function applyPostCreateActions(input: {
  projectId: string;
  sessionId: string;
  actions?: SessionLifecyclePostCreateAction[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.actions?.length) return { ok: true };
  try {
    for (const action of input.actions) {
      if (action.type === 'bind_chat_thread') {
        await db
          .insert(chatThreads)
          .values({
            projectId: input.projectId,
            platform: action.platform,
            workspaceId: action.workspaceId,
            threadId: action.threadId,
            sessionId: input.sessionId,
          })
          .onConflictDoNothing({
            target: [chatThreads.platform, chatThreads.workspaceId, chatThreads.threadId],
          });
      } else if (action.type === 'deliver_prompt') {
        const outcome = await continueSession({
          source: action.source,
          sessionId: input.sessionId,
          text: action.text,
          userId: action.userId ?? undefined,
        });
        if (outcome !== 'delivered') {
          return { ok: false, error: `initial prompt delivery ${outcome}` };
        }
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

function isRetryableCreateError(status?: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function sandboxExternalId(
  result: NonNullable<Awaited<ReturnType<typeof openSession>>>,
): string | null {
  return (result.sandbox as { external_id?: string } | null)?.external_id ?? null;
}

async function postPrompt(
  externalId: string,
  opencodeSessionId: string,
  text: string,
  userId: string,
): Promise<boolean> {
  const body = new TextEncoder().encode(JSON.stringify({ parts: [{ type: 'text', text }] }));
  const res = await forwardToSandbox(
    externalId,
    DAEMON_PORT,
    { kind: 'principal', userId },
    'POST',
    `/session/${encodeURIComponent(opencodeSessionId)}/prompt_async`,
    `?directory=${encodeURIComponent(WORKSPACE)}`,
    new Headers({ 'Content-Type': 'application/json' }),
    body.buffer as ArrayBuffer,
    config.KORTIX_URL ?? '',
  );
  if (res.ok || res.status === 204) return true;
  if (res.status !== 404) console.warn('[session-lifecycle] prompt_async non-ok', { status: res.status });
  return false;
}

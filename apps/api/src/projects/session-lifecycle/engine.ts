import { acpSessionEnvelopes, executorExecutions, projectSessions, projects } from '@kortix/db';
import { isAcpResponseEnvelope, type AcpEnvelope } from '@kortix/sdk/acp';
import { eq } from 'drizzle-orm';
import { bindChatThread } from '../../channels/slack/binding';
import { config } from '../../config';
import { forwardToSandbox } from '../../sandbox-proxy/routes/preview';
import { db } from '../../shared/db';
import { connectorBindingPayloadConflicts } from '../lib/session-connector-bindings';
import { createProjectSession } from '../lib/sessions';
import { openSession } from '../routes/shared';
import { consumeHeadlessAcpSse, selectHeadlessPermissionOption } from './headless-acp';
import { resolveProjectAutomationActor } from './actor';
import { awaitTerminalStage } from './await-stage';
import { sessionBackpressureState } from './backpressure';
import { type DeliveryTarget, deliverWithRetry } from './deliver';
import {
  type SessionLifecycleCommandRow,
  claimCreateSessionCommand,
  claimDueLifecycleCommands,
  markCommandFailed,
  markCommandQueued,
  markCommandSucceeded,
  resultFromExistingCommand,
} from './store';
import type { QueuedContinueSessionPayload } from './store';
import type {
  ContinueSessionCommand,
  CreateSessionCommand,
  QueuedCreateSessionPayload,
  SessionDeliveryOutcome,
  SessionInvocationSource,
  SessionLifecyclePostCreateAction,
  SessionLifecycleResult,
  StartSessionCommand,
} from './types';

const WORKSPACE = '/workspace';
const DAEMON_PORT = 8000;
const READY_DEADLINE_MS = 300_000;
const POLL_INTERVAL_MS = 3_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createSession(
  command: CreateSessionCommand,
): Promise<SessionLifecycleResult> {
  const queuePolicy = command.queuePolicy ?? 'never';
  const backpressure =
    queuePolicy === 'never'
      ? null
      : await sessionBackpressureState(command.project.accountId, command.project.projectId);
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
    const existingPayload = (claimed.row.payload ?? {}) as Record<string, unknown>;
    const existingBody =
      existingPayload.body && typeof existingPayload.body === 'object'
        ? (existingPayload.body as Record<string, unknown>)
        : {};
    if (
      connectorBindingPayloadConflicts(
        existingBody.connector_bindings,
        command.body.connector_bindings,
      )
    ) {
      return {
        status: 'failed',
        commandId: claimed.row.commandId,
        retryable: false,
        error: {
          status: 409,
          body: {
            error: 'Idempotency key was already used with different connector bindings',
            code: 'IDEMPOTENCY_BINDING_CONFLICT',
          },
        },
      };
    }
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
  // so the immediate-ready path and every non-long-poll caller are untouched.
  const start = await awaitTerminalStage(
    first,
    async () => {
      const [fresh] = await db
        .select({
          status: projectSessions.status,
          sandboxProvider: projectSessions.sandboxProvider,
          baseRef: projectSessions.baseRef,
          agentName: projectSessions.agentName,
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
      metadata: projectSessions.metadata,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);

  if (!session) return 'no-session';
  if (session.status === 'failed') return 'failed';
  // deleteSession() stamps metadata.deletedAt and leaves the row 'stopped' —
  // the same status a normal hibernate uses. Without this check a queued
  // follow-up (Slack reply, scheduled trigger, etc.) would revive a session
  // the user explicitly deleted.
  const sessionMeta = (session.metadata ?? {}) as Record<string, unknown>;
  if (typeof sessionMeta.deletedAt === 'string') return 'no-session';

  const userId = command.userId ?? (await resolveProjectAutomationActor(session.accountId));
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

  // Runtime is ready — hand off the prompt through ACP, healing + retrying
  // through transient wake/bind failures. Bounce to 'pending' only after the
  // bounded window genuinely exhausts.
  const toTarget = (o: NonNullable<Awaited<ReturnType<typeof openOnce>>>): DeliveryTarget => ({
    stage: o.stage,
    externalId: sandboxExternalId(o),
    runtimeProtocol: o.runtime_protocol === 'acp' ? 'acp' : null,
    runtimeId: o.runtime_id ?? null,
    runtimeSessionId: o.runtime_session_id ?? null,
  });

  return deliverWithRetry({
    sessionId,
    opened: toTarget(opened),
    reopen: async () => {
      const healed = await openOnce();
      return healed ? toTarget(healed) : null;
    },
    send: (externalId, runtimeId, target) =>
      postAcpPrompt({
        externalId,
        runtimeId,
        acpSessionId: target.runtimeSessionId ?? null,
        projectId: session.projectId,
        sessionId,
        text,
        userId,
      }),
  });
}

export async function drainSessionLifecycleQueue(
  input: {
  workerId?: string;
  limit?: number;
  } = {},
): Promise<{ claimed: number; succeeded: number; failed: number; queued: number }> {
  const workerId = input.workerId ?? `session-lifecycle:${process.pid}:${Date.now()}`;
  const rows = await claimDueLifecycleCommands({ workerId, limit: input.limit ?? 10 });
  const out = { claimed: rows.length, succeeded: 0, failed: 0, queued: 0 };
  for (const row of rows) {
    if (row.commandType === 'continue_session') {
      const outcome = await executeQueuedContinue(row);
      out[outcome] += 1;
      continue;
    }
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
      const message = String(
        result.error?.body?.error ?? result.reason ?? 'Failed to create queued session',
      );
      const retryable = result.retryable ?? isRetryableCreateError(result.error?.status);
      await markCommandFailed(row.commandId, message, { retryable, attempts: row.attempts });
      if (retryable) out.queued += 1;
      else out.failed += 1;
    }
  }
  return out;
}

/**
 * Drain one queued `continue_session` command — the durable face of "deliver
 * this follow-up into the session" (today: the approval-resume backstop). The
 * consumed-marker check runs at DRAIN time, not enqueue time, so a live held
 * request that picked the decision up during the grace window cleanly turns
 * this into a no-op instead of a duplicate prompt.
 */
async function executeQueuedContinue(
  row: SessionLifecycleCommandRow,
): Promise<'succeeded' | 'queued' | 'failed'> {
  const payload = row.payload as unknown as QueuedContinueSessionPayload;
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!row.sessionId || !text) {
    await markCommandFailed(row.commandId, 'continue_session command missing sessionId or text', {
      retryable: false,
      attempts: row.attempts,
    });
    return 'failed';
  }

  if (payload.executionId) {
    const [exec] = await db
      .select({ resultSummary: executorExecutions.resultSummary })
      .from(executorExecutions)
      .where(eq(executorExecutions.executionId, payload.executionId))
      .limit(1);
    const summary = (exec?.resultSummary ?? {}) as Record<string, unknown>;
    if (summary.consumed_at) {
      await markCommandSucceeded(
        row.commandId,
        { status: 'skipped', reason: 'consumed_in_band' },
        row.sessionId,
      );
      return 'succeeded';
    }
  }

  try {
    const delivery = await continueSession({
      source: row.source as SessionInvocationSource,
      sessionId: row.sessionId,
      text,
      userId: row.actorUserId,
    });
    if (delivery === 'delivered') {
      await markCommandSucceeded(row.commandId, { status: 'delivered' }, row.sessionId);
      return 'succeeded';
    }
    // 'pending' = runtime not ready in time — worth another pass. 'no-session'
    // and 'failed' are terminal for this command.
    const retryable = delivery === 'pending';
    await markCommandFailed(row.commandId, `delivery outcome: ${delivery}`, {
      retryable,
      attempts: row.attempts,
      sessionId: row.sessionId,
    });
    return retryable ? 'queued' : 'failed';
  } catch (e) {
    await markCommandFailed(row.commandId, (e as Error).message || 'continue_session threw', {
      retryable: true,
      attempts: row.attempts,
      sessionId: row.sessionId,
    });
    return 'queued';
  }
}

async function executeQueuedCreate(
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

async function executeCreateSession(
  command: CreateSessionCommand,
): Promise<SessionLifecycleResult> {
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
        await bindChatThread({
          projectId: input.projectId,
          platform: action.platform,
          workspaceId: action.workspaceId,
          threadId: action.threadId,
          sessionId: input.sessionId,
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

async function postAcpPrompt(input: {
  externalId: string;
  runtimeId: string;
  acpSessionId: string | null;
  projectId: string;
  sessionId: string;
  text: string;
  userId: string;
}): Promise<boolean> {
  let rpcId = Date.now();
  const persist = async (
    direction: 'client_to_agent' | 'agent_to_client',
    envelope: Record<string, unknown>,
    streamEventId: number | null = null,
  ) => {
    await db.insert(acpSessionEnvelopes).values({
      projectId: input.projectId,
      sessionId: input.sessionId,
      runtimeId: input.runtimeId,
      direction,
      envelope,
      streamEventId,
    }).onConflictDoNothing();
  };
  const postEnvelope = async (request: Record<string, unknown>) => {
    await persist('client_to_agent', request);
    const body = new TextEncoder().encode(JSON.stringify(request));
    const response = await forwardToSandbox(
      input.externalId,
      DAEMON_PORT,
      { kind: 'principal', userId: input.userId },
      'POST',
      `/acp/${encodeURIComponent(input.runtimeId)}`,
      '',
      new Headers({ 'Content-Type': 'application/json' }),
      body.buffer as ArrayBuffer,
      config.KORTIX_URL ?? '',
    );
    if (!response.ok) throw new Error(`ACP request returned HTTP ${response.status}`);
    if (response.status === 202 || response.status === 204) return null;
    const envelope = await response.json() as Record<string, any>;
    await persist('agent_to_client', envelope);
    return envelope;
  };
  const call = async (method: string, params: unknown) => {
    const envelope = await postEnvelope({ jsonrpc: '2.0', id: rpcId++, method, params });
    // Same JSON-RPC response shape guard `AcpClient.request()` applies via
    // `isAcpResponseEnvelope` before trusting `.error`/`.result` — this used
    // to be hand-approximated by the `!envelope` check alone, which let a
    // malformed response (missing both `result` and `error`, or echoing a
    // request/notification shape back) through silently as a success with
    // `result: undefined`.
    if (!envelope || !isAcpResponseEnvelope(envelope as AcpEnvelope)) {
      throw new Error(`ACP ${method} returned no JSON-RPC response`);
    }
    if (envelope.error) throw new Error(envelope.error.message || `ACP ${method} failed`);
    return envelope.result;
  };

  try {
    await call('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'kortix-api', title: 'Kortix Automations', version: '3' },
    });
    let acpSessionId = input.acpSessionId;
    if (acpSessionId) {
      await call('session/load', { sessionId: acpSessionId, cwd: WORKSPACE, mcpServers: [] });
    } else {
      const created = await call('session/new', { cwd: WORKSPACE, mcpServers: [] });
      acpSessionId = typeof created?.sessionId === 'string' ? created.sessionId : null;
      if (!acpSessionId) throw new Error('ACP session/new returned no sessionId');
      const [current] = await db.select({ metadata: projectSessions.metadata })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, input.sessionId))
        .limit(1);
      await db.update(projectSessions).set({
        metadata: {
          ...((current?.metadata as Record<string, unknown> | null) ?? {}),
          runtime_protocol: 'acp',
          runtime_id: input.runtimeId,
          acp_session_id: acpSessionId,
        },
        updatedAt: new Date(),
      }).where(eq(projectSessions.sessionId, input.sessionId));
    }
    const stream = await forwardToSandbox(
      input.externalId,
      DAEMON_PORT,
      { kind: 'principal', userId: input.userId },
      'GET',
      `/acp/${encodeURIComponent(input.runtimeId)}`,
      '',
      new Headers({ Accept: 'text/event-stream' }),
      undefined,
      config.KORTIX_URL ?? '',
    );
    if (!stream.ok || !stream.body) throw new Error(`ACP stream returned HTTP ${stream.status}`);
    const streamAbort = new AbortController();
    const streamTask = consumeHeadlessAcpSse(stream.body, async (eventId, envelope) => {
      await persist('agent_to_client', envelope, eventId);
      if (!Object.prototype.hasOwnProperty.call(envelope, 'id') || typeof envelope.method !== 'string') return;
      if (envelope.method === 'session/request_permission') {
        const optionId = selectHeadlessPermissionOption(envelope.params);
        await postEnvelope({
          jsonrpc: '2.0',
          id: envelope.id,
          result: {
            outcome: optionId
              ? { outcome: 'selected', optionId }
              : { outcome: 'cancelled' },
          },
        });
        return;
      }
      // Headless channels cannot truthfully invent answers to agent
      // elicitation requests. Fail closed so the turn can terminate cleanly.
      await postEnvelope({
        jsonrpc: '2.0',
        id: envelope.id,
        error: { code: -32601, message: 'Interactive request unavailable in this headless run' },
      });
    }, streamAbort.signal).catch((error) => {
      if (!streamAbort.signal.aborted) throw error;
    });
    try {
      const promptTask = call('session/prompt', {
        sessionId: acpSessionId,
        prompt: [{ type: 'text', text: input.text }],
      });
      const completed = await Promise.race([
        promptTask,
        streamTask.then(() => {
          throw new Error('ACP event stream closed before the prompt completed');
        }),
      ]);
      if (typeof completed?.stopReason !== 'string') throw new Error('ACP prompt returned no stopReason');
    } finally {
      streamAbort.abort();
      await streamTask;
    }
    return true;
  } catch (error) {
    console.warn('[session-lifecycle] ACP prompt delivery failed (will retry)', {
      sessionId: input.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

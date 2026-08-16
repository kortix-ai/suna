import {
  connectorCalls,
  projectSessions,
  projects,
  serviceAccounts,
  sessionSandboxes,
} from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { bindChatThread } from '../../channels/slack/binding';
import { config } from '../../config';
import { mayRequeueFailedCreate } from './requeue-policy';
import { forwardToSandbox } from '../../sandbox-proxy/routes/preview';
import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { serviceKeyForExternalId } from '../../platform/service-key';
import type { ProviderName } from '../../platform/providers';
import { sandboxOpencodeEndpoint } from '../opencode-mapping';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';
import { db } from '../../shared/db';
import { connectorBindingPayloadConflicts } from '../lib/session-connector-bindings';
import { secretsAllowlistPayloadConflicts } from '../secrets';
import {
  requireConnectorsConflicts,
  runtimeContextConflicts,
} from './idempotency-conflicts';
import { createProjectSession } from '../lib/sessions';
import { syncSandboxEnvForPrompt } from '../lib/sandbox-env-sync';
import { openSession } from '../routes/shared';
import { generateSessionTitleFromFirstPrompt } from '../session-title-generate';
import { resolveProjectAutomationActor } from './actor';
import { awaitTerminalStage } from './await-stage';
import { sessionBackpressureState } from './backpressure';
import { type DeliveryTarget, deliverWithRetry } from './deliver';
import {
  type SessionLifecycleCommandRow,
  claimCreateSessionCommand,
  claimDueLifecycleCommands,
  enqueueContinueSessionCommand,
  markCommandFailed,
  markCommandQueued,
  markCommandSucceeded,
  resultFromExistingCommand,
} from './store';
import type { QueuedContinueSessionPayload } from './store';
import { crossAccountIdempotencyResult } from './idempotency-guard';
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
    if (
      secretsAllowlistPayloadConflicts(
        existingBody.secrets as string[] | null | undefined,
        command.body.secrets as string[] | null | undefined,
      )
    ) {
      return {
        status: 'failed',
        commandId: claimed.row.commandId,
        retryable: false,
        error: {
          status: 409,
          body: {
            error: 'Idempotency key was already used with a different secrets allowlist',
            code: 'IDEMPOTENCY_SECRETS_CONFLICT',
          },
        },
      };
    }
    if (runtimeContextConflicts(existingBody.runtime_context, command.body.runtime_context)) {
      return {
        status: 'failed',
        commandId: claimed.row.commandId,
        retryable: false,
        error: {
          status: 409,
          body: {
            error: 'Idempotency key was already used with a different runtime_context',
            code: 'IDEMPOTENCY_CONTEXT_CONFLICT',
          },
        },
      };
    }
    // require_connectors resolves to member bindings at create; a replay with a
    // different required set would otherwise return the first session, which was
    // resolved against a different set of the user's own connections.
    if (
      requireConnectorsConflicts(existingBody.require_connectors, command.body.require_connectors)
    ) {
      return {
        status: 'failed',
        commandId: claimed.row.commandId,
        retryable: false,
        error: {
          status: 409,
          body: {
            error: 'Idempotency key was already used with a different require_connectors',
            code: 'IDEMPOTENCY_REQUIRE_CONNECTORS_CONFLICT',
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

  const result = await executeCreateSession(command);
  if (result.status === 'created' && result.sessionId) {
    const postCreate = await applyPostCreateActions({
      projectId: command.project.projectId,
      sessionId: result.sessionId,
      actions: command.postCreate,
      commandId: claimed.row.commandId,
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
  // This is the INLINE path — the queued branch returned above — so `result` is
  // about to be handed to a waiting caller. Marking it retryable would leave the
  // command row queued for the drainer as well, and the caller (told by the
  // guide that a 429/503 is worth retrying) retries with a fresh key: two billed
  // sandboxes for one intent, both running initial_prompt.
  await markCommandFailed(claimed.row.commandId, message, {
    retryable: mayRequeueFailedCreate({
      answeredSynchronously: true,
      errorIsRetryable: result.retryable ?? false,
    }),
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
  // F2: the queued `continue_session` row's stable identity, when this
  // delivery originates from the durable queue (`executeQueuedContinue`,
  // `applyPostCreateActions`'s `deliver_prompt` action). Sent to `postPrompt`
  // as the `Idempotency-Key` — see the note there for why this must be
  // STABLE across every retry of ONE command and DISTINCT across different
  // commands, even when their prompt text is byte-identical. Callers with no
  // durable row of their own (direct API/channel delivery) get a fresh
  // `randomUUID()` per call instead — still stable across THIS call's own
  // internal `deliverWithRetry` retries (computed once, below, outside that
  // loop), just not across separate invocations, which those callers never
  // rely on for dedupe.
  commandId?: string,
): Promise<SessionDeliveryOutcome> {
  const { sessionId, text } = command;
  const idempotencyKey = commandId ?? randomUUID();
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

  // Server-side delivery is the first prompt for sessions created without one.
  void generateSessionTitleFromFirstPrompt({
    sessionId,
    projectId: session.projectId,
    accountId: session.accountId,
    userId,
    firstPromptText: text,
  });

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

  if (command.opencodeEnv) {
    const sandbox = opened.sandbox as {
      external_id?: string | null;
      provider?: string | null;
    } | null;
    const externalId = sandbox?.external_id ?? null;
    const providerName = sandbox?.provider ?? null;
    if (!externalId || !isProviderName(providerName)) {
      console.warn('[session-lifecycle] runtime env sync target is incomplete', {
        sessionId,
        hasExternalId: !!externalId,
        provider: providerName,
      });
      return 'pending';
    }
    try {
      const [serviceKey, ingress] = await Promise.all([
        serviceKeyForExternalId(externalId),
        resolveSandboxIngress(externalId, { port: DAEMON_PORT, transport: 'http' }),
      ]);
      if (!serviceKey) throw new Error('sandbox service key is unavailable');
      await syncSandboxEnvForPrompt({
        projectId: session.projectId,
        sessionId,
        externalId,
        serviceKey,
        previewUrl: ingress.url,
        providerHeaders: ingress.headers,
        providerName,
        opencodeEnv: command.opencodeEnv,
      });
    } catch (err) {
      console.warn('[session-lifecycle] runtime env sync failed before prompt delivery', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'pending';
    }
  }

  // Runtime is ready — hand off the prompt, healing + retrying through the
  // transient failures a freshly-woken sandbox throws (rotated opencode session
  // 404, daemon 5xx while it binds, externalId/opencode_session_id briefly
  // null). Bounce to 'pending' only after the bounded window genuinely exhausts;
  // the old code gave up on the first hiccup and dropped the user's message.
  const toTarget = (o: NonNullable<Awaited<ReturnType<typeof openOnce>>>): DeliveryTarget => ({
    stage: o.stage,
    externalId: sandboxExternalId(o),
    opencodeSessionId: o.opencode_session_id,
  });

  return deliverWithRetry({
    sessionId,
    opened: toTarget(opened),
    reopen: async () => {
      const healed = await openOnce();
      return healed ? toTarget(healed) : null;
    },
    send: (externalId, runtimeId) =>
      postPrompt(externalId, runtimeId, text, userId, sessionId, idempotencyKey),
  });
}

export async function drainSessionLifecycleQueue(
  input: {
    workerId?: string;
    limit?: number;
    /** Drain one freshly-enqueued callback without waiting behind older work. */
    idempotencyKey?: string;
    /** Only drain commands due before this instant — see claimDueLifecycleCommands. */
    availableBefore?: Date;
  } = {},
): Promise<{ claimed: number; succeeded: number; failed: number; queued: number }> {
  const workerId = input.workerId ?? `session-lifecycle:${process.pid}:${Date.now()}`;
  const rows = await claimDueLifecycleCommands({
    workerId,
    limit: input.limit ?? 10,
    idempotencyKey: input.idempotencyKey,
    availableBefore: input.availableBefore,
  });
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
        commandId: row.commandId,
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
 *
 * T13 — no-blind-repost on a retryable ('pending') delivery: below,
 * `retryable = delivery === 'pending'` re-queues this SAME row, and a later
 * drain calls `continueSession` again with the identical `sessionId`/`text` —
 * so a delivery that actually reached opencode but was reported ambiguous
 * (network reset after the daemon accepted it, a timed-out response read)
 * must not re-POST blind on the next pass.
 *
 * This module does not re-check that itself — a cheap authoritative read
 * (list opencode's messages by id, or ask the daemon "did you see this one?")
 * is not available here without another round trip per retry. Instead the
 * guarantee is carried by `postPrompt`'s own transport: it POSTs through
 * `forwardToSandbox`, which is the SAME proxy path the SDK's browser/CLI
 * sends run through, and that path claims a delivery in
 * `apps/api/src/sandbox-proxy/prompt-dedupe.ts` before it ever reaches
 * opencode. Two `postPrompt` calls for the same row carry byte-identical
 * bodies (same `sessionId` + `text`, no messageID field — see `postPrompt`
 * below), so the claim's content-hash key collides on the retry and the
 * SECOND POST is answered `200 {"deduplicated":true}`, which `postPrompt`
 * reads as accepted. That claim is held for `DEDUPE_TTL_MS` (10 minutes,
 * `prompt-dedupe.ts`) — comfortably past both the scheduler's ~60s drain tick
 * and this file's own `deliverWithRetry` deadline (45s), so an ordinary
 * requeue-and-redrain cycle never outlives it. Pinned in
 * `prompt-dedupe.test.ts`: the TTL boundary itself ("a key is claimable again
 * once its TTL has elapsed") and, exercising `postPrompt`'s exact body shape
 * (`{"parts":[{"type":"text","text":…}]}`, no messageID field), "a retried
 * `continue_session` delivery — postPrompt's exact body shape — collides on
 * the same dedupe key". Only a retry that is itself starved past 10 minutes
 * (the same bound
 * `UNDELIVERED_PROMPT_STARVATION_MS` in `undelivered-prompts.ts` treats as a
 * dead scheduler) can outrun this — an accepted risk, not a silent one.
 */
/**
 * T22 — staged-revert guard for the queued `continue_session` backstop.
 *
 * OpenCode's `session.revert` is a STAGED pointer on the session row
 * (`Session.revert?: { messageID, ... }`, `@opencode-ai/sdk` `types.gen`).
 * Nothing is deleted until the NEXT prompt — from ANY producer — commits the
 * truncation. A queued continue (an approval "resume", a trigger fire) that
 * was enqueued BEFORE a user staged a revert must never be that committing
 * prompt: the user is mid-edit of their own session history, and an
 * automated continue queued against the pre-rewind trajectory is void once
 * the rewind lands. This is checked at DRAIN time (same reasoning as the
 * consumed-marker check above `executeQueuedContinue`) so a revert staged
 * after enqueue but before this row's turn to drain is still caught.
 *
 * Reuses `sandboxOpencodeEndpoint` (the same signed-proxy resolution
 * `session-transcript.ts` and `opencode-mapping.ts` already use — no new
 * client) to read the sandbox's live OpenCode session row. Any resolution
 * failure (no pin yet, sandbox unreachable, request timeout) fails OPEN —
 * returns false, i.e. delivers exactly as before this guard existed — so a
 * transient read failure never blocks a legitimate follow-up.
 */
async function queuedContinueHasStagedRevert(row: SessionLifecycleCommandRow): Promise<boolean> {
  if (!row.sessionId) return false;
  try {
    const [session] = await db
      .select({
        opencodeSessionId: projectSessions.opencodeSessionId,
        sandboxUrl: projectSessions.sandboxUrl,
        accountId: projectSessions.accountId,
        projectId: projectSessions.projectId,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, row.sessionId))
      .limit(1);
    if (!session?.opencodeSessionId) return false;

    let externalId = externalIdFromSandboxUrlField(session.sandboxUrl);
    if (!externalId) {
      const [sandbox] = await db
        .select({ externalId: sessionSandboxes.externalId })
        .from(sessionSandboxes)
        .where(
          and(
            eq(sessionSandboxes.sessionId, row.sessionId),
            eq(sessionSandboxes.projectId, session.projectId),
            eq(sessionSandboxes.accountId, session.accountId),
          ),
        )
        .orderBy(desc(sessionSandboxes.updatedAt))
        .limit(1);
      externalId = sandbox?.externalId ?? null;
    }
    if (!externalId) return false;

    const endpoint = await sandboxOpencodeEndpoint(externalId, row.actorUserId ?? undefined);
    if (!endpoint) return false;

    const url = `${endpoint.url}/session/${encodeURIComponent(session.opencodeSessionId)}?directory=${encodeURIComponent(WORKSPACE)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: sandboxRuntimeRequestHeaders(endpoint.headers),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const info = (await res.json().catch(() => null)) as { revert?: unknown } | null;
    return Boolean(info?.revert);
  } catch (err) {
    console.warn('[session-lifecycle] staged-revert check failed — proceeding as not staged', {
      sessionId: row.sessionId,
      commandId: row.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** `sandboxUrl` on the session row looks like `.../p/<external_id>/8000/...`. */
function externalIdFromSandboxUrlField(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/\/p\/([^/]+)\//);
  return match?.[1] ?? null;
}

export async function executeQueuedContinue(
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
      .select({ resultSummary: connectorCalls.resultSummary })
      .from(connectorCalls)
      .where(eq(connectorCalls.executionId, payload.executionId))
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

  if (await queuedContinueHasStagedRevert(row)) {
    console.warn('[session-lifecycle] dropping queued continue — session has a staged revert', {
      sessionId: row.sessionId,
      commandId: row.commandId,
    });
    await markCommandSucceeded(
      row.commandId,
      { status: 'skipped', reason: 'staged_revert' },
      row.sessionId,
    );
    return 'succeeded';
  }

  try {
    const delivery = await continueSession(
      {
        source: row.source as SessionInvocationSource,
        sessionId: row.sessionId,
        text,
        userId: row.actorUserId,
      },
      // F2: stable across every drain-and-retry of THIS row — see
      // `postPrompt`'s F2 note. Two DIFFERENT queued commands (distinct
      // `commandId`s) with identical text now deliver independently instead
      // of the second silently deduping against the first.
      row.commandId,
    );
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
    source: row.source as CreateSessionCommand['source'],
    project,
    userId,
    requestingPrincipalType,
    body: payload.body ?? {},
    metadata: payload.metadata,
    extraEnvVars: payload.extraEnvVars,
    visibility: payload.visibility,
    mayManageSystemConnections: payload.mayManageSystemConnections,
    enforceAccountCap: payload.enforceAccountCap,
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
  const metadata = {
    source: command.source,
    ...(command.metadata ?? {}),
  };
  const result = await createProjectSession({
    project: command.project,
    userId: command.userId,
    requestingPrincipalType: command.requestingPrincipalType,
    body: command.body,
    enforceAccountCap: command.enforceAccountCap,
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
  // F2: the CREATE command's own commandId, when this create can be retried
  // against the same row (the idempotency-key and queued-create paths — see
  // call sites). Forwarded to `continueSession` so `postPrompt`'s
  // `Idempotency-Key` stays stable across those retries. Omitted by the
  // one-shot, non-retryable create path, which falls back to a fresh
  // `randomUUID()` per call inside `continueSession`.
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
        const outcome = await continueSession(
          {
            source: action.source,
            sessionId: input.sessionId,
            text: action.text,
            userId: action.userId ?? undefined,
          },
          input.commandId,
        );
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

function isProviderName(value: string | null): value is ProviderName {
  return (
    value === 'daytona' ||
    value === 'platinum' ||
    value === 'e2b'
  );
}

/**
 * T13 — this body deliberately carries NO `messageID` field, unlike
 * the SDK's `promptOpenCodeMessage` payload. Minting one here would mean
 * placing it correctly in opencode's id-ordered transcript (the id's clock
 * prefix decides "already answered?" — see `messages.ts`'s
 * `mintPromptMessageId`), which requires reading that transcript's current
 * state; this call site has no cheap way to do that server-side, and a
 * wrongly-ordered id silently drops the turn instead of merely losing dedupe
 * precision.
 *
 * F2: without a messageID, `prompt-dedupe.ts`'s precedence used to fall all
 * the way to its content-hash fallback — `sessionId` + `text` only. That is
 * sound across retries of ONE command (identical body by construction, see
 * `executeQueuedContinue`'s guarantee above), but unsound across TWO
 * different commands that happen to carry byte-identical text (two approvals
 * of one `actionPath`, a fixed-text trigger firing twice inside the TTL):
 * both hash to the SAME key, so the second is answered `200
 * {"deduplicated":true}` — which this function reads as delivered — and its
 * turn silently never runs. `idempotencyKey` closes this: it outranks the
 * content hash (`promptDeliveryKey`'s precedence, `prompt-dedupe.ts`), is
 * STABLE across every retry of one command (the caller passes the same value
 * every time — see `continueSession`), and is DISTINCT across different
 * commands even when their text matches exactly.
 */
async function postPrompt(
  externalId: string,
  opencodeSessionId: string,
  text: string,
  userId: string,
  /** The session this prompt is FOR. Passed as the caller binding so the
   *  isolation guard proves the target matches, rather than being waived. */
  callerSessionId: string,
  /** F2: per-command identity forwarded as `Idempotency-Key` — see the note
   *  above. */
  idempotencyKey: string,
): Promise<boolean> {
  const body = new TextEncoder().encode(JSON.stringify({ parts: [{ type: 'text', text }] }));
  try {
    const res = await forwardToSandbox(
      externalId,
      DAEMON_PORT,
      { kind: 'principal', userId, callerSessionId, sandboxAuthored: false },
      'POST',
      `/session/${encodeURIComponent(opencodeSessionId)}/prompt_async`,
      `?directory=${encodeURIComponent(WORKSPACE)}`,
      new Headers({ 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }),
      body.buffer as ArrayBuffer,
      config.KORTIX_URL ?? '',
    );
    if (res.ok || res.status === 204) return true;
    if (res.status !== 404)
      console.warn('[session-lifecycle] prompt_async non-ok', { status: res.status });
    return false;
  } catch (err) {
    // A connection refused/reset while the sandbox finishes resuming — treat as a
    // retryable miss (the deliver loop will heal + retry) instead of letting it
    // bubble up and silently drop the turn.
    console.warn('[session-lifecycle] prompt_async threw (will retry)', { error: String(err) });
    return false;
  }
}

import {
  connectorCalls,
  projectSessions,
  projects,
  serviceAccounts,
  sessionLifecycleCommands,
  sessionSandboxes,
} from '@kortix/db';
import { type SQL, and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { WIRE_ID_PLACED_HEADER } from '../../sandbox-proxy/prompt-wire-id-repair';
import { bindChatThread } from '../../channels/slack/binding';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { mayRequeueFailedCreate } from './requeue-policy';
import { forwardToSandbox } from '../../sandbox-proxy/routes/preview';
import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { serviceKeyForExternalId } from '../../platform/service-key';
import type { ProviderName } from '../../platform/providers';
import { sandboxOpencodeEndpoint } from '../opencode-mapping';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';
import {
  currentInstanceId,
  sandboxBelongsToThisInstance,
  sandboxInstanceId,
} from '../instance-scope';
import { loadSandboxMetadataForSessions, releaseCommandToOwningInstance } from './instance-release';
import { db } from '../../shared/db';
import { connectorBindingPayloadConflicts } from '../lib/session-connector-bindings';
import { secretsAllowlistPayloadConflicts } from '../secrets';
import {
  requireConnectorsConflicts,
  runtimeContextConflicts,
} from './idempotency-conflicts';
import { createProjectSession } from '../lib/sessions';
import { syncSandboxEnvForPrompt } from '../lib/sandbox-env-sync';
import { applyTriggerSessionAccess } from '../trigger-session-access';
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
  markCommandForwarded,
  promoteNextInboxRow,
  markCommandQueued,
  markCommandSucceeded,
  requeueForAdmission,
  resultFromExistingCommand,
  withNextDeliveryAttempt,
  withRemintedWireId,
} from './store';
import type {
  PromptOverridesWire,
  PromptPartWire,
  QueuedContinueSessionPayload,
} from './store';
import { admitInboxPrompt, sessionHoldsLiveTurn } from './inbox-admission';
import { claimDueSessionInboxSiblings } from './inbox-rows';
import {
  type PlacementTipMessage,
  boxClockSkewMs,
  mintLivePlacement,
  noteBoxClockSample,
  openUserAbove,
  parsePlacementTip,
  strandedPlacement,
} from './forwarded-placement';
import {
  MAX_WIRE_ID_CLOCK_CORRECTION,
  WIRE_ID_TIME_MASK,
  WIRE_ID_TIME_SCALE,
  mintWireMessageId,
  newestWireIdTime,
  wireIdTime,
} from '../wire-message-id';
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
  tl?: ProvisionTimeline,
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

  tl?.mark('session-read');

  // FAST PATH — the box is already awake. `openSession` is /start: a provider
  // status call plus a daemon health probe, ~0.5–0.9s per delivery even when
  // nothing needs waking, and it ran on EVERY queued message. When the session
  // row is running, its sandbox row is active and the OpenCode pin exists, the
  // delivery target is fully known from the DB; the POST goes through the
  // proxy, whose own wake-and-retry loop and `deliverWithRetry.reopen` (the
  // full open) cover a box that turns out to be asleep after all. A cold or
  // stopping session takes the slow path below exactly as before.
  const awake = await awakeDeliveryTarget(sessionId);
  if (awake && !command.opencodeEnv) {
    tl?.mark('open-ready-fast');
    return deliverWithRetry({
      sessionId,
      opened: awake,
      reopen: async () => {
        const healed = await openOnce();
        if (!healed) return null;
        return {
          stage: healed.stage,
          externalId: sandboxExternalId(healed),
          opencodeSessionId: healed.opencode_session_id,
        };
      },
      send: (externalId, runtimeId) =>
        postPrompt(externalId, runtimeId, text, userId, sessionId, idempotencyKey, {
          parts: command.parts,
          overrides: command.overrides,
          wireMessageId: command.wireMessageId,
        }),
    });
  }

  const deadline = Date.now() + READY_DEADLINE_MS;
  let opened: Awaited<ReturnType<typeof openOnce>>;
  for (;;) {
    opened = await openOnce();
    if (!opened) return 'no-session';
    if (opened.stage === 'ready') {
      tl?.mark('open-ready');
      break;
    }
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

  // Converge the box BEFORE the prompt goes on the wire — every time, not only
  // when this prompt carries an `opencodeEnv` override. The proxied
  // `prompt_async` route has always done this (sandbox-proxy/pre-prompt-env-sync);
  // this wake path did it only behind `if (command.opencodeEnv)`, so an ordinary
  // `session.send()` prompt onto a box that had to be WOKEN reached OpenCode
  // with whatever the box had at boot: a stale gateway base URL after a
  // KORTIX_URL rotation, stale secrets, a stale model catalog. The sync is
  // cheap and self-deduping (revision + model signature); an unchanged box
  // costs one skipped push.
  {
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

  tl?.mark('env-sync');
  return deliverWithRetry({
    sessionId,
    opened: toTarget(opened),
    reopen: async () => {
      const healed = await openOnce();
      return healed ? toTarget(healed) : null;
    },
    send: (externalId, runtimeId) =>
      postPrompt(externalId, runtimeId, text, userId, sessionId, idempotencyKey, {
        parts: command.parts,
        overrides: command.overrides,
        wireMessageId: command.wireMessageId,
      }),
  });
}

/** How far out a released foreign command is re-queued; the owner's drain ticks every 1s. */
const INSTANCE_RELEASE_DELAY_MS = 2_000;

export async function drainSessionLifecycleQueue(
  input: {
    workerId?: string;
    limit?: number;
    /** Drain one freshly-enqueued callback without waiting behind older work. */
    idempotencyKey?: string;
    /** Only drain commands due before this instant — see claimDueLifecycleCommands. */
    availableBefore?: Date;
  } = {},
): Promise<{ claimed: number; succeeded: number; failed: number; queued: number; released: number }> {
  const workerId = input.workerId ?? `session-lifecycle:${process.pid}:${Date.now()}`;
  // COALESCE a burst before claiming. A targeted kick fires per POST, and the
  // composer sends a burst's POSTs concurrently — their arrival order is the
  // network's. Claiming instantly let the first arrival's batch close before
  // the rest of the burst was even durable (measured: one of four boot sends
  // delivered a step behind, out of order). A quarter second collects the
  // stragglers and is invisible next to the ~1.3 s delivery itself.
  if (input.idempotencyKey) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const rows = await claimDueLifecycleCommands({
    workerId,
    limit: input.limit ?? 10,
    idempotencyKey: input.idempotencyKey,
    availableBefore: input.availableBefore,
  });
  // A targeted claim (one POST's kick) takes exactly its own row — but the
  // rows already queued for the SAME session are this delivery's batch, and
  // leaving them to their own kicks is what delivered a burst of sends one
  // ~1.5 s round-trip at a time (and let a step boundary split the answers).
  // Sweep them in so the lane batches them below.
  if (input.idempotencyKey && rows.length > 0) {
    const sessions = [...new Set(rows.map((r) => r.sessionId).filter((v): v is string => !!v))];
    for (const sessionId of sessions) {
      const siblings = await claimDueSessionInboxSiblings({ workerId, sessionId });
      rows.push(...siblings.filter((sib) => !rows.some((r) => r.commandId === sib.commandId)));
    }
  }
  const out = { claimed: rows.length, succeeded: 0, failed: 0, queued: 0, released: 0 };

  // INSTANCE SCOPE (local dev on a shared DB — projects/instance-scope.ts).
  // A command whose session's sandbox was provisioned by ANOTHER API instance
  // goes back on the queue for that instance: executing it here would push
  // this instance's `KORTIX_URL` (its tunnel) into a box that is not ours.
  // Gated on `KORTIX_INSTANCE_ID`, so deployed environments never run the
  // lookup. Done here, after the claim and the sibling sweep, so every
  // command type and every claim path is covered.
  const mine = currentInstanceId();
  if (mine && rows.length > 0) {
    const sessionIds = [...new Set(rows.map((r) => r.sessionId).filter((v): v is string => !!v))];
    const metadataBySession =
      sessionIds.length > 0 ? await loadSandboxMetadataForSessions(sessionIds) : new Map();
    const availableAt = new Date(Date.now() + INSTANCE_RELEASE_DELAY_MS);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (!row.sessionId) continue;
      const metadata = metadataBySession.get(row.sessionId);
      if (metadata === undefined || sandboxBelongsToThisInstance(metadata)) continue;
      const owner = sandboxInstanceId(metadata);
      await releaseCommandToOwningInstance(row.commandId, { availableAt, owner }).catch((err) => {
        logger.warn('[session-lifecycle] instance-scope release failed; lock expiry will reclaim', {
          commandId: row.commandId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      logger.info('[session-lifecycle] command belongs to another instance — released', {
        commandId: row.commandId,
        sessionId: row.sessionId,
        commandType: row.commandType,
        owner,
        instance: mine,
      });
      rows.splice(i, 1);
      out.released += 1;
    }
  }

  // ONE LANE PER SESSION, and the lanes run concurrently.
  //
  // Order matters WITHIN a session and nowhere else, so that is the only order
  // kept. Draining the whole claim sequentially made every prompt in the batch
  // wait behind the slowest one, and the slowest one can be very slow:
  // `continueSession` waits up to `READY_DEADLINE_MS` (5 min) for a cold box.
  // With every user prompt in the product now going through this queue, one
  // cold boot would hold nine other people's messages for the length of it.
  const lanes = new Map<string, SessionLifecycleCommandRow[]>();
  for (const row of rows) {
    // A create has no session yet; each one is its own lane.
    const lane = row.sessionId ?? `command:${row.commandId}`;
    const existing = lanes.get(lane);
    if (existing) existing.push(row);
    else lanes.set(lane, [row]);
  }

  const runRow = async (
    row: SessionLifecycleCommandRow,
    opts: ExecuteQueuedContinueOptions = {},
  ): Promise<void> => {
    if (row.commandType === 'continue_session') {
      // Contained per row. Every row in this batch is CLAIMED (`running`), and
      // one throw escaping the loop would leave the rest of them there — a
      // state nothing reclaims until the lock expires, and one that blocks
      // every later prompt of the same session behind it.
      const outcome = await executeQueuedContinue(row, opts).catch(async (err) => {
        await markCommandFailed(
          row.commandId,
          `drain failed: ${err instanceof Error ? err.message : String(err)}`,
          { retryable: true, attempts: row.attempts, sessionId: row.sessionId },
        ).catch(() => undefined);
        return 'failed' as const;
      });
      out[outcome] += 1;
      return;
    }
    if (row.commandType !== 'create_session') {
      await markCommandFailed(row.commandId, `Unsupported command type: ${row.commandType}`, {
        retryable: false,
        attempts: row.attempts,
      });
      out.failed += 1;
      return;
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
        return;
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
  };

  await Promise.all(
    [...lanes.values()].map(async (lane) => {
      // Same-session INBOX rows go as ONE batch: the head lands first (it may
      // open the turn), then the rest mint in queue order and POST together
      // — so everything queued reaches OpenCode within one proxy round-trip
      // of the head instead of ~1.5 s apiece, and the step after the current
      // one answers all of them at once. Measured before: 4 prompts queued
      // during boot ran as 3 + 1 across two steps.
      let i = 0;
      while (i < lane.length) {
        const row = lane[i];
        if (!isInboxRow(row)) {
          await runRow(row);
          i += 1;
          continue;
        }
        let j = i + 1;
        while (j < lane.length && isInboxRow(lane[j])) j += 1;
        const sendOrder = (row: SessionLifecycleCommandRow): number => {
          const at = (row.payload as { clientSentAtMs?: unknown } | null)?.clientSentAtMs;
          // The sender tab's Enter instant when it was supplied: the POSTs of
          // two surfaces race across the boot-shell crossfade, and row
          // creation order is the race's outcome, not the user's.
          return typeof at === 'number' ? at : row.createdAt.getTime();
        };
        const batch = lane.slice(i, j).sort((a, b) => sendOrder(a) - sendOrder(b));
        i = j;
        const headDone = runRow(batch[0]);
        if (batch.length === 1) {
          await headDone;
          continue;
        }
        const rest = batch.slice(1);
        // One gate per member: the FIRST waits for the HEAD (its id is not
        // final until its delivery placed it — minting before that inverted
        // head and member on the wire), each next waits for the previous
        // member's mint; the POSTs then run concurrently.
        const gates: BatchPlacementGate[] = [];
        let previous: Promise<bigint | null> = headDone.then(
          () => null,
          () => null,
        );
        for (let k = 0; k < rest.length; k += 1) {
          let release!: (mintedTime?: bigint | null) => void;
          const mine = new Promise<bigint | null>((resolve) => {
            release = (mintedTime) => resolve(mintedTime ?? null);
          });
          gates.push({ waitTurn: previous, release });
          previous = mine;
        }
        await Promise.all([
          headDone,
          ...rest.map((member, k) =>
            runRow(member, { batch: gates[k] }).finally(() => gates[k].release()),
          ),
        ]);
      }
    }),
  );
  return out;
}

/** An inbox prompt row: a `continue_session` with the client's own
 *  submission id — what the queue strip lists and what batches. */
function isInboxRow(row: SessionLifecycleCommandRow): boolean {
  if (row.commandType !== 'continue_session') return false;
  const payload = row.payload as { clientMessageId?: unknown } | null;
  return typeof payload?.clientMessageId === 'string' && payload.clientMessageId.length > 0;
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
 *
 * T13b — why a FORWARDED row (one that stays open after a successful delivery,
 * see `markCommandForwarded`) still cannot be delivered twice. It needs no new
 * mechanism, and this is the audit:
 *
 *  - Every inbox delivery carries `Idempotency-Key: <commandId>` (`:r<n>` on a
 *    redelivery), which is `promptDeliveryKey`'s HIGHEST precedence — the
 *    wire-id and content-hash tiers are never even reached for one. Two
 *    forwards of one row therefore collide on that key and the second is
 *    answered `200 {"deduplicated":true}` for `DEDUPE_TTL_MS`.
 *  - A forwarded row is `succeeded`, and `claimDueLifecycleCommands` claims
 *    only `queued` rows plus `running` ones whose lock died. No drain can
 *    re-claim it, so there is no second forward to dedupe in the first place.
 *  - `reconcileForwardedPrompts` only ever CLOSES rows. It has no delivery
 *    path at all.
 *
 * The one shape that does re-POST is a redelivery, and it changes both halves
 * on purpose — the key (`:r<n>`) and the wire id (`remintWireMessageId`) —
 * because it is repairing a delivery the daemon proved never ran. That path is
 * guarded by the transcript read below: an assistant reply parented on any id
 * this prompt was delivered under drops the redelivery.
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
/**
 * Resolve the signed-proxy OpenCode endpoint for a queued row's session.
 *
 * The same resolution `session-transcript.ts` and `opencode-mapping.ts` use —
 * no new client. Returns null for every "cannot answer" case (no pin yet, no
 * sandbox, endpoint unresolvable) so both callers can fail OPEN on their own
 * terms.
 */
async function queuedContinueOpencodeEndpoint(row: SessionLifecycleCommandRow): Promise<{
  endpoint: { url: string; headers: Record<string, string> };
  opencodeSessionId: string;
} | null> {
  return resolveSessionOpencodeEndpoint(row.sessionId, row.actorUserId);
}

/**
 * The signed proxy endpoint + OpenCode root id for one session — the same
 * resolution every drain-side transcript read uses. Exported for the turn-end
 * reconciliation (`forwarded-strand-reconcile.ts`), which has a session, not a
 * row.
 */
export async function resolveSessionOpencodeEndpoint(
  sessionId: string | null | undefined,
  actorUserId?: string | null,
): Promise<{
  endpoint: { url: string; headers: Record<string, string> };
  opencodeSessionId: string;
} | null> {
  if (!sessionId) return null;
  const [session] = await db
    .select({
      opencodeSessionId: projectSessions.opencodeSessionId,
      sandboxUrl: projectSessions.sandboxUrl,
      accountId: projectSessions.accountId,
      projectId: projectSessions.projectId,
      createdBy: projectSessions.createdBy,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!session?.opencodeSessionId) return null;

  let externalId = externalIdFromSandboxUrlField(session.sandboxUrl);
  if (!externalId) {
    const [sandbox] = await db
      .select({ externalId: sessionSandboxes.externalId })
      .from(sessionSandboxes)
      .where(
        and(
          eq(sessionSandboxes.sessionId, sessionId),
          eq(sessionSandboxes.projectId, session.projectId),
          eq(sessionSandboxes.accountId, session.accountId),
        ),
      )
      .orderBy(desc(sessionSandboxes.updatedAt))
      .limit(1);
    externalId = sandbox?.externalId ?? null;
  }
  if (!externalId) return null;

  // The signed user context is what the daemon admits a runtime read on
  // (`verifyKortixUserContext`); with no actor the call is refused as
  // `malformed`. A caller with no row of its own (turn-end reconciliation,
  // the stop settle) reads as the session's creator.
  const endpoint = await sandboxOpencodeEndpoint(
    externalId,
    actorUserId ?? session.createdBy ?? undefined,
  );
  if (!endpoint) return null;
  return { endpoint, opencodeSessionId: session.opencodeSessionId };
}

/** What one read of the root transcript tells the drain about this prompt. */
interface InboxTranscriptState {
  /** The highest id clock on record, for placing a re-mint above it. */
  newest: bigint | null;
  /** An assistant message answers one of this prompt's delivered ids, so the
   *  turn RAN. `false` also covers "could not read" — see `read`. */
  answered: boolean;
  /** The transcript was actually read. A failed read answers nothing. */
  read: boolean;
  /** The messages the read returned (newest tail), for placement proofs. */
  tip: PlacementTipMessage[] | null;
}

/**
 * Read the root once, for the two things a delivery needs to know.
 *
 * Uses the SAME signed-proxy resolution `queuedContinueHasStagedRevert` uses —
 * no new client. Fails OPEN (`read: false`) on every error: a transient read
 * failure must never block a prompt, and every caller has its own safe default.
 */
/** Newest-N read for placement. Only the tip decides where a re-mint lands,
 *  and a first delivery has no delivered id an `answered` check could match. */
const INBOX_TRANSCRIPT_TIP_LIMIT = 8;

async function readInboxTranscriptState(
  row: SessionLifecycleCommandRow,
  deliveredIds: string[],
  opts: { full?: boolean } = {},
): Promise<InboxTranscriptState> {
  const empty: InboxTranscriptState = { newest: null, answered: false, read: false, tip: null };
  try {
    const resolved = await queuedContinueOpencodeEndpoint(row);
    if (!resolved) return empty;
    // A FULL read only when this row has already been posted once (a
    // redelivery / re-POST), where the `answered` guard needs the reply that
    // may sit anywhere in the transcript. The ordinary case — a first delivery
    // placing its id above a live turn — needs the tip only, and the full read
    // of a long session was ~1s of dead air on every queued message.
    const limit = opts.full ? '' : `&limit=${INBOX_TRANSCRIPT_TIP_LIMIT}`;
    const url = `${resolved.endpoint.url}/session/${encodeURIComponent(resolved.opencodeSessionId)}/message?directory=${encodeURIComponent(WORKSPACE)}${limit}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return empty;
    const tip = parsePlacementTip(await res.json().catch(() => null));
    if (!tip) return empty;

    const newest = newestWireIdTime(tip.map((message) => message.id));
    // Same rule the daemon's `observeOpencodeDelivery` uses: an assistant
    // message parented on the prompt is the turn having run.
    const answered = tip.some(
      (message) =>
        message.role === 'assistant' &&
        typeof message.parentID === 'string' &&
        deliveredIds.includes(message.parentID),
    );
    return { newest, answered, read: true, tip };
  } catch (err) {
    console.warn('[session-lifecycle] inbox transcript read failed — proceeding without it', {
      sessionId: row.sessionId,
      commandId: row.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
}

/**
 * How far back the inbox's own delivered ids are worth reading.
 *
 * DERIVED, not chosen: `MAX_WIRE_ID_CLOCK_CORRECTION` is the widest lift
 * `mintWireMessageId` will accept, so an id older than that cannot move a mint
 * at all. Bounding the scan to it keeps a long-lived session's row history out
 * of every re-mint, and the two cannot drift apart.
 */
const DELIVERED_WIRE_ID_FLOOR_WINDOW_MS = Number(
  MAX_WIRE_ID_CLOCK_CORRECTION / WIRE_ID_TIME_SCALE,
);

/**
 * The newest wire id THIS SESSION has already put on the wire, read from our
 * own rows rather than from OpenCode's transcript.
 *
 * The clock is decoded IN SQL rather than by sorting the ids as text: the id's
 * 12-char prefix is hex, and text ordering under a non-C collation is not the
 * ordering of the number it encodes.
 *
 * Fails OPEN (`null`), like every other read on this path: a floor that cannot
 * be read must not block a prompt, and the transcript floor still applies.
 */
async function readDeliveredWireIdFloor(
  row: SessionLifecycleCommandRow,
): Promise<bigint | null> {
  if (!row.sessionId) return null;
  // `substr(id, 5, 12)` skips the `msg_` prefix. `lpad` to 16 hex chars makes
  // the value a legal `bit(64)`, which is the only width with a bigint cast.
  const clock = (source: SQL) => sql`CASE
    WHEN ${source} ~ '^msg_[0-9a-f]{12}'
    THEN ('x' || lpad(substr(${source}, 5, 12), 16, '0'))::bit(64)::bigint
  END`;
  try {
    const [found] = await db
      .select({
        newest: sql<string | number | null>`GREATEST(
          max(${clock(sql`${sessionLifecycleCommands.payload}->>'wireMessageId'`)}),
          max(${clock(sql`${sessionLifecycleCommands.payload}->>'redeliveredMessageId'`)}),
          max(${clock(sql`${sessionLifecycleCommands.result}->>'forwarded_message_id'`)}))`,
      })
      .from(sessionLifecycleCommands)
      // Served by idx_session_lifecycle_commands_session.
      .where(
        and(
          eq(sessionLifecycleCommands.sessionId, row.sessionId),
          eq(sessionLifecycleCommands.commandType, 'continue_session'),
          gte(
            sessionLifecycleCommands.updatedAt,
            new Date(Date.now() - DELIVERED_WIRE_ID_FLOOR_WINDOW_MS),
          ),
        ),
      )
      .limit(1);
    if (found?.newest === null || found?.newest === undefined) return null;
    return BigInt(found.newest);
  } catch (err) {
    console.warn('[session-lifecycle] delivered wire-id floor read failed — using the transcript', {
      sessionId: row.sessionId,
      commandId: row.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Mint the wire id this attempt delivers with, placed above the root's newest
 * message, and persist it before the POST.
 *
 * TWO callers need this, for one reason. On a box running opencode <= 1.18.14
 * (the baked 1.17.11 on every image built before 2026-08-20) the loop resolves
 * "has this prompt already been answered?" by ID ORDER, so an id that sorts
 * below what is on record is accepted and then silently never runs. From
 * 1.18.15 the exit test is `lastAssistant.parentID === lastUser.id` and a low
 * id no longer drops the prompt — but it still places the message BELOW the
 * answer on screen, because `MessageV2.page()` orders by `time_created` then
 * `id` in both versions. Re-minting is required on the old boxes and is
 * cosmetic-but-still-wanted on the new ones:
 *
 *  - a REDELIVERY: the abandoned attempt may already have persisted its user
 *    message, and repeating that id reads as already answered;
 *  - a prompt that WAITED: the client minted its id when the user pressed
 *    Enter, and the turn it queued behind has been writing higher ids ever
 *    since. This is the ordinary case, not the exotic one — it is what "queue
 *    while busy" does on every single send.
 *
 * Persisted into `payload.redeliveredMessageId` BEFORE delivery, so a crash
 * between mint and POST reuses one id rather than minting a second.
 *
 * A FAILED transcript read still mints rather than blocking the prompt — but it
 * must not mint blind. `mintWireMessageId` backdates by `WIRE_ID_BACKDATE_MS`
 * (2 min) on purpose: too early is self-correcting when there IS a transcript
 * to lift against. With no transcript there is nothing to lift against, and
 * OpenCode mints its own ids from a raw `Date.now()` with no backdate — so the
 * fallback would land two minutes BELOW every message the box wrote in the last
 * two minutes, which is the exact silent drop this function exists to prevent.
 * The un-backdated clock is the floor instead. An unreadable box is also the
 * commonest trigger for a redelivery, so this path is not the exotic one.
 */
async function remintWireMessageId(
  row: SessionLifecycleCommandRow,
  payload: QueuedContinueSessionPayload,
  transcript: InboxTranscriptState,
  /** A batch member's hard floor: the PREVIOUS member's minted clock, so the
   *  batch's ids are strictly ascending in send order — a skew sample landing
   *  mid-batch made two members mint on different rules and swap. */
  batchFloor: bigint | null = null,
): Promise<string> {
  const submitted = wireIdTime(payload.wireMessageId ?? '');
  const floor = transcript.read
    ? transcript.newest
    : // OpenCode's own minting rule, so an id it wrote a second ago is still
      // beaten: `Date.now()` scaled into the id clock, with no backdate.
      (BigInt(Date.now()) * WIRE_ID_TIME_SCALE) & WIRE_ID_TIME_MASK;
  // THE TRANSCRIPT IS NOT THE ONLY FLOOR — it lags. OpenCode persists a
  // mid-turn user message ~4s after the POST (measured against a real sandbox
  // in `integration-inbox-midturn-forward.test.ts`), and two prompts sent
  // inside that window read the SAME `newest` and mint the SAME clock. The
  // user's own two messages then sort by 14 random base62 characters: either
  // they run in the wrong order, or the loser sorts under an assistant reply
  // and OpenCode reads it as already answered and never runs it. The inbox
  // already knows every id it put on the wire; that is the missing floor.
  const delivered = await readDeliveredWireIdFloor(row);
  let known = delivered !== null && (floor === null || delivered > floor) ? delivered : floor;
  if (batchFloor !== null && (known === null || batchFloor > known)) known = batchFloor;
  const newest = known !== null && (submitted === null || known > submitted) ? known : submitted;

  // Placed at the BOX's clock "now" when it is known (see forwarded-placement
  // .ts): newest+1 is only safe while nothing else is minting, and a live turn
  // mints an assistant id at every step boundary.
  const minted = mintLivePlacement({
    nowMs: Date.now(),
    newestKnownTime: newest,
    boxSkewMs: row.sessionId ? boxClockSkewMs(row.sessionId) : null,
  });
  if (newest !== null && minted.time <= newest) {
    // The lift refused: `MAX_WIRE_ID_CLOCK_CORRECTION` (1h) caps how far a
    // transcript may drag an id, and past that cap the id we are about to send
    // sorts BELOW what is on record.
    //
    // WHAT THAT COSTS DEPENDS ON THE BOX'S OPENCODE VERSION, so this is a WARN
    // and not an ERROR, and it no longer claims the turn is lost:
    //  - opencode <= 1.18.14 (baked 1.17.11): the loop's exit check is an id
    //    compare, so the prompt is read as already answered and the turn does
    //    not run. Nothing here can repair that; `forwarded-strand-reconcile`
    //    picks it up at turn end.
    //  - opencode >= 1.18.15: the exit check is
    //    `lastAssistant.parentID === lastUser.id`. The turn RUNS. The only
    //    damage is transcript position — the message renders below the answer
    //    that precedes it, because `MessageV2.page()` orders by `time_created`.
    // Reported either way, because a refused lift always means the clock
    // estimate is wrong by more than an hour.
    logger.warn('[session-lifecycle] re-minted wire id could not clear the transcript', {
      session_id: row.sessionId,
      command_id: row.commandId,
      minted_time: minted.time.toString(),
      newest_known_time: newest.toString(),
      transcript_read: transcript.read,
    });
  }
  try {
    await db
      .update(sessionLifecycleCommands)
      .set({
        payload: withRemintedWireId(minted.id),
        updatedAt: new Date(),
      })
      .where(eq(sessionLifecycleCommands.commandId, row.commandId));
  } catch (err) {
    // Losing the persist costs a re-mint on the next attempt, nothing more.
    // Throwing here would abandon a CLAIMED row in `running`, where nothing
    // reclaims it until its lock expires.
    console.warn('[session-lifecycle] could not persist the re-minted wire id', {
      sessionId: row.sessionId,
      commandId: row.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return minted.id;
}

/** How many times one delivery re-places itself before leaving the rest to
 *  turn-end reconciliation. Each round is one tip read + one DELETE + one POST
 *  — a second strand in a row means step boundaries are landing inside every
 *  window, and the turn-end net is the cheaper place to catch it. */
const MAX_LIVE_PLACEMENT_REPAIRS = 2;

/**
 * Read the tip once after a live-turn delivery and say whether the prompt
 * landed where the loop will run it — see `strandedPlacement`. Also takes the
 * box-clock sample the next placement for this session mints from.
 *
 * Fails OPEN as "not stranded": an unreadable tip proves nothing, and the
 * turn-end reconciliation re-asks the question with the same predicate.
 */
async function verifyLivePlacement(
  row: SessionLifecycleCommandRow,
  wireMessageId: string,
  postedAtMs: number,
): Promise<{ stranded: boolean; strandedBy: string | null; newest: bigint | null }> {
  const ackAtMs = Date.now();
  const transcript = await readInboxTranscriptState(row, [wireMessageId]);
  if (!transcript.read || !transcript.tip) return { stranded: false, strandedBy: null, newest: null };
  const verdict = strandedPlacement(transcript.tip, wireMessageId);
  if (row.sessionId && verdict.createdMs !== null && verdict.createdMs >= postedAtMs - 60_000) {
    // The box stamped `created` somewhere between our POST and its ack; the
    // ack is the conservative pairing (see `noteBoxClockSample`).
    noteBoxClockSample(row.sessionId, verdict.createdMs, ackAtMs);
  }
  return { stranded: verdict.stranded, strandedBy: verdict.strandedBy, newest: verdict.newest };
}

/** Is a forwarded/queued inbox row of this session NEWER than `row` already
 *  on the wire (or in line)? Then `row`'s send order is pinned by it. */
async function hasLaterForwardedSibling(row: SessionLifecycleCommandRow): Promise<boolean> {
  if (!row.sessionId) return false;
  try {
    const [later] = await db
      .select({ commandId: sessionLifecycleCommands.commandId })
      .from(sessionLifecycleCommands)
      .where(
        and(
          eq(sessionLifecycleCommands.sessionId, row.sessionId),
          eq(sessionLifecycleCommands.commandType, 'continue_session'),
          sql`${sessionLifecycleCommands.payload}->>'clientMessageId' IS NOT NULL`,
          sql`${sessionLifecycleCommands.createdAt} > ${row.createdAt.toISOString()}::timestamptz`,
          or(
            inArray(sessionLifecycleCommands.status, ['queued', 'running']),
            sql`${sessionLifecycleCommands.result}->>'status' = 'forwarded'`,
          ),
        ),
      )
      .limit(1);
    return !!later;
  } catch {
    return false; // fail open: a solo repair is better than none
  }
}

/**
 * Delete a stranded user message from the root transcript, so the re-placed
 * copy is the only one OpenCode — and the model — holds. `true` only on a
 * confirmed 2xx (or a 404: already gone).
 */
async function removeStrandedOpencodeMessage(
  row: SessionLifecycleCommandRow,
  wireMessageId: string,
): Promise<boolean> {
  try {
    const resolved = await queuedContinueOpencodeEndpoint(row);
    if (!resolved) return false;
    const url = `${resolved.endpoint.url}/session/${encodeURIComponent(resolved.opencodeSessionId)}/message/${encodeURIComponent(wireMessageId)}?directory=${encodeURIComponent(WORKSPACE)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok || res.status === 404) return true;
    // 409 = the loop is running (`assertNotBusy`); expected mid-turn.
    if (res.status !== 409) {
      console.warn('[session-lifecycle] stranded message delete refused', {
        sessionId: row.sessionId,
        commandId: row.commandId,
        status: res.status,
        body: (await res.text().catch(() => '')).slice(0, 200),
      });
    }
    return false;
  } catch (err) {
    console.warn('[session-lifecycle] stranded message delete threw', {
      sessionId: row.sessionId,
      commandId: row.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Mint the id a REPAIR goes out under — above the assistant that proved the
 * strand — and persist it with the next delivery attempt BEFORE the POST, for
 * the same crash-safety reason `remintWireMessageId` persists first.
 */
async function remintForRepair(
  row: SessionLifecycleCommandRow,
  newestKnownTime: bigint | null,
): Promise<string> {
  const minted = mintLivePlacement({
    nowMs: Date.now(),
    newestKnownTime,
    boxSkewMs: row.sessionId ? boxClockSkewMs(row.sessionId) : null,
  });
  try {
    await db
      .update(sessionLifecycleCommands)
      .set({
        payload: withNextDeliveryAttempt(withRemintedWireId(minted.id)),
        updatedAt: new Date(),
      })
      .where(eq(sessionLifecycleCommands.commandId, row.commandId));
  } catch (err) {
    console.warn('[session-lifecycle] could not persist the re-placed wire id', {
      sessionId: row.sessionId,
      commandId: row.commandId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return minted.id;
}

async function queuedContinueHasStagedRevert(row: SessionLifecycleCommandRow): Promise<boolean> {
  if (!row.sessionId) return false;
  try {
    const resolved = await queuedContinueOpencodeEndpoint(row);
    if (!resolved) return false;
    const { endpoint, opencodeSessionId } = resolved;

    const url = `${endpoint.url}/session/${encodeURIComponent(opencodeSessionId)}?directory=${encodeURIComponent(WORKSPACE)}`;
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

/**
 * How one row of a same-session BATCH (see the drain's lane runner)
 * coordinates with the rows before it: it waits its turn to MINT (so ids come
 * out in queue order), releases the next row the moment its id is final, and
 * then POSTs concurrently with everyone else.
 */
export interface BatchPlacementGate {
  /** Resolves with the previous member's minted id clock (null for the first
   *  member after the head) — this member's mint floor, so batch ids are
   *  strictly ascending in send order whatever the skew cache says. */
  waitTurn: Promise<bigint | null>;
  release: (mintedTime?: bigint | null) => void;
}

export interface ExecuteQueuedContinueOptions {
  /** A member of a same-session batch after the head: admission is the
   *  batch's own ordering, and the id is placed as into a LIVE turn (the head
   *  opened one) and proven afterwards. */
  batch?: BatchPlacementGate;
}

export async function executeQueuedContinue(
  row: SessionLifecycleCommandRow,
  opts: ExecuteQueuedContinueOptions = {},
): Promise<'succeeded' | 'queued' | 'failed'> {
  const payload = row.payload as unknown as QueuedContinueSessionPayload;
  const text = typeof payload.text === 'string' ? payload.text : '';
  // TEXT OR PARTS. An attachment-only prompt carries no text at all — the
  // composer allows it and the POST route accepts it on exactly that basis — so
  // requiring text here would turn a 202 into a permanently dead row (and, via
  // the dead-letter, park the user's session `failed`).
  const hasBody = !!text || (payload.parts?.length ?? 0) > 0;
  if (!row.sessionId || !hasBody) {
    await markCommandFailed(row.commandId, 'continue_session command missing sessionId or body', {
      retryable: false,
      attempts: row.attempts,
    });
    return 'failed';
  }

  // ADMISSION FIRST, before any side effect. A prompt that arrives behind an
  // older prompt of its own session — or beside a sibling already on the wire —
  // waits, so the user's messages keep the order they were typed in. A live
  // turn is NOT one of those reasons any more. The refusal gives the claim's
  // attempt increment back, so waiting can never dead-letter a prompt.
  //
  // Wrapped: this row is CLAIMED (`running`), and a read that throws out of
  // here would strand it there — where nothing reclaims it until its lock
  // expires, while `older_prompt_pending` blocks every later prompt of the
  // session behind it. A failed read is a retryable failure, not a wedge.
  // Delivery timeline: one structured line per row (`[provision-timeline]
  // deliver <commandId>`), so "how long did a send take, and where" is a log
  // read instead of a guess. Same shape as the provision timeline.
  const tl = new ProvisionTimeline(row.commandId, 'deliver');
  let admission: Awaited<ReturnType<typeof admitInboxPrompt>>;
  try {
    // A batch member's ordering IS the batch: the lane minted the rows before
    // it first (see the gate below), so the admission read — "is an older
    // prompt of this session in flight?" — would only ever refuse it for the
    // siblings it is being delivered with.
    admission = opts.batch ? { admit: true } : await admitInboxPrompt(row);
    tl.mark('admission');
  } catch (err) {
    await markCommandFailed(
      row.commandId,
      `admission check failed: ${err instanceof Error ? err.message : String(err)}`,
      { retryable: true, attempts: row.attempts, sessionId: row.sessionId },
    );
    return 'failed';
  }
  if (!admission.admit) {
    try {
      await requeueForAdmission(
        row.commandId,
        admission.reason,
        new Date(Date.now() + admission.retryAfterMs),
      );
    } catch (err) {
      await markCommandFailed(
        row.commandId,
        `admission requeue failed: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true, attempts: row.attempts, sessionId: row.sessionId },
      );
      return 'failed';
    }
    return 'queued';
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

  // DID THIS ROW WAIT?
  //
  // `payload.remintOnDelivery` is the DURABLE half of "this row waited".
  // `result.admission_reason` is the display half, and it is cleared wholesale
  // by `retryInboxPrompt` — which runs on "send now", i.e. exactly on the row
  // that waited longest. Reading only the display half sent that row under the
  // id minted when the user pressed Enter, and OpenCode read it as answered.
  //
  // Read here, above the staged-revert guard, because both questions turn on
  // it: which wire id this attempt delivers with, and whether this row is
  // allowed to commit a revert.
  const waited =
    payload.remintOnDelivery === true ||
    typeof (row.result as { admission_reason?: unknown } | null)?.admission_reason === 'string';
  // `result.promoted` is written by `retryInboxPrompt` alone — the user pointed
  // at ONE row and pressed "send now". `requeueForAdmission` merges into
  // `result`, so it survives the row waiting again behind a live turn.
  const promoted = (row.result as { promoted?: unknown } | null)?.promoted === true;

  // WHICH ROW MAY COMMIT A STAGED REVERT.
  //
  // The guard exists (JAY-600/T22) for the approval-resume / trigger backstop:
  // a continue queued BEFORE the user staged a revert is void for the rewound
  // trajectory, and delivering it commits the truncation under a prompt the
  // user wrote against the trajectory that is being discarded.
  //
  // The REPLACEMENT prompt is the exact opposite. "Edit from this message"
  // stages the revert and prefills the composer with that message; the prompt
  // the user then sends IS what commits it. OpenCode truncates on the next
  // delivery, from any producer — that is the whole mechanism. Running the
  // guard on it marked the row `succeeded/skipped:staged_revert`, and
  // `listInboxPrompts` omits succeeded rows, so the replacement prompt
  // disappeared with no error, no turn and no reply — and so did every prompt
  // after it, because nothing else clears `info.revert`.
  //
  // `payload.clientMessageId` does NOT separate those two: a composer prompt
  // queued while the session was busy carries one too. Whether the row WAITED
  // does. A revert can only be staged on an IDLE session (`session.rewind()`
  // refuses a working one), so a row that was refused admission or held by Stop
  // predates the idle window this revert was staged in; the replacement prompt
  // is sent INTO that window and goes out on its first claim. `promoted` beats
  // both — "send now" names one row explicitly, and without that escape a
  // refused row could never be retried, because retrying re-stamps the very
  // marker the refusal reads.
  const mayCommitStagedRevert = !!payload.clientMessageId && (promoted || !waited);
  // Two independent reads of the same box — the staged-revert flag and the
  // transcript tip (below) — used to run one after the other. Started here,
  // awaited together: they cost one round-trip instead of two.
  const stagedRevertPromise = mayCommitStagedRevert
    ? Promise.resolve(false)
    : queuedContinueHasStagedRevert(row);
  /** The row is behind a staged revert: fail or skip it, per the producer. */
  const settleStagedRevert = async (): Promise<'succeeded' | 'failed' | null> => {
    // A COMPOSER prompt is failed, never dropped. `listInboxPrompts` keeps
    // `failed`/`dead_lettered` rows, so the user's text stays on screen with
    // its reason and a retry button that promotes it past this guard. Silently
    // marking it succeeded is how the message was lost. `markCommandFailed`
    // does not park a session for an inbox row, so nothing else is taken away.
    if (payload.clientMessageId) {
      await markCommandFailed(
        row.commandId,
        'queued before the session was rewound — send it again to run it',
        { retryable: false, attempts: row.attempts, sessionId: row.sessionId },
      );
      return 'failed';
    }
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
  };

  // WHICH WIRE ID THIS ATTEMPT DELIVERS WITH.
  //
  // The client's id is used verbatim only when it is still correctly placed:
  // this prompt goes out on its first claim, into a session that has written
  // nothing since the user pressed Enter. Three things invalidate it, and all
  // three are ordinary rather than exotic:
  //
  //  - a TURN IS LIVE. The turn has been writing higher ids since it started,
  //    and the client's id is its browser's clock with no lift against anything
  //    (`ascendingId`), so a browser running behind the sandbox delivers an id
  //    that sorts BELOW them — which OpenCode accepts and silently never runs.
  //    This is the flagship "type while it works" path. It used to re-mint by
  //    being REFUSED admission (`turn_active` stamped `remintOnDelivery`); with
  //    the refusal gone it has to ask the question directly;
  //  - the prompt WAITED (`result.admission_reason` is stamped by every
  //    admission refusal), so something else held the wire while ids moved on;
  //  - the prompt is a REDELIVERY. The abandoned attempt may already have
  //    persisted its user message under that id.
  //
  // All three re-mint against the root's current newest id, from ONE read that
  // also answers "did this prompt already run?".
  //
  // The authority read is wrapped: it is one indexed row, and a read that
  // throws must not strand a CLAIMED row. Unreadable means UNPROVEN, so it
  // re-mints — one transcript read, against a placement bug that loses the
  // user's message with nothing but a server-side log to show for it.
  const redeliveries = Number(payload.redeliveries ?? 0);
  // How many times this row has already been POSTed. Every one of them is a
  // reason to re-mint, for the same reason a redelivery is: OpenCode already
  // holds a message under the previous id.
  const deliveryAttempt = Number(payload.deliveryAttempt ?? 0);
  // Asked only when nothing else has already decided to re-mint, and only for a
  // row that HAS a client id to be wrong about: an automation prompt carries
  // none, and every id-less producer would pay for this read for nothing.
  const remintKnown = deliveryAttempt > 0 || redeliveries > 0 || waited;
  let turnLive = false;
  // The head of the batch landed and opened a turn (or joined the live one);
  // every row after it is placed as into a live turn, by definition.
  let batchFloor: bigint | null = null;
  if (opts.batch) {
    batchFloor = await opts.batch.waitTurn;
    tl.mark('batch-turn');
    turnLive = true;
  }
  if (payload.wireMessageId && !remintKnown && !opts.batch) {
    try {
      turnLive = await sessionHoldsLiveTurn(row.sessionId);
    } catch (err) {
      console.warn('[session-lifecycle] turn-authority read failed — re-minting the wire id', {
        sessionId: row.sessionId,
        commandId: row.commandId,
        error: err instanceof Error ? err.message : String(err),
      });
      turnLive = true;
    }
  }
  let wireMessageId = payload.wireMessageId;
  /** Deliberately placed BELOW an open sibling — the sibling's step answers
   *  it, and the post-insert strand proof must not "repair" it to the top. */
  let underPlaced = false;
  if (payload.wireMessageId && (remintKnown || turnLive)) {
    const deliveredIds = [
      payload.wireMessageId,
      payload.redeliveredMessageId,
      // EVERY id a re-mint placed this row under, not just the latest: a reply
      // parented on an EARLIER re-minted id proves the prompt was answered just
      // as well, and after two re-mints the scalar no longer holds that id.
      ...(payload.redeliveredMessageIds ?? []),
    ].filter((id): id is string => typeof id === 'string' && id.length > 0);
    const transcriptPromise = readInboxTranscriptState(row, deliveredIds, {
      full: deliveryAttempt > 0 || redeliveries > 0,
    });
    // The staged-revert answer lands while the tip read is in flight.
    const stagedRevertEarly = await stagedRevertPromise;
    if (stagedRevertEarly) {
      const settled = await settleStagedRevert();
      if (settled) {
        opts.batch?.release();
        return settled;
      }
    }
    const transcript = await transcriptPromise;
    tl.mark('transcript-read');
    // The already-answered guard is not redelivery-only. Every re-mint path
    // re-reads the transcript, and an assistant reply parented on one of THIS
    // prompt's delivered ids proves the same thing on all of them: the turn
    // ran. (On a first delivery no id was ever posted, so this cannot fire.)
    if (transcript.read && transcript.answered) {
      // The record said `delivering`, but that only ever proved the ACCEPTANCE
      // write never landed. An assistant reply under this prompt proves the
      // turn ran, so re-sending it would run the user's message — and spend a
      // second real LLM turn — twice.
      console.warn('[session-lifecycle] dropping delivery — the prompt was already answered', {
        sessionId: row.sessionId,
        commandId: row.commandId,
        redeliveries,
      });
      await markCommandSucceeded(
        row.commandId,
        { status: 'skipped', reason: 'already_answered' },
        row.sessionId,
      );
      opts.batch?.release();
      return 'succeeded';
    }
    // A LATE delivery does not always go to the top. When the transcript
    // still holds an OPEN sibling above this prompt's original id — placed,
    // unanswered — the original id slots the prompt into its SEND position,
    // and that sibling's step answers both (OpenCode hands the model the
    // whole transcript). Re-minting was what put a delayed message below its
    // answer— and a re-mint here put it visually LAST when it was sent
    // first. Only a first delivery may do this: a re-POST's original id may
    // already be persisted.
    if (
      !opts.batch &&
      deliveryAttempt === 0 &&
      redeliveries === 0 &&
      payload.wireMessageId &&
      transcript.read &&
      transcript.tip &&
      openUserAbove(transcript.tip, payload.wireMessageId)
    ) {
      wireMessageId = payload.wireMessageId;
      underPlaced = true;
      tl.mark('under-placed');
    } else {
      wireMessageId = await remintWireMessageId(row, payload, transcript, batchFloor);
      tl.mark('remint');
    }
  }
  // The id is final: the next batch member may mint above it.
  opts.batch?.release(wireMessageId ? wireIdTime(wireMessageId) : null);

  {
    const stagedRevertLate = await stagedRevertPromise;
    tl.mark('staged-revert');
    if (stagedRevertLate) {
      const settled = await settleStagedRevert();
      if (settled) return settled;
    }
  }

  // Did this delivery go into a turn that was LIVE when it left? Then the
  // placement has to be PROVEN, not assumed — see forwarded-placement.ts.
  const placedIntoLiveTurn = !!wireMessageId && (turnLive || remintKnown);
  try {
    let attempt = deliveryAttempt;
    let delivery: SessionDeliveryOutcome = 'pending';
    for (let round = 0; ; round += 1) {
      const postedAt = Date.now();
      delivery = await continueSession(
        {
          source: row.source as SessionInvocationSource,
          sessionId: row.sessionId,
          text,
          userId: row.actorUserId,
          ...(payload.parts?.length ? { parts: payload.parts } : {}),
          ...(payload.overrides ? { overrides: payload.overrides } : {}),
          ...(wireMessageId ? { wireMessageId } : {}),
        },
        // F2: stable across every drain-and-retry of THIS row — see
        // `postPrompt`'s F2 note. Two DIFFERENT queued commands (distinct
        // `commandId`s) with identical text now deliver independently instead
        // of the second silently deduping against the first.
        //
        // A ROW THAT ALREADY WENT OUT suffixes it: the previous attempt's
        // 10-minute dedupe claim is still live in the proxy, and reusing the key
        // would let that claim swallow the delivery meant to replace it — a
        // `200 {"deduplicated": true}` that `postPrompt` reads as delivered.
        // Still stable across `deliverWithRetry`'s inner retries, which is what
        // the claim is for.
        //
        // `deliveryAttempt`, not `redeliveries`: a released Stop and a "send now"
        // on a stop-paused row are re-POSTs too, and neither is a reaper
        // redelivery. See `withNextDeliveryAttempt`.
        attempt > 0 ? `${row.commandId}:r${attempt}` : row.commandId,
        tl,
      );
      tl.mark('delivered');
      if (delivery !== 'delivered') break;
      // DELIVERED IS NOT CONSUMED. OpenCode persists the prompt and queues it
      // behind the turn in flight, so the row stays OPEN — see
      // `markCommandForwarded` — until `session_turns` names this wire id.
      //
      // Only a row that HAS a wire id can be tracked that way. Every automation
      // producer (triggers, Slack, approval-resume) leaves `messageID` off the
      // body entirely (`postPrompt`), so the ledger has nothing to key its
      // confirmation on and the row would hang for ever. Those close here, as
      // they always did.
      if (wireMessageId) {
        await markCommandForwarded(row.commandId, row.sessionId, wireMessageId);
      } else {
        await markCommandSucceeded(row.commandId, { status: 'delivered' }, row.sessionId);
      }
      tl.mark('marked');
      if (!placedIntoLiveTurn || !wireMessageId) break;
      // PROOF. One tip read after the insert answers exactly whether the box
      // created a newer assistant BEFORE this prompt landed (the strand
      // signature). It also hands back the box's own `time.created` for the
      // message, which calibrates the next placement for this session.
      const proof = await verifyLivePlacement(row, wireMessageId, postedAt);
      tl.mark('placement-proof');
      if (underPlaced) break; // below an open sibling by design — its step answers this
      if (!proof.stranded) break;
      // A later sibling already on the wire pins this row's ORDER: repairing
      // solo would re-mint it above the sibling and OpenCode would answer them
      // inverted. The turn-end reconciliation re-places the whole tail in
      // send order instead.
      if (await hasLaterForwardedSibling(row)) {
        logger.info(
          '[session-lifecycle] stranded prompt has later siblings — turn-end reconciliation will re-place the tail in order',
          { session_id: row.sessionId, command_id: row.commandId, wire_message_id: wireMessageId },
        );
        break;
      }
      if (round >= MAX_LIVE_PLACEMENT_REPAIRS) {
        logger.error(
          '[session-lifecycle] forwarded prompt still stranded after repairs — leaving it to turn-end reconciliation',
          {
            session_id: row.sessionId,
            command_id: row.commandId,
            wire_message_id: wireMessageId,
            stranded_by: proof.strandedBy,
          },
        );
        break;
      }
      // REPAIR: take the stranded copy out of the transcript, place again
      // above the assistant that proves the strand, and go round once more.
      // The stale message must go first: OpenCode would otherwise hold the
      // prompt twice, and the model would read it twice.
      //
      // OpenCode refuses a message delete WHILE THE LOOP RUNS
      // (`deleteMessage` → `assertNotBusy`), and a strand is, almost by
      // definition, detected while it runs. So this repair fires only when
      // the step already ended between the insert and the proof; the
      // ordinary case is handed to turn-end reconciliation
      // (forwarded-strand-reconcile.ts), which runs the same repair the
      // moment the daemon relays the turn's end — before the box is idle
      // long enough for anyone to notice.
      const removed = await removeStrandedOpencodeMessage(row, wireMessageId);
      if (!removed) {
        logger.info(
          '[session-lifecycle] stranded prompt detected mid-turn — turn-end reconciliation will re-place it',
          {
            session_id: row.sessionId,
            command_id: row.commandId,
            wire_message_id: wireMessageId,
            stranded_by: proof.strandedBy,
          },
        );
        break;
      }
      const replaced = await remintForRepair(row, proof.newest);
      attempt += 1;
      logger.warn('[session-lifecycle] forwarded prompt landed below a newer assistant — re-placed', {
        session_id: row.sessionId,
        command_id: row.commandId,
        stranded_wire_id: wireMessageId,
        stranded_by: proof.strandedBy,
        replaced_wire_id: replaced,
        round: round + 1,
      });
      wireMessageId = replaced;
    }
    if (delivery === 'delivered') {
      // CHAIN. This row is on the wire, so the session's next queued row is
      // admissible NOW — do not leave it to the scheduler tick or to whatever
      // `requeueForAdmission` backoff it accrued while waiting on this one.
      // Fire-and-forget: the drain re-runs admission itself, so a kick that
      // loses a race is a no-op, and a lost kick falls back to the tick.
      void promoteNextInboxRow(row.sessionId)
        .then((key) => (key ? drainSessionLifecycleQueue({ idempotencyKey: key }) : null))
        .catch(() => undefined);
      tl.log({ sessionId: row.sessionId, source: row.source, outcome: delivery });
      return 'succeeded';
    }
    tl.log({ sessionId: row.sessionId, source: row.source, outcome: delivery });
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

function isRetryableCreateError(status?: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * The delivery target for a session whose box is ALREADY awake, from the DB
 * alone — or null, which means "take the full open path". Cheap: two indexed
 * reads, no provider or daemon round-trip.
 */
async function awakeDeliveryTarget(sessionId: string): Promise<DeliveryTarget | null> {
  const [session] = await db
    .select({
      status: projectSessions.status,
      opencodeSessionId: projectSessions.opencodeSessionId,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!session || session.status !== 'running' || !session.opencodeSessionId) return null;
  const [box] = await db
    .select({ status: sessionSandboxes.status, externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  if (!box || box.status !== 'active' || !box.externalId) return null;
  return {
    stage: 'ready',
    externalId: box.externalId,
    opencodeSessionId: session.opencodeSessionId,
  };
}

function sandboxExternalId(
  result: NonNullable<Awaited<ReturnType<typeof openSession>>>,
): string | null {
  return (result.sandbox as { external_id?: string } | null)?.external_id ?? null;
}

function isProviderName(value: string | null): value is ProviderName {
  return value === 'daytona' || value === 'platinum' || value === 'e2b';
}

/**
 * The wire `messageID` is SUPPLIED, never minted here.
 *
 * OpenCode orders its transcript by `time_created` then by the id's clock
 * prefix (`MessageV2.page()`, unchanged across 1.17.11 and 1.18.19), so an id
 * has to be placed above everything already on record. On a box running
 * opencode <= 1.18.14 that placement is also what decides "has this prompt
 * already been answered?" — the loop's exit check is an id compare there, and
 * a badly placed id means the turn never runs. From 1.18.15 the exit check is
 * `lastAssistant.parentID === lastUser.id`, so a bad id costs display order
 * rather than the turn. The process holding the transcript is the
 * one that can place it: the browser/CLI for a first delivery, and the
 * redelivery path here — which re-reads the transcript before it re-mints (see
 * `remintWireMessageId`). Every other producer (triggers, Slack, approval
 * resume) still sends no `messageID`, exactly as before, and gets a
 * root-scoped turn.
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
  /** The full prompt body + picks + wire id, when the producer supplied them. */
  prompt?: {
    parts?: PromptPartWire[];
    overrides?: PromptOverridesWire;
    wireMessageId?: string;
  },
): Promise<boolean> {
  const parts: PromptPartWire[] =
    prompt?.parts && prompt.parts.length > 0 ? prompt.parts : [{ type: 'text', text }];
  const overrides = prompt?.overrides;
  const body = new TextEncoder().encode(
    JSON.stringify({
      ...(prompt?.wireMessageId ? { messageID: prompt.wireMessageId } : {}),
      parts,
      ...(overrides?.agent ? { agent: overrides.agent } : {}),
      ...(overrides?.model ? { model: overrides.model } : {}),
      ...(overrides?.variant ? { variant: overrides.variant } : {}),
    }),
  );
  try {
    const res = await forwardToSandbox(
      externalId,
      DAEMON_PORT,
      {
        kind: 'principal',
        userId,
        callerSessionId,
        // A real Kortix session id (the session this prompt is FOR), so it is
        // also the correct agent binding.
        boundCredentialSessionId: callerSessionId,
        sandboxAuthored: false,
      },
      'POST',
      `/session/${encodeURIComponent(opencodeSessionId)}/prompt_async`,
      // The producer's own directory when it named one, so a project-scoped
      // agent resolves the same way it does on a direct browser send.
      `?directory=${encodeURIComponent(overrides?.directory || WORKSPACE)}`,
      new Headers({
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        // The inbox placed this wire id against the transcript itself (see
        // `remintWireMessageId`), so the proxy's own placement read
        // (`prompt-wire-id-repair.ts`) has nothing to add — one fewer sandbox
        // round-trip per queued message. Direct clients never send this.
        ...(prompt?.wireMessageId ? { [WIRE_ID_PLACED_HEADER]: '1' } : {}),
      }),
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

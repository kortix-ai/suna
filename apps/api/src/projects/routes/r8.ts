import { checkBillingActive } from '../../billing/services/billing-gate';
import { config, type SandboxProviderName } from '../../config';
import { auth, errors, json } from '../../openapi';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import {
  getCrById,
  getNextCrNumber,
  recordRequestedChange,
  serializeChangeRequest,
} from '../change-requests';
import {
  getBranchDiff,
  getDiffBetweenShas,
  invalidateProjectMirror,
  previewMerge,
  resolveBranchAheadState,
} from '../git';
import { createRoute, z } from '@hono/zod-openapi';
import {
  changeRequests,
  projectSessions,
  type sessionLifecycleCommands,
  sessionSandboxes,
} from '@kortix/db';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import {
  assertAgentSessionWorkspaceAllowsRepository,
  assertProjectCapability,
  loadProjectForUser,
  loadVisibleSession,
  sessionIsTombstoned,
} from '../lib/access';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { assertAgentScope, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { resolveChangeRequestBase } from '../change-request-policy';
import { PROJECT_ACTIONS } from '../../iam';
import { callerKortixSessionId } from '../lib/caller-session';
import { sandboxTokenMayActOnSession } from '../lib/sandbox-token-session';
import { AnyObject, ChangeRequestSchema, SessionStartResultSchema, projectsApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';
import { UUID_V4_REGEX, normalizeString, readBody } from '../lib/serializers';
import {
  continueSession,
  deleteInboxPrompt,
  drainSessionLifecycleQueue,
  enqueueContinueSessionCommand,
  holdInboxPrompts,
  listInboxPrompts,
  releaseInboxHold,
  restartSession,
  retryInboxPrompt,
  startSession,
  stopSession,
} from '../session-lifecycle';
import { settleInboxHoldAfterStopInBackground } from '../session-lifecycle/inbox-hold-settle';
import { cancelForwardedPrompt, findInboxRowIdByMessageId } from '../session-lifecycle/cancel-forwarded';
import {
  flattenPromptText,
  sanitizeInboxPromptParts,
} from '../session-lifecycle/prompt-parts';
import { isWarmProjectSession } from '../lib/warm-sessions';
import { dropWarmSessionMarkerOnAdopt } from './warm-sessions';
import { refreshCrTips } from './shared';
import { readSessionTurnState } from '../lib/session-turn-read';
import {
  type PromptRow,
  promptState,
  serializePrompt,
} from '../lib/session-prompt-view';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';

// POST /v1/projects/:projectId/sessions/:sessionId/start
// THE unified session-open endpoint. One idempotent call that provisions a
// missing sandbox, resumes a hibernated/idle one, and resolves the OpenCode pin
// once reachable — returning a single readiness payload { stage, sandbox,
// opencode_session_id, retriable } the client polls until stage='ready'.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/start',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/start',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(SessionStartResultSchema, 'Session readiness payload'),
      ...errors(400, 402, 404),
    },
  }),
  async (c) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    // Floor 'session' (= project.session.start) so the human gate matches
    // restart/stop and a custom role that withholds session.start is denied here
    // (was 'read', which let any project-reader start sessions).
    // Every millisecond here is in front of the provider call, so a resume can
    // never be faster than this prologue. Instrumented for the same reason
    // provisioning is: without per-step marks, "start is slow" is unactionable.
    const stl = new ProvisionTimeline(sessionId, 'session-start');
    const loaded = await loadProjectForUser(c, projectId, 'session');
    stl.mark('project-loaded');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Per-agent gate: resuming a session provisions compute. A scoped agent
    // token must hold project.session.start (no-op for human/PAT tokens).
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
    stl.mark('session-loaded');
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // A deleted session must not answer `stage: "stopped"` — that reads as
    // restartable and the UI offers a Restart that can never work. 404, the
    // same answer the read-by-id gives (see sessionIsTombstoned).
    if (sessionIsTombstoned(visible.row)) return c.json({ error: 'Not found' }, 404);
    // The agent this session will actually run has to still be one the caller
    // may run — grants change after a session is created, and `/start` is what
    // resumes a hibernated box days later. The session's stored `agent_name`
    // may also be the `default` sentinel, which resolves here to the manifest
    // default rather than being waved through unchecked.
    await resolveAndAuthorizeAgent(c, loaded, projectId, null, visible.row.agentName);
    stl.mark('agent-authorized');

    // Adoption (JAY-599/T21): a still-warm row (pre-created, never prompted)
    // stops being speculative the instant a user's tab calls /start on it —
    // see dropWarmSessionMarkerOnAdopt for why this is safe unconditionally.
    // Independent of billing/provisioning below: it is a metadata fact about
    // this row, not a spend, so it lands even if the billing gate rejects the
    // resume that follows.
    if (isWarmProjectSession(visible.row.metadata)) {
      await dropWarmSessionMarkerOnAdopt(sessionId);
      stl.mark('warm-adopted');
    }

    // Same gate as wake/create: resuming or provisioning spends compute.
    const billing = await checkBillingActive(loaded.row.accountId);
    stl.mark('billing-checked');
    if (!billing.ok) {
      return c.json(
        {
          error: billing.message,
          message: billing.message,
          code: billing.reason,
          balance: billing.balance,
          // Same discrimination the create/start 402 carries — a resume block on
          // a paying-but-drained Team account must not read as "no plan".
          billing_model: billing.billingModel,
          has_subscription: billing.hasSubscription,
          billing_state: billing.billingState,
          account_id: loaded.row.accountId,
        },
        402,
      );
    }

    // Optional server-side long-poll: the web client passes ?wait_ms so the
    // server holds the request until readiness flips (or a bounded deadline),
    // killing the ~800ms client poll-tick latency. Clamped; omitted = one-shot.
    const waitMsRaw = Number(c.req.query('wait_ms'));
    const waitMs = Number.isFinite(waitMsRaw) && waitMsRaw > 0 ? Math.min(waitMsRaw, 8000) : 0;
    const result = await startSession({
      source: 'ui',
      loaded,
      visible,
      projectId,
      sessionId,
      waitMs,
    });
    stl.mark(`open-session:${result.start.stage}`);
    stl.log({ waitMs });
    return c.json(
      {
        ...result.start,
        runtime_transport: 'rest' as const,
      },
      200,
    );
  },
);

// POST /v1/projects/:projectId/sessions/:sessionId/restart
// Reboot the existing sandbox in place via the provider SDK (stop+start) — the
// box and its disk (repo clone, deps, opencode) are kept, never removed. Only
// when the session has no sandbox (deleted / never provisioned) do we provision
// a fresh one to recover it from the preserved git branch.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/restart',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/restart',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      202: json(z.any(), 'OK'),
      ...errors(400, 403, 404, 503),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Per-agent gate: restart re-provisions compute. A scoped agent token must
    // hold project.session.start (no-op for human/PAT tokens).
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);

    // Restart is reserved for the session owner or an account owner/admin.
    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // Same tombstone rule as /start: a deleted session's restart used to 202
    // and silently do nothing the UI could see.
    if (sessionIsTombstoned(visible.row)) return c.json({ error: 'Not found' }, 404);
    if (!visible.canManageLifecycle) {
      return c.json(
        {
          error: 'Only the session owner or an account owner/admin can restart this session',
        },
        403,
      );
    }
    const result = await restartSession({
      loaded,
      session: visible.row,
      projectId,
      sessionId,
    });
    return c.json(result.body, result.status as any);
  },
);

// POST /v1/projects/:projectId/sessions/:sessionId/stop
// Manual pause: stops the running sandbox in place (disk kept, same contract as
// an idle auto-stop) without provisioning anything new. Resumable via /start.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/stop',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/stop',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 403, 404, 409, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Per-agent gate: same capability as start/restart — stopping is part of
    // the agent's session-lifecycle surface.
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    // Human gate: stopping has its own leaf (project.session.stop), distinct from
    // start, so a custom role can allow one and withhold the other. Every
    // built-in role holds it, so member/manager are unaffected.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_STOP,
    );

    // Stop is reserved for the session owner or an account owner/admin, same policy
    // as restart.
    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    if (!visible.canManageLifecycle) {
      return c.json(
        { error: 'Only the session owner or an account owner/admin can stop this session' },
        403,
      );
    }

    const result = await stopSession({
      projectId,
      sessionId,
      accountId: loaded.row.accountId,
      userId: loaded.userId,
    });
    return c.json(result.body, result.status as any);
  },
);

const SessionTurnSchema = z.object({
  turn_token: z.string(),
  state: z.enum(['delivering', 'active']),
  message_id: z.string().nullable(),
  opencode_session_id: z.string().nullable(),
  started_at: z.string().nullable(),
  accepted_at: z.string().nullable(),
});

const SessionTurnLastEndedSchema = z.object({
  turn_token: z.string(),
  end_reason: z.string().nullable(),
  ended_at: z.string().nullable(),
});

const SessionTurnResponseSchema = z.object({
  // A LIST, not one turn: `activeTurns` is token-keyed exactly so concurrent
  // prompts (a trigger delivery and a web prompt, say) do not clobber each
  // other, `beginSandboxTurn` merges into it with no single-turn guard, and
  // `session_turns` has no unique constraint on `session_id`. Returning only
  // the newest would make the older — genuinely running — turn look idle to a
  // caller reconciling by `message_id`.
  turns: z.array(SessionTurnSchema),
  last_ended: SessionTurnLastEndedSchema.optional(),
});

// GET /v1/projects/:projectId/sessions/:sessionId/turn
// Server truth about which turns are running right now, and how the last one
// ended. It reads BOTH stores, because neither can answer alone:
//
//  - `session_sandboxes.metadata.activeTurns` is the LIFECYCLE AUTHORITY. It is
//    written in the same statement that grants the turn and erased in the same
//    statement that ends it, so it — and only it — answers "is a turn running".
//    It cannot answer anything about a turn that is over: "cleared" and "never
//    ran" are the same read there, and it records no end reason.
//  - `kortix.session_turns` retains the terminal row, which is why `last_ended`
//    can exist at all. But every ledger write is a best-effort SECOND round trip
//    whose failure `recordTurnLedger` swallows, so it is not proof of anything
//    on its own: a running turn can have NO row (a boot prompt has none until
//    the daemon confirms acceptance, ~19-25s into a session start, and any
//    swallowed INSERT leaves none for the whole turn), and a finished turn can
//    keep an OPEN row for ever (a swallowed settle on a box that keeps running
//    is never reached by settleOrphanedSandboxTurns, which closes rows only once
//    their sandbox has stopped).
//
// So: liveness from the authority, detail and history from the ledger. Reading
// liveness from the ledger would serve both a false idle and a permanent
// phantom-busy as truth — the exact failures this endpoint exists to end.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/turn',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/turn',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(SessionTurnResponseSchema, 'Current turn'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    // A read, not a mutation: the 'read' tier plus the session-content leaf,
    // exactly like GET /sessions/:sessionId. No agent-scope assert and no
    // canManageLifecycle check — an agent may ask whether its own turn is live,
    // and a shared viewer may see that the session is busy.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );

    // `callerKortixSessionId`, never the raw `c.get('sessionId')`: under a
    // Supabase JWT that var holds the BROWSER LOGIN's id, and every KaaB
    // isolation guard reads a non-null caller session as "a sandbox acting for
    // one end-user, narrow it". Passing it raw 404s a signed-in human on any
    // sibling `origin='backend'` session — one the same user's GET /sessions
    // list returns, because project-sessions.ts goes through the helper.
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);

    // Server truth about the turns running right now. The read lives in
    // `lib/session-turn-read.ts` so the session-open bundle answers from the
    // SAME projection instead of a second copy — two projections of one
    // lifecycle authority is how a client ends up holding two disagreeing
    // answers to "is this session working?".
    return c.json(await readSessionTurnState(sessionId));
  },
);

// ─── Prompt inbox ───────────────────────────────────────────────────────────
//
// THE server-side queue for user prompts. A prompt is a durable row in
// `kortix.session_lifecycle_commands` from the instant the composer accepts it,
// which is the whole point: before this, a prompt typed while the agent was
// busy lived in the browser's localStorage, so closing the tab, switching
// device, or a crash lost it silently, and two tabs on one session each held
// their own idea of the queue.
//
// The client still mints the wire `messageID` and sends it here verbatim.
// OpenCode decides "has this prompt already been answered?" by id ORDER, and
// only the process holding the transcript can place an id correctly — see
// `wire-message-id.ts` for the one exception (redelivery, which re-reads the
// transcript first).
//
// Admission — "may this prompt be delivered NOW?" — is not decided here. It is
// decided at drain time by `admitInboxPrompt`, on the ORDER of this session's
// own rows, because that answer changes between the POST and the delivery. A
// live turn does not hold a prompt back: OpenCode queues it by arrival.

const PROMPT_WIRE_MESSAGE_ID = /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/;
const PROMPT_LIST_LIMIT = 200;

const SessionPromptSchema = z.object({
  prompt_id: z.string(),
  client_message_id: z.string(),
  message_id: z.string(),
  wire_message_id: z.string(),
  client_sent_at_ms: z.number().nullable(),
  state: z.enum(['queued', 'delivering', 'waiting', 'failed']),
  reason: z.string().nullable(),
  text: z.string(),
  attempts: z.number(),
  last_error: z.string().nullable(),
  created_at: z.string(),
  available_at: z.string(),
});

/** Everything `POST .../prompts` needs to re-create ONE removed prompt byte for
 *  byte. Not a subset of `SessionPromptSchema`: that one carries a truncated
 *  text PREVIEW and no parts at all, which is a display shape, not a restore
 *  shape. */
const RemovedSessionPromptSchema = z.object({
  prompt_id: z.string(),
  client_message_id: z.string(),
  removed_message_ids: z.array(z.string()).optional(),
  message_id: z.string(),
  parts: z.array(z.any()),
  overrides: z.any().nullable(),
});


function serializeRemovedPrompt(row: PromptRow) {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  return {
    prompt_id: row.commandId,
    client_message_id: typeof payload.clientMessageId === 'string' ? payload.clientMessageId : '',
    // The ORIGINAL wire id, never the re-minted one: an undo re-creates the
    // submission, and `POST .../prompts` places it again from there.
    message_id: typeof payload.wireMessageId === 'string' ? payload.wireMessageId : '',
    // EVERY id this prompt ever travelled under, so the client can clear the
    // transcript husk a cancel leaves behind (the copy at the runtime is
    // emptied, not necessarily deleted, while a step runs).
    removed_message_ids: [
      payload.wireMessageId,
      payload.redeliveredMessageId,
      (row.result as Record<string, unknown> | null)?.forwarded_message_id,
    ].filter((id, i, all): id is string => typeof id === 'string' && !!id && all.indexOf(id) === i),
    // The full body, untruncated, with every file/agent part — see the DELETE
    // handler for why the display shape cannot stand in for this.
    parts: parts.length > 0 ? parts : [{ type: 'text', text: payload.text ?? '' }],
    overrides:
      payload.overrides && typeof payload.overrides === 'object' ? payload.overrides : null,
  };
}


projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/prompts',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/prompts',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } }, required: true },
    },
    responses: {
      200: json(z.any(), 'Already queued (same client_message_id)'),
      202: json(z.any(), 'Prompt queued'),
      ...errors(400, 402, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    // FLOOR 'session', NOT 'write'. Sending a prompt is running the session,
    // not editing the project — it must pass exactly the check `/start` and
    // `POST /sessions` pass, because those are how the SAME message gets in.
    //
    // It didn't. A built-in project `member` (project.read + project.session.*,
    // no project.write) could open a session and have its first prompt answered
    // — that one rides `POST /sessions`'s `pending_prompt` stash, gated
    // 'session' — and then got 403 "Your role on this project doesn't let you
    // change this project" on EVERY follow-up, which lands here. Two gates for
    // one action: allowed to start the conversation, refused to continue it.
    //
    // The real authorization is the pair below (project.session.start, per-agent
    // + per-capability). This coarse floor only ever added a second, stricter,
    // contradictory tier on top. Same reasoning for delete/retry/hold below:
    // they manage the queue of a session the caller is already allowed to run.
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Same per-agent gate as `/start`: a prompt is what spends the compute a
    // session start provisions.
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_START,
    );

    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // `deleteSession()` stamps metadata.deletedAt and leaves the row 'stopped'.
    // Accepting a prompt for it would revive a session the user removed.
    const metadata = (visible.row.metadata ?? {}) as Record<string, unknown>;
    if (typeof metadata.deletedAt === 'string') {
      return c.json({ error: 'Session is deleted' }, 409);
    }

    const body = await readBody(c);
    const clientMessageId = normalizeString(body.client_message_id);
    const messageId = normalizeString(body.message_id);
    const rawParts = Array.isArray(body.parts) ? body.parts : [];
    if (!clientMessageId || clientMessageId.length > 128) {
      return c.json({ error: 'client_message_id is required (1..128 chars)' }, 400);
    }
    if (!messageId || !PROMPT_WIRE_MESSAGE_ID.test(messageId)) {
      // Rejected rather than repaired: an id this endpoint cannot verify the
      // ordering of is one OpenCode may read as already answered, and a
      // dropped turn is worse than a refused request.
      return c.json({ error: 'message_id must be an OpenCode wire message id' }, 400);
    }
    const sanitized = sanitizeInboxPromptParts(rawParts);
    if ('error' in sanitized) return c.json({ error: sanitized.error }, 400);
    const parts = sanitized.parts;
    const text = flattenPromptText(parts);

    const overridesInput = (body.overrides ?? {}) as Record<string, unknown>;
    const model = overridesInput.model as { providerID?: unknown; modelID?: unknown } | null;
    const overrides = {
      agent: typeof overridesInput.agent === 'string' ? overridesInput.agent : null,
      model:
        model && typeof model.providerID === 'string' && typeof model.modelID === 'string'
          ? { providerID: model.providerID, modelID: model.modelID }
          : null,
      variant: typeof overridesInput.variant === 'string' ? overridesInput.variant : null,
      directory: typeof overridesInput.directory === 'string' ? overridesInput.directory : null,
    };

    // Every prompt re-asks, because a prompt is what spends the money and a
    // prompt can SWITCH agent mid-session via `overrides.agent`. Checking only
    // at create would let a member send the first message as their granted
    // agent and every one after it as any other agent in the manifest. Falls
    // back to the session's own agent when the prompt names none.
    await resolveAndAuthorizeAgent(c, loaded, projectId, overrides.agent, visible.row.agentName);

    // Same gate as start/wake: a prompt spends compute.
    const billing = await checkBillingActive(loaded.row.accountId);
    if (!billing.ok) {
      return c.json(
        {
          error: billing.message,
          message: billing.message,
          code: billing.reason,
          balance: billing.balance,
          billing_model: billing.billingModel,
          has_subscription: billing.hasSubscription,
          billing_state: billing.billingState,
          account_id: loaded.row.accountId,
        },
        402,
      );
    }

    // The unique index on `idempotency_key` IS the "retry = same
    // clientMessageId = same row" contract — enforced by the database, not by a
    // cache that a second pod would not share.
    const idempotencyKey = `prompt:${sessionId}:${clientMessageId}`;
    const enqueued = await enqueueContinueSessionCommand({
      source: 'ui',
      projectId,
      accountId: loaded.row.accountId,
      sessionId,
      actorUserId: loaded.userId,
      text,
      idempotencyKey,
      clientMessageId,
      wireMessageId: messageId,
      // OPT-IN, and only one producer sets it: the localStorage migration,
      // whose id is minted at page load — against a transcript this tab has
      // not read yet — for a message the user typed before their last reload.
      // The drain re-mints against the live root before delivering, which is
      // the only place that can place the id correctly.
      ...(body.remint_on_delivery === true ? { remintOnDelivery: true } : {}),
      // SEND order across surfaces whose POSTs race — see the batch sort in
      // the drain. Bounded to the near past/future so a wrong client clock
      // cannot pin its prompts to the head or tail of every future batch.
      ...(typeof body.client_sent_at_ms === 'number' &&
      Math.abs(Date.now() - body.client_sent_at_ms) < 10 * 60_000
        ? { clientSentAtMs: Math.trunc(body.client_sent_at_ms) }
        : {}),
      parts,
      overrides,
    });

    const stored = (enqueued.row.payload ?? {}) as Record<string, unknown>;
    const response = {
      prompt_id: enqueued.row.commandId,
      state: promptState(enqueued.row).state,
      message_id:
        typeof stored.redeliveredMessageId === 'string'
          ? stored.redeliveredMessageId
          : typeof stored.wireMessageId === 'string'
            ? stored.wireMessageId
            : messageId,
      deduped: enqueued.deduped,
      // The write's place on the SERVER clock — stamped after the enqueue
      // settled. Clients rank queue snapshots on this one clock, so a read
      // issued before this POST carries an older stamp and can never erase
      // the row it confirmed (JAY-728).
      observed_at: new Date().toISOString(),
    };
    if (enqueued.deduped) return c.json(response, 200);

    // Sending anything NEW lifts a hold the stop button left on this session's
    // queue — the same rule the browser-local queue always had, and the reason
    // stop cannot wedge a session: everything typed afterwards would otherwise
    // land behind rows that are, by construction, never due.
    await releaseInboxHold(sessionId).catch(() => undefined);

    // Fire the targeted drain WITHOUT waiting on it: the response is "your
    // prompt is durable", not "your prompt has been delivered". The drain
    // claims by idempotency key so this row does not wait behind older work.
    void drainSessionLifecycleQueue({ idempotencyKey }).catch(() => undefined);
    return c.json(response, 202);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/prompts',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/prompts',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(
        z.object({ prompts: z.array(SessionPromptSchema), observed_at: z.string() }),
        'Pending prompts',
      ),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);

    // Captured BEFORE the read: an answer is only as fresh as the moment it
    // was asked. Clients rank queue snapshots on this server clock (JAY-728).
    const observedAt = new Date().toISOString();
    // Scoped to INBOX rows — see `listInboxPrompts`. `continue_session` is also
    // how triggers, Slack and approval-resume deliver, and listing those put an
    // automation's internal prompt in the user's own queue.
    const rows = await listInboxPrompts(sessionId, PROMPT_LIST_LIMIT);

    return c.json({ prompts: rows.map(serializePrompt), observed_at: observedAt });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/sessions/{sessionId}/prompts/{promptId}',
    tags: ['sessions'],
    summary: 'DELETE /:projectId/sessions/:sessionId/prompts/:promptId',
    ...auth,
    request: {
      params: z.object({
        projectId: z.string(),
        sessionId: z.string(),
        promptId: z.string(),
      }),
    },
    responses: {
      200: json(z.object({ removed: RemovedSessionPromptSchema }), 'Deleted'),
      ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    const promptId = c.req.param('promptId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
    // A prompt is named by its row id (uuid) OR by its wire message id — the
    // handle the bubble still has after the row leaves the list.
    if (!UUID_V4_REGEX.test(promptId) && !/^msg_[A-Za-z0-9]{6,40}$/.test(promptId)) {
      return c.json({ error: 'Invalid prompt id' }, 400);
    }

    // Floor 'session' — see the POST /prompts gate comment. Un-queuing your own
    // pending message is running the session, not editing the project.
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_START,
    );
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);

    // The session AND inbox scopes are in the DELETE's own predicate, so
    // neither a prompt id from another session nor an automation's
    // `continue_session` row can be removed by naming it here.
    //
    // A `msg_…` id names the prompt by its MESSAGE instead: the row leaves
    // `GET .../prompts` the moment the daemon confirms persistence (~1 s),
    // but the bubble on screen still knows its wire id — and the prompt is
    // still cancellable until a model step reads it.
    let effectivePromptId = promptId;
    if (promptId.startsWith('msg_')) {
      const found = await findInboxRowIdByMessageId(sessionId, promptId);
      if (!found) return c.json({ error: 'Not found' }, 404);
      effectivePromptId = found;
    }
    const outcome = await deleteInboxPrompt(sessionId, effectivePromptId);
    // The response CARRIES THE PROMPT IT REMOVED. A removal is offered with an
    // undo, and the row is hard-deleted, so this response is the only place the
    // full body still exists. Undoing from `GET /prompts`'s view instead
    // restores a 2000-char preview with no attachments and no model override —
    // a silent, unannounced loss on a button labelled "Undo".
    if (outcome.outcome === 'deleted') {
      return c.json({ removed: serializeRemovedPrompt(outcome.row) }, 200);
    }
    if (outcome.outcome === 'delivering') {
      // On the wire is no longer the point of no return: a forwarded prompt
      // the loop has not READ is taken back out of the runtime — whole
      // message when idle, part by part when busy (an empty user message is
      // invisible to the model). Only "a step is answering it" still refuses.
      const cancelled = await cancelForwardedPrompt(sessionId, effectivePromptId);
      if (cancelled.outcome === 'cancelled') {
        return c.json({ removed: serializeRemovedPrompt(cancelled.row) }, 200);
      }
      if (cancelled.outcome === 'not_forwarded') {
        // The row fell back into the queue while the cancel watched it.
        const retried = await deleteInboxPrompt(sessionId, effectivePromptId);
        if (retried.outcome === 'deleted') {
          return c.json({ removed: serializeRemovedPrompt(retried.row) }, 200);
        }
      }
      return c.json(
        {
          error:
            cancelled.outcome === 'answered'
              ? 'Prompt is already being answered'
              : 'Prompt is being delivered and the runtime could not be reached to cancel it',
        },
        409,
      );
    }
    return c.json({ error: 'Not found' }, 404);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/prompts/{promptId}/retry',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/prompts/:promptId/retry',
    ...auth,
    request: {
      params: z.object({
        projectId: z.string(),
        sessionId: z.string(),
        promptId: z.string(),
      }),
    },
    responses: {
      200: json(SessionPromptSchema, 'Prompt re-queued'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    const promptId = c.req.param('promptId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
    if (!UUID_V4_REGEX.test(promptId)) return c.json({ error: 'Invalid prompt id' }, 400);

    // Floor 'session' — see the POST /prompts gate comment. "Retry"/"send now"
    // on your own queued message is running the session, not editing the project.
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_START,
    );
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);

    // ONE primitive for "retry" and for "send now": both are the user pointing
    // at a row and asking for THAT message. `retryInboxPrompt` promotes it past
    // the ordering gate, releases the session's hold, and keeps the wire
    // `message_id` unchanged so the proxy still absorbs a retry of a delivery
    // that actually landed.
    const requeued = await retryInboxPrompt(sessionId, promptId);
    if (!requeued) return c.json({ error: 'Not found' }, 404);

    void drainSessionLifecycleQueue(
      requeued.idempotencyKey ? { idempotencyKey: requeued.idempotencyKey } : { limit: 1 },
    ).catch(() => undefined);
    return c.json(serializePrompt(requeued), 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/prompts/hold',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/prompts/hold',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } }, required: true },
    },
    responses: {
      200: json(
        z.object({ prompts: z.array(SessionPromptSchema), observed_at: z.string() }),
        'Hold applied',
      ),
      ...errors(400, 404),
    },
  }),
  // STOP HAS TO REACH THE QUEUE.
  //
  // "Stopping means stop doing things, and that includes the queue" was a
  // browser-local pause while the queue was browser-local. The queue is in
  // Postgres now, so the pause has to be too: pausing a client drain leaves the
  // admission gate free to deliver, roughly one scheduler tick after the abort
  // clears turn authority — exactly the message the user pressed Stop to get
  // ahead of. A hold is released by an action (any new send, or "send now" on a
  // row), never by a timer.
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    // Floor 'session' — see the POST /prompts gate comment. Stop/hold is the
    // counterpart of send; a member who can send must be able to hold.
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_START,
    );
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);

    const body = await readBody(c);
    if (typeof body.held !== 'boolean') {
      return c.json({ error: 'held must be a boolean' }, 400);
    }

    await holdInboxPrompts(sessionId, body.held);
    // After the write, before the read-back — either instant orders this
    // snapshot correctly against the hold it just applied (JAY-728).
    const observedAt = new Date().toISOString();
    const rows = await listInboxPrompts(sessionId, PROMPT_LIST_LIMIT);
    if (body.held) {
      // The instant marking above is what the client waits for; what a Stop
      // means for prompts already on the wire needs the box and happens behind
      // this response — see inbox-hold-settle.ts.
      settleInboxHoldAfterStopInBackground(sessionId);
    } else {
      void drainSessionLifecycleQueue({ limit: 1 }).catch(() => undefined);
    }
    return c.json({ prompts: rows.map(serializePrompt), observed_at: observedAt });
  },
);

// ─── Change Requests ────────────────────────────────────────────────────────
// Kortix-native PR layer. The CR is metadata stored alongside the project;
// the underlying merge runs through ./git.ts which works against any git
// backend (GitHub, GitLab, plain git) — so the merge UI lives in
// Kortix even when the repo is hosted elsewhere.
//
// v1 is intentionally minimal: open / merged / closed, head_ref + base_ref,
// head/base commit SHAs auto-refreshed on read. No reviews, no comments,
// no mirrored revision history — git remains the source of truth.

/**
 * Refresh the CR's cached head/base SHAs against the live git tips. Used by
 * read endpoints so the UI never shows stale "X commits behind" state. No-op
 * when the SHAs already match or the CR is no longer open.
 */

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/change-requests',
    tags: ['change-requests'],
    summary: 'GET /:projectId/change-requests',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({}).passthrough(),
    },
    responses: {
      200: json(z.array(ChangeRequestSchema), 'Change requests'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const statusFilter = normalizeString(c.req.query('status'))?.toLowerCase();
    const whereClauses = [eq(changeRequests.projectId, projectId)];
    if (statusFilter && statusFilter !== 'all') {
      if (!['open', 'merged', 'closed'].includes(statusFilter)) {
        return c.json({ error: 'Invalid status filter' }, 400);
      }
      whereClauses.push(eq(changeRequests.status, statusFilter as 'open' | 'merged' | 'closed'));
    }

    const rows = await db
      .select()
      .from(changeRequests)
      .where(and(...whereClauses))
      .orderBy(desc(changeRequests.number));

    return c.json({
      change_requests: rows.map(serializeChangeRequest),
    });
  },
);

// POST /v1/projects/:projectId/change-requests
// Body: { title, description?, head_ref, base_ref?, session_id? }

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/change-requests',
    tags: ['change-requests'],
    summary: 'POST /:projectId/change-requests',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(ChangeRequestSchema, 'The created change request'),
      ...errors(400, 404, 422, 500),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Human-side capability gate (Git Ops). Managers hold it; a custom
    // role omits project.gitops.push to take Git-Ops away from a department.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GITOPS_PUSH,
    );

    // Per-agent gate: opening a CR is the agent's intended path to propose work.
    // Default-deny — a scoped agent must be granted the leaf this route already
    // gates the underlying commit on. `project.cr.open` was the SAME capability
    // under a second name and is gone from the catalog (spec §2.4); a manifest
    // still spelling it that way is rewritten on input by
    // `canonicalizeGrantActions`, so the grant reaching here is always the leaf.
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_GITOPS_PUSH);

    const title = normalizeString(body.title);
    if (!title) return c.json({ error: 'title is required' }, 400);
    const description = normalizeString(body.description) ?? '';
    const headRef = normalizeString(body.head_ref ?? body.headRef);
    if (!headRef) return c.json({ error: 'head_ref is required' }, 400);
    // The session must be resolved BEFORE the base, because a session's own
    // base is what the change request targets.
    let originSessionId: string | null = normalizeString(body.session_id ?? body.sessionId);
    let sessionBaseRef: string | null = null;
    if (originSessionId) {
      const [sessionRow] = await db
        .select({ sessionId: projectSessions.sessionId, baseRef: projectSessions.baseRef })
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.sessionId, originSessionId),
            eq(projectSessions.projectId, projectId),
          ),
        )
        .limit(1);
      if (!sessionRow) originSessionId = null;
      else sessionBaseRef = normalizeString(sessionRow.baseRef);
    }

    const baseDecision = resolveChangeRequestBase({
      requested: normalizeString(body.base_ref ?? body.baseRef),
      sessionBase: sessionBaseRef,
      projectDefault: loaded.row.defaultBranch,
      actorIsSession: isProjectSessionPrincipal(c),
    });
    if (!baseDecision.ok) {
      return c.json({ error: baseDecision.error, code: baseDecision.code }, 400);
    }
    const baseRef = baseDecision.baseRef;
    if (baseRef === headRef) {
      return c.json({ error: 'head_ref and base_ref must differ' }, 400);
    }

    // Resolve current tips so the CR has anchored SHAs from the start, and
    // refuse an EMPTY change request outright: a head with no commits ahead
    // of base renders "No changes detected" in the dashboard and can never
    // be applied (previewMerge reports it un-mergeable). The two shapes are
    // a committed-but-never-pushed session branch (head tip == base tip) and
    // a stale branch behind an advanced base (merge-base == head tip); both
    // came up in the wild via agent flows on 2026-07-06. The resolver forces
    // a mirror re-fetch before concluding "not ahead", so a push that landed
    // moments ago never bounces.
    let baseSha: string | null = null;
    let headSha: string | null = null;
    let headAhead = true;
    try {
      const projectForGit = await withProjectGitAuth(loaded.row);
      const aheadState = await resolveBranchAheadState(projectForGit, baseRef, headRef);
      baseSha = aheadState.baseSha;
      headSha = aheadState.headSha;
      headAhead = aheadState.ahead;
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Failed to resolve branches',
        },
        400,
      );
    }
    if (!headAhead) {
      return c.json(
        {
          error: `head_ref "${headRef}" has no commits ahead of "${baseRef}" — the change request would be empty and could never be applied. Commit your work and push the branch (git push origin HEAD), then retry. If your branch is behind an advanced base, rebase onto the latest base first.`,
          code: 'CR_HEAD_NOT_AHEAD',
        },
        422,
      );
    }

    // Atomically allocate the next per-project number and insert. Retry once on
    // unique-constraint collision (only happens under racing opens).
    let inserted: typeof changeRequests.$inferSelect | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const number = await getNextCrNumber(projectId);
      try {
        const [row] = await db
          .insert(changeRequests)
          .values({
            accountId: loaded.row.accountId,
            projectId,
            number,
            title,
            description,
            baseRef,
            headRef,
            headCommitSha: headSha,
            baseCommitSha: baseSha,
            originSessionId,
            createdBy: loaded.userId,
          })
          .returning();
        inserted = row;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate key/.test(message)) throw error;
      }
    }
    if (!inserted) return c.json({ error: 'Failed to allocate CR number' }, 500);

    return c.json(serializeChangeRequest(inserted), 201);
  },
);

// POST /v1/projects/:projectId/sessions/:sessionId/commit-push
// Commits the session sandbox's working-tree changes and pushes them to the
// session branch — the host-driven path that lets the dashboard open a change
// request without routing through the agent. Idempotent: a clean tree with
// nothing left to push returns { nothing_to_do: true }.
//
// NOTE (2026-05-29): currently UNUSED by the UI. The shipped change-request
// flow lets the agent commit + open the CR from a single chat prompt instead.
// Kept (wired through to the daemon /kortix/git/commit-push route) as the
// host-driven primitive for a possible fully-UI flow. Remove together with the
// daemon route + web client/hook if that direction is dropped.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/commit-push',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/commit-push',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404, 409, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GITOPS_PUSH,
    );

    // The capability check above is PROJECT-wide, and in Kortix-as-a-Backend the
    // sandbox's own token holds it — every KaaB session shares the wrapper's
    // credential, so "may push in this project" is true for every end-user's
    // agent. Without this, end-user A's sandbox could commit and push end-user
    // B's working tree to B's branch. A sandbox token acts for exactly one
    // session (sandbox_id == session_id by construction); bind it to that one.
    const callerSandboxSessionId = callerKortixSessionId(c);
    if (
      callerSandboxSessionId !== null &&
      !sandboxTokenMayActOnSession(callerSandboxSessionId, sessionId)
    ) {
      return c.json({ error: 'sandbox token is not scoped to this session' }, 403);
    }

    const body = await readBody(c);
    const message = normalizeString(body.message) ?? undefined;

    const [row] = await db
      .select()
      .from(sessionSandboxes)
      .where(
        and(
          eq(sessionSandboxes.sessionId, sessionId),
          eq(sessionSandboxes.projectId, projectId),
          eq(sessionSandboxes.accountId, loaded.row.accountId),
        ),
      )
      .limit(1);
    if (!row || !row.externalId) {
      return c.json({ error: 'Session sandbox not found' }, 404);
    }
    if (row.status !== 'active') {
      return c.json({ error: 'Session sandbox is not running', status: row.status }, 409);
    }

    const providerName = row.provider as SandboxProviderName;
    if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(providerName)) {
      return c.json({ error: 'Unsupported sandbox provider' }, 409);
    }

    // resolveEndpoint already injects the sandbox service key as a Bearer token
    // (and the Daytona preview headers), which the daemon's /kortix/git route
    // validates against KORTIX_TOKEN — same contract as /kortix/env.
    let endpoint: { url: string; headers: Record<string, string> };
    try {
      endpoint = await getProvider(providerName).resolveEndpoint(row.externalId);
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Failed to reach sandbox',
        },
        502,
      );
    }

    let daemonRes: Response;
    try {
      daemonRes = await fetch(`${endpoint.url.replace(/\/$/, '')}/kortix/git/commit-push`, {
          method: 'POST',
          headers: endpoint.headers,
          body: JSON.stringify({ message }),
          signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Sandbox unreachable',
        },
        502,
      );
    }

    const result = (await daemonRes.json().catch(() => null)) as {
      ok?: boolean;
      committed?: boolean;
      pushed?: boolean;
      nothingToDo?: boolean;
      branch?: string | null;
      headSha?: string | null;
      message?: string;
    } | null;

    if (!daemonRes.ok || !result?.ok) {
      return c.json(
        { error: result?.message || 'Failed to save changes' },
        daemonRes.status === 409 ? 409 : 502,
      );
    }

    // A fresh commit just landed on the session branch and was pushed to origin.
    // Force the next mirror read to re-fetch so the CR we open immediately after
    // sees the new tip (the mirror is otherwise refresh-throttled).
    invalidateProjectMirror(projectId);

    return c.json({
      committed: Boolean(result.committed),
      pushed: Boolean(result.pushed),
      nothing_to_do: Boolean(result.nothingToDo),
      branch: result.branch ?? null,
      head_sha: result.headSha ?? null,
    });
  },
);

// GET /v1/projects/:projectId/change-requests/:crId
// Auto-refreshes the cached head/base SHAs against the live git tips so the
// UI never shows stale "X commits behind" state.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/change-requests/{crId}',
    tags: ['change-requests'],
    summary: 'GET /:projectId/change-requests/:crId',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
    },
    responses: {
      200: json(ChangeRequestSchema, 'The change request'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const crId = c.req.param('crId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    let cr = await getCrById(crId, projectId);
    if (!cr) return c.json({ error: 'Change request not found' }, 404);

    await refreshCrTips({
      cr,
      project: await withProjectGitAuth(loaded.row),
    });
    cr = (await getCrById(crId, projectId))!;

    return c.json({ change_request: serializeChangeRequest(cr) });
  },
);

// PATCH /v1/projects/:projectId/change-requests/:crId
// Body: { title?, description? }

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/change-requests/{crId}',
    tags: ['change-requests'],
    summary: 'PATCH /:projectId/change-requests/:crId',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const crId = c.req.param('crId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Per-agent gate: editing a CR is part of the change-request capability,
    // which is `project.gitops.push` (see the create route above).
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_GITOPS_PUSH);

    const cr = await getCrById(crId, projectId);
    if (!cr) return c.json({ error: 'Change request not found' }, 404);
    if (cr.status !== 'open') {
      return c.json({ error: `Cannot edit a ${cr.status} change request` }, 409);
    }

    const updates: Partial<typeof changeRequests.$inferInsert> = {
      updatedAt: new Date(),
    };
    const title = normalizeString(body.title);
    if (title) updates.title = title;
    if (typeof body.description === 'string') updates.description = body.description;

    const [row] = await db
      .update(changeRequests)
      .set(updates)
      .where(eq(changeRequests.crId, crId))
      .returning();
    return c.json(serializeChangeRequest(row));
  },
);

// POST /v1/projects/:projectId/change-requests/:crId/request-changes
// Human "request changes" from the Review Center: persist the feedback on the CR
// (CRs have no comment table — this is how the ask is remembered + shown back)
// and deliver it to the agent that opened the change so it revises. Delivery is
// fire-and-forget: continueSession boots the sandbox if it's asleep, resolves the
// live session, and retries — so the HTTP response stays snappy.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/change-requests/{crId}/request-changes',
    tags: ['change-requests'],
    summary: 'POST /:projectId/change-requests/:crId/request-changes',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const crId = c.req.param('crId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // request-changes is a human review decision on a CR, not a code push —
    // gate it on project.review.act (the same leaf as /review/items/{id}/act),
    // not gitops.push. Manager holds both; a custom reviewer role with
    // review.act but no gitops.push can now request changes.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_REVIEW_ACT,
    );

    const feedback = normalizeString(body.feedback ?? body.text);
    if (!feedback) return c.json({ error: 'feedback is required' }, 400);

    const cr = await getCrById(crId, projectId);
    if (!cr) return c.json({ error: 'Change request not found' }, 404);
    if (cr.status !== 'open') {
      return c.json({ error: `Cannot request changes on a ${cr.status} change request` }, 409);
    }

    // Persist first — the ask must survive even if delivery can't reach the agent.
    const row = await recordRequestedChange(crId, projectId, {
      text: feedback,
      by: loaded.userId,
      at: new Date().toISOString(),
    });
    if (!row) return c.json({ error: 'Change request not found' }, 404);

    // Deliver to the originating session's agent (best-effort, background — a
    // sandbox boot can take seconds, so we never block the response on it).
    const willDeliver = Boolean(cr.originSessionId);
    if (cr.originSessionId) {
      void continueSession({
        source: 'ui',
        sessionId: cr.originSessionId,
        text: `Please revise change request #${cr.number} ("${cr.title}") based on this feedback:\n\n${feedback}`,
        userId: loaded.userId,
      })
        .then((outcome) => {
          // The response already told the user willDeliver=true and nothing
          // retries this — a non-delivered outcome (incl. 'pending') means the
          // feedback silently never reached the agent. Make it loud.
          if (outcome !== 'delivered') {
            console.error('[change-requests] request-changes prompt not delivered', {
              crId,
              sessionId: cr.originSessionId,
              outcome,
            });
          }
        })
        .catch((err) => {
          console.warn('[change-requests] request-changes delivery failed', {
            crId,
            error: String(err),
          });
        });
    }

    return c.json({ change_request: serializeChangeRequest(row), delivering: willDeliver });
  },
);

// GET /v1/projects/:projectId/change-requests/:crId/diff
// For open / closed CRs: lives off the live branch tips (three-dot diff).
// For merged CRs: uses the SHAs captured at merge time, so the diff still
// renders even though the head branch is now fully reachable from base.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/change-requests/{crId}/diff',
    tags: ['change-requests'],
    summary: 'GET /:projectId/change-requests/:crId/diff',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const crId = c.req.param('crId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertAgentSessionWorkspaceAllowsRepository(c, loaded.row.accountId, projectId);

    const cr = await getCrById(crId, projectId);
    if (!cr) return c.json({ error: 'Change request not found' }, 404);

    const projectForGit = await withProjectGitAuth(loaded.row);

    try {
      const useSnapshot = cr.status === 'merged' && cr.baseCommitSha && cr.headCommitSha;
      const diff = useSnapshot
        ? await getDiffBetweenShas(projectForGit, cr.baseCommitSha!, cr.headCommitSha!)
        : await getBranchDiff(projectForGit, cr.baseRef, cr.headRef);
      return c.json({
        cr_id: cr.crId,
        base_ref: cr.baseRef,
        head_ref: cr.headRef,
        base_sha: diff.base_sha,
        head_sha: diff.head_sha,
        merge_base: diff.merge_base,
        files: diff.files,
        files_changed: diff.files_changed,
        additions: diff.additions,
        deletions: diff.deletions,
        patch: diff.patch,
      });
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Failed to compute diff',
        },
        400,
      );
    }
  },
);

// GET /v1/projects/:projectId/change-requests/:crId/merge-preview

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/change-requests/{crId}/merge-preview',
    tags: ['change-requests'],
    summary: 'GET /:projectId/change-requests/:crId/merge-preview',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), crId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const crId = c.req.param('crId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertAgentSessionWorkspaceAllowsRepository(c, loaded.row.accountId, projectId);

    const cr = await getCrById(crId, projectId);
    if (!cr) return c.json({ error: 'Change request not found' }, 404);

    try {
      const preview = await previewMerge(
        await withProjectGitAuth(loaded.row),
        cr.baseRef,
        cr.headRef,
      );
      return c.json(preview);
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Failed to preview merge',
        },
        400,
      );
    }
  },
);

// POST /v1/projects/:projectId/change-requests/:crId/merge
// Body: { message?: string }

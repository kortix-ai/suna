/** Session runtime: start (the unified open), restart, stop, and the current turn. */
import { checkBillingAdmission } from '../../billing/services/billing-gate';
import { auth, errors, json } from '../../openapi';
import { createRoute, z } from '@hono/zod-openapi';
import {
  assertProjectCapability,
  loadProjectForUser,
  loadVisibleSession,
  sessionIsTombstoned,
} from '../lib/access';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { assertAgentScope } from '../../iam/agent-scope';
import { PROJECT_ACTIONS } from '../../iam';
import { callerKortixSessionId } from '../lib/caller-session';
import { SessionStartResultSchema, projectsApp } from '../lib/app';
import {
  sessionUsesCurrentRepository,
} from '../lib/repository-generation';
import { backfillSessionTranscriptMirrorOnWake } from '../lib/session-transcript-capture';
import { isUuid } from '../../shared/validate';
import { restartSession, startSession, stopSession } from '../session-lifecycle';
import { isWarmProjectSession } from '../lib/warm-sessions';
import { dropWarmSessionMarkerOnAdopt } from './warm-sessions';
import { readSessionTurnState } from '../lib/session-turn-read';
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
      query: z.object({
        wait_ms: z.string().optional(),
        repository_mode: z.enum(['previous']).optional(),
      }),
    },
    responses: {
      200: json(SessionStartResultSchema, 'Session readiness payload'),
      ...errors(400, 402, 403, 404, 409),
    },
  }),
  async (c) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

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
    const projectMetadata = loaded.row.metadata as Record<string, unknown>;
    const sessionMetadata = visible.row.metadata as Record<string, unknown>;
    const repositoryMode = c.req.query('repository_mode');
    const usesCurrentRepository = sessionUsesCurrentRepository(projectMetadata, sessionMetadata);
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
    const billing = await checkBillingAdmission(loaded.row.accountId);
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
    // THE RUNTIME IS UP — mirror what is already in it, once.
    //
    // Capture otherwise runs only at turn end, so enabling
    // `session_transcript_history` did nothing for a project's EXISTING
    // sessions: each one stayed blank on open until somebody sent it another
    // message. Opening the session is exactly when the user waits and the
    // feature is supposed to pay off, so that is where the backfill belongs.
    //
    // Fire-and-forget and self-limiting: at most one attempt per session per
    // process, skipped entirely when the flag is off or the mirror already
    // proves it holds the session's first message. It cannot fail or delay
    // this response.
    if (result.start.stage === 'ready') void backfillSessionTranscriptMirrorOnWake(sessionId);
    stl.log({
      waitMs,
      repositoryMode: usesCurrentRepository ? 'current' : 'previous',
      compatibilityModeRequested: repositoryMode === 'previous',
    });
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
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

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
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

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
  message_id: z.string().optional(),
  end_reason: z.string().nullable(),
  ended_at: z.string().nullable(),
  error: z
    .object({ name: z.string().nullable(), message: z.string().nullable() })
    .optional(),
});

const SessionTurnFailureSchema = z.object({
  message_id: z.string(),
  ended_at: z.string().nullable(),
  // Null when the turn failed and nobody named why.
  error: z.object({ name: z.string().nullable(), message: z.string().nullable() }).nullable(),
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
  recent_failures: z.array(SessionTurnFailureSchema).optional(),
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
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

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

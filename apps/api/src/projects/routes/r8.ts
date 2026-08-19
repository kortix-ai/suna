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
  type SessionTurnError,
  sessionTurns,
} from '@kortix/db';
import { and, asc, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import {
  assertAgentSessionWorkspaceAllowsRepository,
  assertProjectCapability,
  loadProjectForUser,
  loadVisibleSession,
} from '../lib/access';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { assertAgentScope } from '../../iam/agent-scope';
import { PROJECT_ACTIONS } from '../../iam';
import { callerKortixSessionId } from '../lib/caller-session';
import { sandboxTokenMayActOnSession } from '../lib/sandbox-token-session';
import { AnyObject, ChangeRequestSchema, SessionStartResultSchema, projectsApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';
import { UUID_V4_REGEX, normalizeString, readBody } from '../lib/serializers';
import { RUNNING_SANDBOX_STATUSES, storedSandboxTurns } from '../sandbox-turn-lifecycle';
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
import {
  PROMPT_TEXT_PREVIEW_CHARS,
  flattenPromptText,
  sanitizeInboxPromptParts,
} from '../session-lifecycle/prompt-parts';
import { isWarmProjectSession } from '../lib/warm-sessions';
import { dropWarmSessionMarkerOnAdopt } from './warm-sessions';
import { refreshCrTips } from './shared';
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

/**
 * WHY a turn failed, in the words the user is shown.
 *
 * `end_reason` is a five-value enum and cannot carry "ModelNotFound:
 * kortix/grok-4.6". Neither can the transcript: when OpenCode raises
 * `session.error` before any assistant message exists, it persists nothing for
 * the turn but the user message. This object is the ONLY durable record of the
 * failure, which is why it is served from every turn read.
 *
 * Present on a failed turn, absent on a completed one — see
 * `syntheticTurnError` for the sentences the never-ran reasons carry.
 */
const SessionTurnErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  status_code: z.number().optional(),
  is_retryable: z.boolean().optional(),
  provider_id: z.string().optional(),
  recorded_at: z.string(),
});

const SessionTurnLastEndedSchema = z.object({
  turn_token: z.string(),
  // The OpenCode user message this turn answered. It is what a client keys the
  // error onto: the message is in the transcript, and the failure is not.
  message_id: z.string().nullable(),
  end_reason: z.string().nullable(),
  ended_at: z.string().nullable(),
  error: SessionTurnErrorSchema.nullable(),
});

/** How many history rows `GET .../turns` returns by default, and the ceiling a
 *  caller may ask for. A session's retained history is unbounded; a read of it
 *  is not. */
const SESSION_TURN_HISTORY_DEFAULT = 50;
const SESSION_TURN_HISTORY_MAX = 200;

/** One row of `GET .../turns` — the retained history, newest first. */
const SessionTurnHistorySchema = z.object({
  turn_token: z.string(),
  message_id: z.string().nullable(),
  opencode_session_id: z.string().nullable(),
  state: z.string(),
  end_reason: z.string().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  error: SessionTurnErrorSchema.nullable(),
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

    // `session_sandboxes.session_id` is UNIQUE, so this is the session's one
    // box. A box that is not running holds no live turn whatever its metadata
    // still says — the same predicate settleOrphanedSandboxTurns uses to close
    // every ledger row left open on a stopped box. Served by
    // idx_session_sandboxes_session (plain Index Scan; measured, see below).
    const [box] = await db
      .select({ status: sessionSandboxes.status, metadata: sessionSandboxes.metadata })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, sessionId))
      .limit(1);
    const authority =
      box && RUNNING_SANDBOX_STATUSES.has(box.status) ? storedSandboxTurns(box.metadata) : [];

    // Decoration only, keyed by the tokens the authority already named: the
    // ledger owns `accepted_at`, and it fills in an identity the authority may
    // not carry yet. It never adds or removes a turn — an open row whose token
    // the authority no longer holds is a swallowed settle, not a running turn.
    // Bounded by the authority's own token list, so this is a primary-key
    // lookup and needs no ORDER BY and no LIMIT: measured as `Index Scan using
    // session_turns_pkey (turn_token = ANY (...))`, with the session scope as a
    // filter — kept because a token must never read another session's row.
    const ledger = new Map<
      string,
      {
        messageId: string | null;
        opencodeSessionId: string | null;
        startedAt: Date;
        acceptedAt: Date | null;
      }
    >();
    if (authority.length > 0) {
      const rows = await db
        .select({
          turnToken: sessionTurns.turnToken,
          messageId: sessionTurns.messageId,
          opencodeSessionId: sessionTurns.opencodeSessionId,
          startedAt: sessionTurns.startedAt,
          acceptedAt: sessionTurns.acceptedAt,
        })
        .from(sessionTurns)
        .where(
          and(
            eq(sessionTurns.sessionId, sessionId),
            inArray(
              sessionTurns.turnToken,
              authority.map((turn) => turn.token),
            ),
          ),
        );
      for (const row of rows) ledger.set(row.turnToken, row);
    }

    const live = authority
      .map((turn) => {
        const row = ledger.get(turn.token);
        // The authority's own instant first: it is what the grant statement
        // wrote. The ledger start is the fallback for a legacy `activeTurn`
        // record, which carries none.
        const startedAt =
          turn.startedAtMs !== null ? new Date(turn.startedAtMs) : (row?.startedAt ?? null);
        return {
          startedAtMs: startedAt ? startedAt.getTime() : null,
          turn: {
            turn_token: turn.token,
            // State comes from the authority: `acceptSandboxTurn` promotes the
            // authority entry in statement one and UPSERTs the ledger in
            // statement two, so a swallowed second write leaves the row saying
            // `delivering` for a turn OpenCode has accepted.
            state: turn.state,
            message_id: turn.messageId ?? row?.messageId ?? null,
            opencode_session_id: turn.opencodeSessionId || row?.opencodeSessionId || null,
            started_at: startedAt ? startedAt.toISOString() : null,
            accepted_at: row?.acceptedAt ? row.acceptedAt.toISOString() : null,
          },
        };
      })
      // Newest start first, then by token so two turns minted in the same
      // millisecond — or two legacy records with no instant at all — still
      // come back in a stable order.
      .sort(
        (a, b) =>
          (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0) ||
          a.turn.turn_token.localeCompare(b.turn.turn_token),
      )
      .map((entry) => entry.turn);
    if (live.length > 0) return c.json({ turns: live });

    const [ended] = await db
      .select({
        turnToken: sessionTurns.turnToken,
        messageId: sessionTurns.messageId,
        endReason: sessionTurns.endReason,
        endedAt: sessionTurns.endedAt,
        error: sessionTurns.error,
      })
      .from(sessionTurns)
      .where(and(eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.state, 'ended')))
      // `ended_at` is nullable, so it cannot order this on its own. Measured
      // with EXPLAIN ANALYZE on real Postgres at 20k rows over 200 sessions:
      // `Bitmap Index Scan on session_turns_session_idx` for the session scope,
      // then a top-N heapsort over that session's rows only — the index orders
      // by started_at, not by ended_at, so the sort is expected and bounded by
      // one session's history.
      .orderBy(desc(sessionTurns.endedAt), desc(sessionTurns.startedAt))
      .limit(1);
    // `last_ended` is OMITTED, never null: its absence is the only thing that
    // separates "this session has never run a turn" from "the last one ended".
    // It is HISTORY, and history is what the swallowed ledger write costs: a
    // lost settle leaves the previous terminal row as the newest one. Liveness
    // above does not depend on it.
    return c.json({
      turns: [],
      ...(ended
        ? {
            last_ended: {
              turn_token: ended.turnToken,
              // Keyed by the OpenCode user message, because that is what a
              // client can put the failure NEXT TO. `error` rides this same
              // read on purpose: the common case — "the last turn failed" —
              // must cost the poller no extra round trip.
              message_id: ended.messageId ?? null,
              end_reason: ended.endReason,
              ended_at: ended.endedAt ? ended.endedAt.toISOString() : null,
              error: ended.error ?? null,
            },
          }
        : {}),
    });
  },
);

// GET /v1/projects/:projectId/sessions/:sessionId/turns?limit=
// The session's RETAINED TURN HISTORY, newest first — one row per turn the
// ledger settled, each carrying the error that ended it.
//
// `GET .../turn` answers "what is happening now, and how did the last one
// end?", which is what a live client polls. It cannot answer the question a
// client has after a RELOAD: the transcript it just fetched holds N user
// messages, and it needs to know which of them a turn failed on. Only the
// newest failure is on `last_ended`; every older one is invisible there.
//
// So: liveness and the newest end from `/turn`, the whole history from here.
// The client keys rows onto its transcript by `message_id`. Bounded by `limit`
// (default 50, max 200) and served by `session_turns_session_idx`, the same
// index the terminal read above uses.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/turns',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/turns',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      query: z.object({ limit: z.string().optional() }).passthrough(),
    },
    responses: {
      200: json(z.object({ turns: z.array(SessionTurnHistorySchema) }), 'Recent turns'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    // The same gate as `GET .../turn`: this is session content, read-tier.
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

    // CLAMPED, never trusted: an unbounded `limit` turns one poll into a scan
    // of a long-lived session's entire retained history.
    const requested = Number.parseInt(normalizeString(c.req.query('limit')) ?? '', 10);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1), SESSION_TURN_HISTORY_MAX)
      : SESSION_TURN_HISTORY_DEFAULT;

    const rows = await db
      .select({
        turnToken: sessionTurns.turnToken,
        messageId: sessionTurns.messageId,
        opencodeSessionId: sessionTurns.opencodeSessionId,
        state: sessionTurns.state,
        endReason: sessionTurns.endReason,
        startedAt: sessionTurns.startedAt,
        endedAt: sessionTurns.endedAt,
        error: sessionTurns.error,
      })
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, sessionId))
      // `started_at` is NOT NULL and is the index's own ordering, so this is a
      // plain backwards index scan. Ordering by `ended_at` instead would sort,
      // and would order a still-open row above every settled one.
      .orderBy(desc(sessionTurns.startedAt))
      .limit(limit);

    return c.json({
      turns: rows.map((row) => ({
        turn_token: row.turnToken,
        message_id: row.messageId ?? null,
        opencode_session_id: row.opencodeSessionId ?? null,
        state: row.state,
        end_reason: row.endReason ?? null,
        started_at: row.startedAt ? row.startedAt.toISOString() : null,
        ended_at: row.endedAt ? row.endedAt.toISOString() : null,
        error: row.error ?? null,
      })),
    });
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
  state: z.enum(['queued', 'delivering', 'waiting', 'failed']),
  reason: z.string().nullable(),
  text: z.string(),
  attempts: z.number(),
  /** Why the control plane could not DELIVER this row. */
  last_error: z.string().nullable(),
  /** Why the model run that carried this row FAILED. A different fact from
   *  `last_error`, and the only one that can say "ModelNotFound". */
  error: SessionTurnErrorSchema.nullable(),
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
  message_id: z.string(),
  parts: z.array(z.any()),
  overrides: z.any().nullable(),
});

type PromptRow = typeof sessionLifecycleCommands.$inferSelect;

/**
 * Map a durable command row onto the inbox's four user-visible states.
 *
 * `succeeded` no longer means "never appears". A FORWARDED row is `succeeded`
 * so the drain can never re-claim it, and still unanswered: OpenCode has
 * persisted the message and queued it behind the turn in flight. It reads
 * `delivering` until the `session_turns` ledger confirms a turn consumed it —
 * which is what keeps the composer working across that interval instead of
 * showing the user nothing. Only a `delivered` row disappears; it IS the
 * transcript by then.
 */
function promptState(row: Pick<PromptRow, 'status' | 'result'>): {
  state: 'queued' | 'delivering' | 'waiting' | 'failed';
  reason: string | null;
} {
  const result = (row.result ?? {}) as Record<string, unknown>;
  // TERMINAL FIRST, above every marker on the row. A row can be given up on
  // while it still carries `forwarded` — `deadLetter` (redelivery.ts) is
  // exactly that — and reading the marker first made it `delivering` for ever:
  // the strip filters in-flight rows out, `countLiveInboxPrompts` counts them
  // as live work, and the sweep scans `succeeded` only. Nothing could close it.
  // `failed` is the state that carries the retry, which is the way out.
  if (row.status === 'failed' || row.status === 'dead_lettered') {
    return { state: 'failed', reason: null };
  }
  // Then HELD: a held row is waiting on the USER, not on the session — the stop
  // button put it there, and only an explicit send or "send now" takes it out.
  // It outranks the markers below: a held row is not in line at all, and that
  // is true of a forwarded row Stop paused just as much as of a queued one.
  if (result.held === true) return { state: 'waiting', reason: 'held' };
  // Then FORWARDED, above `running`: this is a `succeeded` row, so every branch
  // below would otherwise fall through to `queued` and show a prompt that is
  // already at OpenCode as if it had never been sent.
  if (result.status === 'forwarded') return { state: 'delivering', reason: 'forwarded' };
  if (row.status === 'running') return { state: 'delivering', reason: null };
  const admission = result.admission_reason;
  if (typeof admission === 'string') return { state: 'waiting', reason: admission };
  return { state: 'queued', reason: null };
}

function serializePrompt(row: PromptRow, errors?: Map<string, SessionTurnError>) {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const result = (row.result ?? {}) as Record<string, unknown>;
  const { state, reason } = promptState(row);
  // Every id this row has ever been sent under, because the drain re-mints one
  // on redelivery and the ledger keys its rows by whichever id the turn
  // actually carried.
  const wireIds = [
    result.forwarded_message_id,
    payload.redeliveredMessageId,
    payload.wireMessageId,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
  return {
    prompt_id: row.commandId,
    client_message_id: typeof payload.clientMessageId === 'string' ? payload.clientMessageId : '',
    // The id the message ACTUALLY carries in the transcript, when known: the
    // drain re-mints a mid-turn prompt above the live turn's ids, and the strip
    // hides a row the moment the transcript shows its message — a client-minted
    // id here left the row on screen beside its own bubble until the next poll.
    message_id:
      typeof result.forwarded_message_id === 'string'
        ? result.forwarded_message_id
        : typeof payload.redeliveredMessageId === 'string'
          ? payload.redeliveredMessageId
          : typeof payload.wireMessageId === 'string'
            ? payload.wireMessageId
            : '',
    state,
    reason,
    text: (typeof payload.text === 'string' ? payload.text : '').slice(
      0,
      PROMPT_TEXT_PREVIEW_CHARS,
    ),
    attempts: row.attempts,
    last_error: row.lastError ?? null,
    // The TURN's error, not the queue's. `last_error` is why the control plane
    // could not DELIVER this row; this is why the model run that carried it
    // failed — "ModelNotFound: kortix/grok-4.6" is only ever the second kind,
    // and it is invisible to the inbox on its own.
    error: wireIds.map((id) => errors?.get(id)).find((error) => error !== undefined) ?? null,
    created_at: row.createdAt.toISOString(),
    available_at: row.availableAt.toISOString(),
  };
}

/**
 * The failure of the turn that carried each of these prompts, keyed by wire id.
 *
 * ONE extra query, and only when the inbox is non-empty — the steady state of
 * every session is an empty queue, which costs nothing. Scoped to this session
 * and to rows that actually carry an error, so an ordinary completed turn adds
 * no rows to carry back.
 */
async function promptTurnErrors(
  sessionId: string,
  rows: PromptRow[],
): Promise<Map<string, SessionTurnError>> {
  const errors = new Map<string, SessionTurnError>();
  const ids = [
    ...new Set(
      rows.flatMap((row) => {
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        const result = (row.result ?? {}) as Record<string, unknown>;
        return [
          result.forwarded_message_id,
          payload.redeliveredMessageId,
          payload.wireMessageId,
        ].filter((id): id is string => typeof id === 'string' && id.length > 0);
      }),
    ),
  ];
  if (ids.length === 0) return errors;
  const turns = await db
    .select({ messageId: sessionTurns.messageId, error: sessionTurns.error })
    .from(sessionTurns)
    .where(
      and(
        eq(sessionTurns.sessionId, sessionId),
        inArray(sessionTurns.messageId, ids),
        isNotNull(sessionTurns.error),
      ),
    )
    // Oldest first, so the newest attempt on a redelivered id overwrites it.
    .orderBy(asc(sessionTurns.startedAt));
  for (const turn of turns) {
    if (turn.messageId && turn.error) errors.set(turn.messageId, turn.error);
  }
  return errors;
}

function serializeRemovedPrompt(row: PromptRow) {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  return {
    prompt_id: row.commandId,
    client_message_id: typeof payload.clientMessageId === 'string' ? payload.clientMessageId : '',
    // The ORIGINAL wire id, never the re-minted one: an undo re-creates the
    // submission, and `POST .../prompts` places it again from there.
    message_id: typeof payload.wireMessageId === 'string' ? payload.wireMessageId : '',
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
      200: json(z.object({ prompts: z.array(SessionPromptSchema) }), 'Pending prompts'),
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

    // Scoped to INBOX rows — see `listInboxPrompts`. `continue_session` is also
    // how triggers, Slack and approval-resume deliver, and listing those put an
    // automation's internal prompt in the user's own queue.
    const rows = await listInboxPrompts(sessionId, PROMPT_LIST_LIMIT);

    const errors = await promptTurnErrors(sessionId, rows);
    return c.json({ prompts: rows.map((row) => serializePrompt(row, errors)) });
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
    if (!UUID_V4_REGEX.test(promptId)) return c.json({ error: 'Invalid prompt id' }, 400);

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
    const outcome = await deleteInboxPrompt(sessionId, promptId);
    // The response CARRIES THE PROMPT IT REMOVED. A removal is offered with an
    // undo, and the row is hard-deleted, so this response is the only place the
    // full body still exists. Undoing from `GET /prompts`'s view instead
    // restores a 2000-char preview with no attachments and no model override —
    // a silent, unannounced loss on a button labelled "Undo".
    if (outcome.outcome === 'deleted') {
      return c.json({ removed: serializeRemovedPrompt(outcome.row) }, 200);
    }
    if (outcome.outcome === 'delivering') {
      return c.json({ error: 'Prompt is already being delivered' }, 409);
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

    void drainSessionLifecycleQueue({ limit: 1 }).catch(() => undefined);
    return c.json(serializePrompt(requeued, await promptTurnErrors(sessionId, [requeued])), 200);
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
      200: json(z.object({ prompts: z.array(SessionPromptSchema) }), 'Hold applied'),
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
    const rows = await listInboxPrompts(sessionId, PROMPT_LIST_LIMIT);
    if (!body.held) void drainSessionLifecycleQueue({ limit: 1 }).catch(() => undefined);
    const errors = await promptTurnErrors(sessionId, rows);
    return c.json({ prompts: rows.map((row) => serializePrompt(row, errors)) });
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
    const baseRef = normalizeString(body.base_ref ?? body.baseRef) ?? loaded.row.defaultBranch;
    if (baseRef === headRef) {
      return c.json({ error: 'head_ref and base_ref must differ' }, 400);
    }

    let originSessionId: string | null = normalizeString(body.session_id ?? body.sessionId);
    if (originSessionId) {
      const [sessionRow] = await db
        .select({ sessionId: projectSessions.sessionId })
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.sessionId, originSessionId),
            eq(projectSessions.projectId, projectId),
          ),
        )
        .limit(1);
      if (!sessionRow) originSessionId = null;
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

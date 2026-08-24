/**
 * Warm sessions — pre-create the session a present user is about to start, and
 * the deprecated claim that predates it. See ../lib/warm-sessions.ts.
 */

import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';

import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions, sessionLifecycleCommands } from '@kortix/db';
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { callerHasManagerStanding, loadProjectForUser } from '../lib/access';
import { canUseAnyAgent } from '../lib/agent-access';
import { ClaimWarmProjectSessionInputSchema, SessionSchema, WarmProjectSessionResultSchema, projectsApp } from '../lib/app';
import { UUID_V4_REGEX, normalizeString, readBody, requestAuditContext, serializeSession } from '../lib/serializers';
import { createProjectSession } from '../lib/sessions';
import { WARM_SESSION_METADATA_KEY } from '../lib/warm-sessions';
import { SESSION_LAST_ACTIVITY_KEY } from '../session-activity';
import { projectSessionMetadataMerge } from '../lib/session-metadata-merge';
import { drainSessionLifecycleQueue } from '../session-lifecycle';
import { convertPendingPromptToInboxRow } from '../session-lifecycle/pending-prompt';
import { ACTIVE_SESSION_STATUSES } from '../lib/session-status';
import { callerKortixSessionId } from '../lib/caller-session';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { GitOperationError } from '../git/mirror';

/**
 * Warming is SPECULATIVE. The browser fires it on every project view and
 * ignores every failure, falling through to the ordinary create path, which
 * re-evaluates every gate and surfaces the real error to the user. So there is
 * exactly one failure response here, whatever went wrong: billing, the
 * concurrent-session cap, a missing connector connection, an unreadable repo.
 *
 * 409 rather than 5xx because none of those are server faults, and a 5xx on
 * every page view of a repo-less project is both wrong and noisy enough to fail
 * `08-accounts-project-access.spec.ts` (which asserts no 5xx on /v1/projects).
 */
/**
 * `workspace_refresh` is a required field of the published
 * `WarmProjectSessionResult` (npm since v0.11.0), so it cannot be dropped
 * without breaking external consumers. It is now always `skipped`, which is the
 * literal truth: nothing refreshes a warm workspace any more. A warm session's
 * checkout is as old as the session, exactly like any other session's.
 */
const NO_REFRESH = { status: 'skipped' as const };

const WARM_SESSION_MARKER = sql`${projectSessions.metadata}->>${WARM_SESSION_METADATA_KEY}::text = 'true'`;

/**
 * The caller's live, still-unused warm session for this project, or null.
 *
 * ACTIVE statuses only, so a box the idle reaper already stopped is never handed
 * back as "ready". Deliberately does NOT match on agent or sandbox slug: the
 * client compares what comes back against what the user actually selected and
 * falls back to an ordinary create when they differ, which is why the server
 * needs no notion of compatibility at all.
 *
 * `excludeSessionId` skips one session id — the one the caller just took. The
 * warm marker only drops when the FIRST PROMPT reaches the preview proxy
 * (`recordSessionActivity`), seconds after the client already consumed the
 * session client-side, so without this exclusion a replenish racing that gap
 * finds the just-taken row and hands it straight back as `reused: true`.
 */
export async function findWarmProjectSession(scope: {
  accountId: string;
  projectId: string;
  userId: string;
  excludeSessionId?: string | null;
}) {
  const [row] = await db
    .select()
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.accountId, scope.accountId),
        eq(projectSessions.projectId, scope.projectId),
        eq(projectSessions.createdBy, scope.userId),
        inArray(projectSessions.status, [...ACTIVE_SESSION_STATUSES]),
        WARM_SESSION_MARKER,
        sql`coalesce(${projectSessions.metadata}->>'deletedAt', '') = ''`,
        ...(scope.excludeSessionId ? [ne(projectSessions.sessionId, scope.excludeSessionId)] : []),
      ),
    )
    .orderBy(desc(projectSessions.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Drop `metadata.warm` and stamp `last_activity_at` for one session — one
 * UPDATE, one moment.
 *
 * Called from POST /start (routes/r8.ts), the earliest server signal a user
 * actually entered this session. Verified for JAY-599/T21: the ONLY caller of
 * the session-lifecycle engine's `startSession` (which this route drives) is
 * this route itself — nothing pool-side, no server warmer, no automation ever
 * issues a `/start` against a session it did not adopt. So reaching this
 * function at all already proves adoption; the drop can be unconditional,
 * with no separate "I really mean it" flag threaded through the request.
 *
 * The activity stamp is a deliberate REVERSAL of the earlier "adoption is not
 * a turn" rule. Adoption only ever happens because a user pressed Enter with a
 * prompt (the warm take navigates and fires /start), so "last active" =
 * adoption time is honest — while an unstamped row sorted at its CREATE time,
 * the start of the user's dwell on the project home, burying the newest
 * session in the sidebar until the first prompt round-tripped through
 * `recordSessionActivity`. That first prompt re-stamps seconds later, so the
 * two writes can never meaningfully disagree. `updated_at` is bumped for the
 * same reason: `GET /sessions` orders by it, so leaving it untouched made
 * every API-order consumer (CLI, mobile, external SDK) report a stale
 * "latest session" for the adoption-to-first-prompt window. Both stamps
 * mirror `recordSessionActivity` exactly.
 *
 * A no-op (0 rows touched) when the session was never warm: `WARM_SESSION_MARKER`
 * in the WHERE clause makes this safe to call unconditionally and concurrently
 * — a second call (a retried `/start`, a race) finds nothing left to drop and
 * never re-stamps. Best-effort: a failure here degrades the sidebar's timing
 * (the row stays hidden until the first prompt's `recordSessionActivity`
 * catches it), and must never fail the readiness call itself.
 */
export async function dropWarmSessionMarkerOnAdopt(
  sessionId: string,
  /** Epoch ms. Defaults to now; injectable so tests need no clock control. */
  at?: number,
): Promise<void> {
  try {
    const adoptedAt = new Date(at ?? Date.now());
    await db
      .update(projectSessions)
      .set({
        metadata: sql`(${projectSessionMetadataMerge({
          [SESSION_LAST_ACTIVITY_KEY]: adoptedAt.toISOString(),
        })}) - ${WARM_SESSION_METADATA_KEY}::text`,
        updatedAt: adoptedAt,
      })
      .where(and(eq(projectSessions.sessionId, sessionId), WARM_SESSION_MARKER));
  } catch (err) {
    console.warn('[warm-session] failed to drop adoption marker', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function warmSessionUnavailable(c: any) {
  return c.json(
    {
      error: 'This project cannot prepare a warm session right now.',
      code: 'WARM_SESSION_UNAVAILABLE',
    },
    409,
  );
}

// POST /v1/projects/:projectId/sessions/warm
//
// Pre-create the session the user is about to start.
//
// This is the SAME create `POST /{projectId}/sessions` runs, with the project's
// own defaults and nothing else — an ordinary session, owned by this user, that
// they have not typed into yet. It carries one marker, `metadata.warm`, so the
// `visible` session list can hide it until the first prompt lands. See
// lib/warm-sessions.ts.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/warm',
    tags: ['sessions'],
    summary: 'Create or reuse the current user warm project session',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                // The id of the warm session the caller just took for a send.
                // Excluded from the reuse lookup below, so a replenish racing
                // the window before the first prompt drops `metadata.warm`
                // (`recordSessionActivity`) creates a FRESH session instead of
                // handing the just-taken one straight back as `reused: true`.
                exclude_session_id: z.string().optional(),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: json(WarmProjectSessionResultSchema, 'The available warm session'),
      ...errors(400, 402, 403, 404, 409, 429, 500, 503),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    // Same reason the feature flag is checked here rather than in the UI: a warm
    // session is billed compute. A member with no usable agent can never prompt
    // one (`/start` and `/prompts` both refuse), so provisioning it spends money
    // on a sandbox that is dead on arrival.
    //
    // Answered as UNAVAILABLE, not 403. Warming is speculative and unrequested —
    // the browser fires it on project open and ignores every failure. "You are
    // forbidden" is the wrong word for "there is no warm session for you": it
    // put a red 403 in the network panel of a member who did nothing wrong, on
    // every single page load. The spend is still blocked, which is the point.
    if (!(await canUseAnyAgent(c, loaded, projectId))) return warmSessionUnavailable(c);
    // After membership authz, so a non-member learns nothing. A warm session is
    // billed compute, so the switch has to stop the SPEND, not just the UI.
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'warm_sessions');
    if (gate) return gate;

    const body = await readBody(c);
    const excludeSessionId = normalizeString(body.exclude_session_id);

    const view = {
      viewerId: loaded.userId,
      canManageProject: callerHasManagerStanding(loaded.effectiveRole, callerKortixSessionId(c)),
    };
    const existing = await findWarmProjectSession({
      accountId: loaded.row.accountId,
      projectId,
      userId: loaded.userId,
      excludeSessionId,
    });
    if (existing) {
      return c.json(
        { session: serializeSession(existing, view), reused: true, workspace_refresh: NO_REFRESH },
        200,
      );
    }

    try {
      const result = await createProjectSession({
        project: loaded.row,
        userId: loaded.userId,
        requestingPrincipalType:
          c.get('authType') === 'service_account' ? 'service_account' : 'human',
        // Empty: `createProjectSession` resolves the project's default branch,
        // default agent and default sandbox slug exactly as it does for a "New
        // session" click with no overrides. Nothing to keep in sync.
        body: {},
        metadata: { source: 'ui', [WARM_SESSION_METADATA_KEY]: true },
        // A warm box is real, billed compute holding a concurrent-session slot.
        // It must never take the LAST one and 429 the next genuine start.
        reserveConcurrentSlots: 1,
        authType: c.get('authType') as string | undefined,
        apiKeyType: c.get('apiKeyType') as string | undefined,
        inSession: isProjectSessionPrincipal(c),
        callerSessionId: callerKortixSessionId(c),
        request: requestAuditContext(c),
      });
      if (result.error || !result.row) return warmSessionUnavailable(c);
      return c.json(
        { session: serializeSession(result.row, view), reused: false, workspace_refresh: NO_REFRESH },
        200,
      );
    } catch (error) {
      // A project whose repo cannot be read (no credentials, deleted remote, bad
      // ref) simply cannot be warmed. Deliberately narrow: only this classified
      // git failure is swallowed, so a genuine bug in this path still pages.
      if (error instanceof GitOperationError) {
        console.warn('[warm-session] project repo unreadable; skipping warm session', {
          projectId,
          kind: error.kind,
        });
        return warmSessionUnavailable(c);
      }
      throw error;
    }
  },
);

// POST /v1/projects/:projectId/sessions/warm/claim
//
// DEPRECATED. Kept because `claimWarmProjectSession` has shipped in every
// published `@kortix/sdk` since v0.11.0 and removing it would 404 an external
// consumer at runtime. The browser no longer calls it: a warm session is an
// ordinary session, so the send path navigates to it and prompts it, and the
// first prompt drops the marker on its own (projects/session-activity.ts).
//
// It now does exactly what that prompt does — drop `metadata.warm` — plus the
// two things its published input can carry.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/warm/claim',
    tags: ['sessions'],
    summary: 'Claim the current user warm project session (deprecated)',
    deprecated: true,
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: {
        content: {
          'application/json': { schema: ClaimWarmProjectSessionInputSchema },
        },
      },
    },
    responses: {
      200: json(SessionSchema, 'The claimed session'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readBody(c);
    const sessionId = normalizeString(body.session_id);
    if (!sessionId || !UUID_V4_REGEX.test(sessionId)) {
      return c.json({ error: 'Invalid session id', code: 'INVALID_SESSION_ID' }, 400);
    }

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    // Claiming turns a warm box into this user's session — the same agent gate
    // an ordinary create passes (see the /warm route above), and the same
    // unavailable-not-forbidden wording.
    if (!(await canUseAnyAgent(c, loaded, projectId))) return warmSessionUnavailable(c);
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'warm_sessions');
    if (gate) return gate;

    const candidate = await findWarmProjectSession({
      accountId: loaded.row.accountId,
      projectId,
      userId: loaded.userId,
    });
    if (!candidate || candidate.sessionId !== sessionId) {
      return c.json(
        {
          error: 'The warm session is no longer available',
          code: 'WARM_SESSION_ALREADY_CLAIMED',
        },
        409,
      );
    }

    const requestedAgent = normalizeString(body.agent_name);
    if (requestedAgent && requestedAgent !== candidate.agentName) {
      return c.json(
        {
          error: 'The warm session does not match the selected agent',
          code: 'WARM_SESSION_CONFIGURATION_MISMATCH',
        },
        409,
      );
    }

    // Same conversion as session create: the prompt becomes a durable inbox
    // row in the SAME transaction as the claim, and the merged metadata keeps
    // only the picks — a pre-deploy web bundle replays `pending_prompt.text`
    // client-side, and stripping the text is what prevents a double send.
    const rawPendingPrompt =
      body.pending_prompt &&
      typeof body.pending_prompt === 'object' &&
      !Array.isArray(body.pending_prompt) &&
      typeof (body.pending_prompt as Record<string, unknown>).text === 'string'
        ? (body.pending_prompt as Record<string, unknown>)
        : null;
    const conversion = rawPendingPrompt
      ? convertPendingPromptToInboxRow({
          pendingPrompt: rawPendingPrompt,
          projectId,
          accountId: loaded.row.accountId,
          sessionId,
          actorUserId: loaded.userId,
        })
      : null;
    if (conversion?.error) {
      return c.json({ error: `pending_prompt: ${conversion.error}` }, 400);
    }
    const pendingPrompt = conversion ? { pending_prompt: conversion.metadataPicks } : {};
    const claimed = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(projectSessions)
        .set({
          metadata: sql`(${projectSessionMetadataMerge(
            pendingPrompt,
          )}) - ${WARM_SESSION_METADATA_KEY}::text`,
          updatedAt: new Date(),
        })
        .where(and(eq(projectSessions.sessionId, sessionId), WARM_SESSION_MARKER))
        .returning();
      if (row && conversion?.rowValues) {
        // A re-claim after a failed response cannot double-insert: the claim
        // CAS above already refused (marker gone), so this insert runs at most
        // once per session. The idempotency key still guards the create path's
        // row for a session that somehow saw both.
        await tx
          .insert(sessionLifecycleCommands)
          .values(conversion.rowValues)
          .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey })
          .returning({ commandId: sessionLifecycleCommands.commandId });
      }
      return row;
    });
    if (!claimed) {
      return c.json(
        {
          error: 'The warm session is no longer available',
          code: 'WARM_SESSION_ALREADY_CLAIMED',
        },
        409,
      );
    }
    // The box is warm and running — nudge the drain so the first prompt goes
    // out now instead of on the next scheduler tick.
    if (conversion?.rowValues?.idempotencyKey) {
      void drainSessionLifecycleQueue({
        idempotencyKey: conversion.rowValues.idempotencyKey,
      }).catch(() => undefined);
    }
    return c.json(
      serializeSession(claimed, {
        viewerId: loaded.userId,
        canManageProject: callerHasManagerStanding(loaded.effectiveRole, callerKortixSessionId(c)),
      }),
      200,
    );
  },
);

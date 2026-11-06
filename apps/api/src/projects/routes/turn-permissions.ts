/** Agent permission asks: the sandbox `turn-permission` relay that stores the ask and pushes it. */
import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { isSessionSandboxCredential } from '../../middleware/session-sandbox-credential';
import { permissionPushGate } from '../../notifications/permission-push';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { TurnPermissionRelayBodySchema } from '@kortix/api-contract/runtime-relay';
import { projectsApp } from '../lib/app';
import { askNotificationContext } from '../lib/notification-recipients';
import { sandboxTokenMayActOnSession } from '../lib/sandbox-token-session';
import { recordPendingPermission, takeApprovedCall } from '../lib/pending-permissions';
import { askExpiresAt, liveWaitMsFor, surfaceSessionIdOf } from '../lib/session-asks';
import { logger } from '../../lib/logger';
import { workspaceIdParam } from '../../shared/route-params';

// POST /v1/projects/:projectId/turn-permission
// Sandbox-to-apps/api relay for a harness permission request
// (apps/kortix-sandbox-agent-server/src/harness/shared/turn-relay.ts `relayPermission`).
// It stores the ask (lib/pending-permissions.ts), so it outlives the call that
// parks and waits in Review, and sends one "needs your approval" notification
// per request id to the person who prompted the running turn and the session's
// watchers (KRTX-1742). It answers how long the call may wait live
// (`live_wait_ms`), and `approved` when a person approved this exact call
// (`args_hash`) while it was parked: the agent's re-run then runs. Session
// resolution matches POST /turn-question (routes/turn-questions.ts), but only a
// sandbox credential may call it.

/** Request ids are short (`per_…`, `perm_…`); the cap bounds the dedupe keys. */
const MAX_REQUEST_ID_CHARS = 256;

export function registerTurnPermissionsRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/turn-permission',
      tags: ['projects'],
      summary: 'Answer an agent permission request for a turn',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        // The daemon's body (`@kortix/api-contract/runtime-relay`). The handler
        // reads `session_id` and `request_id`; `permission` and `patterns` name
        // what waits for approval.
        body: { content: { 'application/json': { schema: TurnPermissionRelayBodySchema } }, required: true },
      },
      responses: {
        200: json(
          z.object({
            ok: z.literal(true),
            notified: z.boolean(),
            live_wait_ms: z.number().optional(),
            approved: z.boolean().optional(),
            grant: z.string().optional(),
          }),
          'OK',
        ),
        ...errors(400, 403, 404),
      },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);

      // Sandbox credential ONLY. A user token could otherwise push "needs your
      // approval" to another member's devices at will. The daemon is the only
      // caller.
      if (!isSessionSandboxCredential(c)) {
        return c.json({ error: 'turn-permission requires a sandbox token' }, 403);
      }
      const accountId = c.get('accountId') as string | undefined;
      const sandboxId = c.get('sandboxId') as string | undefined;
      if (!accountId || !sandboxId) {
        return c.json({ error: 'turn-permission requires a sandbox token' }, 403);
      }
      const [sandbox] = await db
        .select({ sandboxId: sessionSandboxes.sandboxId, sessionId: sessionSandboxes.sessionId })
        .from(sessionSandboxes)
        .where(
          and(
            eq(sessionSandboxes.sandboxId, sandboxId),
            eq(sessionSandboxes.projectId, projectId),
            eq(sessionSandboxes.accountId, accountId),
            inArray(sessionSandboxes.status, ['provisioning', 'active']),
          ),
        )
        .limit(1);
      if (!sandbox) {
        return c.json({ error: 'sandbox token is not scoped to this workspace' }, 403);
      }
      // The session this credential is BOUND to.
      const callerSandboxSessionId = sandbox.sessionId ?? sandbox.sandboxId;

      let body: {
        session_id?: unknown;
        request_id?: unknown;
        runtime_session_id?: unknown;
        permission?: unknown;
        patterns?: unknown;
        tool?: unknown;
        args_hash?: unknown;
        args?: unknown;
      };
      try {
        body = (await c.req.json()) as typeof body;
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }
      const sessionId = typeof body?.session_id === 'string' ? body.session_id.trim() : '';
      if (!sessionId) {
        return c.json({ error: 'session_id is required' }, 400);
      }
      // A sandbox token acts for exactly one session (lib/sandbox-token-session.ts).
      if (!sandboxTokenMayActOnSession(callerSandboxSessionId, sessionId)) {
        return c.json({ error: 'sandbox token is not scoped to this session' }, 403);
      }

      const [session] = await db
        .select({
          sessionId: projectSessions.sessionId,
          origin: projectSessions.origin,
          metadata: projectSessions.metadata,
          parentSessionId: projectSessions.parentSessionId,
        })
        .from(projectSessions)
        .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)))
        .limit(1);
      if (!session) {
        return c.json({ error: 'Not found' }, 404);
      }

      const requestId = typeof body.request_id === 'string' ? body.request_id.trim() : '';
      if (!requestId) {
        return c.json({ error: 'request_id is required' }, 400);
      }
      if (requestId.length > MAX_REQUEST_ID_CHARS) {
        return c.json({ error: `request_id exceeds ${MAX_REQUEST_ID_CHARS} characters` }, 400);
      }

      const permission = typeof body.permission === 'string' && body.permission ? body.permission.slice(0, 64) : 'tool';
      const tool = typeof body.tool === 'string' && body.tool ? body.tool.slice(0, 128) : permission;
      const argsHash = typeof body.args_hash === 'string' && /^[a-f0-9]{64}$/.test(body.args_hash) ? body.args_hash : null;

      // The agent re-runs a call a person approved while it was parked: it runs,
      // and nothing new waits on anyone.
      if (argsHash) {
        const approved = await takeApprovedCall(sessionId, argsHash);
        if (approved) {
          return c.json({ ok: true, notified: false, approved: true, ...(approved.decision === 'always' ? { grant: approved.permission } : {}) });
        }
      }

      const patterns = Array.isArray(body.patterns) ? body.patterns.filter((p): p is string => typeof p === 'string').slice(0, 16).map((p) => p.slice(0, 2_000)) : [];
      await recordPendingPermission({
        accountId,
        projectId,
        sessionId,
        surfaceSessionId: await surfaceSessionIdOf(sessionId, session),
        requestId,
        runtimeSessionId: typeof body.runtime_session_id === 'string' ? body.runtime_session_id : null,
        tool,
        permission,
        patterns,
        args: body.args ?? null,
        // A daemon built before parking sends no hash: its call never re-runs through an approval.
        argsHash: argsHash ?? `request:${requestId}`,
        expiresAt: askExpiresAt(),
      }).catch((err) => {
        // The ask still reaches the person live; only its durable copy is lost.
        logger.warn('[turn-permission] could not store the permission ask', { sessionId, error: err instanceof Error ? err.message : String(err) });
      });

      // One notification per request id across replicas; it is not awaited
      // (notifications/permission-push.ts). It reaches the person who prompted
      // the running turn and the session's (or the trigger's) watchers. The
      // notifier resolves this context only when the flag is on.
      const notified = await permissionPushGate.notify({
        sessionId,
        projectId,
        requestId,
        context: () =>
          askNotificationContext({ sessionId, projectId, accountId, metadata: session.metadata, origin: session.origin }),
      });
      return c.json({ ok: true, notified, live_wait_ms: liveWaitMsFor(session) });
    },
  );
}

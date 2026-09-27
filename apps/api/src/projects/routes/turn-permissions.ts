/** Agent permission asks: the sandbox `turn-permission` relay that triggers a push. */
import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { isSessionSandboxCredential } from '../../middleware/session-sandbox-credential';
import { permissionPushGate } from '../../notifications/permission-push';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { AnyObject, projectsApp } from '../lib/app';
import { sandboxTokenMayActOnSession } from '../lib/sandbox-token-session';

// POST /v1/projects/:projectId/turn-permission
// Sandbox-to-apps/api relay for OpenCode's `permission.asked` event
// (apps/kortix-sandbox-agent-server/src/harness/open-code/permission-relay.ts).
// It only notifies: the session creator's devices get one "needs your
// approval" push per request id. It never answers the permission — the user
// approves in the session UI, over OpenCode's own API. Session resolution
// matches POST /turn-question (routes/turn-questions.ts), but only a sandbox
// credential may call it.

/** OpenCode request ids are short (`per_…`); the cap bounds the dedupe keys. */
const MAX_REQUEST_ID_CHARS = 256;

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/turn-permission',
    tags: ['projects'],
    summary: 'POST /:projectId/turn-permission',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.object({ ok: z.literal(true), notified: z.boolean() }), 'OK'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');

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
      return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
    }
    // The session this credential is BOUND to.
    const callerSandboxSessionId = sandbox.sessionId ?? sandbox.sandboxId;

    let body: { session_id?: unknown; request_id?: unknown };
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
      .select({ sessionId: projectSessions.sessionId })
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

    // Fire-and-forget, one push per request id (notifications/permission-push.ts).
    const notified = permissionPushGate.notify({ sessionId, projectId, requestId });
    return c.json({ ok: true, notified });
  },
);

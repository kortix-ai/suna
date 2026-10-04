import { createRoute, z } from '@hono/zod-openapi';
import { sessionPresenceLeases } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { auth, errors, json } from '../../openapi';
import { db } from '../../lib/db';
import { PROJECT_ACTIONS } from '../../iam';
import { callerKortixSessionId } from '../../services/sessions/caller-session';
import { assertProjectCapability, loadProjectForUser, loadVisibleSession, sessionIsTombstoned } from '../lib/access';
import { projectsApp } from '../lib/app';
import { extendSandboxDeadline, previewGrantMs } from '../../services/sandboxes/sandbox-deadline';
export function registerSessionPresenceRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'put', path: '/{projectId}/sessions/{sessionId}/presence', tags: ['sessions'],
    summary: 'Renew a browser tab presence lease', ...auth,
    request: { params: z.object({ projectId: z.string().uuid(), sessionId: z.string() }), body: { content: { 'application/json': { schema: z.object({ tab_id: z.string().uuid(), active: z.boolean() }) } } } },
    responses: { 200: json(z.object({ ok: z.boolean() }), 'Presence updated'), ...errors(403, 404) },
  }), async (c) => {
    const { projectId, sessionId } = c.req.valid('param');
    const { tab_id: tabId, active } = c.req.valid('json');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (loaded.actor?.credential.kind !== 'jwt' || callerKortixSessionId(c)) return c.json({ error: 'Human login required' }, 403);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
    const visible = await loadVisibleSession(loaded, sessionId, null, null);
    if (!visible || sessionIsTombstoned(visible.row)) return c.json({ error: 'Not found' }, 404);
    if (active) {
      const expiresAt = new Date(Date.now() + 90_000);
      await db.insert(sessionPresenceLeases).values({ userId: loaded.userId, sessionId, tabId, expiresAt })
        .onConflictDoUpdate({ target: [sessionPresenceLeases.userId, sessionPresenceLeases.sessionId, sessionPresenceLeases.tabId], set: { expiresAt } });
      await extendSandboxDeadline({ sessionId }, previewGrantMs());
    } else {
      await db.delete(sessionPresenceLeases).where(and(eq(sessionPresenceLeases.userId, loaded.userId), eq(sessionPresenceLeases.sessionId, sessionId), eq(sessionPresenceLeases.tabId, tabId)));
    }
    return c.json({ ok: true }, 200);
  });
}

import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { markSessionNotificationsRead } from '../../notifications/inbox-read';
import { assertProjectCapability, loadProjectForUser, loadVisibleSession, projectCapabilityAllowed, sessionIsTombstoned } from '../lib/access';
import { projectsApp } from '../lib/app';
import { deleteSessionPresence, upsertSessionPresence } from '../lib/session-presence';
import { extendSandboxDeadlineForPresence } from '../sandbox-deadline';

const PresenceBody = z.object({
  tab_id: z.string().uuid(),
  active: z.boolean(),
  alerts: z.boolean().optional().openapi({
    description: 'This tab raises its own OS notification for the session, so the phone and Web Push hold back. Default false.',
  }),
});

export function registerSessionPresenceRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'put', path: '/{projectId}/sessions/{sessionId}/presence', tags: ['sessions'],
    summary: 'Renew a browser tab presence lease', ...auth,
    description: 'active=true holds a 90 s lease for this tab and marks the caller\'s notifications of this session read; active=false drops the lease.',
    request: { params: z.object({ projectId: z.string().uuid(), sessionId: z.string() }), body: { required: true, content: { 'application/json': { schema: PresenceBody } } } },
    responses: { 200: json(z.object({ ok: z.boolean() }), 'Presence updated'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId, sessionId } = c.req.valid('param');
    const { tab_id: tabId, active, alerts } = c.req.valid('json');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (loaded.actor?.credential.kind !== 'jwt' || callerKortixSessionId(c)) return c.json({ error: 'Human login required' }, 403);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
    const visible = await loadVisibleSession(loaded, sessionId, null, null);
    if (!visible || sessionIsTombstoned(visible.row)) return c.json({ error: 'Not found' }, 404);
    if (active) {
      await upsertSessionPresence(loaded.userId, sessionId, tabId, alerts === true);
      // KRTX-1742: a person looking at the session has seen what it notified.
      await markSessionNotificationsRead(loaded.userId, sessionId);
      // KRTX-1729: a person who may start the session keeps its computer awake,
      // by the idle grace. A read-only viewer's lease only routes pushes.
      if (await projectCapabilityAllowed(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_START)) {
        await extendSandboxDeadlineForPresence({ sessionId });
      }
    } else {
      await deleteSessionPresence(loaded.userId, sessionId, tabId);
    }
    return c.json({ ok: true }, 200);
  });
}

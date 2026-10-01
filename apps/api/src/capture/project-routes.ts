/**
 * Kortix Capture for agents and CLIs inside a project.
 *
 *   GET /v1/projects/:projectId/capture/search
 *   GET /v1/projects/:projectId/capture/timeline
 *   GET /v1/projects/:projectId/capture/frames/:frameId
 *
 * The route reads the captures of ONE human: the caller (JWT, PAT, OAuth), or,
 * for a session token, the human the session acts for (`on_behalf_of`, private
 * session only). Never another member: there is no `user_id` parameter and no
 * admin view. No human (trigger, service account, shared session) is a 403.
 * The human must have capture on: account enabled and one enabled device.
 * Same query semantics as the account routes (`user-routes.ts`).
 */
import { createRoute, z } from '@hono/zod-openapi';
import { captureAccountSettings, captureDevices, projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { accountRoleFor } from '../iam/read-models';
import { auth, errors, json } from '../openapi';
import { loadProjectForUser } from '../projects/lib/access';
import { projectsApp } from '../projects/lib/app';
import { callerKortixSessionId } from '../projects/lib/caller-session';
import { getRequestOnBehalfOf } from '../projects/lib/on-behalf-of';
import { recordAuditEvent } from '../shared/audit';
import { db } from '../shared/db';
import { captureFrame, captureTimeline, searchCaptures } from './user-routes';

const refuse = (c: any, status: 403 | 404, code: string, error: string) => c.json({ error, code }, status);

/** The human whose captures this request reads, or the refusal to send. */
async function captureHuman(c: any, loaded: { userId: string; row: { projectId: string; accountId: string } }) {
  const sessionId = callerKortixSessionId(c);
  const authType = c.get('authType') as string | undefined;
  let human: string | null = null;
  if (!sessionId) {
    if (authType === 'supabase' || authType === 'pat' || authType === 'oauth') human = loaded.userId;
  } else if (authType === 'pat') {
    const onBehalf = getRequestOnBehalfOf(c);
    const [session] = onBehalf
      ? await db
          .select({ visibility: projectSessions.visibility })
          .from(projectSessions)
          .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, loaded.row.projectId)))
          .limit(1)
      : [];
    if (session?.visibility === 'private') human = onBehalf;
  }
  if (!human || !(await accountRoleFor(loaded.row.accountId, human))) {
    return { response: refuse(c, 403, 'CAPTURE_NO_HUMAN', 'This credential does not act for a person, so it has no capture history') };
  }
  const accountId = loaded.row.accountId;
  const [settings] = await db.select({ enabled: captureAccountSettings.enabled }).from(captureAccountSettings).where(eq(captureAccountSettings.accountId, accountId));
  const [device] = await db
    .select({ id: captureDevices.id })
    .from(captureDevices)
    .where(and(eq(captureDevices.accountId, accountId), eq(captureDevices.userId, human), eq(captureDevices.enabled, true)))
    .limit(1);
  if (!settings?.enabled || !device) {
    return { response: refuse(c, 403, 'CAPTURE_NOT_ENABLED', 'Kortix Capture is not turned on for this person in this account') };
  }
  if (sessionId) {
    await recordAuditEvent({
      accountId,
      projectId: loaded.row.projectId,
      sessionId,
      actorUserId: human,
      actorType: 'agent',
      onBehalfOfUserId: human,
      action: 'capture.agent_read',
      resourceType: 'capture_member',
      resourceId: human,
      outcome: 'success',
      metadata: { path: c.req.path },
    });
  }
  return { human, accountId };
}

const params = z.object({ projectId: z.string().uuid() });
const query = z.object({
  q: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  app: z.string().optional(),
  domain: z.string().optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
});
const reply = { 200: json(z.any(), 'OK'), ...errors(400, 403, 404) };

projectsApp.openapi(
  createRoute({ method: 'get', path: '/{projectId}/capture/search', tags: ['capture'], summary: "Search the acting person's Kortix Capture history", ...auth, request: { params, query }, responses: reply }),
  async (c: any) => {
    const loaded = await loadProjectForUser(c, c.req.param('projectId'), 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const who = await captureHuman(c, loaded);
    if ('response' in who) return who.response;
    return searchCaptures(c, who.accountId, who.human);
  },
);

projectsApp.openapi(
  createRoute({ method: 'get', path: '/{projectId}/capture/timeline', tags: ['capture'], summary: "The acting person's Kortix Capture timeline", ...auth, request: { params, query: z.object({ from: z.string().optional(), to: z.string().optional() }) }, responses: reply }),
  async (c: any) => {
    const loaded = await loadProjectForUser(c, c.req.param('projectId'), 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const who = await captureHuman(c, loaded);
    if ('response' in who) return who.response;
    return captureTimeline(c, who.accountId, who.human);
  },
);

projectsApp.openapi(
  createRoute({ method: 'get', path: '/{projectId}/capture/frames/{frameId}', tags: ['capture'], summary: "One frame of the acting person's Kortix Capture history", ...auth, request: { params: params.extend({ frameId: z.string() }) }, responses: reply }),
  async (c: any) => {
    const loaded = await loadProjectForUser(c, c.req.param('projectId'), 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const who = await captureHuman(c, loaded);
    if ('response' in who) return who.response;
    // A frame of someone else is "not found", never "forbidden": no existence leak.
    return captureFrame(c, who.accountId, async (owner) => owner === who.human, (cc) => refuse(cc, 404, 'CAPTURE_FRAME_NOT_FOUND', 'Frame not found'));
  },
);

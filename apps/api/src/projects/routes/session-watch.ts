// Follow or mute one session's notifications (KRTX-1742). The creator follows
// implicitly and a prompter starts following; any person who may see the
// session can mute or unmute it for themselves. A project route, so
// `guardSession` applies the session visibility rule and audits an oversight
// read.
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { isWatchingSession, setSessionWatch } from '../../notifications/watchers';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { guardSession } from '../lib/http-session-access';

type LoadedProject = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

/**
 * The person behind this request: a browser sign-in, or a personal CLI token
 * not bound to a session. Null for an agent's session token, an API key, a
 * service account or an OAuth app: they never follow a session.
 */
export function personUserId(c: Context, loaded: LoadedProject): string | null {
  const authType = c.get('authType');
  const kind = loaded.actor?.credential.kind;
  if (authType === 'supabase' && kind === 'jwt') return loaded.userId;
  if (authType === 'pat' && kind === 'pat' && !callerKortixSessionId(c)) return loaded.userId;
  return null;
}

const Params = z.object({ projectId: z.string().uuid(), sessionId: z.string().min(1).max(128) });
const WatchSchema = z
  .object({ watching: z.boolean().openapi({ description: 'True: this session notifies you. False: muted for you.' }) })
  .openapi('SessionWatch');

/** The person and the visible session, or the refusal to send. */
async function resolveWatcher(c: Context, projectId: string, sessionId: string) {
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { ok: false as const, status: 404 as const, error: 'Not found' };
  const userId = personUserId(c, loaded);
  if (!userId) return { ok: false as const, status: 403 as const, error: 'Only a person can follow a session' };
  await assertProjectCapability(c, userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
  const guard = await guardSession(c, loaded, sessionId, 'read');
  if (!guard.ok) return guard;
  return { ok: true as const, userId, createdBy: guard.session.row.createdBy ?? null };
}

export function registerSessionWatchRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/sessions/{sessionId}/watch', tags: ['sessions'],
    summary: 'Check whether a session notifies you',
    description: 'True when you created the session or follow it, and have not muted it.',
    ...auth,
    request: { params: Params },
    responses: { 200: json(WatchSchema, 'Your notification setting for this session'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId, sessionId } = c.req.valid('param');
    const watcher = await resolveWatcher(c, projectId, sessionId);
    if (!watcher.ok) return c.json({ error: watcher.error }, watcher.status);
    return c.json({ watching: await isWatchingSession(sessionId, watcher.userId, watcher.createdBy) }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'put', path: '/{projectId}/sessions/{sessionId}/watch', tags: ['sessions'],
    summary: "Follow or mute a session's notifications",
    description: 'watching=false mutes this session for you, the creator included; watching=true follows it.',
    ...auth,
    request: { params: Params, body: { required: true, content: { 'application/json': { schema: WatchSchema } } } },
    responses: { 200: json(WatchSchema, 'Your notification setting for this session'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId, sessionId } = c.req.valid('param');
    const { watching } = c.req.valid('json');
    const watcher = await resolveWatcher(c, projectId, sessionId);
    if (!watcher.ok) return c.json({ error: watcher.error }, watcher.status);
    await setSessionWatch(projectId, sessionId, watcher.userId, watching);
    return c.json({ watching }, 200);
  });
}

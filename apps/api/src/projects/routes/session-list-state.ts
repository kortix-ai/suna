// Pin a session to the top of your list, or archive it out of the list
// (KRTX-2418). Per person: any person who may see the session pins or archives
// it for themselves, and no one else's list changes. An agent, an API key or a
// service account has no list of its own and gets 403.
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { guardSession } from '../lib/http-session-access';
import { sessionIsTombstoned } from '../lib/session-visibility';
import { setSessionArchived, setSessionPinned, type SessionUserState } from '../lib/session-user-state';
import { personUserId } from './session-watch';

const Params = z.object({ projectId: z.string().uuid(), sessionId: z.string().min(1).max(128) });
const StateSchema = z
  .object({
    pinned_at: z.string().nullable().openapi({ description: 'When you pinned the session. Null: not pinned.' }),
    archived_at: z.string().nullable().openapi({ description: 'When you archived the session. Null: not archived.' }),
  })
  .openapi('SessionListState');

function stateBody(state: SessionUserState) {
  return { pinned_at: state.pinnedAt?.toISOString() ?? null, archived_at: state.archivedAt?.toISOString() ?? null };
}

/** The person and the visible, undeleted session, or the refusal to send. */
async function resolvePerson(c: Context, projectId: string, sessionId: string) {
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { ok: false as const, response: c.json({ error: 'Not found' }, 404) };
  const userId = personUserId(c, loaded);
  if (!userId) return { ok: false as const, response: c.json({ error: 'Only a person can pin or archive a session' }, 403) };
  await assertProjectCapability(c, userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
  const guard = await guardSession(c, loaded, sessionId, 'read');
  if (!guard.ok) return { ok: false as const, response: c.json({ error: guard.error }, guard.status) };
  if (sessionIsTombstoned(guard.session.row)) return { ok: false as const, response: c.json({ error: 'Not found' }, 404) };
  return { ok: true as const, userId };
}

export function registerSessionListStateRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'put', path: '/{projectId}/sessions/{sessionId}/pin', tags: ['sessions'],
    summary: 'Pin or unpin a session in your list',
    description: 'pinned=true keeps the session at the top of your list and takes it out of your archive. Only your list changes.',
    ...auth,
    request: {
      params: Params,
      body: { required: true, content: { 'application/json': { schema: z.object({ pinned: z.boolean() }).openapi('SessionPin') } } },
    },
    responses: { 200: json(StateSchema, 'Your pin and archive for this session'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId, sessionId } = c.req.valid('param');
    const person = await resolvePerson(c, projectId, sessionId);
    if (!person.ok) return person.response;
    return c.json(stateBody(await setSessionPinned(sessionId, person.userId, c.req.valid('json').pinned)), 200);
  });

  projectsApp.openapi(createRoute({
    method: 'put', path: '/{projectId}/sessions/{sessionId}/archive', tags: ['sessions'],
    summary: 'Archive or unarchive a session in your list',
    description: 'archived=true hides the session from your list and unpins it; list it with `archived=only`. Only your list changes.',
    ...auth,
    request: {
      params: Params,
      body: { required: true, content: { 'application/json': { schema: z.object({ archived: z.boolean() }).openapi('SessionArchive') } } },
    },
    responses: { 200: json(StateSchema, 'Your pin and archive for this session'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId, sessionId } = c.req.valid('param');
    const person = await resolvePerson(c, projectId, sessionId);
    if (!person.ok) return person.response;
    return c.json(stateBody(await setSessionArchived(sessionId, person.userId, c.req.valid('json').archived)), 200);
  });
}

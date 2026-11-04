// POST /v1/projects/:projectId/chat/threads — Kortix starts a thread in the
// person's chat (flag `infinichat`): a top-level message from Kortix. Only a
// session calls it, for the person it works for (lib/chat-threads.ts).
import { createRoute, z } from '@hono/zod-openapi';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { auth, errors, json } from '../../openapi';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { CHAT_AGENT, CHAT_ROOT_TEXT_KEY, CHAT_ROOT_TEXT_MAX, sessionPerson } from '../lib/chat-threads';
import { getOrCreateDm } from '../lib/project-spaces';
import { requestAuditContext } from '../lib/serializers';
import { SESSION_CREATE_ERROR_STATUSES, sendSessionCreateError } from '../lib/sessions';
import { createSession } from '../session-lifecycle';

const ChatThreadInputSchema = z.object({ text: z.string().trim().min(1).max(CHAT_ROOT_TEXT_MAX) });
const ChatThreadSchema = z.object({ session_id: z.string() });

export function registerChatThreadRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'post',
    path: '/{projectId}/chat/threads',
    tags: ['sessions'],
    summary: 'Start a thread in the person’s chat',
    description: 'A session posts a top-level message to the person it works for, in their chat with Kortix (their DM with My Kortix). The person’s reply runs in that thread. Flag `infinichat`.',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { required: true, content: { 'application/json': { schema: ChatThreadInputSchema } } },
    },
    responses: { 201: json(ChatThreadSchema, 'The new thread'), ...errors(...SESSION_CREATE_ERROR_STATUSES) },
  }), async (c) => {
    const projectId = c.req.param('projectId');
    const caller = callerKortixSessionId(c);
    if (!caller) return c.json({ error: 'Only a session starts a thread in a person’s chat' }, 403);
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const disabled = requireFeatureFlag(c, loaded.row.metadata, 'infinichat');
    if (disabled) return disabled;
    const person = await sessionPerson(projectId, caller);
    if (!person) return c.json({ error: 'This session works for no person', code: 'no_person' }, 409);
    const space = await getOrCreateDm(projectId, loaded.row.accountId, person, CHAT_AGENT);
    const result = await createSession({
      source: 'system:chat-post',
      project: loaded.row,
      userId: person,
      requestingPrincipalType: 'human',
      body: { agent_name: CHAT_AGENT, space_id: space.spaceId },
      metadata: { [CHAT_ROOT_TEXT_KEY]: c.req.valid('json').text },
      visibility: 'private',
      inSession: false,
      callerSessionId: null,
      request: requestAuditContext(c),
      idempotencyKey: null,
    });
    if (result.error) return sendSessionCreateError(c, result.error);
    const sessionId = result.row?.sessionId ?? result.sessionId;
    if (!sessionId) return c.json({ error: 'The thread could not be started' }, 503);
    return c.json({ session_id: sessionId }, 201);
  });
}

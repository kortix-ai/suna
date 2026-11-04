// POST /v1/projects/:projectId/chat/threads — Kortix starts a thread in the
// person's chat (flag `chat`): a top-level message from Kortix. Only a
// session calls it, for the person it works for (lib/chat-threads.ts).
import { createRoute, z } from '@hono/zod-openapi';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { auth, errors, json } from '../../openapi';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { CHAT_AGENT, CHAT_ROOT_TEXT_KEY, CHAT_ROOT_TEXT_MAX, sessionThread, threadWorksOnlyForPerson } from '../lib/chat-threads';
import { getOrCreateDm } from '../lib/project-spaces';
import { requestAuditContext } from '../lib/serializers';
import { SESSION_CREATE_ERROR_STATUSES, sendSessionCreateError } from '../lib/sessions';
import { createSession } from '../session-lifecycle';

/** A thread title from Kortix's message: its first line, at most 60 characters. */
function threadTitle(text: string): string {
  const line = text.split('\n').find((part) => part.trim())?.trim() ?? text.trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

const ChatThreadInputSchema = z.object({ text: z.string().trim().min(1).max(CHAT_ROOT_TEXT_MAX) });
const ChatThreadSchema = z.object({ session_id: z.string() });

export function registerChatThreadRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'post',
    path: '/{projectId}/chat/threads',
    tags: ['sessions'],
    summary: 'Start a thread in the person’s chat',
    description: 'A session posts a top-level message to the person it works for, in their chat with Kortix (their DM with My Kortix). The person’s reply runs in that thread. Only a `private` session filed in no space or in one of the person’s own DMs may post; any other session gets 403 `not_the_persons_chat`. Flag `chat`.',
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
    const disabled = requireFeatureFlag(c, loaded.row.metadata, 'chat');
    if (disabled) return disabled;
    const thread = await sessionThread(projectId, caller);
    if (!thread) return c.json({ error: 'This session works for no person', code: 'no_person' }, 409);
    // Checked before the DM is made: a refused call writes nothing.
    if (!(await threadWorksOnlyForPerson(projectId, thread))) {
      return c.json(
        { error: 'Only a private session in the person’s own chat or in no space posts to their chat', code: 'not_the_persons_chat' },
        403,
      );
    }
    const person = thread.personId;
    const space = await getOrCreateDm(projectId, loaded.row.accountId, person, CHAT_AGENT);
    const result = await createSession({
      source: 'system:chat-post',
      project: loaded.row,
      userId: person,
      requestingPrincipalType: 'human',
      body: { agent_name: CHAT_AGENT, space_id: space.spaceId },
      // Its title until a generated one replaces it: the start of Kortix's own message.
      metadata: { [CHAT_ROOT_TEXT_KEY]: c.req.valid('json').text, name: threadTitle(c.req.valid('json').text) },
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

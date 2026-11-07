// POST /v1/projects/:projectId/chat/threads — Kortix starts a thread in the
// person's chat (flag `chat`): a top-level message from Kortix. Only a
// session calls it, for the person it works for (lib/chat-threads.ts).
//
// POST /v1/projects/:projectId/spaces/:spaceId/posts — an agent posts into any
// space its person may post in: a top-level message, or a message into one of
// its threads, with mentions (lib/space-posts.ts).
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
import { agentMayPerform, getAgentGrant } from '../../iam/agent-scope';
import { PROJECT_ACTIONS } from '../../iam';
import { postIntoSpace } from '../lib/space-posts';
import { workspaceIdParam } from '../../shared/route-params';

/** A thread title from Kortix's message: its first line, at most 60 characters. */
function threadTitle(text: string): string {
  const line = text.split('\n').find((part) => part.trim())?.trim() ?? text.trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

const ChatThreadInputSchema = z.object({ text: z.string().trim().min(1).max(CHAT_ROOT_TEXT_MAX) });
const ChatThreadSchema = z.object({ session_id: z.string() });
const SpacePostInputSchema = z.object({
  text: z.string().trim().min(1).max(CHAT_ROOT_TEXT_MAX),
  /** A thread of the space: the post goes into it instead of starting a new one. */
  thread_id: z.string().optional(),
  /** Into a thread: the thread's agent answers (a turn runs). Default: it only reads it. */
  ask: z.boolean().optional(),
});
const SpacePostSchema = z.object({
  /** The thread the post started, or the one it went into. */
  session_id: z.string(),
  kind: z.enum(['thread', 'reply']),
  /** The people the post's mentions notified. */
  notified: z.array(z.string()),
  mentions: z.array(z.object({ token: z.string(), kind: z.enum(['person', 'agent']), label: z.string() })),
});

export function registerChatThreadRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'post',
    path: '/{workspaceId}/chat/threads',
    tags: ['sessions'],
    summary: 'Start a thread in the person’s chat',
    description: 'A session posts a top-level message to the person it works for, in their chat with Kortix (their DM with My Kortix). The person’s reply runs in that thread. Only a `private` session filed in no space or in one of the person’s own DMs may post; any other session gets 403 `not_the_persons_chat`. Flag `chat`.',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string() }),
      body: { required: true, content: { 'application/json': { schema: ChatThreadInputSchema } } },
    },
    responses: { 201: json(ChatThreadSchema, 'The new thread'), ...errors(...SESSION_CREATE_ERROR_STATUSES) },
  }), async (c) => {
    const projectId = workspaceIdParam(c);
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

  projectsApp.openapi(createRoute({
    method: 'post',
    path: '/{workspaceId}/spaces/{spaceId}/posts',
    tags: ['spaces'],
    summary: 'Post into a space as an agent',
    description:
      'A session posts for the person it works for, where that person may post: a channel the session can see (a private channel only from its own threads), ' +
      'or a DM the person owns (only from a private session that works only for them; else 403 `not_the_persons_chat`). ' +
      'Without `thread_id`: a new top-level message from the agent in the space\'s chat; a person\'s reply runs that thread with the space\'s agent. ' +
      'With `thread_id` (a thread of this space): a message from the agent in that thread, which its agent only reads unless `ask` is true. ' +
      '`@person` (display name, email or its local part) and `@agent` become mentions; each mentioned person who may see the thread gets one notification. Flag `chat`.',
    ...auth,
    request: {
      params: z.object({ workspaceId: z.string(), spaceId: z.string() }),
      body: { required: true, content: { 'application/json': { schema: SpacePostInputSchema } } },
    },
    responses: { 201: json(SpacePostSchema, 'The post'), ...errors(...SESSION_CREATE_ERROR_STATUSES) },
  }), async (c) => {
    const projectId = workspaceIdParam(c);
    const caller = callerKortixSessionId(c);
    if (!caller) return c.json({ error: 'Only an agent in a session posts here. A person writes in the chat.', code: 'session_only' }, 403);
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const disabled = requireFeatureFlag(c, loaded.row.metadata, 'chat');
    if (disabled) return disabled;
    const input = c.req.valid('json');
    const outcome = await postIntoSpace({
      project: loaded.row,
      callerSessionId: caller,
      spaceId: c.req.param('spaceId'),
      text: input.text,
      threadId: input.thread_id ?? null,
      ask: input.ask === true,
      actor: loaded.actor ?? null,
      agentMayPrompt: agentMayPerform(getAgentGrant(c), PROJECT_ACTIONS.PROJECT_SESSION_START),
      startThread: async (spec) => {
        const result = await createSession({
          source: 'system:chat-post',
          project: loaded.row,
          userId: spec.person,
          requestingPrincipalType: 'human',
          body: { agent_name: spec.agentName, space_id: spec.spaceId },
          metadata: { ...spec.metadata, name: threadTitle(input.text) },
          visibility: spec.visibility,
          inSession: false,
          callerSessionId: null,
          request: requestAuditContext(c),
          idempotencyKey: null,
        });
        if (result.error) return { error: result.error };
        return { sessionId: result.row?.sessionId ?? result.sessionId ?? null };
      },
    });
    if ('createError' in outcome) return sendSessionCreateError(c, outcome.createError);
    // Each status is one the route declares; the service picks one of them.
    return c.json(outcome.body, outcome.status) as never;
  });
}

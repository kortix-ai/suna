// POST /v1/projects/:projectId/front-chat — the caller's one front chat (flag
// `infinichat`): a My Kortix session in which the agent only talks and a worker
// session does the work (lib/front-chat-keys.ts, kortixd harness/pi/front.ts).
import { createRoute, z } from '@hono/zod-openapi';
import { MY_KORTIX_AGENT_NAME } from '@kortix/shared';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { auth, errors, json } from '../../openapi';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { findFrontChatSession } from '../lib/front-chat';
import { FRONT_CHAT_FLAG, FRONT_CHAT_METADATA_KEY } from '../lib/front-chat-keys';
import { requestAuditContext } from '../lib/serializers';
import { sessionCreateSurface } from '../lib/session-surface';
import { SESSION_CREATE_ERROR_STATUSES, sendSessionCreateError } from '../lib/sessions';
import { createSession } from '../session-lifecycle';

const FrontChatSchema = z.object({
  session_id: z.string(),
  created: z.boolean(),
});

export function registerFrontChatRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'post',
    path: '/{projectId}/front-chat',
    tags: ['sessions'],
    summary: 'Open my front chat',
    description: 'The caller\'s one front chat in this project: the newest one, or a new My Kortix session when there is none. Flag `infinichat`; My Kortix must be on in kortix.yaml.',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(FrontChatSchema, 'The existing front chat'),
      201: json(FrontChatSchema, 'A new front chat'),
      ...errors(...SESSION_CREATE_ERROR_STATUSES),
    },
  }), async (c) => {
    const projectId = c.req.param('projectId');
    // A person's chat: a session token never opens one.
    if (callerKortixSessionId(c)) return c.json({ error: 'A session cannot open a front chat' }, 403);
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const disabled = requireFeatureFlag(c, loaded.row.metadata, FRONT_CHAT_FLAG);
    if (disabled) return disabled;
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);

    const existing = await findFrontChatSession(projectId, loaded.userId);
    if (existing) return c.json({ session_id: existing, created: false }, 200);

    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    const result = await createSession({
      source: sessionCreateSurface(c.req.header('x-kortix-client-version')),
      project: loaded.row,
      userId: loaded.userId,
      requestingPrincipalType: c.get('authType') === 'service_account' ? 'service_account' : 'human',
      body: { agent_name: MY_KORTIX_AGENT_NAME, title: 'Kortix' },
      metadata: { [FRONT_CHAT_METADATA_KEY]: true },
      authType: c.get('authType') as string | undefined,
      apiKeyType: c.get('apiKeyType') as string | undefined,
      inSession: isProjectSessionPrincipal(c),
      callerSessionId: null,
      parentActor: loaded.actor ?? undefined,
      request: requestAuditContext(c),
      idempotencyKey: null,
    });
    if (result.error) return sendSessionCreateError(c, result.error);
    const sessionId = result.row?.sessionId ?? result.sessionId;
    if (!sessionId) return c.json({ error: 'The front chat could not be created' }, 503);
    return c.json({ session_id: sessionId, created: true }, 201);
  });
}

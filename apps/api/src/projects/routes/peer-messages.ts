// Cross-session messages and the agents a session can reach
// (`@kortix/api-contract/multi-agent`). Logic lives in
// `projects/peer-messages/service.ts`. Unflagged.
//
// Who may call, per route. `:sessionId` is the session the route speaks for.
//   reachable, send     the session's own credential, or a person who may
//                       prompt that session (`mayPromptSessions`)
//   list                the session's own credential, or a person who can see it
//   approve, deny,      a person who may prompt the receiving session; never a
//   inbound             session credential: the hold is the person's control
// A message reaches its recipient only when the person the caller acts for
// may prompt the recipient, and the caller's agent grant includes
// project.session.start; otherwise the answer is a `refused` result.
import { createRoute, z } from '@hono/zod-openapi';
import {
  PeerMessageAmbiguousSchema,
  PeerMessageSchema,
  PeerMessageSendBodySchema,
  PeerMessageSendResultSchema,
  ReachableAgentsSchema,
  ReachableScopeSchema,
  SessionInboundSchema,
} from '@kortix/api-contract/multi-agent';
import type { Context } from 'hono';
import { checkBillingAdmission } from '../../billing/services/billing-gate';
import { PROJECT_ACTIONS } from '../../iam';
import { agentMayPerform, getAgentGrant, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { mayPromptSessions } from '../../notifications/access';
import { auth, errors, json } from '../../openapi';
import { assertProjectCapability, loadProjectForUser, loadVisibleSession } from '../lib/access';
import { projectsApp } from '../lib/app';
import { sessionIsTombstoned } from '../lib/session-visibility';
import {
  PeerMessageError,
  decideHeldMessage,
  listPeerMessages,
  reachableAgents,
  sendPeerMessage,
  setSessionInbound,
  type PeerCaller,
} from '../peer-messages/service';

const SessionParams = z.object({ projectId: z.string().uuid(), sessionId: z.string().min(1).max(128) });
const MessageParams = SessionParams.extend({ messageId: z.string().min(1).max(64) });

type Mode = 'speak' | 'read' | 'person';

/**
 * Load the session `:sessionId` names and check the caller may act on it in `mode`.
 * Returns the response to send on refusal.
 */
async function authorize(c: Context, projectId: string, sessionId: string, mode: Mode) {
  const fail = (status: 403 | 404, error: string, code?: string) =>
    ({ ok: false as const, response: c.json({ error, ...(code ? { code } : {}) }, status) });
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return fail(404, 'Not found');
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
  const callerSessionId = callerKortixSessionId(c);
  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerSessionId);
  if (!visible || sessionIsTombstoned(visible.row)) return fail(404, 'Session not found');
  const principal = isProjectSessionPrincipal(c);
  if (principal && mode === 'person') {
    return fail(403, "Only the session's person decides who may message it", 'person_only');
  }
  if (principal && callerSessionId !== sessionId) {
    return fail(403, 'A session speaks only for itself here', 'not_this_session');
  }
  if (!principal && mode !== 'read' &&
    !(await mayPromptSessions(loaded.userId, loaded.row.accountId, [sessionId])).has(sessionId)) {
    return fail(403, 'You may not prompt this session', 'cannot_prompt');
  }
  const caller: PeerCaller = {
    actor: loaded.actor ?? { userId: loaded.userId, accountId: loaded.row.accountId, credential: { kind: 'jwt' }, ctx: {} },
    userId: loaded.userId,
    agentMayPrompt: agentMayPerform(getAgentGrant(c), PROJECT_ACTIONS.PROJECT_SESSION_START),
  };
  return { ok: true as const, loaded, session: visible.row, caller };
}

function peerError(c: Context, err: unknown) {
  // Each route declares the statuses it can answer; the service picks one of them.
  if (err instanceof PeerMessageError) return c.json({ error: err.message, code: err.code, ...err.extra }, err.status) as never;
  throw err;
}

export function registerPeerMessagesRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/sessions/{sessionId}/reachable', tags: ['sessions'],
    summary: 'List the agents a session can message',
    description:
      '`scope=mine` (default): its parent, children, lead and teammates. `scope=project`: every live session of the project the caller may see; ' +
      'with `project_id`, of that project of the account instead. ' +
      'Each row says how it relates to the session, its board state, its inbound setting and whether a message would reach it.',
    ...auth,
    request: {
      params: SessionParams,
      query: z.object({
        scope: ReachableScopeSchema.optional(),
        // With scope=project: list another project of the account, as the caller's person sees it.
        project_id: z.string().uuid().optional(),
      }),
    },
    responses: { 200: json(ReachableAgentsSchema, 'The session and the agents it can reach'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId, sessionId } = c.req.valid('param');
    const query = c.req.valid('query');
    const access = await authorize(c, projectId, sessionId, 'speak');
    if (!access.ok) return access.response;
    try {
      return c.json(await reachableAgents({
        self: access.session,
        scope: query.scope ?? (query.project_id ? 'project' : 'mine'),
        caller: access.caller,
        projectId: query.project_id ?? null,
      }), 200);
    } catch (err) {
      return peerError(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/sessions/{sessionId}/peer-messages', tags: ['sessions'],
    summary: 'Send a message from this session to another session',
    description:
      '`to` is a handle, a session id or 8+ character prefix, `parent`, `main`, or `@name`. The answer never waits for the receiver: ' +
      'a working receiver reads it at its next step, an idle one starts a turn, a stopped one wakes. A receiver set to `hold` gets it after its person approves; ' +
      'one set to `refuse`, or one the caller may not prompt, answers `refused`. The same text to the same session within 60 s is `dropped`. ' +
      '`shutdown_response` with `approve: true` stops the sending session a few seconds later.',
    ...auth,
    request: { params: SessionParams, body: { required: true, content: { 'application/json': { schema: PeerMessageSendBodySchema } } } },
    responses: {
      200: json(PeerMessageSendResultSchema, 'Where the message is now'),
      409: json(PeerMessageAmbiguousSchema, '`to` names more than one session'),
      ...errors(400, 402, 403, 404, 429),
    },
  }), async (c) => {
    const { projectId, sessionId } = c.req.valid('param');
    const access = await authorize(c, projectId, sessionId, 'speak');
    if (!access.ok) return access.response;
    // A delivered message may start a turn: the same gate as a prompt.
    const billing = await checkBillingAdmission(access.loaded.row.accountId);
    if (!billing.ok) return c.json({ error: billing.message, message: billing.message, code: billing.reason }, 402);
    try {
      const outcome = await sendPeerMessage({ sender: access.session, body: c.req.valid('json'), caller: access.caller });
      if (outcome.kind === 'ambiguous') {
        return c.json({ error: true as const, code: 'ambiguous_recipient' as const, message: outcome.message, candidates: outcome.candidates }, 409);
      }
      return c.json(outcome.result, 200);
    } catch (err) {
      return peerError(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/sessions/{sessionId}/peer-messages', tags: ['sessions'],
    summary: 'List the messages a session sent or received',
    description: '`direction=in`: received; `out`: sent; absent: both. Newest first, at most 100. A held message past its window reads `expired`.',
    ...auth,
    request: { params: SessionParams, query: z.object({ direction: z.enum(['in', 'out']).optional() }) },
    responses: { 200: json(z.object({ messages: z.array(PeerMessageSchema) }), 'The messages'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId, sessionId } = c.req.valid('param');
    const access = await authorize(c, projectId, sessionId, 'read');
    if (!access.ok) return access.response;
    return c.json({ messages: await listPeerMessages(sessionId, c.req.valid('query').direction ?? 'both') }, 200);
  });

  for (const decision of ['approve', 'deny'] as const) {
    projectsApp.openapi(createRoute({
      method: 'post', path: `/{projectId}/sessions/{sessionId}/peer-messages/{messageId}/${decision}`, tags: ['sessions'],
      summary: decision === 'approve' ? 'Approve a held message to this session' : 'Deny a held message to this session',
      description: decision === 'approve'
        ? 'Delivers a message the session holds (inbound `hold`). A person who may prompt the session only. `409` when it expired or was decided.'
        : 'Drops a message the session holds; the sender sees `denied`. A person who may prompt the session only.',
      ...auth,
      request: { params: MessageParams },
      responses: { 200: json(PeerMessageSchema, 'The decided message'), ...errors(400, 402, 403, 404, 409) },
    }), async (c) => {
      const { projectId, sessionId, messageId } = c.req.valid('param');
      const access = await authorize(c, projectId, sessionId, 'person');
      if (!access.ok) return access.response;
      if (decision === 'approve') {
        const billing = await checkBillingAdmission(access.loaded.row.accountId);
        if (!billing.ok) return c.json({ error: billing.message, message: billing.message, code: billing.reason }, 402);
      }
      try {
        return c.json(await decideHeldMessage({ receiver: access.session, messageId, approve: decision === 'approve' }), 200);
      } catch (err) {
        return peerError(c, err);
      }
    });
  }

  projectsApp.openapi(createRoute({
    method: 'put', path: '/{projectId}/sessions/{sessionId}/inbound', tags: ['sessions'],
    summary: 'Set who may send this session a message',
    description: '`accept` (default): messages arrive. `hold`: each waits for approval, 5 minutes. `refuse`: senders are told it was not sent. A person who may prompt the session only.',
    ...auth,
    request: {
      params: SessionParams,
      body: { required: true, content: { 'application/json': { schema: z.object({ inbound: SessionInboundSchema }).strict() } } },
    },
    responses: { 200: json(z.object({ inbound: SessionInboundSchema }), 'The setting'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId, sessionId } = c.req.valid('param');
    const access = await authorize(c, projectId, sessionId, 'person');
    if (!access.ok) return access.response;
    return c.json({ inbound: await setSessionInbound(sessionId, c.req.valid('json').inbound) }, 200);
  });
}

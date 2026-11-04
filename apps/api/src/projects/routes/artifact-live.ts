// Live presence on Artifacts (KRTX-3669, flags `artifacts` + `artifact_comments`).
//
//   POST …/artifacts/{artifactId}/live/ticket   a single-use ticket for the socket
//   POST …/artifacts/{artifactId}/live/agent    an agent session names its place
//
// The socket itself, `GET …/artifacts/{artifactId}/live?ticket=`, is upgraded
// in `inbound-dispatch.ts` (`artifacts/live-hub.ts`). Both routes run the
// comment routes' view gate (`authorizeComments`, read mode): 403
// `feature_disabled` while a flag is off, 404 for an Artifact the caller cannot
// view, 403 without project.artifact.read or project.artifact.comment.
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ARTIFACT_LIVE_LIMITS, artifactLiveAgentSignalSchema } from '@kortix/shared/artifact-live';
import { auth, errors, json } from '../../openapi';
import { ArtifactLiveAgentError, signalArtifactLiveAgent } from '../../artifacts/live-hub';
import { inspectLiveCredential, liveCredentialKind, type LiveCredentialRef } from '../../artifacts/live-credential';
import { artifactLiveTicketClaims, mintArtifactLiveTicket } from '../../artifacts/live-ticket';
import type { Actor } from '../../iam/actor';
import { bearerToken } from '../../shared/bearer-token';
import { decodeSupabaseJwtPayload } from '../../shared/jwt-verify';
import { projectsApp } from '../lib/app';
import { authorizeComments } from './artifact-comments';

const ArtifactParams = z.object({ projectId: z.string().uuid(), artifactId: z.string().uuid() });
const notFound = (c: Context) => c.json({ error: 'Artifact not found', code: 'not_found' }, 404);

/**
 * The credential behind this request, as the live socket will re-check it
 * (`artifacts/live-credential.ts`): its kind, its row, and its expiry. A
 * browser session's expiry is the access token's `exp`; every other kind
 * reports its row's. Null: an authType that may not open a socket.
 */
function liveCredential(c: Context, actor: Actor): { ref: LiveCredentialRef; tokenExpiresAt: number | null } | null {
  const kind = liveCredentialKind(c.get('authType'), actor.credential.kind);
  if (!kind) return null;
  const { credential } = actor;
  switch (kind) {
    case 'browser_session': {
      const token = bearerToken(c.req.header('authorization'));
      const exp = token ? decodeSupabaseJwtPayload(token)?.exp : undefined;
      const sessionId = c.get('sessionId');
      return {
        ref: { kind, id: typeof sessionId === 'string' ? sessionId : null },
        tokenExpiresAt: typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null,
      };
    }
    case 'oauth': {
      const tokenId = c.get('oauthTokenId');
      return { ref: { kind, id: typeof tokenId === 'string' ? tokenId : null }, tokenExpiresAt: null };
    }
    case 'pat':
    case 'agent_session':
      return { ref: { kind, id: 'tokenId' in credential ? credential.tokenId : null }, tokenExpiresAt: null };
    case 'service_account':
      return { ref: { kind, id: credential.kind === 'service_account' ? credential.serviceAccountId : null }, tokenExpiresAt: null };
  }
}

const TicketSchema = z.object({
  ticket: z.string().openapi({ description: 'Open `GET …/live?ticket=<ticket>` with it. It works once.' }),
  expires_at: z.string().openapi({ description: `When the unused ticket stops working: ${ARTIFACT_LIVE_LIMITS.ticketMs / 1000} s after it was minted.` }),
}).openapi('ArtifactLiveTicket');

const AgentSignalBody = z.object({
  status: z.enum(['reading', 'editing', 'writing', 'idle']).openapi({ description: '`idle`: the agent leaves the Artifact.' }),
  thread_id: z.string().uuid().optional().openapi({ description: 'The comment thread the agent works on, on this Artifact.' }),
  quote: z.string().min(1).max(500).optional().openapi({ description: 'Text the agent works near; its first 64 characters place the label.' }),
}).strict().openapi('ArtifactLiveAgentSignal');

export function registerArtifactLiveRoutes(): void {
  // A WebSocket upgrade never reaches Hono: `inbound-dispatch.ts` takes it
  // first. This documents the socket and answers a plain request.
  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/artifacts/{artifactId}/live', tags: ['artifacts'],
    summary: 'The Artifact\'s live presence WebSocket',
    description: 'Upgrade to a WebSocket with `?ticket=` from `POST …/live/ticket` (frames: `@kortix/shared/artifact-live`). Without a ticket, or with a used or expired one, the upgrade answers 401; a caller who cannot view the Artifact, 404. Close codes: 4400 bad frame, 4403 access lost (final), 4429 too many frames, 1000 silent for 45 s. A request without an upgrade answers 426.',
    ...auth,
    request: { params: ArtifactParams, query: z.object({ ticket: z.string().optional() }) },
    responses: { 426: json(z.object({ error: z.string(), code: z.literal('websocket_required') }), 'Upgrade to a WebSocket'), ...errors(401) },
  }), (c) => c.json({ error: 'Open this path as a WebSocket with a live ticket', code: 'websocket_required' as const }, 426));

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/artifacts/{artifactId}/live/ticket', tags: ['artifacts'],
    summary: 'Get a single-use ticket for the Artifact\'s live presence socket',
    description: `The ticket lives ${ARTIFACT_LIVE_LIMITS.ticketMs / 1000} s, works once, and is bound to you and this Artifact. A browser cannot send Authorization on a WebSocket, so the socket authenticates with the ticket and never with a JWT in its URL.`,
    ...auth,
    request: { params: ArtifactParams },
    responses: { 200: json(TicketSchema, 'The ticket'), ...errors(401, 403, 404, 503) },
  }), async (c) => {
    const { projectId, artifactId } = c.req.valid('param');
    const access = await authorizeComments(c, projectId, artifactId, false);
    if (!access.ok) return access.response;
    const forbidden = () => c.json({ error: 'This credential cannot open live presence', code: 'artifact_live_forbidden' }, 403);
    const credential = liveCredential(c, access.actor);
    if (!credential) return forbidden();
    // The credential's own expiry goes into the ticket: the socket closes with 4401 then.
    let state;
    try {
      state = await inspectLiveCredential(credential.ref, { userId: access.actor.userId, accountId: access.actor.accountId });
    } catch {
      return c.json({ error: 'Live presence is unavailable; try again shortly', code: 'artifact_live_unavailable' }, 503);
    }
    if (!state.live) return c.json({ error: 'The credential is no longer valid', code: 'credential_revoked' }, 401);
    const expiries = [credential.tokenExpiresAt, state.expiresAt].filter((value): value is number => value !== null);
    const claims = artifactLiveTicketClaims(access.actor, access.scope.sessionId, { projectId, artifactId }, {
      ...credential.ref, expiresAt: expiries.length ? Math.min(...expiries) : null,
    });
    if (!claims) return forbidden();
    const { ticket, expiresAt } = mintArtifactLiveTicket(claims);
    c.header('Cache-Control', 'no-store');
    return c.json({ ticket, expires_at: new Date(expiresAt).toISOString() }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/artifacts/{artifactId}/live/agent', tags: ['artifacts'],
    summary: 'Show where an agent session works on the Artifact',
    description: `Session-bound tokens only (\`kortix artifacts focus\`); a person's token answers 403 \`artifact_live_session_only\`. reading/editing/writing show the session's agent at \`thread_id\` or near \`quote\`; writing shows "<agent> is writing…" there. With no signal for ${ARTIFACT_LIVE_LIMITS.agentIdleMs / 1000} s, or when its turn ends, the agent leaves; \`idle\` makes it leave now.`,
    ...auth,
    request: { params: ArtifactParams, body: { required: true, content: { 'application/json': { schema: AgentSignalBody } } } },
    responses: { 204: { description: 'Shown to everyone on the Artifact' }, ...errors(400, 401, 403, 404) },
  }), async (c) => {
    const { projectId, artifactId } = c.req.valid('param');
    // The CLI reads a 403 other than `feature_disabled` as "a person's token":
    // every other refusal (no view, no artifact leaf, a project-level denial) is 404.
    let access;
    try {
      access = await authorizeComments(c, projectId, artifactId, false);
    } catch (error) {
      if (error instanceof HTTPException && error.status === 403) return notFound(c);
      throw error;
    }
    if (!access.ok) {
      if (access.response.status !== 403) return access.response;
      const { code } = await access.response.clone().json() as { code?: string };
      return code === 'feature_disabled' ? access.response : notFound(c);
    }
    const sessionId = access.scope.sessionId;
    if (!sessionId) return c.json({ error: 'Only an agent session can set agent presence', code: 'artifact_live_session_only' }, 403);
    // The shared contract is the authority: it also refuses NUL in the quote.
    const signal = artifactLiveAgentSignalSchema.safeParse(c.req.valid('json'));
    if (!signal.success) return c.json({ error: 'Invalid agent signal', code: 'invalid_signal' }, 400);
    try {
      await signalArtifactLiveAgent(access.scope.artifact, sessionId, signal.data);
    } catch (error) {
      if (error instanceof ArtifactLiveAgentError) return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
    return c.body(null, 204);
  });
}

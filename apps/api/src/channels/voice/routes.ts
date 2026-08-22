/**
 * Mount point for the voice MCP — the ONLY thing apps/voice-agent (a separate
 * process — see runtime.ts's file header) calls back into.
 *
 * Auth here is completely different from every other route on `projectsApp`:
 * the caller is the LiveKit worker process, not a Kortix session, so it
 * authenticates with the per-call `kortix_api_token` minted in `startCall`
 * and handed to it via the room's metadata (see runtime.ts's
 * `VoiceRoomMetadata`) — never session/PAT auth. `verifyCallApiToken`
 * (worker-token.ts) is the whole check: it's an HMAC over the call id, and
 * the call id IS the session id, so `projectId`/`sessionId` come straight
 * from the path with nothing to look up first.
 *
 * `voiceMcpRoutes` is mounted standalone BEFORE `projectsApp` (see
 * index.ts's comment) specifically so this route skips `projectsApp`'s
 * `.use('/*', supabaseAuth)` — a worker token is not a Kortix session and
 * `resolveProjectPrincipal` would 401 it regardless of validity. There used
 * to be a SECOND, Kortix-agent-facing MCP route here too
 * (`/:projectId/mcp/voice`, session/PAT-authed, guarded by its own
 * `voiceMcpRoutes.use('/:projectId/mcp/voice', supabaseAuth)`) for the
 * agent's own voice_spawn/voice_read/send_prompt/run_command/voice_end
 * tools; that moved to the `kortix_voice` channel connector
 * (connector/channels.ts, connector/db-deps.ts's executeVoiceCall) so it runs
 * through the connector gateway like every other connector call — policies,
 * approvals, and the audit trail included, none of which a direct MCP route
 * ever had. This file and mcp.ts are now exclusively the worker's way in. If
 * a second, differently-authed MCP ever needs to live here again, give it
 * its own path rather than layering another `.use()` onto this one: reusing
 * a path that also carries `supabaseAuth` for a caller that isn't a Kortix
 * session is exactly the mistake that used to 401 a perfectly valid worker
 * token against `resolveProjectPrincipal`.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { errors, json, makeOpenApiApp } from '../../openapi';
import { roomNameForCall } from './livekit';
import { handleVoiceMcp, type VoiceMcpContext } from './mcp';
import { appendTurn, askKortix, type VoiceCall } from './runtime';
import { runCommandInSandbox } from './run-command';
import { verifyCallApiToken } from './worker-token';

export const voiceMcpRoutes = makeOpenApiApp();

/**
 * Builds the worker's MCP context straight from the request: the HMAC proves
 * this caller owns this call, and projectId/sessionId are both in the path —
 * which is everything askKortix/runCommandInSandbox/appendTurn use. The call
 * id IS the session id and the room name derives from it, so there is
 * nothing to look up (no in-process call registry — see runtime.ts's
 * `isCallLive` doc for why one used to exist and why it was wrong).
 */
function buildWorkerContext(c: Context, projectId: string, sessionId: string): VoiceMcpContext | null {
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!verifyCallApiToken(sessionId, token)) return null;

  const callId = sessionId;
  const call: VoiceCall = {
    callId,
    projectId,
    sessionId,
    voice: 'alloy',
    room: roomNameForCall(callId),
    startedAt: Date.now(),
    closed: false,
  };

  return {
    projectId,
    sessionId,
    callId,
    askKortix: (request: string) => askKortix(call, request),
    runCommand: (command: string, cwd?: string) => runCommandInSandbox(sessionId, command, cwd),
    postTurn: (role, text, speaker) => appendTurn({ callId, projectId, sessionId }, role, text, speaker),
  };
}

voiceMcpRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/mcp/voice',
    tags: ['channels'],
    summary: "POST .../mcp/voice — the voice worker's MCP (JSON-RPC over streamable HTTP)",
    // NO `body` schema on purpose, even though this route takes one. Declaring
    // it makes @hono/zod-openapi install a json validator that runs BEFORE the
    // handler, and Hono's json validator throws its own 400 ("Malformed JSON in
    // request body") on a body it cannot parse. That preempted the auth check
    // below — an UNAUTHENTICATED caller sending `{not json` got a 400 telling it
    // the token was never even looked at, and the handler's own -32700 branch
    // was dead code, so an authenticated worker's truncated frame came back as
    // a plain HTTP error instead of the JSON-RPC parse error its MCP client
    // parses. Both are fixed by parsing the body ourselves, after the HMAC.
    // The schema was `z.any()`, so nothing documented is lost.
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'JSON-RPC response'),
      ...errors(400, 401, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    const ctx = buildWorkerContext(c, projectId, sessionId);
    if (!ctx) return c.json({ error: 'Unauthorized' }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }

    const res = await handleVoiceMcp(ctx, body as Record<string, unknown>);
    if (res === null) return c.body(null, 202);
    return c.json(res);
  },
);

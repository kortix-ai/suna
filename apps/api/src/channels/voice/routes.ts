/**
 * Mount point for the voice MCP, plus the HTTP contract apps/voice-agent (a
 * separate process — see runtime.ts's file header) calls back into.
 *
 * Auth for the MCP route reuses the executor's project-principal resolution
 * rather than inventing a second path: the caller is an in-sandbox agent
 * holding a session-scoped credential, which is exactly what the executor
 * already knows how to identify. That also means `voice_spawn` joins the
 * meeting through the executor gateway, so connector policies, approvals, and
 * the audit trail all apply — a direct Recall call from here would quietly
 * bypass every one of them.
 *
 * Auth for the `/voice/*` routes below is completely different: the caller is
 * the LiveKit worker process, not a Kortix session, so it authenticates with
 * the per-call `kortix_api_token` minted in `startCall` and handed to it via
 * the room's metadata (see runtime.ts's `VoiceRoomMetadata`) — never the
 * project-principal auth the MCP route uses.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { dbExecutorRouterDeps } from '../../executor/db-deps';
import { handleCall } from '../../executor/gateway';
import { VOICE_CHANNEL_CONNECTOR_SLUG } from '../../executor/channels';
import { supabaseAuth } from '../../middleware/auth';
import { errors, json, makeOpenApiApp } from '../../openapi';
import { resolveProjectBotName } from '../voice-identity';
import { handleVoiceMcp, type VoiceMcpContext } from './mcp';
import { appendTurn, askKortix, getCall, startCall, type VoiceCall } from './runtime';
import { runCommandInSandbox } from './run-command';
import { verifyCallApiToken } from './worker-token';

export const voiceMcpRoutes = makeOpenApiApp();

// `voiceMcpRoutes` is mounted standalone BEFORE `projectsApp` (see the file
// header + index.ts's comment) specifically so the three worker-callback
// routes below skip projectsApp's `supabaseAuth` and use their own HMAC
// check instead. That means `/mcp/voice` — the ONE route on this app that
// actually needs standard session/PAT auth, the same as every other
// projectsApp route — never runs `supabaseAuth` either, since it lives on a
// completely separate Hono instance that never reaches projectsApp's `.use('/*',
// supabaseAuth)`. Without this, `resolveProjectPrincipal` always sees an
// empty `c.get('userId')` and every call — regardless of token validity —
// 401s. Scoped to exactly this one path so the worker callback routes below
// are untouched.
voiceMcpRoutes.use('/:projectId/mcp/voice', supabaseAuth);

async function buildContext(c: Context, projectId: string): Promise<VoiceMcpContext | null> {
  const principal = await dbExecutorRouterDeps.resolveProjectPrincipal(c, projectId);
  if (!principal?.sessionId) return null;

  const sessionId = principal.sessionId;

  return {
    projectId,
    sessionId,
    async spawn({ meetingUrl, voice }) {
      const botName = await resolveProjectBotName(projectId);

      // The call id IS the session id: one live call per session, and it is what
      // binds the conversation to the thread that spawned it. The join-time
      // LiveKit token minted at join time carries the same value.
      const callId = sessionId;

      // Start the room BEFORE joining. If the bot arrives first it renders a
      // bridge page whose room does not exist yet, and the page's join is
      // rejected with nothing to retry against.
      await startCall({ callId, projectId, sessionId, botId: null, botName, voice });

      const result = await handleCall(dbExecutorRouterDeps.makeGatewayDeps(principal), {
        projectId,
        accountId: principal.accountId,
        subject: principal.subject,
        sessionId,
        connectorSlug: VOICE_CHANNEL_CONNECTOR_SLUG,
        actionPath: 'join_meeting',
        args: { meeting_url: meetingUrl },
      });

      if (result.status !== 'ok') {
        // Surface the gateway's own reason (policy denial, missing connector,
        // pending approval) rather than a generic failure — the agent can act on
        // "connector_not_found" and cannot act on "join failed".
        const detail = (result as { reason?: string }).reason ?? result.status;
        throw new Error(`could not join the meeting: ${detail}`);
      }

      const botId =
        result.data && typeof result.data === 'object'
          ? ((result.data as { id?: string }).id ?? null)
          : null;

      const call = (await import('./runtime')).getCall(callId);
      if (call) call.botId = botId;

      return { callId, botId };
    },
  };
}

voiceMcpRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/mcp/voice',
    tags: ['channels'],
    summary: 'POST /:projectId/mcp/voice — voice MCP (JSON-RPC)',
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: z.any() } } },
    },
    responses: {
      200: json(z.any(), 'JSON-RPC response'),
      ...errors(400, 401, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const ctx = await buildContext(c, projectId);
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

// ── apps/voice-agent's callback contract ───────────────────────────────────
// Three routes under /{projectId}/sessions/{sessionId}/voice/ — path, body
// shape, and response shape are all fixed by that app's `kortix-client.ts` /
// README.md ("The apps/api contract this app expects"); this side implements
// them, it does not get to renegotiate them without also editing that app,
// which is out of scope here.

async function authenticateWorker(
  c: Context,
  projectId: string,
  sessionId: string,
): Promise<{ ok: true; call: VoiceCall } | { ok: false; status: 401 | 404; error: string }> {
  // Verify the token BEFORE touching the call registry: the token is an HMAC
  // over the session id itself (call id IS session id — see runtime.ts / this
  // file's own comment above), so this doesn't need to load anything first,
  // and an unauthenticated caller learns nothing about whether a call exists.
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!verifyCallApiToken(sessionId, token)) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  const call = getCall(sessionId);
  if (!call || call.closed || call.projectId !== projectId) {
    return { ok: false, status: 404, error: 'call not found' };
  }

  return { ok: true, call };
}

voiceMcpRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/voice/prompt',
    tags: ['channels'],
    summary: "POST .../voice/prompt — worker's send_prompt hand-off to Kortix",
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: z.object({ call_id: z.string(), text: z.string() }) } } },
    },
    responses: { 200: json(z.any(), 'Queued'), ...errors(400, 401, 404) },
  }),
  async (c: any) => {
    const auth = await authenticateWorker(c, c.req.param('projectId'), c.req.param('sessionId'));
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const text = typeof body.text === 'string' ? body.text : '';

    // Answer FIRST, then deliver — see askKortix's own doc comment. This
    // route must respond well inside the worker's PROMPT_TIMEOUT_MS.
    const result = askKortix(auth.call, text);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  },
);

voiceMcpRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/voice/run-command',
    tags: ['channels'],
    summary: "POST .../voice/run-command — worker's run_command quick-check tool",
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({ call_id: z.string(), command: z.string(), cwd: z.string().optional() }),
          },
        },
      },
    },
    responses: { 200: json(z.any(), 'Command result'), ...errors(400, 401, 404) },
  }),
  async (c: any) => {
    const auth = await authenticateWorker(c, c.req.param('projectId'), c.req.param('sessionId'));
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const command = typeof body.command === 'string' ? body.command : '';
    const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
    if (!command.trim()) return c.json({ error: 'command is required' }, 400);

    try {
      const result = await runCommandInSandbox(auth.call.sessionId, command, cwd);
      return c.json({
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
      });
    } catch (err) {
      // Same rule mcp.ts follows: a readable error the worker's tool can speak
      // around, not a bare 500 that turns into a generic network-error string.
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  },
);

voiceMcpRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/voice/turns',
    tags: ['channels'],
    summary: "POST .../voice/turns — worker's transcript sink",
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              call_id: z.string(),
              role: z.enum(['user', 'agent']),
              text: z.string(),
              speaker: z.string().nullable().optional(),
            }),
          },
        },
      },
    },
    responses: { 200: json(z.any(), 'Persisted'), ...errors(400, 401, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');

    // Deliberately does NOT require a live entry in the in-process call
    // registry, unlike the other two worker routes. Since LiveKit took over the
    // media plane the API holds no socket for a call, so which instance has it
    // in memory is arbitrary — and an API restart mid-call would otherwise
    // silently stop persisting a conversation that is still happening. The HMAC
    // already proves this caller owns this call, and projectId/sessionId are in
    // the path, which is everything a transcript row needs.
    const authHeader = c.req.header('Authorization') ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
    if (!verifyCallApiToken(sessionId, token)) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const role = body.role === 'agent' ? 'agent' : 'user';
    const text = typeof body.text === 'string' ? body.text : '';
    const speaker = typeof body.speaker === 'string' ? body.speaker : null;
    const callId = typeof body.call_id === 'string' && body.call_id ? body.call_id : sessionId;

    // Reject empty/whitespace-only text with 400 rather than silently 200'ing
    // a no-op write. appendTurn() itself no-ops on empty text (by design, for
    // its other caller paths), which used to mean a caller sending blank text
    // saw a green 200 in its own logs while nothing was persisted — a capture
    // regression upstream of this route would look identical to success. This
    // makes that failure mode loud at the one place that can see it happen.
    if (!text.trim()) return c.json({ error: 'text must not be empty' }, 400);

    await appendTurn({ callId, projectId, sessionId }, role, text, speaker);
    return c.json({ ok: true });
  },
);

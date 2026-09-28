/**
 * The hosted Kortix MCP server: `POST /v1/projects/:projectId/mcp`, MCP
 * Streamable HTTP (JSON responses, stateless).
 *
 * Any MCP client adds the URL and signs in with OAuth ("Sign in with Kortix",
 * ../oauth): a `401` carries `WWW-Authenticate: Bearer resource_metadata=…`,
 * the client reads the RFC 9728 document, registers itself (RFC 7591), runs
 * the PKCE code flow, and returns with a `kortix_oat_` token that acts as the
 * user. Every tool call runs through the real API routes in-process with that
 * token, so authorization is exactly the API's.
 *
 * The project in the URL is the connection's default project (the CLI's
 * linked project) and its `mcp` feature flag gates the endpoint.
 */
import { Hono, type Context, type Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { mintWireMessageId } from '@kortix/sdk';
import { supabaseAuth } from '../middleware/auth';
import { loadProjectForUser } from '../projects/lib/access';
import { requireFeatureFlag } from '../feature-flags/gate';
import { mcpResourceMetadataUrl, oauthIssuer } from '../oauth/discovery';
import { OAUTH_SCOPE_KORTIX } from '../oauth/access-token';
import { isUuid } from '../shared/validate';

type Dispatch = (request: Request) => Promise<Response>;

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_RESULT_CHARS = 60_000;

interface ToolContext {
  projectId: string;
  projectName: string;
  authorization: string;
  origin: string;
  /** The caller's own request headers: its client IP and user agent reach the audit unchanged. */
  headers: Headers;
  dispatch: Dispatch;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (value: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: value.length > MAX_RESULT_CHARS ? `${value.slice(0, MAX_RESULT_CHARS)}\n…[truncated at ${MAX_RESULT_CHARS} chars]` : value }],
  ...(isError ? { isError: true } : {}),
});

// ─── The Kortix API, in-process, as the caller ──────────────────────────────

/** Paths a tool may not reach: the OAuth server and the MCP endpoint itself. */
function blockedPath(path: string): boolean {
  return path.startsWith('/v1/oauth') || /\/mcp(\/|$)/.test(path.split('?')[0]!);
}

async function callApi(
  ctx: ToolContext,
  method: string,
  path: string,
  opts: { query?: Record<string, unknown>; body?: unknown } = {},
): Promise<{ status: number; body: string }> {
  const url = new URL(path.replaceAll('{projectId}', ctx.projectId).replaceAll(':projectId', ctx.projectId), ctx.origin);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const headers = new Headers(ctx.headers);
  // Body headers belong to the caller's request, not this one. accept-encoding
  // too: an in-process Response is never decoded, so a gzip reply would reach
  // the tool as raw bytes.
  for (const name of ['content-length', 'content-type', 'accept-encoding', 'connection', 'transfer-encoding', 'mcp-session-id', 'mcp-protocol-version']) {
    headers.delete(name);
  }
  headers.set('authorization', ctx.authorization);
  headers.set('accept', 'application/json');
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  const response = await ctx.dispatch(
    new Request(url, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }),
  );
  return { status: response.status, body: await response.text() };
}

function apiResult(r: { status: number; body: string }): ToolResult {
  return text(`HTTP ${r.status}\n${r.body}`, r.status >= 400);
}

// ─── The OpenAPI catalog (search_api / describe_api) ────────────────────────

type Operation = { method: string; path: string; summary: string; description: string; tags: string[]; spec: any };
let catalog: Promise<{ ops: Operation[]; doc: any }> | null = null;

function loadCatalog(ctx: ToolContext) {
  catalog ??= ctx
    .dispatch(new Request(new URL('/v1/openapi.json', ctx.origin)))
    .then((r) => r.json())
    .then((doc: any) => {
      const ops: Operation[] = [];
      for (const [path, methods] of Object.entries<any>(doc.paths ?? {})) {
        if (blockedPath(path)) continue;
        for (const [method, spec] of Object.entries<any>(methods)) {
          if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
          ops.push({
            method: method.toUpperCase(),
            path,
            summary: String(spec.summary ?? ''),
            description: String(spec.description ?? ''),
            tags: Array.isArray(spec.tags) ? spec.tags : [],
            spec,
          });
        }
      }
      return { ops, doc };
    })
    .catch((err) => {
      catalog = null;
      throw err;
    });
  return catalog;
}

export function searchOperations(ops: Operation[], query: string, limit: number): Operation[] {
  const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
  if (terms.length === 0) return ops.slice(0, limit);
  return ops
    .map((op) => {
      const path = op.path.toLowerCase();
      const summary = op.summary.toLowerCase();
      const rest = `${op.tags.join(' ')} ${op.description}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (path.includes(term)) score += 3;
        if (summary.includes(term)) score += 2;
        if (rest.includes(term)) score += 1;
      }
      return { op, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.op.path.length - b.op.path.length)
    .slice(0, limit)
    .map((x) => x.op);
}

/** Inline `$ref`s so one operation reads on its own. Depth-capped: schemas recurse. */
function resolveRefs(node: any, doc: any, depth = 0): any {
  if (depth > 6 || node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, doc, depth + 1));
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const target = node.$ref.slice(2).split('/').reduce((acc: any, key: string) => acc?.[key], doc);
    return resolveRefs(target, doc, depth + 1);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolveRefs(v, doc, depth + 1)]));
}

// ─── Tools ──────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'start_session',
    description:
      'Start a Kortix session in this project with a first prompt. An agent runs it in its own cloud sandbox on its own branch. Returns the session_id; read the reply with read_session (the first turn takes ~10–60 s while the sandbox boots).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task for the agent.' },
        name: { type: 'string', description: 'Optional session title.' },
        agent: { type: 'string', description: 'Optional agent name; the project default when omitted.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'send_message',
    description:
      "Send a message to an existing session's agent. It waits in the session's inbox until the current turn ends, and the session is started if it was stopped. Read the reply with read_session.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        text: { type: 'string', description: 'The message.' },
      },
      required: ['session_id', 'text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'read_session',
    description:
      "Read a session: its status and a compact transcript of the latest messages. Call again to follow a running turn.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        limit: { type: 'number', description: 'Latest messages to return (default 20, max 500).' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search_api',
    description:
      'Search the Kortix API (the same routes the web app and the kortix CLI use: accounts, projects, sessions, files, secrets, connectors, triggers, agents, models, change requests, access, billing, …). Returns METHOD /path — summary lines. Follow with describe_api, then call_api.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "secrets", "trigger fire", "session files".' },
        limit: { type: 'number', description: 'Max results (default 20).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'describe_api',
    description: "Show one API route's parameters, request body schema and success response schema.",
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'GET, POST, PUT, PATCH or DELETE.' },
        path: { type: 'string', description: 'The route as search_api printed it, e.g. /v1/projects/{projectId}/secrets.' },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'call_api',
    description:
      'Call any Kortix API route as the signed-in user, with their permissions. {projectId} in the path is replaced with this connection\'s project. Returns the HTTP status and the response body.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        path: { type: 'string', description: 'Starts with /v1/, e.g. /v1/projects/{projectId}/sessions.' },
        query: { type: 'object', description: 'Query-string parameters.' },
        body: { description: 'JSON request body.' },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
] as const;

function arg(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new ToolInputError(`${key} is required`);
  return value.trim();
}

class ToolInputError extends Error {}

async function runTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'start_session': {
      const body: Record<string, unknown> = { initial_prompt: arg(input, 'prompt') };
      if (typeof input.name === 'string' && input.name.trim()) body.name = input.name.trim();
      if (typeof input.agent === 'string' && input.agent.trim()) body.agent_name = input.agent.trim();
      const r = await callApi(ctx, 'POST', '/v1/projects/{projectId}/sessions', { body });
      if (r.status >= 400) return apiResult(r);
      const session = JSON.parse(r.body);
      return text(
        JSON.stringify(
          { session_id: session.session_id, name: session.name ?? null, status: session.status, branch: session.branch_name ?? null },
          null,
          2,
        ),
      );
    }
    case 'send_message': {
      const sessionId = arg(input, 'session_id');
      if (!isUuid(sessionId)) throw new ToolInputError('session_id must be a UUID');
      const found = await callApi(ctx, 'GET', `/v1/projects/{projectId}/sessions/${sessionId}`);
      if (found.status >= 400) return apiResult(found);
      const session = JSON.parse(found.body);
      // The same body `kortix sessions chat --queue` sends (apps/cli/src/commands/sessions-queue.ts).
      const model = typeof session.metadata?.opencode_model === 'string' ? session.metadata.opencode_model : '';
      const slash = model.indexOf('/');
      const overrides = {
        ...(session.agent_name ? { agent: session.agent_name } : {}),
        ...(slash > 0 ? { model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } } : {}),
      };
      const queued = await callApi(ctx, 'POST', `/v1/projects/{projectId}/sessions/${sessionId}/prompts`, {
        body: {
          client_message_id: crypto.randomUUID(),
          message_id: mintWireMessageId(),
          parts: [{ type: 'text', text: arg(input, 'text') }],
          client_sent_at_ms: Date.now(),
          remint_on_delivery: true,
          ...(Object.keys(overrides).length ? { overrides } : {}),
        },
      });
      if (queued.status >= 400) return apiResult(queued);
      await callApi(ctx, 'POST', `/v1/projects/{projectId}/sessions/${sessionId}/start`, { body: {} });
      return text(JSON.stringify({ queued: true, session_id: sessionId }, null, 2));
    }
    case 'read_session': {
      const sessionId = arg(input, 'session_id');
      if (!isUuid(sessionId)) throw new ToolInputError('session_id must be a UUID');
      const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 500);
      const [session, transcript] = await Promise.all([
        callApi(ctx, 'GET', `/v1/projects/{projectId}/sessions/${sessionId}`),
        callApi(ctx, 'GET', `/v1/projects/{projectId}/sessions/${sessionId}/transcript`, {
          query: { limit, chars: 2000 },
        }),
      ]);
      if (session.status >= 400) return apiResult(session);
      const s = JSON.parse(session.body);
      return text(
        `${JSON.stringify({ session_id: s.session_id, name: s.name ?? null, status: s.status }, null, 2)}\n\n` +
          (transcript.status < 400 ? transcript.body : `transcript: HTTP ${transcript.status} ${transcript.body}`),
      );
    }
    case 'search_api': {
      const { ops } = await loadCatalog(ctx);
      const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100);
      const hits = searchOperations(ops, arg(input, 'query'), limit);
      if (hits.length === 0) return text('No matching routes. Try broader keywords.');
      return text(hits.map((op) => `${op.method} ${op.path}${op.summary && !op.summary.startsWith(op.method) ? ` — ${op.summary}` : ''}`).join('\n'));
    }
    case 'describe_api': {
      const { ops, doc } = await loadCatalog(ctx);
      const method = arg(input, 'method').toUpperCase();
      const path = arg(input, 'path').replace(/:([A-Za-z_]+)/g, '{$1}');
      const op = ops.find((o) => o.method === method && o.path === path);
      if (!op) return text(`No route ${method} ${path}. Use search_api to find it.`, true);
      const responses = op.spec.responses ?? {};
      const success = responses['200'] ?? responses['201'] ?? responses['202'];
      return text(
        JSON.stringify(
          resolveRefs(
            {
              method,
              path,
              summary: op.summary,
              description: op.description || undefined,
              parameters: op.spec.parameters,
              requestBody: op.spec.requestBody?.content?.['application/json']?.schema,
              response: success?.content?.['application/json']?.schema,
            },
            doc,
          ),
          null,
          2,
        ),
      );
    }
    case 'call_api': {
      const method = arg(input, 'method').toUpperCase();
      const path = arg(input, 'path');
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new ToolInputError(`method ${method} is not allowed`);
      if (!path.startsWith('/v1/') || blockedPath(path)) throw new ToolInputError('path must start with /v1/ and not target /v1/oauth or an MCP endpoint');
      const query = input.query && typeof input.query === 'object' ? (input.query as Record<string, unknown>) : undefined;
      return apiResult(await callApi(ctx, method, path, { query, body: input.body }));
    }
    default:
      throw new ToolInputError(`unknown tool ${name}`);
  }
}

function instructions(ctx: ToolContext): string {
  return [
    `Kortix MCP for the project "${ctx.projectName}" (project_id ${ctx.projectId}). You act as the signed-in user, with their permissions.`,
    'Delegate work to a Kortix agent with start_session, follow it with read_session, and continue it with send_message.',
    'Everything else the Kortix web app and CLI can do is the Kortix API: find a route with search_api, read it with describe_api, run it with call_api. {projectId} in a path means this project.',
    'Learn the platform first: call_api GET /v1/skills lists the Kortix guides, GET /v1/skills/<name> reads one.',
  ].join('\n');
}

// ─── JSON-RPC ───────────────────────────────────────────────────────────────

async function handleRpc(ctx: ToolContext, method: string, params: Record<string, any>): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const requested = String(params.protocolVersion ?? '');
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[1],
        serverInfo: { name: 'kortix', title: 'Kortix', version: process.env.KORTIX_VERSION ?? 'dev' },
        capabilities: { tools: {} },
        instructions: instructions(ctx),
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      try {
        return await runTool(ctx, String(params.name ?? ''), (params.arguments as Record<string, unknown>) ?? {});
      } catch (err) {
        if (err instanceof ToolInputError) return text(err.message, true);
        throw err;
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 });
  }
}

/**
 * Turns the auth middleware's 401 into the challenge MCP clients follow to find
 * the authorization server (RFC 9728 §5.1). URLs come from KORTIX_URL, never
 * from the request (learnings 2026-08-19).
 */
function challengeUnauthorized(c: Context, next: Next) {
  const projectId = c.req.param('projectId') ?? '';
  const challenge = () =>
    c.json({ error: 'unauthorized', error_description: 'Sign in with OAuth to use the Kortix MCP server.' }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${mcpResourceMetadataUrl(projectId, new URL(c.req.url).origin)}", scope="${OAUTH_SCOPE_KORTIX}"`,
    });
  if (!c.req.header('Authorization')?.startsWith('Bearer ')) return challenge();
  return supabaseAuth(c, next).catch((err) => {
    if (err instanceof HTTPException && err.status === 401) return challenge();
    throw err;
  });
}

export function createMcpApp(dispatch: Dispatch) {
  const app = new Hono();

  app.post('/:projectId/mcp', challengeUnauthorized, async (c) => {
    const projectId = c.req.param('projectId');
    if (!isUuid(projectId)) return c.json({ error: 'Not found' }, 404);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'mcp');
    if (gate) return gate;

    const message = await c.req.json().catch(() => undefined);
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, 400);
    }
    // A notification or a response from the client: accepted, nothing to answer.
    if (message.id === undefined || message.id === null) return c.body(null, 202);

    const ctx: ToolContext = {
      projectId,
      projectName: loaded.row.name,
      authorization: c.req.header('Authorization')!,
      origin: oauthIssuer(new URL(c.req.url).origin),
      headers: c.req.raw.headers,
      dispatch,
    };
    try {
      const result = await handleRpc(ctx, message.method, message.params ?? {});
      return c.json({ jsonrpc: '2.0', id: message.id, result });
    } catch (err) {
      const e = err as Error & { rpcCode?: number };
      return c.json({ jsonrpc: '2.0', id: message.id, error: { code: e.rpcCode ?? -32603, message: e.message } });
    }
  });

  // Stateless server: no SSE stream to open, no session to delete.
  app.on(['GET', 'DELETE'], '/:projectId/mcp', (c) => c.json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' }));

  return app;
}

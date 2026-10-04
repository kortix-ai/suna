/**
 * The hosted Kortix MCP server: `POST /v1/mcp`, MCP Streamable HTTP (JSON
 * responses, stateless). One server per person, like the `kortix` CLI: it is
 * bound to the caller's token, never to a project, and reaches every account,
 * project and session that token can.
 *
 * Any MCP client adds the URL and signs in with OAuth ("Sign in with Kortix",
 * ../oauth): a `401` carries `WWW-Authenticate: Bearer resource_metadata=…`,
 * the client reads the RFC 9728 document, registers itself (RFC 7591), runs
 * the PKCE code flow, and returns with a `kortix_oat_` token that acts as the
 * user. A `kortix_pat_` (the CLI's token) works as a Bearer header too. Every
 * tool call runs through the real API routes in-process with that token, so
 * authorization is exactly the API's.
 */
import { Hono, type Context, type Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { mintWireMessageId } from '@kortix/sdk';
import { supabaseAuth } from '../middleware/auth';
import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { mcpResourceMetadataUrl, oauthIssuer } from '../oauth/discovery';
import { OAUTH_SCOPE_KORTIX } from '../oauth/access-token';
import { db } from '../shared/db';
import { isUuid } from '../shared/validate';
import {
  JOB_CANCEL,
  JOB_DEFAULT_TIMEOUT_SECONDS,
  JOB_LAUNCH,
  JOB_MAX_TIMEOUT_SECONDS,
  JOB_POLL,
  JOB_TAIL_BYTES,
  parseJobPoll,
  renderJob,
  type JobState,
} from './jobs';
import { KORTIX_TOOL, parseArgs, runCli } from './cli';
import { CONNECTOR_TOOLS, isConnectorTool, runConnectorTool, type Host } from './connectors';
import { blockedPath, canonicalPath, requestBodyShape, searchOperations, shapeTranscript, type Operation } from './shape';

type Dispatch = (request: Request) => Promise<Response>;

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_RESULT_CHARS = 60_000;

interface ToolContext {
  authorization: string;
  origin: string;
  /** The caller's own request headers: its client IP and user agent reach the audit unchanged. */
  headers: Headers;
  dispatch: Dispatch;
  /** The whole MCP request must answer inside the load balancer's 60 s idle cut. */
  deadline: number;
}

export type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
};

const text = (value: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: value.length > MAX_RESULT_CHARS ? `${value.slice(0, MAX_RESULT_CHARS)}\n…[truncated at ${MAX_RESULT_CHARS} chars]` : value }],
  ...(isError ? { isError: true } : {}),
});

// ─── The Kortix API, in-process, as the caller ──────────────────────────────

export type ApiReply = {
  status: number;
  body: string;
  /** The reply's `Retry-After`, when it sent one. */
  retryAfter?: string;
  /** Set when `summarizeBinary` was asked and the reply is not text: the body is not read. */
  binary?: { type: string; bytes: number };
  /** `X-Next-Cursor` of a keyset page. */
  nextCursor?: string;
};

const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|[^;]*\+(json|xml))/i;

async function callApi(
  ctx: ToolContext,
  method: string,
  path: string,
  opts: { query?: Record<string, unknown>; body?: unknown; summarizeBinary?: boolean; raw?: { body: Uint8Array; headers: Record<string, string> } } = {},
): Promise<ApiReply> {
  const url = new URL(path, ctx.origin);
  // Guard the path the router will see (dot segments, %-escapes), not the caller's spelling.
  const resolved = canonicalPath(url.pathname);
  if (url.origin !== new URL(ctx.origin).origin || !resolved?.startsWith('/v1/') || blockedPath(resolved)) {
    throw new ToolInputError('path must start with /v1/ and not target /v1/oauth or an MCP endpoint');
  }
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.delete(key);
    for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(v));
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
  for (const [k, v] of Object.entries(opts.raw?.headers ?? {})) headers.set(k, v);
  const response = await ctx.dispatch(
    new Request(url, { method, headers, body: opts.raw ? (opts.raw.body as BodyInit) : opts.body !== undefined ? JSON.stringify(opts.body) : undefined }),
  );
  const reply: ApiReply = {
    status: response.status,
    body: '',
    retryAfter: response.headers.get('retry-after') ?? undefined,
    nextCursor: response.headers.get('x-next-cursor') ?? undefined,
  };
  const type = response.headers.get('content-type') ?? '';
  if (opts.summarizeBinary && type && !TEXT_TYPE.test(type)) {
    reply.binary = { type: type.split(';')[0]!, bytes: (await response.arrayBuffer()).byteLength };
    return reply;
  }
  reply.body = await response.text();
  return reply;
}

/** `label` (`METHOD path`) leads the first line when given; a 429/503 `Retry-After` closes the text. */
function apiResult(r: ApiReply, label?: string): ToolResult {
  const head = `${label ? `${label} → ` : ''}HTTP ${r.status}`;
  const retry = (r.status === 503 || r.status === 429) && r.retryAfter ? `\nRetry after ${r.retryAfter} s.` : '';
  if (r.binary) return text(`${head} ${r.binary.type}, ${r.binary.bytes} bytes (binary, not shown)${retry}`, r.status >= 400);
  return text(`${head}\n${r.body}${retry}`, r.status >= 400);
}

// ─── The OpenAPI catalog (search_api / describe_api) ────────────────────────

let catalog: Promise<{ ops: Operation[]; doc: any }> | null = null;

function loadCatalog(ctx: ToolContext) {
  catalog ??= ctx
    .dispatch(new Request(new URL('/v1/openapi.json', ctx.origin)))
    .then((r) => r.json())
    .then((doc: any) => {
      const ops: Operation[] = [];
      for (const [path, methods] of Object.entries<any>(doc.paths ?? {})) {
        if (!path.startsWith('/v1/') || blockedPath(path)) continue;
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

// ─── Sessions and projects by id ────────────────────────────────────────────

function projectArg(input: Record<string, unknown>): string {
  const projectId = arg(input, 'project_id');
  if (!isUuid(projectId)) throw new ToolInputError('project_id must be a UUID (list_projects shows them)');
  return projectId;
}

/**
 * A session's API path, `/v1/projects/<project>/sessions/<session>`. The
 * project comes from the session row. That is a lookup, not an authorization:
 * the project route it names still decides whether the caller may read the
 * session. An unknown session is a 404 here; a session in another account
 * reaches that route and gets its 403 (the API answers 403 for a foreign
 * account everywhere), so an outsider can tell the two apart. That is the
 * API's rule, not one this tool adds.
 */
async function sessionPath(sessionId: string): Promise<string> {
  if (!isUuid(sessionId)) throw new ToolInputError('session_id must be a UUID');
  const [row] = await db
    .select({ projectId: projectSessions.projectId })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!row) throw new ToolInputError('HTTP 404\n{"error":"Not found"}');
  return `/v1/projects/${row.projectId}/sessions/${sessionId}`;
}

// ─── Sandboxes (run_command / read_file / write_file / list_files) ──────────

/** Time budget of one MCP request, under the load balancer's 60 s idle cut. */
const REQUEST_BUDGET_MS = 55_000;

/** `…/v1/p/<external_id>/8000` or `/p/<external_id>/8000` → the proxy path. */
function daemonPath(url: unknown): string | null {
  const id = typeof url === 'string' ? /\/p\/([^/]+)\/8000/.exec(url)?.[1] : undefined;
  return id ? `/v1/p/${id}/8000` : null;
}

/** A session's daemon, resolved once per tool call: the API path of the session and its proxy base. */
export type Sandbox = { session: string; base: string | null };

/** The session lookup (DB read + session GET) that every sandbox call needs first. */
async function resolveSandbox(ctx: ToolContext, sessionId: string): Promise<Sandbox | { status: number; body: string }> {
  const session = await sessionPath(sessionId);
  const found = await callApi(ctx, 'GET', session);
  if (found.status >= 400) return found;
  return { session, base: daemonPath(JSON.parse(found.body).sandbox_url) };
}

/**
 * One call to a session's sandbox daemon through the API's per-session proxy —
 * the path the web file panel and terminal use, so access is exactly theirs. A
 * stopped sandbox is started, then the call is retried until it answers. Pass a
 * resolved `Sandbox` to skip the session lookup (a tool that makes several
 * calls resolves once and reuses it for the length of that one tool call).
 */
export async function callSandbox(
  ctx: ToolContext,
  target: string | Sandbox,
  method: string,
  path: string,
  /** `body` may be a function: it is built per attempt, after a wake used some of the budget. */
  opts: { query?: Record<string, unknown>; body?: unknown | (() => unknown) } = {},
): Promise<{ status: number; body: string }> {
  const sandbox = typeof target === 'string' ? await resolveSandbox(ctx, target) : target;
  if (!('session' in sandbox)) return sandbox;
  const deadline = ctx.deadline - 5_000;
  let started = false;
  let reason = '';
  for (;;) {
    if (sandbox.base) {
      const body = typeof opts.body === 'function' ? opts.body() : opts.body;
      const r = await callApi(ctx, method, `${sandbox.base}${path}`, { query: opts.query, body });
      // The proxy answers 502/503 with `retry: true` only when the request
      // never reached the daemon (not ready, waking), so a retry is safe.
      if (!((r.status === 502 || r.status === 503) && /"retry":\s*true/.test(r.body))) return r;
    }
    if (Date.now() > deadline) {
      return { status: 504, body: `The sandbox is still starting${reason ? ` (reason ${reason})` : ''}. Call again; it keeps booting.` };
    }
    if (!started) {
      const s = await callApi(ctx, 'POST', `${sandbox.session}/start`, { body: {} });
      if (s.status >= 400) return s;
      const booted = JSON.parse(s.body);
      sandbox.base ??= daemonPath(booted.runtime_url);
      reason = typeof booted.reason === 'string' ? booted.reason : '';
      started = true;
    }
    await Bun.sleep(2_000);
  }
}

/** The daemon's env-rpc failure text: `CODE: message`, once (the message often starts with the code). */
function rpcError(reply: any, body: string): string {
  const code = String(reply.error?.code ?? 'error');
  const message = String(reply.error?.message ?? body);
  return message.startsWith(code) ? message : `${code}: ${message}`;
}

/** The daemon's env-rpc answers `{ ok, value }` or `{ ok: false, error }`. */
function envRpcResult(r: { status: number; body: string }, render: (value: any) => string): ToolResult {
  if (r.status >= 400) return apiResult(r);
  const reply = JSON.parse(r.body);
  if (!reply.ok) return text(rpcError(reply, r.body), true);
  return text(render(reply.value));
}

// ─── Commands as jobs (./jobs.ts) ───────────────────────────────────────────

/** Run a short shell script in the session's sandbox (env-rpc exec). */
function sandboxScript(ctx: ToolContext, target: string | Sandbox, script: string, env: Record<string, string>, cwd?: string) {
  return callSandbox(ctx, target, 'POST', '/kortix/env-rpc', {
    body: { op: 'exec', args: { command: script, env, timeout: 15_000, ...(cwd ? { cwd } : {}) } },
  });
}

/** `sandboxScript`, parsed: the script's stdout, stderr and exit code, or the error result to return. */
async function sandboxExec(
  ctx: ToolContext,
  target: string | Sandbox,
  script: string,
  env: Record<string, string> = {},
  cwd?: string,
): Promise<{ error: ToolResult } | { stdout: string; stderr: string; exitCode: number }> {
  const r = await sandboxScript(ctx, target, script, env, cwd);
  if (r.status >= 400) return { error: apiResult(r) };
  const reply = JSON.parse(r.body);
  if (!reply.ok) return { error: text(rpcError(reply, r.body), true) };
  return { stdout: String(reply.value.stdout ?? ''), stderr: String(reply.value.stderr ?? ''), exitCode: Number(reply.value.exitCode ?? 0) };
}

/** `~` and `~/…` mean the sandbox user's $HOME; the API does not know it, so ask the sandbox. */
async function expandHome(ctx: ToolContext, sandbox: Sandbox, path: string): Promise<{ error: ToolResult } | { path: string }> {
  if (path !== '~' && !path.startsWith('~/')) return { path };
  const r = await sandboxExec(ctx, sandbox, 'printf %s "$HOME"');
  if ('error' in r) return r;
  return { path: `${r.stdout || '/root'}${path.slice(1)}` };
}

/** Both sandbox-or-repository tools need one of the two ids. */
function needTarget(input: Record<string, unknown>) {
  if (!optionalArg(input, 'session_id') && !optionalArg(input, 'project_id')) {
    throw new ToolInputError('pass session_id (live sandbox) or project_id (repository)');
  }
}

/** Paging caps. A page stays under the result cap so `text()` never cuts it. */
const PAGE_CHARS = 50_000;
const BINARY_INLINE_CHARS = 40_000;
const IMAGE_MAX_BYTES = 1_000_000;

/** An optional non-negative integer argument (`min` 1 for a count). */
function intArg(input: Record<string, unknown>, key: string, min = 0): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) throw new ToolInputError(`${key} must be an integer >= ${min}`);
  return value;
}

/** A page of `items` (lines or entries) from `offset`: at most `limit` items and PAGE_CHARS, with the offset that continues it. */
export function page(items: string[], offset: number, limit: number | undefined, unit: string): string {
  if (offset > 0 && offset >= items.length) return `Nothing at offset ${offset}: ${items.length} ${unit} in all.`;
  const out: string[] = [];
  let chars = 0;
  let end = offset;
  while (end < items.length && (limit === undefined || out.length < limit)) {
    const item = items[end]!;
    if (out.length > 0 && chars + item.length + 1 > PAGE_CHARS) break;
    out.push(item.length > PAGE_CHARS ? item.slice(0, PAGE_CHARS) : item);
    chars += item.length + 1;
    end += 1;
  }
  const more = items.length - end;
  return more > 0 ? `${out.join('\n')}\n… ${more} more ${unit}; call again with offset=${end}` : out.join('\n');
}

/** A text file as `offset`/`limit` lines. */
function pageLines(content: string, input: Record<string, unknown>): ToolResult {
  const lines = content.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return text(page(lines, intArg(input, 'offset') ?? 0, intArg(input, 'limit', 1), 'lines'));
}

// ─── Sessions ───────────────────────────────────────────────────────────────

/** A session is busy while it boots, runs a turn, or holds queued prompts. */
const BOOTING = new Set(['queued', 'branching', 'provisioning']);

async function sessionActivity(ctx: ToolContext, path: string) {
  const [session, turn, prompts] = await Promise.all([
    callApi(ctx, 'GET', path),
    callApi(ctx, 'GET', `${path}/turn`),
    callApi(ctx, 'GET', `${path}/prompts`),
  ]);
  if (session.status >= 400) return { error: session } as const;
  const s = JSON.parse(session.body);
  const turns = turn.status < 400 ? (JSON.parse(turn.body).turns ?? []) : [];
  const queued = prompts.status < 400 ? (JSON.parse(prompts.body).prompts ?? []).length : 0;
  const busy = BOOTING.has(s.status) || turns.length > 0 || queued > 0;
  return {
    session: s,
    summary: {
      session_id: s.session_id,
      project_id: s.project_id,
      name: s.name ?? null,
      status: s.status,
      // `queued`: nothing runs, prompts wait. Only `idle` means the agent is done.
      turn: BOOTING.has(s.status) ? 'booting' : turns.length > 0 ? 'running' : queued > 0 ? 'queued' : 'idle',
      queued_prompts: queued,
      branch: s.branch_name,
      agent: s.agent_name,
      error: s.error ?? null,
    },
    busy,
  } as const;
}

/** A count argument: default when absent, clamped to 1..max, an error when it is not a number. */
function limitArg(input: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolInputError(`${key} must be a number`);
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

// ─── Tools ──────────────────────────────────────────────────────────────────

const SESSION_ID = { type: 'string', description: 'The session_id (UUID).' } as const;
const PROJECT_ID = { type: 'string', description: 'The project_id (UUID), from list_projects.' } as const;

const TOOLS = [
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'List every project you can open, across all your accounts: project_id, name, account, repository, your role. Start here: the other tools take a project_id or a session_id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'start_session',
    title: 'Start a session',
    description:
      'Start a Kortix session in a project with a first prompt. An agent runs it in its own cloud sandbox on its own git branch. Returns the session_id. Follow it with read_session and wait_seconds (the first turn needs ~10–60 s while the sandbox boots).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        prompt: { type: 'string', description: 'The task for the agent.' },
        name: { type: 'string', description: 'Optional session title.' },
        agent: { type: 'string', description: 'Optional agent name; the project default when omitted.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Optional free-form labels to classify the session (each 1-64 chars, at most 20). Filter by them with list_sessions labels.' },
        metadata: { type: 'object', description: 'Optional free-form JSON object stored on the session (at most 16,384 characters). Server-managed keys are refused.' },
      },
      required: ['project_id', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'send_message',
    title: 'Send a message to a session',
    description:
      "Send a message to a session's agent. It waits in the session's inbox until the current turn ends, and a stopped session is started. Read the reply with read_session and wait_seconds.",
    inputSchema: {
      type: 'object',
      properties: { session_id: SESSION_ID, text: { type: 'string', description: 'The message.' } },
      required: ['session_id', 'text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'read_session',
    title: 'Read a session',
    description:
      "Read a session: its status, whether a turn is running, and the latest messages with each tool call's input and output. wait_seconds blocks until the agent is idle (up to 45 s); call again while `turn` is not `idle` (`booting`, `running` or `queued`). Tool inputs and outputs are cut per part (marked `[truncated: N of M chars]`); when the messages do not fit, the oldest are dropped (`omitted_older`). `last_turn_error` names a failed turn. Older history: call_api on the session's transcript route with shape=sync.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION_ID,
        limit: { type: 'number', description: 'Latest messages to return (default 10, max 100). `message_count` is how many came back; `complete: true` means no older message exists.' },
        wait_seconds: { type: 'number', description: 'Wait up to this long (max 45) for the running turn to end before reading.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_sessions',
    title: 'List sessions',
    description:
      "List the top-level sessions you can see in a project, in the project's list order: id, title, labels, status, agent, owner, started_by (who started the run), child_count, branch, created_at, updated_at. Filter with started_by, labels and query (searches every session you can see, not only recent ones). A row with child_count > 0 has sub-sessions: pass its session_id as parent_session_id to list them. `next_cursor` is set when more exist: pass it back as `cursor`.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        limit: { type: 'number', description: 'Max sessions (default 20, max 200).' },
        cursor: { type: 'string', description: 'The next_cursor of the previous page (same filters).' },
        started_by: { type: 'string', enum: ['me', 'others', 'automated'], description: 'me = you started it; others = another member; automated = a trigger, channel or API key.' },
        query: { type: 'string', description: 'Case-insensitive text matched against title, starter, agent, owner and session id prefix (1-200 chars).' },
        parent_session_id: { type: 'string', description: 'List only the children of this session instead of top-level sessions.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Only sessions that carry every one of these labels (exact match). A top-level session also matches through a child.' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'run_command',
    title: 'Run a command in a session sandbox',
    description:
      "Run a bash command in a session's sandbox (its git checkout is /workspace) and return stdout, stderr (separate streams) and the exit code. A stopped sandbox is started first. A command may run for minutes: when it outlasts one call (~50 s), the result says `status: running` with a job_id and the output so far; call again with that job_id to keep waiting, or with cancel: true to stop it. The kortix CLI is preinstalled and signed in as the session.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION_ID,
        command: { type: 'string', description: 'A bash command line.' },
        cwd: { type: 'string', description: 'Working directory (default /workspace).' },
        timeout_seconds: { type: 'number', description: `Kill the command after this long (default ${JOB_DEFAULT_TIMEOUT_SECONDS}, max ${JOB_MAX_TIMEOUT_SECONDS}).` },
        job_id: { type: 'string', description: 'Keep waiting on a command an earlier call returned as still running (instead of command).' },
        cancel: { type: 'boolean', description: 'With job_id: stop that command.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'read_file',
    title: 'Read a file',
    description:
      "Read one file. With session_id: the session's live sandbox (uncommitted edits included; relative paths resolve under /workspace, `~` is the sandbox home; images come back as images; reads are limited to /workspace, the home directory and /tmp: use run_command for anything else). With project_id instead (session_id wins when both are given): the project's git repository at `ref` (default branch when omitted), no sandbox needed. A long text file comes back in pages of lines: `offset` (lines to skip) and `limit` (lines) read the next page. A binary file is not returned as text: use run_command (e.g. base64 -w0 file | cut -c 1-40000).",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, e.g. README.md or /workspace/src/index.ts.' },
        session_id: SESSION_ID,
        project_id: PROJECT_ID,
        ref: { type: 'string', description: 'Repository only: a branch, tag or commit.' },
        offset: { type: 'number', description: 'Text files: lines to skip (default 0). A cut result ends with the offset that continues it.' },
        limit: { type: 'number', description: 'Text files: max lines to return (default: as many as fit in ~50 000 characters).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'write_file',
    title: 'Write a file in a session sandbox',
    description:
      "Write a file in a session's sandbox, creating parent directories. Overwrites an existing file. `~` is the sandbox home. The agent and the session branch see it at once; commit it with run_command (git) or ask the agent.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION_ID,
        path: { type: 'string', description: 'File path; relative paths resolve under /workspace.' },
        content: { type: 'string', description: 'The whole new file content.' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'base64 for binary content (default utf8).' },
      },
      required: ['session_id', 'path', 'content'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_files',
    title: 'List files',
    description:
      "List files. With session_id: one directory of the session's live sandbox (default /workspace; absolute paths, `~` is the sandbox home). With project_id instead (session_id wins when both are given): every file of the project's git repository under `path` (recursive), at `ref`. A long list is cut; the result ends with the `offset` that continues it.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory (sandbox) or directory/file path in the repository (a leading / is the repository root).' },
        session_id: SESSION_ID,
        project_id: PROJECT_ID,
        ref: { type: 'string', description: 'Repository only: a branch, tag or commit.' },
        offset: { type: 'number', description: 'Entries to skip (default 0).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'read_skill',
    title: 'Read Kortix guides',
    description:
      "Read the Kortix platform guides (skills): how projects, sessions, agents, kortix.yaml, triggers, connectors, secrets, Apps, change requests and the CLI work. No name lists them; a name returns the guide and its reference file paths; file reads one reference. With project_id, the project's own skills come with them: no name lists both; a name returns that project skill's SKILL.md and its reference file paths (a project skill wins over a guide of the same name); file reads one of its references.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name, e.g. kortix-system.' },
        file: { type: 'string', description: 'A reference file the guide names, e.g. references/cli.md.' },
        project_id: { ...PROJECT_ID, description: "Optional: include this project's own skills (from its skills/ directory)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'search_api',
    title: 'Search the Kortix API',
    description:
      'Search the Kortix API — the routes the web app and the kortix CLI use: accounts, projects, sessions, files, secrets, connectors, triggers, agents, models, change requests, Apps, access, billing, audit. Returns METHOD /path — summary lines. Follow with describe_api, then call_api.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "secrets", "trigger fire", "change request merge".' },
        limit: { type: 'number', description: 'Max results (default 20).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'describe_api',
    title: 'Describe an API route',
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
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'call_api',
    title: 'Call the Kortix API',
    description:
      'Call any Kortix API route as the signed-in user, with their permissions. {projectId} in the path is replaced with project_id; replace every other {placeholder} yourself, e.g. /v1/projects/{projectId}/secrets/MY_KEY. Returns `METHOD path → HTTP status` and the response body.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        project_id: { type: 'string', description: 'Fills {projectId} in the path.' },
        path: { type: 'string', description: 'Starts with /v1/, e.g. /v1/projects/{projectId}/sessions.' },
        query: { type: 'object', description: 'Query-string parameters; an array value repeats the parameter.' },
        body: { type: 'object', additionalProperties: true, description: 'JSON request body (an object; a JSON string is parsed).' },
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

function optionalArg(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const bounded = (value: unknown, fallback: number, max: number) => Math.min(Math.max(Number(value) || fallback, 1), max);

class ToolInputError extends Error {}

const STARTED_BY = ['me', 'others', 'automated'];

/** Query for the list route: top-level sessions (or one parent's children), optionally filtered. */
export function listSessionsQuery(input: Record<string, unknown>): Record<string, string | number | string[]> {
  const query: Record<string, string | number | string[]> = {
    limit: limitArg(input, 'limit', 20, 200),
    parent: optionalArg(input, 'parent_session_id') ?? 'root',
  };
  const cursor = optionalArg(input, 'cursor');
  if (cursor !== undefined) query.cursor = cursor;
  const startedBy = optionalArg(input, 'started_by');
  if (startedBy !== undefined) {
    if (!STARTED_BY.includes(startedBy)) throw new ToolInputError('started_by must be me, others or automated');
    query.started_by = startedBy;
  }
  const q = optionalArg(input, 'query');
  if (q !== undefined) {
    if (q.length > 200) throw new ToolInputError('query is at most 200 characters');
    query.q = q;
  }
  const labels = labelsArg(input);
  if (labels?.length) query.label = labels;
  return query;
}

function labelsArg(input: Record<string, unknown>): string[] | undefined {
  const labels = input.labels;
  if (labels === undefined) return undefined;
  if (!Array.isArray(labels) || !labels.every((label) => typeof label === 'string')) {
    throw new ToolInputError('labels must be a list of strings');
  }
  return labels;
}

/** The POST /sessions body for start_session. */
export function startSessionBody(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { initial_prompt: arg(input, 'prompt') };
  if (optionalArg(input, 'name')) body.name = optionalArg(input, 'name');
  if (optionalArg(input, 'agent')) body.agent_name = optionalArg(input, 'agent');
  const labels = labelsArg(input);
  if (labels) body.labels = labels;
  const metadata = input.metadata;
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new ToolInputError('metadata must be a JSON object');
    }
    body.metadata = metadata;
  }
  return body;
}

/** One bounded row of `list_sessions` output. */
export function listSessionRow(s: any) {
  return {
    session_id: s.session_id,
    name: s.name ?? null,
    labels: s.labels ?? [],
    status: s.status,
    agent: s.agent_name,
    owner: s.owner_name ?? s.owner_email ?? null,
    started_by: s.initiator?.label ?? null,
    parent_session_id: s.parent_session_id ?? null,
    child_count: s.child_count ?? 0,
    ...(s.search_match ? { search_match: s.search_match } : {}),
    origin: s.origin,
    branch: s.branch_name ?? null,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

/** The project's own skills (`skills/<slug>/SKILL.md`, or the legacy dir) from the same /detail route the web app reads; it honors the caller's per-skill grants. */
async function projectSkills(ctx: ToolContext, projectId: string): Promise<{ slug: string; name: string; description: string | null; path: string; files: string[] }[] | Error> {
  const r = await callApi(ctx, 'GET', `/v1/projects/${projectId}/detail`);
  if (r.status >= 400) return new ToolInputError(`HTTP ${r.status} reading project ${projectId}: ${r.body.slice(0, 200)}`);
  const detail = JSON.parse(r.body) as { config?: { skills?: { name: string; path: string; description: string | null }[] }; files?: { path: string }[] };
  return (detail.config?.skills ?? []).map((s) => {
    const dir = s.path.slice(0, s.path.lastIndexOf('/') + 1);
    return { ...s, slug: dir.split('/').at(-2) ?? s.name, files: (detail.files ?? []).map((f) => f.path).filter((p) => p.startsWith(dir)) };
  });
}

async function runTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'list_projects':
      return listProjectsTool(ctx, input);
    case 'start_session': {
      const body = startSessionBody(input);
      const r = await callApi(ctx, 'POST', `/v1/projects/${projectArg(input)}/sessions`, { body });
      if (r.status >= 400) return apiResult(r);
      const session = JSON.parse(r.body);
      return text(
        JSON.stringify(
          { session_id: session.session_id, project_id: session.project_id, name: session.name ?? null, labels: session.labels ?? [], status: session.status, branch: session.branch_name ?? null },
          null,
          2,
        ),
      );
    }
    case 'send_message':
      return sendMessageTool(ctx, input);
    case 'read_session':
      return readSessionTool(ctx, input);
    case 'list_sessions': {
      const r = await callApi(ctx, 'GET', `/v1/projects/${projectArg(input)}/sessions`, { query: listSessionsQuery(input) });
      if (r.status >= 400) return apiResult(r);
      const rows = (JSON.parse(r.body) as any[]).map(listSessionRow);
      return text(JSON.stringify({ sessions: rows, next_cursor: r.nextCursor ?? null }, null, 2));
    }
    case 'run_command':
      return runCommandTool(ctx, input);
    case 'read_file':
      return readFileTool(ctx, input);
    case 'write_file': {
      const content = input.content;
      if (typeof content !== 'string') throw new ToolInputError('content is required');
      const base64 = input.encoding === 'base64';
      // Buffer.from(…, 'base64') is lenient: bad input would write junk bytes.
      if (base64 && (!/^[A-Za-z0-9+/=\s]*$/.test(content) || content.replace(/[=\s]/g, '').length % 4 === 1)) {
        throw new ToolInputError('content is not valid base64; nothing was written');
      }
      const sandbox = await resolveSandbox(ctx, arg(input, 'session_id'));
      if (!('session' in sandbox)) return apiResult(sandbox);
      const home = await expandHome(ctx, sandbox, arg(input, 'path'));
      if ('error' in home) return home.error;
      const r = await callSandbox(ctx, sandbox, 'POST', '/kortix/env-rpc', {
        body: { op: 'writeFile', args: { path: home.path, content, encoding: base64 ? 'base64' : 'utf8' } },
      });
      return envRpcResult(r, () => `wrote ${home.path}`);
    }
    case 'list_files':
      return listFilesTool(ctx, input);
    case 'read_skill':
      return readSkillTool(ctx, input);
    case 'kortix':
      return kortixCliTool(ctx, input);
    case 'search_api': {
      const { ops } = await loadCatalog(ctx);
      const hits = searchOperations(ops, arg(input, 'query'), limitArg(input, 'limit', 20, 100));
      if (hits.length === 0) return text('No matching routes. Try broader keywords.');
      return text(hits.map((op) => `${op.method} ${op.path}${op.summary && !op.summary.startsWith(op.method) ? ` — ${op.summary}` : ''}`).join('\n'));
    }
    case 'describe_api':
      return describeApiTool(ctx, input);
    case 'call_api':
      return callApiTool(ctx, input);
    default:
      if (isConnectorTool(name)) return runConnectorTool(name, input, connectorHost(ctx));
      throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
  }
}

async function listProjectsTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const accounts = await callApi(ctx, 'GET', '/v1/accounts');
  if (accounts.status >= 400) return apiResult(accounts);
  const parsed = JSON.parse(accounts.body);
  const list = (Array.isArray(parsed) ? parsed : (parsed.accounts ?? [])) as { account_id: string; name?: string }[];
  const perAccount = await Promise.all(
    list.map(async (account) => {
      const r = await callApi(ctx, 'GET', '/v1/projects', { query: { account_id: account.account_id } });
      const rows = r.status < 400 ? (JSON.parse(r.body) as any[]) : [];
      return rows.map((p) => ({
        project_id: p.project_id,
        name: p.name,
        account: account.name ?? account.account_id,
        account_id: account.account_id,
        repository: p.repo_url ?? null,
        default_branch: p.default_branch ?? null,
        role: p.effective_project_role ?? null,
      }));
    }),
  );
  const projects = perAccount.flat();
  return text(projects.length ? JSON.stringify(projects, null, 2) : 'No projects. Create one in the web app or with `kortix init`.');
}

async function sendMessageTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const sessionId = arg(input, 'session_id');
  const message = arg(input, 'text');
  const path = await sessionPath(sessionId);
  const found = await callApi(ctx, 'GET', path);
  if (found.status >= 400) return apiResult(found);
  const session = JSON.parse(found.body);
  // The same body `kortix sessions chat --queue` sends (apps/cli/src/commands/sessions-queue.ts).
  const model = typeof session.metadata?.opencode_model === 'string' ? session.metadata.opencode_model : '';
  const slash = model.indexOf('/');
  const overrides = {
    ...(session.agent_name ? { agent: session.agent_name } : {}),
    ...(slash > 0 ? { model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } } : {}),
  };
  const clientMessageId = crypto.randomUUID();
  const messageId = mintWireMessageId();
  const queued = await callApi(ctx, 'POST', `${path}/prompts`, {
    body: {
      client_message_id: clientMessageId,
      message_id: messageId,
      parts: [{ type: 'text', text: message }],
      client_sent_at_ms: Date.now(),
      remint_on_delivery: true,
      ...(Object.keys(overrides).length ? { overrides } : {}),
    },
  });
  if (queued.status >= 400) return apiResult(queued);
  // Start after the prompt is queued: start drains the inbox of a stopped session.
  const start = await callApi(ctx, 'POST', `${path}/start`, { body: {} });
  return text(
    JSON.stringify({ queued: true, started: start.status < 400, session_id: sessionId, message_id: messageId, client_message_id: clientMessageId }, null, 2),
  );
}

async function readSessionTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const path = await sessionPath(arg(input, 'session_id'));
  const limit = limitArg(input, 'limit', 10, 100);
  const wait = input.wait_seconds === undefined ? 0 : limitArg(input, 'wait_seconds', 1, 45) * 1000;
  // The activity poll and the transcript read must both end inside the request budget.
  const deadline = Math.min(Date.now() + wait, ctx.deadline - 12_000);
  let activity = await sessionActivity(ctx, path);
  while (!('error' in activity) && activity.busy && Date.now() + 2_000 < deadline) {
    await Bun.sleep(2_000);
    activity = await sessionActivity(ctx, path);
  }
  if ('error' in activity) return apiResult(activity.error!);
  const late = Symbol('late');
  const transcript = await Promise.race([
    callApi(ctx, 'GET', `${path}/transcript`, { query: { limit, chars: 1500, detail: 'full' } }),
    Bun.sleep(Math.max(ctx.deadline - Date.now() - 2_000, 0)).then(() => late),
  ]);
  const note = typeof transcript === 'symbol' ? 'transcript: not read inside the request budget; call again' : transcript.status >= 400 ? `transcript: HTTP ${transcript.status} ${transcript.body}` : null;
  if (note) return text(`${JSON.stringify(activity.summary, null, 2)}\n\n${note}`);
  return text(shapeTranscript(activity.summary, JSON.parse((transcript as ApiReply).body)));
}

async function runCommandTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const started = Date.now();
  const sessionId = arg(input, 'session_id');
  const existing = optionalArg(input, 'job_id');
  if (existing && !/^[0-9a-f]{16}$/.test(existing)) throw new ToolInputError('job_id is the 16-character id a running result returned');
  if (existing && optionalArg(input, 'command')) throw new ToolInputError('pass command (start a command) or job_id (follow one), not both');
  if (input.cancel === true && !existing) throw new ToolInputError('cancel needs the job_id of a running command');
  const rawTimeout = input.timeout_seconds;
  if (rawTimeout !== undefined && rawTimeout !== null && !(Number(rawTimeout) > 0)) throw new ToolInputError('timeout_seconds must be a positive number');
  const command = existing ? undefined : arg(input, 'command');
  const jobId = existing ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  // One session lookup for the launch and every poll of this call.
  const sandbox = await resolveSandbox(ctx, sessionId);
  if (!('session' in sandbox)) return apiResult(sandbox);
  const exec = (script: string, env: Record<string, string>, cwd?: string) => sandboxExec(ctx, sandbox, script, { KMCP_JOB: jobId, ...env }, cwd);
  let finishedBefore = false;
  if (existing && input.cancel === true) {
    const r = await exec(JOB_CANCEL, {});
    if ('error' in r) return r.error;
    finishedBefore = r.stdout.trim() === 'finished';
  } else if (!existing) {
    const timeout = bounded(rawTimeout, JOB_DEFAULT_TIMEOUT_SECONDS, JOB_MAX_TIMEOUT_SECONDS);
    const r = await exec(JOB_LAUNCH, { KMCP_CMD: command!, KMCP_TIMEOUT: String(timeout) }, optionalArg(input, 'cwd'));
    if ('error' in r) return r.error;
    // A launch that fails (a cwd that does not exist, no space left) says why, before any poll.
    if (r.exitCode !== 0) return text(`Could not start the command (exit ${r.exitCode}): ${r.stderr.trim() || 'no error output'}`, true);
  }
  // Wait for the exit file, fast at first (most commands finish in well
  // under a second), then every second, leaving ~6 s for the final read.
  const sep = `--kortix-mcp-${crypto.randomUUID()}--`;
  const poll = async (): Promise<{ error: ToolResult } | { job: JobState }> => {
    const r = await exec(JOB_POLL, { KMCP_TAIL: String(JOB_TAIL_BYTES), KMCP_SEP: sep });
    return 'error' in r ? r : { job: parseJobPoll(r.stdout, sep) };
  };
  let delay = 200;
  for (;;) {
    const r = await poll();
    if ('error' in r) return r.error;
    if (r.job.state === 'missing') return text(`No job ${jobId} in this session's sandbox (a restarted sandbox loses its jobs).`, true);
    if (r.job.state === 'done' || Date.now() + delay > ctx.deadline - 6_000) {
      const rendered = renderJob(jobId, r.job, Date.now() - started);
      return text(finishedBefore && r.job.state === 'done' ? `job already finished (${r.job.exit === 'cancelled' ? 'cancelled' : `exit ${r.job.exit}`})\n${rendered}` : rendered);
    }
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, 1_000);
  }
}

async function readFileTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const path = arg(input, 'path');
  needTarget(input);
  const sessionId = optionalArg(input, 'session_id');
  if (!sessionId) {
    const r = await callApi(ctx, 'GET', `/v1/projects/${projectArg(input)}/files/content`, { query: { path, ref: optionalArg(input, 'ref') } });
    if (r.status >= 400) return apiResult(r);
    const file = JSON.parse(r.body);
    // The route returns git's stdout as a string; a NUL byte means binary, never text.
    if (String(file.content).includes('\0')) return text(`${path} is a binary file. Read it through a session (read_file with session_id) or clone the repository.`);
    return pageLines(file.content, input);
  }
  const sandbox = await resolveSandbox(ctx, sessionId);
  if (!('session' in sandbox)) return apiResult(sandbox);
  const home = await expandHome(ctx, sandbox, path);
  if ('error' in home) return home.error;
  const r = await callSandbox(ctx, sandbox, 'GET', '/file/content', { query: { path: home.path } });
  if (r.status >= 400) return apiResult(r);
  const file = JSON.parse(r.body);
  if (file.type === 'text') return pageLines(file.content, input);
  if (String(file.mimeType).startsWith('image/')) {
    if (file.size > IMAGE_MAX_BYTES) return text(`Image (${file.mimeType}, ${file.size} bytes) is over the ${IMAGE_MAX_BYTES} byte limit for inline images. Resize it with run_command first.`);
    return { content: [{ type: 'image', data: file.content, mimeType: file.mimeType }] };
  }
  if (String(file.content).length > BINARY_INLINE_CHARS) {
    return text(`${home.path} is binary, ${file.size} bytes (${file.mimeType}) — use run_command (e.g. base64 -w0 ${home.path} | cut -c 1-40000) to fetch it.`);
  }
  return text(`Binary file (${file.mimeType}, ${file.size} bytes). Base64:\n${file.content}`);
}

async function listFilesTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  needTarget(input);
  const path = optionalArg(input, 'path');
  const sessionId = optionalArg(input, 'session_id');
  const offset = intArg(input, 'offset') ?? 0;
  if (!sessionId) {
    const repoPath = path?.replace(/^\/+/, '');
    const ref = optionalArg(input, 'ref');
    const r = await callApi(ctx, 'GET', `/v1/projects/${projectArg(input)}/files`, { query: { path: repoPath, ref } });
    if (r.status >= 400) return apiResult(r);
    const files = JSON.parse(r.body) as { path: string }[];
    return text(files.length ? page(files.map((f) => f.path), offset, undefined, 'entries') : `No files${repoPath ? ` under ${repoPath}` : ''} at ${ref ? `${ref} (or that ref does not exist)` : 'the default branch'}.`);
  }
  const sandbox = await resolveSandbox(ctx, sessionId);
  if (!('session' in sandbox)) return apiResult(sandbox);
  const home = await expandHome(ctx, sandbox, path ?? '/workspace');
  if ('error' in home) return home.error;
  const r = await callSandbox(ctx, sandbox, 'GET', '/file', { query: { path: home.path } });
  if (r.status >= 400) return apiResult(r);
  const nodes = JSON.parse(r.body) as { absolute: string; type: string }[];
  return text(nodes.length ? page(nodes.map((n) => (n.type === 'directory' ? `${n.absolute}/` : n.absolute)), offset, undefined, 'entries') : 'Empty directory.');
}

async function readSkillTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const name = optionalArg(input, 'name');
  const file = optionalArg(input, 'file');
  const projectId = optionalArg(input, 'project_id');
  const own = projectId ? await projectSkills(ctx, projectArg(input)) : [];
  if (own instanceof Error) throw own;
  const mine = name ? own.find((s) => s.slug === name || s.name === name) : undefined;
  if (mine) {
    const dir = mine.path.slice(0, mine.path.lastIndexOf('/') + 1);
    if (file) {
      if (file.split('/').includes('..')) throw new ToolInputError('file must stay inside the skill directory');
      const r = await callApi(ctx, 'GET', `/v1/projects/${projectId}/files/content`, { query: { path: `${dir}${file.replace(/^\/+/, '')}` } });
      return r.status >= 400 ? apiResult(r) : text(JSON.parse(r.body).content);
    }
    const r = await callApi(ctx, 'GET', `/v1/projects/${projectId}/files/content`, { query: { path: mine.path } });
    if (r.status >= 400) return apiResult(r);
    const refs = mine.files.filter((f) => f !== mine.path).map((f) => `- ${f.slice(dir.length)}`);
    const body = JSON.parse(r.body).content as string;
    return text(refs.length ? `${body}\n\nReference files (read_skill with project_id, name and file):\n${refs.join('\n')}` : body);
  }
  if (!name) {
    const r = await callApi(ctx, 'GET', '/v1/skills');
    if (r.status >= 400) return apiResult(r);
    const skills = JSON.parse(r.body).skills as { name: string; description: string }[];
    const guides = skills.map((s) => `${s.name} — ${s.description}`).join('\n\n');
    if (!projectId) return text(guides);
    const project = own.map((s) => `${s.slug} — ${s.description ?? '(no description)'}`).join('\n\n');
    return text(`Project skills (read_skill with project_id and name):\n\n${project || '(none: the project has no skills/ directory)'}\n\nPlatform guides:\n\n${guides}`);
  }
  if (file) {
    const r = await callApi(ctx, 'GET', `/v1/skills/${encodeURIComponent(name)}/file`, { query: { path: file } });
    return r.status >= 400 ? apiResult(r) : text(JSON.parse(r.body).content);
  }
  // The body and its reference paths, as `kortix system-skills get` prints
  // them: every reference inline (`?full=1`) is ~280 KB for kortix-system.
  const r = await callApi(ctx, 'GET', `/v1/skills/${encodeURIComponent(name)}`);
  if (r.status >= 400) return apiResult(r);
  const skill = JSON.parse(r.body) as { body: string; references?: { path: string }[] };
  const refs = (skill.references ?? []).map((f) => `- ${f.path}`);
  return text(refs.length ? `${skill.body}\n\nReference files (read_skill with file):\n${refs.join('\n')}` : skill.body);
}

async function kortixCliTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const args = parseArgs(input.args);
  if (typeof args === 'string') throw new ToolInputError(args);
  const projectId = optionalArg(input, 'project_id');
  const sessionId = optionalArg(input, 'session_id');
  if ((projectId && !isUuid(projectId)) || (sessionId && !isUuid(sessionId))) throw new ToolInputError('project_id and session_id must be UUIDs (list_projects, list_sessions)');
  const timeoutMs = Math.min(45_000, ctx.deadline - Date.now() - 4_000);
  if (timeoutMs < 2_000) throw new ToolInputError('Not enough time left in this MCP request for a command. Call again.');
  const run = await runCli({
    args,
    // The caller's own credential, as sent: the CLI then acts as exactly this user through this API.
    token: ctx.authorization.replace(/^Bearer\s+/i, ''),
    apiUrl: `http://127.0.0.1:${Number(process.env.PORT) || 8008}/v1`,
    projectId,
    sessionId,
    timeoutMs,
  });
  return run.ok ? text(run.json, run.exitCode !== 0) : text(run.error, true);
}

async function describeApiTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
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
          requestBody: requestBodyShape(resolveRefs(op.spec.requestBody, doc)),
          response: success?.content?.['application/json']?.schema,
        },
        doc,
      ),
      null,
      2,
    ),
  );
}

async function callApiTool(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const method = arg(input, 'method').toUpperCase();
  let path = arg(input, 'path');
  if (/\{projectId\}|:projectId/.test(path)) {
    const projectId = projectArg(input);
    path = path.replaceAll('{projectId}', projectId).replaceAll(':projectId', projectId);
  }
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new ToolInputError(`method ${method} is not allowed`);
  if (!path.startsWith('/v1/')) throw new ToolInputError('path must start with /v1/ and not target /v1/oauth or an MCP endpoint');
  const open = /\{[^}/]+\}/.exec(path.split('?')[0]!)?.[0];
  if (open) throw new ToolInputError(`path still has ${open}: replace it with the real value, e.g. /v1/projects/{projectId}/secrets/MY_KEY`);
  const query = input.query && typeof input.query === 'object' ? (input.query as Record<string, unknown>) : undefined;
  let body = input.body;
  // A client that types `body` as a string sends JSON text: parse it, never double-encode it.
  if (typeof body === 'string') body = (() => { try { return JSON.parse(body as string); } catch { return body; } })();
  return apiResult(await callApi(ctx, method, path, { query, body, summarizeBinary: true }), `${method} ${path}`);
}

/** What ./connectors.ts needs from this file: the in-process transport and the sandbox file read. */
const connectorHost = (ctx: ToolContext): Host => ({
  call: (method, path, opts) => callApi(ctx, method, path, opts),
  text,
  apiResult: (r) => apiResult(r),
  input: (message) => new ToolInputError(message),
  arg,
  optionalArg,
  projectId: projectArg,
  async readSandboxFile(sessionId, path) {
    const sandbox = await resolveSandbox(ctx, sessionId);
    if (!('session' in sandbox)) return apiResult(sandbox);
    const home = await expandHome(ctx, sandbox, path);
    if ('error' in home) return home.error;
    const r = await callSandbox(ctx, sandbox, 'GET', '/file/content', { query: { path: home.path } });
    if (r.status >= 400) return apiResult(r);
    const file = JSON.parse(r.body);
    // The daemon answers text as a string and everything else as base64.
    return { bytes: file.type === 'text' ? new TextEncoder().encode(file.content) : new Uint8Array(Buffer.from(file.content, 'base64')), mime: typeof file.mimeType === 'string' ? file.mimeType : undefined };
  },
});

function instructions(): string {
  return [
    'Kortix MCP. You act as the signed-in user, with their permissions, across every account and project they can open — the same reach as the kortix CLI.',
    'Start with list_projects. Tools take a project_id (start_session, list_sessions, repository reads) or a session_id (everything about one session).',
    'Sessions: start_session delegates a task to a Kortix agent in its own cloud sandbox; read_session (with wait_seconds) follows it; send_message continues it; list_sessions finds existing ones.',
    "Sandboxes: run_command runs bash in a session's sandbox, and read_file / write_file / list_files reach its live /workspace. With a project_id instead of a session_id, read_file and list_files read the project's git repository.",
    'Platform knowledge: read_skill lists the Kortix guides; read_skill name=kortix-system is the complete reference.',
    'Connectors (Gmail, Slack, GitHub, MCP servers, APIs a project connected): list_connectors shows what is connected and its accounts → search_connector_actions finds an action by intent → describe_connector_action reads its arguments → call_connector runs it as you (pass `reason` for a write whose args are only ids; a `pending_approval` result carries a link the human opens, then call again). A connector that is not connected: connect_connector returns the url the human opens. upload_connector_attachment stages a file for a call; search_connector_apps and add_connector add one to the project.',
    'The kortix CLI itself: the `kortix` tool runs any CLI command as you, e.g. args ["secrets","ls","--json"] (discover with ["--help"] and ["<group>","--help"]; project_id and session_id set the context). Login, hosts, ship, tui and other machine-local commands are refused with the alternative. read_skill with project_id also lists the project\'s own skills.',
    'Everything else the web app and the kortix CLI can do is the Kortix API: search_api finds a route, describe_api reads it, call_api runs it (project_id fills {projectId}).',
  ].join('\n');
}

// ─── JSON-RPC ───────────────────────────────────────────────────────────────

async function handleRpc(ctx: ToolContext, method: string, params: Record<string, any>): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const requested = String(params.protocolVersion ?? '');
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0]!,
        serverInfo: { name: 'kortix', title: 'Kortix', version: process.env.KORTIX_VERSION ?? 'dev' },
        capabilities: { tools: {} },
        instructions: instructions(),
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: [...TOOLS, ...CONNECTOR_TOOLS, KORTIX_TOOL] };
    case 'tools/call': {
      if (typeof params.name !== 'string') throw Object.assign(new Error('Invalid params: name must be a tool name'), { rpcCode: -32602 });
      try {
        return await runTool(ctx, params.name, (params.arguments as Record<string, unknown>) ?? {});
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
  const metadata = `resource_metadata="${mcpResourceMetadataUrl(new URL(c.req.url).origin)}"`;
  const sent = Boolean(c.req.header('Authorization')?.startsWith('Bearer '));
  // RFC 6750 3.1: a token that was sent and refused names `invalid_token`.
  const challenge = () =>
    c.json({ error: 'unauthorized', error_description: 'Sign in with OAuth, or send a kortix_pat_ token, to use the Kortix MCP server.' }, 401, {
      'WWW-Authenticate': `Bearer ${sent ? 'error="invalid_token", ' : ''}${metadata}, scope="${OAUTH_SCOPE_KORTIX}"`,
    });
  if (!sent) return challenge();
  return supabaseAuth(c, next).catch((err) => {
    if (err instanceof HTTPException && err.status === 401) return challenge();
    // A token without the `kortix` scope: tell the client which scope to ask for.
    if (err instanceof HTTPException && err.status === 403 && err.message.startsWith('insufficient_scope')) {
      return c.json({ error: 'insufficient_scope', error_description: err.message }, 403, {
        'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${OAUTH_SCOPE_KORTIX}", ${metadata}`,
      });
    }
    throw err;
  });
}

const PARSE_ERROR = Symbol('parse error');

export function createMcpApp(dispatch: Dispatch) {
  const app = new Hono();

  app.post('/', challengeUnauthorized, async (c) => {
    const reject = (id: unknown, code: number, message: string) => c.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, 400);
    const message = await c.req.json().catch(() => PARSE_ERROR);
    if (message === PARSE_ERROR) return reject(null, -32700, 'Parse error');
    if (Array.isArray(message)) return reject(null, -32600, 'Invalid Request: batches are not supported; send one message per request');
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return reject(null, -32600, 'Invalid Request: jsonrpc must be "2.0"');
    // A response from the client (the server sends no requests): accepted, nothing to answer.
    if (typeof message.method !== 'string') {
      return 'result' in message || 'error' in message ? c.body(null, 202) : reject(message.id, -32600, 'Invalid Request: method is required');
    }
    const version = c.req.header('MCP-Protocol-Version');
    if (version !== undefined && message.method !== 'initialize' && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      return reject(message.id, -32600, `Unsupported MCP-Protocol-Version ${version}; supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`);
    }
    // A notification: accepted, nothing to answer.
    if (message.id === undefined || message.id === null) return c.body(null, 202);

    const ctx: ToolContext = {
      authorization: c.req.header('Authorization')!,
      origin: oauthIssuer(new URL(c.req.url).origin),
      headers: c.req.raw.headers,
      dispatch,
      deadline: Date.now() + REQUEST_BUDGET_MS,
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
  app.on(['GET', 'DELETE'], '/', (c) => c.json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' }));

  return app;
}

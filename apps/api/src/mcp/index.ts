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

type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
};

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
  const url = new URL(path, ctx.origin);
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
  // The audit's client_reported_source, as `cli` and `web` set it for theirs.
  headers.set('x-kortix-client', 'mcp');
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
 * session, and answers 404 for one they cannot see, exactly as for a missing one.
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `…/v1/p/<external_id>/8000` or `/p/<external_id>/8000` → the proxy path. */
function daemonPath(url: unknown): string | null {
  const id = typeof url === 'string' ? /\/p\/([^/]+)\/8000/.exec(url)?.[1] : undefined;
  return id ? `/v1/p/${id}/8000` : null;
}

/**
 * One call to a session's sandbox daemon through the API's per-session proxy —
 * the path the web file panel and terminal use, so access is exactly theirs. A
 * stopped sandbox is started, then the call is retried until it answers.
 */
async function callSandbox(
  ctx: ToolContext,
  sessionId: string,
  method: string,
  path: string,
  /** `body` may be a function: it is built per attempt, after a wake used some of the budget. */
  opts: { query?: Record<string, unknown>; body?: unknown | (() => unknown) } = {},
): Promise<{ status: number; body: string }> {
  const session = await sessionPath(sessionId);
  const found = await callApi(ctx, 'GET', session);
  if (found.status >= 400) return found;
  let base = daemonPath(JSON.parse(found.body).sandbox_url);
  const deadline = ctx.deadline - 5_000;
  let started = false;
  for (;;) {
    if (base) {
      const body = typeof opts.body === 'function' ? opts.body() : opts.body;
      const r = await callApi(ctx, method, `${base}${path}`, { query: opts.query, body });
      // The proxy answers 502/503 with `retry: true` only when the request
      // never reached the daemon (not ready, waking), so a retry is safe.
      const notReady = (r.status === 502 || r.status === 503) && /"retry":\s*true/.test(r.body);
      if (!notReady || Date.now() > deadline) return r;
    }
    if (!started) {
      const s = await callApi(ctx, 'POST', `${session}/start`, { body: {} });
      if (s.status >= 400) return s;
      base ??= daemonPath(JSON.parse(s.body).runtime_url);
      started = true;
    } else if (Date.now() > deadline) {
      return { status: 504, body: 'The sandbox is still starting. Call again; it keeps booting.' };
    }
    await sleep(2_000);
  }
}

/** The daemon's env-rpc answers `{ ok, value }` or `{ ok: false, error }`. */
function envRpcResult(r: { status: number; body: string }, render: (value: any) => string): ToolResult {
  if (r.status >= 400) return apiResult(r);
  const reply = JSON.parse(r.body);
  if (!reply.ok) return text(`${reply.error?.code ?? 'error'}: ${reply.error?.message ?? r.body}`, true);
  return text(render(reply.value));
}

// ─── Commands as jobs (./jobs.ts) ───────────────────────────────────────────

/** Run a short shell script in the session's sandbox (env-rpc exec). */
function sandboxScript(ctx: ToolContext, sessionId: string, script: string, env: Record<string, string>, cwd?: string) {
  return callSandbox(ctx, sessionId, 'POST', '/kortix/env-rpc', {
    body: { op: 'exec', args: { command: script, env, timeout: 15_000, ...(cwd ? { cwd } : {}) } },
  });
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
      turn: BOOTING.has(s.status) ? 'booting' : turns.length > 0 ? 'running' : 'idle',
      queued_prompts: queued,
      branch: s.branch_name,
      agent: s.agent_name,
      error: s.error ?? null,
    },
    busy,
  } as const;
}

// ─── Tools ──────────────────────────────────────────────────────────────────

const SESSION_ID = { type: 'string', description: 'The session_id (UUID).' } as const;
const PROJECT_ID = { type: 'string', description: 'The project_id (UUID), from list_projects.' } as const;

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List every project you can open, across all your accounts: project_id, name, account, repository, your role. Start here: the other tools take a project_id or a session_id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'start_session',
    description:
      'Start a Kortix session in a project with a first prompt. An agent runs it in its own cloud sandbox on its own git branch. Returns the session_id. Follow it with read_session and wait_seconds (the first turn needs ~10–60 s while the sandbox boots).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        prompt: { type: 'string', description: 'The task for the agent.' },
        name: { type: 'string', description: 'Optional session title.' },
        agent: { type: 'string', description: 'Optional agent name; the project default when omitted.' },
      },
      required: ['project_id', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'send_message',
    description:
      "Send a message to a session's agent. It waits in the session's inbox until the current turn ends, and a stopped session is started. Read the reply with read_session and wait_seconds.",
    inputSchema: {
      type: 'object',
      properties: { session_id: SESSION_ID, text: { type: 'string', description: 'The message.' } },
      required: ['session_id', 'text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'read_session',
    description:
      "Read a session: its status, whether a turn is running, and the latest messages with each tool call's input and output. wait_seconds blocks until the agent is idle (up to 45 s); call again while `turn` is still `running`.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: SESSION_ID,
        limit: { type: 'number', description: 'Latest messages to return (default 10, max 100).' },
        wait_seconds: { type: 'number', description: 'Wait up to this long (max 45) for the running turn to end before reading.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_sessions',
    description: 'List the sessions you can see in a project, newest first: id, title, status, agent, owner.',
    inputSchema: {
      type: 'object',
      properties: { project_id: PROJECT_ID, limit: { type: 'number', description: 'Max sessions (default 20, max 200).' } },
      required: ['project_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'run_command',
    description:
      "Run a bash command in a session's sandbox (its git checkout is /workspace) and return stdout, stderr and the exit code. A stopped sandbox is started first. A command may run for minutes: when it outlasts one call (~50 s), the result says `status: running` with a job_id and the output so far; call again with that job_id to keep waiting, or with cancel: true to stop it. The kortix CLI is preinstalled and signed in as the session.",
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
    description:
      "Read one file. With session_id: the session's live sandbox (uncommitted edits included; relative paths resolve under /workspace; images come back as images). With project_id instead: the project's git repository at `ref` (default branch when omitted), no sandbox needed.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, e.g. README.md or /workspace/src/index.ts.' },
        session_id: SESSION_ID,
        project_id: PROJECT_ID,
        ref: { type: 'string', description: 'Repository only: a branch, tag or commit.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_file',
    description:
      "Write a file in a session's sandbox, creating parent directories. Overwrites an existing file. The agent and the session branch see it at once; commit it with run_command (git) or ask the agent.",
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
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'list_files',
    description:
      "List files. With session_id: one directory of the session's live sandbox (default /workspace). With project_id instead: every file of the project's git repository under `path` (recursive), at `ref`.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory (sandbox) or path prefix (repository).' },
        session_id: SESSION_ID,
        project_id: PROJECT_ID,
        ref: { type: 'string', description: 'Repository only: a branch, tag or commit.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_skill',
    description:
      "Read the Kortix platform guides (skills): how projects, sessions, agents, kortix.yaml, triggers, connectors, secrets, Apps, change requests and the CLI work. No name lists them; a name returns the guide and its reference file paths; file reads one reference. The project's own skills are repository files under .kortix/ — read them with read_file.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name, e.g. kortix-system.' },
        file: { type: 'string', description: 'A reference file the guide names, e.g. references/cli.md.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search_api',
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
      'Call any Kortix API route as the signed-in user, with their permissions. {projectId} in the path is replaced with project_id. Returns the HTTP status and the response body.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        project_id: { type: 'string', description: 'Fills {projectId} in the path.' },
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

function optionalArg(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const bounded = (value: unknown, fallback: number, max: number) => Math.min(Math.max(Number(value) || fallback, 1), max);

class ToolInputError extends Error {}

async function runTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'list_projects': {
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
            role: p.effective_role ?? null,
          }));
        }),
      );
      const projects = perAccount.flat();
      return text(projects.length ? JSON.stringify(projects, null, 2) : 'No projects. Create one in the web app or with `kortix init`.');
    }
    case 'start_session': {
      const body: Record<string, unknown> = { initial_prompt: arg(input, 'prompt') };
      if (optionalArg(input, 'name')) body.name = optionalArg(input, 'name');
      if (optionalArg(input, 'agent')) body.agent_name = optionalArg(input, 'agent');
      const r = await callApi(ctx, 'POST', `/v1/projects/${projectArg(input)}/sessions`, { body });
      if (r.status >= 400) return apiResult(r);
      const session = JSON.parse(r.body);
      return text(
        JSON.stringify(
          { session_id: session.session_id, project_id: session.project_id, name: session.name ?? null, status: session.status, branch: session.branch_name ?? null },
          null,
          2,
        ),
      );
    }
    case 'send_message': {
      const sessionId = arg(input, 'session_id');
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
      const queued = await callApi(ctx, 'POST', `${path}/prompts`, {
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
      await callApi(ctx, 'POST', `${path}/start`, { body: {} });
      return text(JSON.stringify({ queued: true, session_id: sessionId }, null, 2));
    }
    case 'read_session': {
      const path = await sessionPath(arg(input, 'session_id'));
      const limit = bounded(input.limit, 10, 100);
      const wait = Number(input.wait_seconds) > 0 ? bounded(input.wait_seconds, 1, 45) * 1000 : 0;
      // Leave the transcript read ~8 s of the request budget.
      const deadline = Math.min(Date.now() + wait, ctx.deadline - 8_000);
      let activity = await sessionActivity(ctx, path);
      while (!('error' in activity) && activity.busy && Date.now() < deadline) {
        await sleep(2_000);
        activity = await sessionActivity(ctx, path);
      }
      if ('error' in activity) return apiResult(activity.error!);
      const transcript = await callApi(ctx, 'GET', `${path}/transcript`, {
        query: { limit, chars: 4000, detail: 'full' },
      });
      if (transcript.status >= 400) {
        return text(`${JSON.stringify(activity.summary, null, 2)}\n\ntranscript: HTTP ${transcript.status} ${transcript.body}`);
      }
      const t = JSON.parse(transcript.body);
      return text(
        JSON.stringify(
          { ...activity.summary, transcript_source: t.source, transcript_note: t.reason ?? undefined, messages: t.messages },
          null,
          2,
        ),
      );
    }
    case 'list_sessions': {
      const r = await callApi(ctx, 'GET', `/v1/projects/${projectArg(input)}/sessions`, { query: { limit: bounded(input.limit, 20, 200) } });
      if (r.status >= 400) return apiResult(r);
      const rows = (JSON.parse(r.body) as any[]).map((s) => ({
        session_id: s.session_id,
        name: s.name ?? null,
        status: s.status,
        agent: s.agent_name,
        owner: s.owner_name ?? s.owner_email ?? null,
        origin: s.origin,
        updated_at: s.updated_at,
      }));
      return text(JSON.stringify(rows, null, 2));
    }
    case 'run_command': {
      const started = Date.now();
      const sessionId = arg(input, 'session_id');
      const existing = optionalArg(input, 'job_id');
      if (existing && !/^[0-9a-f]{16}$/.test(existing)) throw new ToolInputError('job_id is the 16-character id a running result returned');
      const jobId = existing ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);
      const dir = { KMCP_JOB: jobId };
      const exec = async (script: string, env: Record<string, string>, cwd?: string): Promise<{ error: ToolResult } | { stdout: string }> => {
        const r = await sandboxScript(ctx, sessionId, script, { ...dir, ...env }, cwd);
        if (r.status >= 400) return { error: apiResult(r) };
        const reply = JSON.parse(r.body);
        if (!reply.ok) return { error: text(`${reply.error?.code ?? 'error'}: ${reply.error?.message ?? r.body}`, true) };
        return { stdout: String(reply.value.stdout ?? '') };
      };
      if (existing && input.cancel === true) {
        const r = await exec(JOB_CANCEL, {});
        if ('error' in r) return r.error;
      } else if (!existing) {
        const timeout = bounded(input.timeout_seconds, JOB_DEFAULT_TIMEOUT_SECONDS, JOB_MAX_TIMEOUT_SECONDS);
        const r = await exec(JOB_LAUNCH, { KMCP_CMD: arg(input, 'command'), KMCP_TIMEOUT: String(timeout) }, optionalArg(input, 'cwd'));
        if ('error' in r) return r.error;
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
        if (r.job.state === 'done' || Date.now() + delay > ctx.deadline - 6_000) return text(renderJob(jobId, r.job, Date.now() - started));
        await sleep(delay);
        delay = Math.min(delay * 2, 1_000);
      }
    }
    case 'read_file': {
      const path = arg(input, 'path');
      const sessionId = optionalArg(input, 'session_id');
      if (!sessionId) {
        const r = await callApi(ctx, 'GET', `/v1/projects/${projectArg(input)}/files/content`, { query: { path, ref: optionalArg(input, 'ref') } });
        return r.status >= 400 ? apiResult(r) : text(JSON.parse(r.body).content);
      }
      const r = await callSandbox(ctx, sessionId, 'GET', '/file/content', { query: { path } });
      if (r.status >= 400) return apiResult(r);
      const file = JSON.parse(r.body);
      if (file.type === 'text') return text(file.content);
      if (String(file.mimeType).startsWith('image/')) return { content: [{ type: 'image', data: file.content, mimeType: file.mimeType }] };
      return text(`Binary file (${file.mimeType}, ${file.size} bytes). Base64:\n${file.content}`);
    }
    case 'write_file': {
      const content = input.content;
      if (typeof content !== 'string') throw new ToolInputError('content is required');
      const r = await callSandbox(ctx, arg(input, 'session_id'), 'POST', '/kortix/env-rpc', {
        body: { op: 'writeFile', args: { path: arg(input, 'path'), content, encoding: input.encoding === 'base64' ? 'base64' : 'utf8' } },
      });
      return envRpcResult(r, () => `wrote ${arg(input, 'path')}`);
    }
    case 'list_files': {
      const path = optionalArg(input, 'path');
      const sessionId = optionalArg(input, 'session_id');
      if (!sessionId) {
        const r = await callApi(ctx, 'GET', `/v1/projects/${projectArg(input)}/files`, { query: { path, ref: optionalArg(input, 'ref') } });
        if (r.status >= 400) return apiResult(r);
        const files = JSON.parse(r.body) as { path: string }[];
        return text(files.length ? files.map((f) => f.path).join('\n') : 'No files.');
      }
      const r = await callSandbox(ctx, sessionId, 'GET', '/file', { query: { path: path ?? '/workspace' } });
      if (r.status >= 400) return apiResult(r);
      const nodes = JSON.parse(r.body) as { absolute: string; type: string }[];
      return text(nodes.length ? nodes.map((n) => (n.type === 'directory' ? `${n.absolute}/` : n.absolute)).join('\n') : 'Empty directory.');
    }
    case 'read_skill': {
      const name = optionalArg(input, 'name');
      if (!name) {
        const r = await callApi(ctx, 'GET', '/v1/skills');
        if (r.status >= 400) return apiResult(r);
        const skills = JSON.parse(r.body).skills as { name: string; description: string }[];
        return text(skills.map((s) => `${s.name} — ${s.description}`).join('\n\n'));
      }
      const file = optionalArg(input, 'file');
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
    case 'search_api': {
      const { ops } = await loadCatalog(ctx);
      const hits = searchOperations(ops, arg(input, 'query'), bounded(input.limit, 20, 100));
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
      let path = arg(input, 'path');
      if (/\{projectId\}|:projectId/.test(path)) {
        const projectId = projectArg(input);
        path = path.replaceAll('{projectId}', projectId).replaceAll(':projectId', projectId);
      }
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new ToolInputError(`method ${method} is not allowed`);
      if (!path.startsWith('/v1/') || blockedPath(path)) throw new ToolInputError('path must start with /v1/ and not target /v1/oauth or an MCP endpoint');
      const query = input.query && typeof input.query === 'object' ? (input.query as Record<string, unknown>) : undefined;
      return apiResult(await callApi(ctx, method, path, { query, body: input.body }));
    }
    default:
      throw new ToolInputError(`unknown tool ${name}`);
  }
}

function instructions(): string {
  return [
    'Kortix MCP. You act as the signed-in user, with their permissions, across every account and project they can open — the same reach as the kortix CLI.',
    'Start with list_projects. Tools take a project_id (start_session, list_sessions, repository reads) or a session_id (everything about one session).',
    'Sessions: start_session delegates a task to a Kortix agent in its own cloud sandbox; read_session (with wait_seconds) follows it; send_message continues it; list_sessions finds existing ones.',
    "Sandboxes: run_command runs bash in a session's sandbox, and read_file / write_file / list_files reach its live /workspace. With a project_id instead of a session_id, read_file and list_files read the project's git repository.",
    'Platform knowledge: read_skill lists the Kortix guides; read_skill name=kortix-system is the complete reference.',
    'Everything else the web app and the kortix CLI can do is the Kortix API: search_api finds a route, describe_api reads it, call_api runs it (project_id fills {projectId}).',
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
        instructions: instructions(),
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
  const challenge = () =>
    c.json({ error: 'unauthorized', error_description: 'Sign in with OAuth, or send a kortix_pat_ token, to use the Kortix MCP server.' }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${mcpResourceMetadataUrl(new URL(c.req.url).origin)}", scope="${OAUTH_SCOPE_KORTIX}"`,
    });
  if (!c.req.header('Authorization')?.startsWith('Bearer ')) return challenge();
  return supabaseAuth(c, next).catch((err) => {
    if (err instanceof HTTPException && err.status === 401) return challenge();
    throw err;
  });
}

export function createMcpApp(dispatch: Dispatch) {
  const app = new Hono();

  app.post('/', challengeUnauthorized, async (c) => {
    const message = await c.req.json().catch(() => undefined);
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, 400);
    }
    // A notification or a response from the client: accepted, nothing to answer.
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

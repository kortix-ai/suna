import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { isUuid } from '../shared/validate';
import { blockedPath, canonicalPath, type Operation } from './shape';

export type Dispatch = (request: Request) => Promise<Response>;

const MAX_RESULT_CHARS = 60_000;

export interface ToolContext {
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

export const text = (value: string, isError = false): ToolResult => ({
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

export async function callApi(
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
export function apiResult(r: ApiReply, label?: string): ToolResult {
  const head = `${label ? `${label} → ` : ''}HTTP ${r.status}`;
  const retry = (r.status === 503 || r.status === 429) && r.retryAfter ? `\nRetry after ${r.retryAfter} s.` : '';
  if (r.binary) return text(`${head} ${r.binary.type}, ${r.binary.bytes} bytes (binary, not shown)${retry}`, r.status >= 400);
  return text(`${head}\n${r.body}${retry}`, r.status >= 400);
}

// ─── The OpenAPI catalog (search_api / describe_api) ────────────────────────

let catalog: Promise<{ ops: Operation[]; doc: any }> | null = null;

export function loadCatalog(ctx: ToolContext) {
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
export function resolveRefs(node: any, doc: any, depth = 0): any {
  if (depth > 6 || node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, doc, depth + 1));
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const target = node.$ref.slice(2).split('/').reduce((acc: any, key: string) => acc?.[key], doc);
    return resolveRefs(target, doc, depth + 1);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolveRefs(v, doc, depth + 1)]));
}

// ─── Sessions and projects by id ────────────────────────────────────────────

export function projectArg(input: Record<string, unknown>): string {
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
export async function sessionPath(sessionId: string): Promise<string> {
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
export const REQUEST_BUDGET_MS = 55_000;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `…/v1/p/<external_id>/8000` or `/p/<external_id>/8000` → the proxy path. */
function daemonPath(url: unknown): string | null {
  const id = typeof url === 'string' ? /\/p\/([^/]+)\/8000/.exec(url)?.[1] : undefined;
  return id ? `/v1/p/${id}/8000` : null;
}

/** A session's daemon, resolved once per tool call: the API path of the session and its proxy base. */
export type Sandbox = { session: string; base: string | null };

/** The session lookup (DB read + session GET) that every sandbox call needs first. */
export async function resolveSandbox(ctx: ToolContext, sessionId: string): Promise<Sandbox | { status: number; body: string }> {
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
    await sleep(2_000);
  }
}

/** The daemon's env-rpc failure text: `CODE: message`, once (the message often starts with the code). */
function rpcError(reply: any, body: string): string {
  const code = String(reply.error?.code ?? 'error');
  const message = String(reply.error?.message ?? body);
  return message.startsWith(code) ? message : `${code}: ${message}`;
}

/** The daemon's env-rpc answers `{ ok, value }` or `{ ok: false, error }`. */
export function envRpcResult(r: { status: number; body: string }, render: (value: any) => string): ToolResult {
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
export async function sandboxExec(
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
export async function expandHome(ctx: ToolContext, sandbox: Sandbox, path: string): Promise<{ error: ToolResult } | { path: string }> {
  if (path !== '~' && !path.startsWith('~/')) return { path };
  const r = await sandboxExec(ctx, sandbox, 'printf %s "$HOME"');
  if ('error' in r) return r;
  return { path: `${r.stdout || '/root'}${path.slice(1)}` };
}

/** Both sandbox-or-repository tools need one of the two ids. */
export function needTarget(input: Record<string, unknown>) {
  if (!optionalArg(input, 'session_id') && !optionalArg(input, 'project_id')) {
    throw new ToolInputError('pass session_id (live sandbox) or project_id (repository)');
  }
}

/** Paging caps. A page stays under the result cap so `text()` never cuts it. */
const PAGE_CHARS = 50_000;
export const BINARY_INLINE_CHARS = 40_000;
export const IMAGE_MAX_BYTES = 1_000_000;

/** An optional non-negative integer argument (`min` 1 for a count). */
export function intArg(input: Record<string, unknown>, key: string, min = 0): number | undefined {
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
export function pageLines(content: string, input: Record<string, unknown>): ToolResult {
  const lines = content.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return text(page(lines, intArg(input, 'offset') ?? 0, intArg(input, 'limit', 1), 'lines'));
}

// ─── Sessions ───────────────────────────────────────────────────────────────

/** A session is busy while it boots, runs a turn, or holds queued prompts. */
const BOOTING = new Set(['queued', 'branching', 'provisioning']);

export async function sessionActivity(ctx: ToolContext, path: string) {
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
export function limitArg(input: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolInputError(`${key} must be a number`);
  return Math.min(Math.max(Math.trunc(n), 1), max);
}


export function arg(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new ToolInputError(`${key} is required`);
  return value.trim();
}

export function optionalArg(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export const bounded = (value: unknown, fallback: number, max: number) => Math.min(Math.max(Number(value) || fallback, 1), max);

export class ToolInputError extends Error {}

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

export function labelsArg(input: Record<string, unknown>): string[] | undefined {
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
export async function projectSkills(ctx: ToolContext, projectId: string): Promise<{ slug: string; name: string; description: string | null; path: string; files: string[] }[] | Error> {
  const r = await callApi(ctx, 'GET', `/v1/projects/${projectId}/detail`);
  if (r.status >= 400) return new ToolInputError(`HTTP ${r.status} reading project ${projectId}: ${r.body.slice(0, 200)}`);
  const detail = JSON.parse(r.body) as { config?: { skills?: { name: string; path: string; description: string | null }[] }; files?: { path: string }[] };
  return (detail.config?.skills ?? []).map((s) => {
    const dir = s.path.slice(0, s.path.lastIndexOf('/') + 1);
    return { ...s, slug: dir.split('/').at(-2) ?? s.name, files: (detail.files ?? []).map((f) => f.path).filter((p) => p.startsWith(dir)) };
  });
}

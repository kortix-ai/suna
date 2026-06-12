/**
 * Execution layer — the gateway's "run the call" step. Given a connector's
 * binding + resolved secret + args, build and perform the outbound request to
 * the third party. Credentials are attached HERE (server-side); the sandbox
 * never sees them. Pure builders + an injectable `fetchImpl` keep it unit-tested.
 *
 * Covers openapi / http / mcp execution. (GraphQL execution — building a query
 * string from the field + selection — is a follow-up; normalization already
 * works.) See docs/specs/executor.md §7.
 */
import type { ActionBinding } from './types';

export interface ExecutorAuth {
  type: 'bearer' | 'basic' | 'custom' | 'none';
  in: 'header' | 'query';
  name: string | null;
  prefix: string | null;
}

export type ParamLoc = 'path' | 'query' | 'header';

export interface BuiltRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ExecResult {
  status: number;
  ok: boolean;
  data: unknown;
}

const NO_AUTH: ExecutorAuth = { type: 'none', in: 'header', name: null, prefix: null };
export type McpTransport = 'http' | 'sse';

/** Attach a credential to a request per the connector's auth method. */
export function applyAuth(
  headers: Record<string, string>,
  query: URLSearchParams,
  auth: ExecutorAuth,
  secret: string | null,
): void {
  if (auth.type === 'none' || !secret) return;
  if (auth.type === 'bearer') {
    const prefix = auth.prefix ?? 'Bearer';
    headers['Authorization'] = `${prefix} ${secret}`.trim();
    return;
  }
  if (auth.type === 'basic') {
    // secret is either "user:pass" or a token; base64 as-is.
    headers['Authorization'] = `Basic ${Buffer.from(secret).toString('base64')}`;
    return;
  }
  // custom
  const value = auth.prefix ? `${auth.prefix}${secret}` : secret;
  const name = auth.name ?? 'Authorization';
  if (auth.in === 'query') query.set(name, value);
  else headers[name] = value;
}

/** Derive where each input property goes from its `x-in` hint (from normalization). */
export function paramHintsFromSchema(
  inputSchema: Record<string, unknown> | null | undefined,
): Record<string, ParamLoc> {
  const out: Record<string, ParamLoc> = {};
  const props = (inputSchema as any)?.properties;
  if (props && typeof props === 'object') {
    for (const [key, val] of Object.entries(props)) {
      const loc = (val as any)?.['x-in'];
      if (loc === 'path' || loc === 'query' || loc === 'header') out[key] = loc;
    }
  }
  return out;
}

function methodAllowsBody(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Build an HTTP request for openapi/http bindings. Path params are substituted
 * into the template; the rest are routed by hint (query/header) or, lacking a
 * hint, into the body for body-methods else the query string. `args.body`
 * is sent as the JSON body verbatim.
 */
export function buildHttpRequest(opts: {
  baseUrl: string;
  method: string;
  pathTemplate: string;
  auth?: ExecutorAuth;
  secret?: string | null;
  args?: Record<string, unknown>;
  paramHints?: Record<string, ParamLoc>;
}): BuiltRequest {
  const args = opts.args ?? {};
  const hints = opts.paramHints ?? {};
  const headers: Record<string, string> = {};
  const query = new URLSearchParams();
  const consumed = new Set<string>();

  // Path params: {name} → value.
  let path = opts.pathTemplate.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    consumed.add(name);
    const v = args[name];
    return encodeURIComponent(v == null ? '' : String(v));
  });

  const bodyObj: Record<string, unknown> = {};
  let explicitBody: unknown;
  let hasExplicitBody = false;

  for (const [key, value] of Object.entries(args)) {
    if (consumed.has(key)) continue;
    if (key === 'body') {
      explicitBody = value;
      hasExplicitBody = true;
      continue;
    }
    const hint = hints[key];
    if (hint === 'path') continue; // already templated (or absent)
    if (hint === 'query') { appendQuery(query, key, value); continue; }
    if (hint === 'header') { headers[key] = String(value); continue; }
    // no hint
    if (methodAllowsBody(opts.method)) bodyObj[key] = value;
    else appendQuery(query, key, value);
  }

  applyAuth(headers, query, opts.auth ?? NO_AUTH, opts.secret ?? null);

  let url = joinUrl(opts.baseUrl, path);
  const qs = query.toString();
  if (qs) url += (url.includes('?') ? '&' : '?') + qs;

  let body: string | undefined;
  const finalBody = hasExplicitBody ? explicitBody : (Object.keys(bodyObj).length ? bodyObj : undefined);
  if (finalBody !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    body = JSON.stringify(finalBody);
  }

  return { url, method: opts.method.toUpperCase(), headers, body };
}

function appendQuery(query: URLSearchParams, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const v of value) query.append(key, String(v));
  } else if (value != null) {
    query.set(key, String(value));
  }
}

/** Serialize a JS value to a GraphQL literal (strings/numbers/bools/arrays/objects). */
function gqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(gqlLiteral).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>).map(([k, val]) => `${k}:${gqlLiteral(val)}`).join(',')}}`;
  }
  return 'null';
}

/**
 * Build a GraphQL request. Args become inline field arguments; a `__select`
 * arg (string) supplies the selection set for object-returning fields (scalar
 * fields need none). e.g. call("…","query.user",{ id:"1", __select:"id name" }).
 */
export function buildGraphqlRequest(opts: {
  endpoint: string;
  operation: 'query' | 'mutation';
  field: string;
  auth?: ExecutorAuth;
  secret?: string | null;
  args?: Record<string, unknown>;
}): BuiltRequest {
  const { __select, ...rest } = (opts.args ?? {}) as Record<string, unknown>;
  const argStr = Object.keys(rest).length
    ? `(${Object.entries(rest).map(([k, v]) => `${k}:${gqlLiteral(v)}`).join(',')})`
    : '';
  const sel = typeof __select === 'string' && __select.trim() ? ` { ${__select.trim()} }` : '';
  const query = `${opts.operation} { ${opts.field}${argStr}${sel} }`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const search = new URLSearchParams();
  applyAuth(headers, search, opts.auth ?? NO_AUTH, opts.secret ?? null);
  let url = opts.endpoint;
  const qs = search.toString();
  if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  return { url, method: 'POST', headers, body: JSON.stringify({ query }) };
}

function withAuth(
  url: string,
  headers: Record<string, string>,
  auth: ExecutorAuth,
  secret: string | null,
): { url: string; headers: Record<string, string> } {
  const query = new URLSearchParams();
  const nextHeaders = { ...headers };
  applyAuth(nextHeaders, query, auth, secret);
  const qs = query.toString();
  return {
    url: qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url,
    headers: nextHeaders,
  };
}

/** Build a JSON-RPC request for an MCP streamable-HTTP connector. */
export function buildMcpJsonRpcRequest(opts: {
  url: string;
  auth?: ExecutorAuth;
  secret?: string | null;
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}): BuiltRequest {
  const req = withAuth(
    opts.url,
    { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    opts.auth ?? NO_AUTH,
    opts.secret ?? null,
  );
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: opts.id ?? 1,
    method: opts.method,
    params: opts.params ?? {},
  });
  return { url: req.url, method: 'POST', headers: req.headers, body };
}

/** Build a JSON-RPC `tools/call` request for an MCP (http transport) connector. */
export function buildMcpRequest(opts: {
  url: string;
  auth?: ExecutorAuth;
  secret?: string | null;
  toolName: string;
  args?: Record<string, unknown>;
}): BuiltRequest {
  return buildMcpJsonRpcRequest({
    url: opts.url,
    auth: opts.auth,
    secret: opts.secret,
    method: 'tools/call',
    params: { name: opts.toolName, arguments: opts.args ?? {} },
  });
}

export type FetchImpl = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  ok: boolean;
  text: () => Promise<string>;
}>;

/** Parse a response body: JSON, or SSE-framed JSON (MCP streamable-HTTP), else raw text. */
export function parseResponseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* not plain JSON — try SSE */
  }
  // SSE: `event: message\ndata: {...}` — take the last data: line that parses as JSON.
  const dataLines = text
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter(Boolean);
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(dataLines[i]!);
    } catch {
      /* keep scanning */
    }
  }
  return text;
}

/** Perform a built request and parse the response (JSON or SSE-framed JSON). */
export async function performRequest(req: BuiltRequest, fetchImpl: FetchImpl): Promise<ExecResult> {
  const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
  const text = await res.text();
  return { status: res.status, ok: res.ok, data: parseResponseBody(text) };
}

interface SseState {
  buffer: string;
}

interface SseFrame {
  event: string;
  data: string;
}

function shiftSseFrame(state: SseState): SseFrame | null {
  const match = state.buffer.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) return null;
  const raw = state.buffer.slice(0, match.index);
  state.buffer = state.buffer.slice(match.index + match[0].length);

  const frame: SseFrame = { event: 'message', data: '' };
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) frame.event = line.slice(6).trim();
    if (line.startsWith('data:')) {
      frame.data += `${frame.data ? '\n' : ''}${line.slice(5).trim()}`;
    }
  }
  return frame;
}

async function readSseFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: SseState,
  timeoutMs: number,
): Promise<SseFrame> {
  const queued = shiftSseFrame(state);
  if (queued) return queued;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out waiting for MCP SSE response')), timeoutMs);
      }),
    ]);
    if (chunk.done) throw new Error('MCP SSE stream closed');
    state.buffer += decoder.decode(chunk.value, { stream: true });
    const frame = shiftSseFrame(state);
    if (frame) return frame;
    return readSseFrame(reader, decoder, state, timeoutMs);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForSseJsonRpc(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: SseState,
  id: number,
  timeoutMs: number,
): Promise<any> {
  for (;;) {
    const frame = await readSseFrame(reader, decoder, state, timeoutMs);
    if (!frame.data) continue;
    try {
      const parsed = JSON.parse(frame.data);
      if (parsed?.id === id) return parsed;
    } catch {
      // Ignore non-JSON keepalive/data frames.
    }
  }
}

async function waitForSseEndpoint(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: SseState,
  timeoutMs: number,
): Promise<string> {
  for (;;) {
    const frame = await readSseFrame(reader, decoder, state, timeoutMs);
    if (frame.event === 'endpoint' && frame.data) return frame.data;
  }
}

async function postSseJsonRpc(
  endpointUrl: string,
  auth: ExecutorAuth,
  secret: string | null,
  message: Record<string, unknown>,
): Promise<void> {
  const req = withAuth(
    endpointUrl,
    { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    auth,
    secret,
  );
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(message),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MCP SSE message POST failed (${res.status}): ${text || res.statusText}`);
  }
}

async function performMcpSseJsonRpc(opts: {
  url: string;
  auth?: ExecutorAuth;
  secret?: string | null;
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const auth = opts.auth ?? NO_AUTH;
  const secret = opts.secret ?? null;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    const sseReq = withAuth(opts.url, { Accept: 'text/event-stream' }, auth, secret);
    const sse = await fetch(sseReq.url, { method: 'GET', headers: sseReq.headers, signal: controller.signal });
    if (!sse.ok) {
      const text = await sse.text().catch(() => '');
      return { status: sse.status, ok: false, data: parseResponseBody(text) };
    }
    if (!sse.body) throw new Error('MCP SSE response had no body');

    reader = sse.body.getReader();
    const decoder = new TextDecoder();
    const state: SseState = { buffer: '' };
    const endpointPath = await waitForSseEndpoint(reader, decoder, state, timeoutMs);
    const endpointUrl = new URL(endpointPath, sseReq.url).href;

    await postSseJsonRpc(endpointUrl, auth, secret, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'kortix-executor', version: '1' },
      },
    });
    await waitForSseJsonRpc(reader, decoder, state, 1, timeoutMs);
    await postSseJsonRpc(endpointUrl, auth, secret, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });
    await postSseJsonRpc(endpointUrl, auth, secret, {
      jsonrpc: '2.0',
      id: 2,
      method: opts.method,
      params: opts.params ?? {},
    });
    const data = await waitForSseJsonRpc(reader, decoder, state, 2, timeoutMs);
    return { status: 200, ok: !data?.error, data };
  } catch (err) {
    const message = err instanceof Error && err.name === 'AbortError'
      ? 'MCP SSE request timed out'
      : (err as Error).message;
    return { status: 0, ok: false, data: message };
  } finally {
    if (timeout) clearTimeout(timeout);
    await reader?.cancel().catch(() => undefined);
    controller.abort();
  }
}

export async function performMcpJsonRpc(opts: {
  url: string;
  auth?: ExecutorAuth;
  secret?: string | null;
  method: string;
  params?: Record<string, unknown>;
  transport?: McpTransport | null;
  fetchImpl: FetchImpl;
}): Promise<ExecResult> {
  if ((opts.transport ?? 'http') === 'sse') {
    return performMcpSseJsonRpc(opts);
  }
  const req = buildMcpJsonRpcRequest({
    url: opts.url,
    auth: opts.auth,
    secret: opts.secret,
    method: opts.method,
    params: opts.params,
  });
  return performRequest(req, opts.fetchImpl);
}

/**
 * Top-level execute — dispatch by binding kind, build the request, perform it.
 * `secret` is the resolved plaintext credential (server-side only).
 */
export async function executeCall(opts: {
  binding: ActionBinding;
  baseUrl?: string | null;
  auth?: ExecutorAuth;
  secret?: string | null;
  args?: Record<string, unknown>;
  paramHints?: Record<string, ParamLoc>;
  mcpTransport?: McpTransport | null;
  fetchImpl: FetchImpl;
}): Promise<ExecResult> {
  const { binding } = opts;

  if (binding.kind === 'openapi') {
    const base = opts.baseUrl ?? binding.server;
    if (!base) throw new Error('openapi connector has no server/base URL');
    const req = buildHttpRequest({
      baseUrl: base,
      method: binding.method,
      pathTemplate: binding.path,
      auth: opts.auth,
      secret: opts.secret,
      args: opts.args,
      paramHints: opts.paramHints,
    });
    return performRequest(req, opts.fetchImpl);
  }

  if (binding.kind === 'http') {
    if (!opts.baseUrl) throw new Error('http connector has no base_url');
    const req = buildHttpRequest({
      baseUrl: opts.baseUrl,
      method: binding.method,
      pathTemplate: binding.path,
      auth: opts.auth,
      secret: opts.secret,
      args: opts.args,
      paramHints: opts.paramHints,
    });
    return performRequest(req, opts.fetchImpl);
  }

  if (binding.kind === 'mcp') {
    if (!opts.baseUrl) throw new Error('mcp connector has no url');
    return performMcpJsonRpc({
      url: opts.baseUrl,
      auth: opts.auth,
      secret: opts.secret,
      method: 'tools/call',
      params: { name: binding.tool, arguments: opts.args ?? {} },
      transport: opts.mcpTransport,
      fetchImpl: opts.fetchImpl,
    });
  }

  if (binding.kind === 'graphql') {
    if (!opts.baseUrl) throw new Error('graphql connector has no endpoint');
    const req = buildGraphqlRequest({
      endpoint: opts.baseUrl,
      operation: binding.operation,
      field: binding.field,
      auth: opts.auth,
      secret: opts.secret,
      args: opts.args,
    });
    return performRequest(req, opts.fetchImpl);
  }

  throw new Error(`execution for "${binding.kind}" connectors is not implemented yet`);
}

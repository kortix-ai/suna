/**
 * Execution layer — the gateway's "run the call" step. Given a connector's
 * binding + resolved secret + args, build and perform the outbound request to
 * the third party. Credentials are attached HERE (server-side); the sandbox
 * never sees them. Pure builders + an injectable `fetchImpl` keep it unit-tested.
 *
 * Covers openapi / http / mcp / graphql execution. Pipedream actions and the
 * Connect Proxy execute through the gateway's Pipedream adapter because
 * Pipedream injects the user's connected account server-side.
 */
import type { ActionBinding } from './types';

export interface ExecutorAuth {
  type: 'bearer' | 'basic' | 'custom' | 'none';
  in: 'header' | 'query';
  name: string | null;
  prefix: string | null;
}

type ParamLoc = 'path' | 'query' | 'header';

interface BuiltRequest {
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

/** Attach a credential to a request per the connector's auth method. */
function applyAuth(
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
function buildHttpRequest(opts: {
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
function buildGraphqlRequest(opts: {
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

/** Build a JSON-RPC `tools/call` request for an MCP (http transport) connector. */
function buildMcpRequest(opts: {
  url: string;
  auth?: ExecutorAuth;
  secret?: string | null;
  toolName: string;
  args?: Record<string, unknown>;
}): BuiltRequest {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const query = new URLSearchParams();
  applyAuth(headers, query, opts.auth ?? NO_AUTH, opts.secret ?? null);
  let url = opts.url;
  const qs = query.toString();
  if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: opts.toolName, arguments: opts.args ?? {} },
  });
  return { url, method: 'POST', headers, body };
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
async function performRequest(req: BuiltRequest, fetchImpl: FetchImpl): Promise<ExecResult> {
  const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
  const text = await res.text();
  return { status: res.status, ok: res.ok, data: parseResponseBody(text) };
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
    const req = buildMcpRequest({
      url: opts.baseUrl,
      auth: opts.auth,
      secret: opts.secret,
      toolName: binding.tool,
      args: opts.args,
    });
    return performRequest(req, opts.fetchImpl);
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

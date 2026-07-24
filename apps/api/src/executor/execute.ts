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
import { createHmac, randomBytes } from 'node:crypto';
import { sanitizeConnectorHeaders } from '@kortix/manifest-schema';
import type { ActionBinding } from './types';

export interface ExecutorAuth {
  type: 'bearer' | 'basic' | 'custom' | 'oauth1' | 'none';
  in: 'header' | 'query';
  name: string | null;
  prefix: string | null;
}

export type ParamLoc = 'path' | 'query' | 'header';

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

/**
 * Attach a credential to a request per the connector's auth method.
 * `oauth1` is not handled here — it needs the method + final URL + query to
 * sign, so buildHttpRequest applies it (manifest validation restricts oauth1
 * to openapi/http connectors, the only bindings that route through there).
 */
function applyAuth(
  headers: Record<string, string>,
  query: URLSearchParams,
  auth: ExecutorAuth,
  secret: string | null,
): void {
  if (auth.type === 'none' || auth.type === 'oauth1' || !secret) return;
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

/**
 * The header name the connector's credential OWNS, or null when the credential
 * doesn't land in a header (query placement, or no auth at all).
 *
 * Deliberately independent of whether a secret is actually resolved: the slot
 * belongs to the credential either way, so a connector's outbound headers don't
 * silently change shape depending on whether the credential happens to be set.
 */
function reservedAuthHeader(auth: ExecutorAuth): string | null {
  if (auth.type === 'none') return null;
  if (auth.type === 'custom') return auth.in === 'query' ? null : (auth.name ?? 'Authorization');
  // bearer / basic / oauth1 all sign into Authorization.
  return 'Authorization';
}

/**
 * Merge a connector's static `headers` (kortix.yaml) into the outbound request.
 *
 * Call this BEFORE the credential is attached — the credential must win:
 *   - any static header whose name matches the auth header (case-INsensitively,
 *     since HTTP header names are case-insensitive) is DROPPED, so a static
 *     header can neither spoof nor clobber the credential;
 *   - anything that fails the shared validation (illegal name, CR/LF or other
 *     control chars in the value, over-long, transport-owned) is dropped too —
 *     the parser/CRUD layer already rejects those loudly, this is the
 *     fail-safe backstop for a row that predates that validation.
 * A static header REPLACES a same-named default/arg-derived header (matching
 * case-insensitively, so the request can never carry two spellings of one
 * header): what the author typed is what goes on the wire, Postman-style.
 */
export function applyConnectorHeaders(
  headers: Record<string, string>,
  staticHeaders: Record<string, string> | null | undefined,
  auth: ExecutorAuth,
): void {
  const clean = sanitizeConnectorHeaders(staticHeaders);
  const reserved = reservedAuthHeader(auth)?.toLowerCase() ?? null;
  for (const [name, value] of Object.entries(clean)) {
    const lower = name.toLowerCase();
    if (reserved && lower === reserved) continue;
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === lower) delete headers[existing];
    }
    headers[name] = value;
  }
}

/* ─── OAuth 1.0a (RFC 5849) — HMAC-SHA1 request signing ─────────────────── */

/**
 * The oauth1 credential is ONE stored secret whose value is a JSON object with
 * all four values (same pack-into-one convention as basic's "user:pass"):
 * `{"consumer_key":"…","consumer_secret":"…","token":"…","token_secret":"…"}`.
 */
interface Oauth1Creds {
  consumer_key: string;
  consumer_secret: string;
  token: string;
  token_secret: string;
}

function parseOauth1Secret(secret: string | null): Oauth1Creds | null {
  if (!secret) return null;
  try {
    const o = JSON.parse(secret) as Record<string, unknown>;
    if (
      typeof o?.consumer_key === 'string' &&
      typeof o?.consumer_secret === 'string' &&
      typeof o?.token === 'string' &&
      typeof o?.token_secret === 'string'
    ) {
      return o as unknown as Oauth1Creds;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/** RFC 3986 percent-encoding — stricter than encodeURIComponent. */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Compute the OAuth 1.0a HMAC-SHA1 signature (RFC 5849 §3.4). Pure — exported
 * for unit tests against the spec's published test vector. `params` are the
 * decoded oauth_* + query pairs; JSON bodies are excluded per §3.4.1.3.1.
 */
export function oauth1Signature(opts: {
  method: string;
  /** Base string URI — scheme://host/path, no query. */
  url: string;
  params: Array<[string, string]>;
  consumerSecret: string;
  tokenSecret: string;
}): string {
  const normalized = opts.params
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = `${opts.method.toUpperCase()}&${rfc3986(opts.url)}&${rfc3986(normalized)}`;
  const key = `${rfc3986(opts.consumerSecret)}&${rfc3986(opts.tokenSecret)}`;
  return createHmac('sha1', key).update(base).digest('base64');
}

/** Build the `Authorization: OAuth …` header for a request. */
export function oauth1Header(opts: {
  method: string;
  /** Request URL without the query string. */
  url: string;
  query: URLSearchParams;
  creds: Oauth1Creds;
  /** Test seams — real calls omit these. */
  nonce?: string;
  timestamp?: string;
}): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: opts.creds.consumer_key,
    oauth_nonce: opts.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_token: opts.creds.token,
    oauth_version: '1.0',
  };
  const params: Array<[string, string]> = [
    ...Object.entries(oauth),
    ...[...opts.query.entries()],
  ];
  oauth.oauth_signature = oauth1Signature({
    method: opts.method,
    url: opts.url,
    params,
    consumerSecret: opts.creds.consumer_secret,
    tokenSecret: opts.creds.token_secret,
  });
  return `OAuth ${Object.keys(oauth)
    .sort()
    .map((k) => `${rfc3986(k)}="${rfc3986(oauth[k]!)}"`)
    .join(', ')}`;
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
  /** Connector-level static headers (kortix.yaml `headers:`). */
  headers?: Record<string, string> | null;
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

  const auth = opts.auth ?? NO_AUTH;
  // Static headers first — the credential is attached after and always wins.
  applyConnectorHeaders(headers, opts.headers, auth);
  if (auth.type === 'oauth1') {
    // Signed over method + URL + query (JSON bodies are excluded per RFC 5849
    // §3.4.1.3.1) — must run after the query is final, so not in applyAuth.
    const creds = parseOauth1Secret(opts.secret ?? null);
    if (!creds) {
      throw new Error(
        'oauth1 credential must be a JSON object {"consumer_key","consumer_secret","token","token_secret"}',
      );
    }
    headers['Authorization'] = oauth1Header({
      method: opts.method,
      url: joinUrl(opts.baseUrl, path),
      query,
      creds,
    });
  } else {
    applyAuth(headers, query, auth, opts.secret ?? null);
  }

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

function renderPostmanTemplate(
  template: string,
  args: Record<string, unknown>,
  encode: boolean,
): string {
  return template.replace(/{{\s*([^{}]+?)\s*}}/g, (_whole, rawName: string) => {
    const name = rawName.trim();
    const value = args[name];
    if (value === undefined || value === null) throw new Error(`missing Postman variable "${name}"`);
    const rendered = String(value);
    return encode ? encodeURIComponent(rendered) : rendered;
  });
}

function setDefaultHeader(headers: Record<string, string>, name: string, value: string): void {
  if (!Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase())) headers[name] = value;
}

function buildPostmanRequest(opts: {
  binding: Extract<ActionBinding, { kind: 'postman' }>;
  auth?: ExecutorAuth;
  /** Connector-level static headers (kortix.yaml `headers:`). */
  headers?: Record<string, string> | null;
  secret?: string | null;
  args?: Record<string, unknown>;
}): BuiltRequest {
  const args = opts.args ?? {};
  const url = new URL(renderPostmanTemplate(opts.binding.url, args, true));
  const headers = Object.fromEntries(
    Object.entries(opts.binding.headers).map(([key, value]) => [key, renderPostmanTemplate(value, args, false)]),
  );
  const auth = opts.auth ?? NO_AUTH;
  // Static headers override the collection's own headers, but never the auth one.
  applyConnectorHeaders(headers, opts.headers, auth);
  if (auth.type === 'oauth1') {
    const creds = parseOauth1Secret(opts.secret ?? null);
    if (!creds) {
      throw new Error(
        'oauth1 credential must be a JSON object {"consumer_key","consumer_secret","token","token_secret"}',
      );
    }
    headers.Authorization = oauth1Header({
      method: opts.binding.method,
      url: `${url.protocol}//${url.host}${url.pathname}`,
      query: url.searchParams,
      creds,
    });
  } else {
    applyAuth(headers, url.searchParams, auth, opts.secret ?? null);
  }

  let body: string | undefined;
  if (opts.binding.bodyMode === 'json' && args.body !== undefined) {
    setDefaultHeader(headers, 'Content-Type', 'application/json');
    body = JSON.stringify(args.body);
  } else if (opts.binding.bodyMode === 'raw' && args.body !== undefined) {
    body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
  } else if (opts.binding.bodyMode === 'urlencoded' && args.body && typeof args.body === 'object') {
    setDefaultHeader(headers, 'Content-Type', 'application/x-www-form-urlencoded');
    const encoded = new URLSearchParams();
    for (const [key, value] of Object.entries(args.body as Record<string, unknown>)) appendQuery(encoded, key, value);
    body = encoded.toString();
  }
  return { url: url.href, method: opts.binding.method.toUpperCase(), headers, body };
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
  /** Connector-level static headers (kortix.yaml `headers:`). */
  headers?: Record<string, string> | null;
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
  const auth = opts.auth ?? NO_AUTH;
  applyConnectorHeaders(headers, opts.headers, auth);
  applyAuth(headers, search, auth, opts.secret ?? null);
  let url = opts.endpoint;
  const qs = search.toString();
  if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  return { url, method: 'POST', headers, body: JSON.stringify({ query }) };
}

/** Build a JSON-RPC `tools/call` request for an MCP (http transport) connector. */
function buildMcpRequest(opts: {
  url: string;
  auth?: ExecutorAuth;
  /** Connector-level static headers (kortix.yaml `headers:`). */
  headers?: Record<string, string> | null;
  secret?: string | null;
  toolName: string;
  args?: Record<string, unknown>;
}): BuiltRequest {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const query = new URLSearchParams();
  const auth = opts.auth ?? NO_AUTH;
  applyConnectorHeaders(headers, opts.headers, auth);
  applyAuth(headers, query, auth, opts.secret ?? null);
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
  /**
   * The connector's static `headers:` table (kortix.yaml) — sent on every
   * request this connector makes. Merged in BEFORE the credential, so the auth
   * header always wins on a (case-insensitive) name collision.
   */
  headers?: Record<string, string> | null;
  secret?: string | null;
  args?: Record<string, unknown>;
  paramHints?: Record<string, ParamLoc>;
  fetchImpl: FetchImpl;
}): Promise<ExecResult> {
  const { binding } = opts;

  if (binding.kind === 'postman') {
    return performRequest(buildPostmanRequest({
      binding,
      auth: opts.auth,
      headers: opts.headers,
      secret: opts.secret,
      args: opts.args,
    }), opts.fetchImpl);
  }

  if (binding.kind === 'openapi') {
    const base = opts.baseUrl ?? binding.server;
    if (!base) throw new Error('openapi connector has no server/base URL');
    const req = buildHttpRequest({
      baseUrl: base,
      method: binding.method,
      pathTemplate: binding.path,
      auth: opts.auth,
      headers: opts.headers,
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
      headers: opts.headers,
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
      headers: opts.headers,
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
      headers: opts.headers,
      secret: opts.secret,
      args: opts.args,
    });
    return performRequest(req, opts.fetchImpl);
  }

  throw new Error(`execution for "${binding.kind}" connectors is not implemented yet`);
}

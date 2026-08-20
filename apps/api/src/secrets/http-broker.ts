import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import type {
  SecretBrokerRequest,
  SecretBrokerResponse,
} from '@kortix/api-contract';
import type { SecretEgressPolicy, SecretInjectionSlot } from '@kortix/db';
import { isPrivateIp } from '../shared/ssrf-guard';
import { matchRule } from './strategy';

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 5_242_880;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const REDACTED = Buffer.from('[REDACTED]');

// FRAMING / hop-by-hop headers only. These are rejected with a 400 because the
// broker manages them itself (it sets `host` and `content-length`, forces
// `accept-encoding: identity`) or because they describe THIS connection, not the
// upstream one (`connection`, `keep-alive`, `te`, `trailer`, `transfer-encoding`,
// `upgrade`, `proxy-*`). A caller must not set them.
//
// `authorization` and `cookie` are DELIBERATELY NOT here. They are the two
// credential-carrying request headers, and the whole substitution feature exists
// so an agent can put a HANDLE where it would put the real credential — i.e.
// `Authorization: Bearer <handle>`, the single most common auth pattern. The
// substitution pass below replaces the handle with the real value inside these
// headers; blocking them (as the pre-substitution broker did, 59c1f74bf8) left
// the new substitution-only default with no working path to Bearer/token/cookie
// auth. A legacy `inject` slot that names one of them still overwrites it, so the
// old broker behaviour is unchanged. The shim keeps an identical copy of this
// set (`blocked-headers.test.ts` pins the two together).
const BLOCKED_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const SAFE_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-language',
  'content-type',
  'etag',
  'last-modified',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-request-id',
]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type SecretBrokerErrorCode =
  | 'invalid_request'
  | 'policy_denied'
  | 'unsafe_destination'
  | 'upstream_failed'
  | 'upstream_timeout'
  | 'response_too_large';

export class SecretBrokerError extends Error {
  constructor(
    readonly code: SecretBrokerErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SecretBrokerError';
  }
}

export interface PreparedBrokerRequest {
  url: URL;
  method: SecretBrokerRequest['method'];
  headers: Record<string, string>;
  body: Buffer | null;
  /** Identifiers whose handle was found and replaced on THIS hop. Audit reads
   *  it, and the response redactor uses it to decide whose value to scrub. */
  substituted: string[];
  /** True when this prepared request puts a REAL secret value on the wire —
   *  either a handle substitution fired, or the route's own inject slot placed
   *  the decrypted secret in the request. A redirect returned after this must
   *  NOT be followed: the credential is already delivered, and the upstream can
   *  reflect it (or bytes derived from it) into a `Location` pointing at an
   *  off-policy host that the substituted secret's own policy never gated. */
  carriesSecret: boolean;
}

export interface BrokerTransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type BrokerTransport = (
  request: PreparedBrokerRequest,
) => Promise<BrokerTransportResponse>;

function decodeBody(value: string | undefined): Buffer | null {
  if (value === undefined) return null;
  if (!BASE64.test(value)) {
    throw new SecretBrokerError('invalid_request', 'body_base64 is invalid', 400);
  }
  const body = Buffer.from(value, 'base64');
  if (body.byteLength > MAX_REQUEST_BYTES) {
    throw new SecretBrokerError('invalid_request', 'request body exceeds 1 MiB', 413);
  }
  return body;
}

function sanitizeHeaders(input: Record<string, string> | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input ?? {})) {
    const name = rawName.trim().toLowerCase();
    if (!HEADER_NAME.test(name)) {
      throw new SecretBrokerError('invalid_request', `invalid request header: ${rawName}`, 400);
    }
    if (BLOCKED_REQUEST_HEADERS.has(name)) {
      throw new SecretBrokerError('invalid_request', `request header is managed by Kortix: ${name}`, 400);
    }
    // Drop any caller-supplied accept-encoding. The broker forces `identity` on
    // its own upstream leg (below), so the response body reaches
    // `redactSecretFromResponse` as raw bytes and a compressed echo cannot slip
    // the secret past the scrub. Blocking it with a 400 would break the shim,
    // which always sends `accept-encoding: identity`, and every already-deployed
    // daemon with it.
    if (name === 'accept-encoding') continue;
    if (value.includes('\r') || value.includes('\n')) {
      throw new SecretBrokerError('invalid_request', `invalid request header value: ${name}`, 400);
    }
    headers[name] = value;
  }
  return headers;
}

function injectedValue(slot: SecretInjectionSlot, secret: string): string {
  if (slot.kind !== 'header') return secret;
  const value = slot.template === undefined ? secret : slot.template.replaceAll('{{secret}}', secret);
  if (value.includes('\r') || value.includes('\n')) {
    throw new SecretBrokerError('invalid_request', 'managed header value is invalid', 400);
  }
  if (slot.template === undefined) return value;
  if (!slot.template.includes('{{secret}}')) {
    throw new SecretBrokerError(
      'invalid_request',
      'header injection template must contain {{secret}}',
      400,
    );
  }
  return value;
}

function injectJsonBody(body: Buffer | null, path: string, secret: string): Buffer {
  const segments = path.split('.');
  if (
    segments.length === 0 ||
    segments.length > 16 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '__proto__' ||
        segment === 'prototype' ||
        segment === 'constructor',
    )
  ) {
    throw new SecretBrokerError('invalid_request', 'invalid JSON injection path', 400);
  }

  let parsed: unknown = {};
  if (body && body.byteLength > 0) {
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new SecretBrokerError('invalid_request', 'JSON body injection requires valid JSON', 400);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SecretBrokerError('invalid_request', 'JSON body injection requires an object', 400);
  }

  let cursor = parsed as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (next === undefined) {
      cursor[segment] = {};
    } else if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new SecretBrokerError('invalid_request', 'JSON injection path is not an object', 400);
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = secret;

  const result = Buffer.from(JSON.stringify(parsed));
  if (result.byteLength > MAX_REQUEST_BYTES) {
    throw new SecretBrokerError('invalid_request', 'request body exceeds 1 MiB after injection', 413);
  }
  return result;
}

// ── Representations ─────────────────────────────────────────────────────────

/**
 * The four ways one string can appear in an HTTP request or response.
 *
 * ONE list, used in both directions: `redactSecretFromResponse` scans for these
 * representations of a SECRET and writes `[REDACTED]`; `substituteBuffer` scans
 * for these representations of a HANDLE and writes the same representation of
 * the secret. Substitution is the exact dual of redaction, so a representation
 * either path can miss is a representation the other misses too — which is the
 * only way the two can stay honest about each other.
 */
export type SecretEncoding = 'raw' | 'url' | 'base64' | 'json';

const SECRET_ENCODERS: Record<SecretEncoding, (value: string) => string> = {
  raw: (value) => value,
  url: (value) => encodeURIComponent(value),
  base64: (value) => Buffer.from(value).toString('base64'),
  // `JSON.stringify` quotes; the slice drops the quotes and keeps the escapes.
  json: (value) => JSON.stringify(value).slice(1, -1),
};

const SECRET_ENCODINGS: readonly SecretEncoding[] = ['raw', 'url', 'base64', 'json'];

export function encodeSecretRepresentation(value: string, encoding: SecretEncoding): string {
  return SECRET_ENCODERS[encoding](value);
}

/**
 * Every DISTINCT representation of `value`, most-preferred encoding first.
 *
 * Handles are `[A-Za-z0-9_-]`-safe by construction (`mintHandle`), so `raw`,
 * `url` and `json` usually collapse to the same bytes. That collapse is exactly
 * where the request stops carrying information: an occurrence tells us nothing
 * about which encoding the caller MEANT, and the answer decides what we write
 * back — a raw value in a URL query, or a percent-encoded one. `primary`
 * resolves it per surface (the caller knows whether it is holding a header, a
 * query string or a JSON body); ties go to the first listed.
 */
export function secretRepresentations(
  value: string,
  primary: SecretEncoding = 'raw',
): Array<{ encoding: SecretEncoding; text: string }> {
  const order = [primary, ...SECRET_ENCODINGS.filter((encoding) => encoding !== primary)];
  const seen = new Set<string>();
  const out: Array<{ encoding: SecretEncoding; text: string }> = [];
  for (const encoding of order) {
    const text = SECRET_ENCODERS[encoding](value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ encoding, text });
  }
  return out;
}

/** One secret this session may spend on this request, and the handle that
 *  stands in for it inside the sandbox. `policy` is the FROZEN snapshot the
 *  handle was minted against — re-matched per redirect hop, never trusted from
 *  the hop that started the relay. */
export interface SecretSubstitution {
  identifier: string;
  handle: string;
  value: string;
  policy: SecretEgressPolicy;
}

/**
 * Replace every representation of every handle with the SAME representation of
 * its secret. `applied` collects the identifiers that actually matched, for the
 * audit record and for response redaction.
 */
function substituteBuffer(
  source: Buffer,
  substitutions: readonly SecretSubstitution[],
  primary: SecretEncoding,
  applied: Set<string>,
): Buffer {
  let result = source;
  for (const substitution of substitutions) {
    for (const { encoding, text } of secretRepresentations(substitution.handle, primary)) {
      const next = replaceBuffer(
        result,
        Buffer.from(text),
        Buffer.from(encodeSecretRepresentation(substitution.value, encoding)),
      );
      if (next !== result) applied.add(substitution.identifier);
      result = next;
    }
  }
  return result;
}

function substituteString(
  value: string,
  substitutions: readonly SecretSubstitution[],
  primary: SecretEncoding,
  applied: Set<string>,
): string {
  return substituteBuffer(Buffer.from(value), substitutions, primary, applied).toString('utf8');
}

/** Which encoding a body's own content type says its bytes are written in. */
function bodyEncoding(contentType: string | undefined): SecretEncoding {
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'application/json' || type.endsWith('+json')) return 'json';
  if (type === 'application/x-www-form-urlencoded') return 'url';
  return 'raw';
}

/**
 * A compressed request body does not contain the handle's bytes, so the scan
 * would find nothing and the guest's request would leave carrying the literal
 * handle. The shim already forces `accept-encoding: identity` on the response
 * side for the mirror-image reason (an echoed secret cannot be redacted out of
 * gzip); this asserts the request side rather than failing silently.
 */
function assertIdentityRequestBody(headers: Record<string, string>): void {
  const encoding = headers['content-encoding']?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    throw new SecretBrokerError(
      'invalid_request',
      'request bodies must use identity content-encoding',
      400,
    );
  }
}

// Control characters and spaces cannot appear in a request target. A secret
// whose bytes would break the request line is refused rather than sent
// half-encoded into a header or path the upstream reads as two requests.
const UNSAFE_TARGET = /[\s\u0000-\u001f\u007f]/;

export function prepareSecretBrokerRequest(
  policy: SecretEgressPolicy,
  secret: string,
  input: SecretBrokerRequest,
  substitutions: readonly SecretSubstitution[] = [],
): PreparedBrokerRequest {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new SecretBrokerError('invalid_request', 'url is invalid', 400);
  }
  if (url.protocol !== 'https:') {
    throw new SecretBrokerError('unsafe_destination', 'url must use HTTPS', 400);
  }
  if (url.username || url.password) {
    throw new SecretBrokerError('unsafe_destination', 'url must not contain credentials', 400);
  }
  // `matchRule` sees only {host, method, path} — never the port — so a policy
  // that approves `api.example.com` would otherwise let the value reach
  // `https://api.example.com:8443/`. Pin egress to the standard HTTPS port.
  // `new URL` normalizes an explicit :443 to an empty port, so empty === 443.
  if (url.port && url.port !== '443') {
    throw new SecretBrokerError('unsafe_destination', 'egress is https/443 only', 400);
  }

  const method = input.method ?? 'GET';
  const rule = matchRule(policy, { host: url.hostname, method, path: url.pathname });
  if (!rule) {
    throw new SecretBrokerError('policy_denied', 'outbound request does not match the secret policy', 403);
  }

  let body = decodeBody(input.body_base64);
  if ((method === 'GET' || method === 'HEAD') && body && body.byteLength > 0) {
    throw new SecretBrokerError('invalid_request', `${method} requests cannot contain a body`, 400);
  }
  const headers = sanitizeHeaders(input.headers);
  // Force an uncompressed upstream response so echo redaction scans real bytes.
  headers['accept-encoding'] = 'identity';

  // ── Substitution ──────────────────────────────────────────────────────────
  //
  // Admission is re-evaluated HERE, per hop, against this hop's destination:
  // `executeSecretBrokerRequest` re-enters this function for every redirect,
  // and a secret whose policy admits the original host must not ride along to
  // wherever that host points next.
  const admitted = substitutions.filter(
    (substitution) =>
      matchRule(substitution.policy, { host: url.hostname, method, path: url.pathname }) !== null,
  );
  const applied = new Set<string>();
  if (admitted.length > 0) {
    assertIdentityRequestBody(headers);
    for (const [name, value] of Object.entries(headers)) {
      const substituted = substituteString(value, admitted, 'raw', applied);
      if (substituted === value) continue;
      if (substituted.includes('\r') || substituted.includes('\n')) {
        throw new SecretBrokerError(
          'invalid_request',
          `substituted header value is invalid: ${name}`,
          400,
        );
      }
      headers[name] = substituted;
    }

    const pathname = substituteString(url.pathname, admitted, 'url', applied);
    const search = substituteString(url.search, admitted, 'url', applied);
    if (pathname !== url.pathname) url.pathname = pathname;
    if (search !== url.search) url.search = search;
    if (UNSAFE_TARGET.test(`${url.pathname}${url.search}`)) {
      throw new SecretBrokerError('invalid_request', 'substituted request target is invalid', 400);
    }

    if (body && body.byteLength > 0) {
      body = substituteBuffer(body, admitted, bodyEncoding(headers['content-type']), applied);
      if (body.byteLength > MAX_REQUEST_BYTES) {
        throw new SecretBrokerError(
          'invalid_request',
          'request body exceeds 1 MiB after substitution',
          413,
        );
      }
    }

    // Substitution can only rewrite bytes where a handle sat, but a handle in
    // the path means those bytes are part of the request target. Re-match so
    // the path actually sent is the path the policy admitted.
    if (!matchRule(policy, { host: url.hostname, method, path: url.pathname })) {
      throw new SecretBrokerError(
        'policy_denied',
        'outbound request does not match the secret policy',
        403,
      );
    }
  }

  // ── Legacy injection ──────────────────────────────────────────────────────
  //
  // A stored policy that carries an `inject` slot still injects exactly as it
  // did before substitution existed. A substitution-only row (the new default,
  // §6 of the exposure model) carries no slot and is served purely by the block
  // above — there is nothing to inject and nothing to name.
  const slot = rule.inject ?? policy.inject;
  const injectedRouteSecret = slot != null;
  if (slot) {
    if (slot.kind === 'header') {
      const name = slot.name.trim().toLowerCase();
      if (!HEADER_NAME.test(name) || name === 'host' || name === 'content-length') {
        throw new SecretBrokerError('invalid_request', 'invalid managed header name', 400);
      }
      headers[name] = injectedValue(slot, secret);
    } else if (slot.kind === 'query') {
      url.searchParams.set(slot.name, secret);
    } else {
      body = injectJsonBody(body, slot.path, secret);
      headers['content-type'] = 'application/json';
    }
  }
  if (body) headers['content-length'] = String(body.byteLength);

  return {
    url,
    method,
    headers,
    body,
    substituted: [...applied],
    carriesSecret: applied.size > 0 || injectedRouteSecret,
  };
}

async function resolvePinnedAddress(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  if (isIP(url.hostname) !== 0) {
    if (isPrivateIp(url.hostname)) {
      throw new SecretBrokerError('unsafe_destination', 'destination IP is private or reserved', 403);
    }
    return { address: url.hostname, family: isIP(url.hostname) as 4 | 6 };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new SecretBrokerError('unsafe_destination', 'destination DNS lookup failed', 502);
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new SecretBrokerError(
      'unsafe_destination',
      'destination resolves to a private or reserved address',
      403,
    );
  }
  const selected = addresses[0];
  return { address: selected.address, family: selected.family === 6 ? 6 : 4 };
}

export function createPinnedRequestOptions(
  prepared: PreparedBrokerRequest,
  pinned: { address: string; family: 4 | 6 },
): RequestOptions {
  return {
    protocol: 'https:',
    hostname: pinned.address,
    family: pinned.family,
    port: prepared.url.port || 443,
    path: `${prepared.url.pathname}${prepared.url.search}`,
    method: prepared.method,
    headers: {
      ...prepared.headers,
      host: prepared.url.host,
    },
    servername: isIP(prepared.url.hostname) === 0 ? prepared.url.hostname : undefined,
  };
}

export async function pinnedHttpsTransport(
  prepared: PreparedBrokerRequest,
): Promise<BrokerTransportResponse> {
  const pinned = await resolvePinnedAddress(prepared.url);
  return await new Promise<BrokerTransportResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = httpsRequest(
      createPinnedRequestOptions(prepared, pinned),
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy();
            fail(
              new SecretBrokerError(
                'response_too_large',
                'upstream response exceeds 5 MiB',
                502,
              ),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          const headers: Record<string, string | string[] | undefined> = {};
          for (const [name, value] of Object.entries(response.headers)) headers[name] = value;
          resolve({
            status: response.statusCode ?? 502,
            headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', fail);
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy();
      fail(new SecretBrokerError('upstream_timeout', 'upstream request timed out', 504));
    });
    request.on('error', (error) => {
      fail(
        error instanceof SecretBrokerError
          ? error
          : new SecretBrokerError('upstream_failed', 'upstream request failed', 502),
      );
    });
    if (prepared.body) request.write(prepared.body);
    request.end();
  });
}

/** Every occurrence of `needle` replaced by `replacement`. Returns the SAME
 *  buffer object when nothing matched, which is how callers detect a hit
 *  without a second scan. */
function replaceBuffer(source: Buffer, needle: Buffer, replacement: Buffer): Buffer {
  if (needle.byteLength === 0) return source;
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (;;) {
    const index = source.indexOf(needle, cursor);
    if (index === -1) break;
    chunks.push(source.subarray(cursor, index), replacement);
    cursor = index + needle.byteLength;
  }
  if (cursor === 0) return source;
  chunks.push(source.subarray(cursor));
  return Buffer.concat(chunks);
}

export function redactSecretFromResponse(body: Buffer, secret: string): Buffer {
  let result = body;
  for (const { text } of secretRepresentations(secret)) {
    result = replaceBuffer(result, Buffer.from(text), REDACTED);
  }
  return result;
}

function responseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!SAFE_RESPONSE_HEADERS.has(normalized) || value === undefined) continue;
    safe[normalized] = Array.isArray(value) ? value.join(', ') : value;
  }
  return safe;
}

function redirectedInput(
  input: SecretBrokerRequest,
  location: string,
  status: number,
): SecretBrokerRequest {
  const nextUrl = new URL(location, input.url).href;
  if (status === 303 || ((status === 301 || status === 302) && input.method === 'POST')) {
    return { url: nextUrl, method: 'GET', headers: input.headers };
  }
  return { ...input, url: nextUrl };
}

export interface SecretBrokerExecuteOptions {
  transport?: BrokerTransport;
  /** Other secrets this session may spend on this destination, keyed to the
   *  handle that stands in for each of them inside the sandbox. */
  substitutions?: readonly SecretSubstitution[];
  /** Filled with the identifiers actually substituted, for the audit record.
   *  An out-param rather than a return field because the return type is the
   *  wire contract (`SecretBrokerResponse`) and audit is not part of it. */
  applied?: Set<string>;
}

export async function executeSecretBrokerRequest(
  policy: SecretEgressPolicy,
  secret: string,
  input: SecretBrokerRequest,
  options: SecretBrokerExecuteOptions = {},
): Promise<SecretBrokerResponse> {
  const transport = options.transport ?? pinnedHttpsTransport;
  const substitutions = options.substitutions ?? [];
  const applied = options.applied ?? new Set<string>();
  let current = input;
  for (let redirects = 0; ; redirects += 1) {
    const prepared = prepareSecretBrokerRequest(policy, secret, current, substitutions);
    for (const identifier of prepared.substituted) applied.add(identifier);
    const upstream = await transport(prepared);
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      // A redirect only matters BEFORE any real credential is on the wire. Once
      // this hop has carried a secret (a substitution fired, or the route's own
      // secret was injected) the value is already delivered, and following the
      // `Location` would carry the substituted bytes — or a value the upstream
      // reflected into `Location` — to a host re-gated only by the ROUTE
      // secret's policy, never by the substituted secret's own. Fail closed.
      if (prepared.carriesSecret) {
        throw new SecretBrokerError(
          'upstream_failed',
          'redirect after secret substitution is not followed',
          502,
        );
      }
      const rawLocation = upstream.headers.location;
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      if (!location) {
        throw new SecretBrokerError('upstream_failed', 'upstream redirect has no location', 502);
      }
      if (redirects >= MAX_REDIRECTS) {
        throw new SecretBrokerError('upstream_failed', 'upstream redirect limit exceeded', 502);
      }
      current = redirectedInput(current, location, upstream.status);
      continue;
    }
    // Redact the injected secret AND every secret substituted into the
    // request. A handle the guest sent is a secret the upstream can echo, so
    // an echo guard that only knew about the route's own identifier would hand
    // the other values straight back.
    // Every secret that could appear in this response: the route's own injected
    // secret, plus every substituted value that actually rode out on the wire.
    const secretsToRedact = [
      secret,
      ...substitutions
        .filter((substitution) => applied.has(substitution.identifier))
        .map((substitution) => substitution.value),
    ];

    let body = upstream.body;
    for (const value of secretsToRedact) {
      body = redactSecretFromResponse(body, value);
    }

    // The whitelisted response headers travel back verbatim, so an upstream can
    // reflect a substituted value into `content-type`, `etag`, `x-request-id`,
    // etc. Run each header value through the SAME redaction as the body — the
    // body alone is not the only exit.
    const headers = responseHeaders(upstream.headers);
    for (const [name, headerValue] of Object.entries(headers)) {
      let redacted: Buffer = Buffer.from(headerValue);
      for (const value of secretsToRedact) {
        redacted = redactSecretFromResponse(redacted, value);
      }
      headers[name] = redacted.toString('utf8');
    }

    return {
      status: upstream.status,
      headers,
      body_base64: body.toString('base64'),
    };
  }
}

// The request gate: body/header validation, plus every head-side security check
// (`prepareRelayHead`) that both the buffered and the streaming transport share.
import { BLOCKED_REQUEST_HEADERS } from '@kortix/api-contract/secret-relay';
import type { SecretBrokerRequest } from '@kortix/api-contract';
import type { SecretEgressPolicy, SecretInjectionSlot } from '@kortix/db';
import { matchRule } from '../strategy';
import { BASE64, HEADER_NAME, MAX_REQUEST_BYTES, SecretBrokerError } from './errors';
import {
  assertIdentityRequestBody,
  bodyEncoding,
  substituteBuffer,
  substituteString,
  type SecretSubstitution,
} from './substitution';

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

// Control characters and spaces cannot appear in a request target. A secret
// whose bytes would break the request line is refused rather than sent
// half-encoded into a header or path the upstream reads as two requests.
const UNSAFE_TARGET = /[\s\u0000-\u001f\u007f]/;

/** The non-body half of an outbound request, as BOTH transports supply it. */
interface RelayHeadInput {
  url: string;
  method: SecretBrokerRequest['method'];
  /** Ordered `[name, value]` pairs, duplicates allowed — see `foldHeaders`. */
  headers: Array<[string, string]>;
}

export interface PreparedRelayHead {
  url: URL;
  method: NonNullable<SecretBrokerRequest['method']>;
  headers: Record<string, string>;
  /**
   * The substitutions admitted on THIS hop's destination. The caller feeds
   * exactly these — never the full set — to the body substituter, so a handle
   * the policy does not admit here stays the worthless self-describing string
   * it is.
   */
  admitted: SecretSubstitution[];
  /** Live and MUTABLE: the caller adds body-side hits before reading it. */
  applied: Set<string>;
  /** True when the route's own `inject` slot placed the decrypted secret. */
  injectedRouteSecret: boolean;
  /**
   * A legacy `json` body-injection slot, NOT yet applied — the head does not
   * own the body. The streaming transport refuses it rather than buffering an
   * unbounded body to satisfy it.
   */
  bodyInject: { path: string } | null;
  /** Head-side snapshot. Recompute after body substitution. */
  substituted: string[];
  /** Head-side snapshot. Recompute after body substitution. */
  carriesSecret: boolean;
}

/**
 * Fold an ordered header list into the `Record<string,string>` both the node
 * transport and the legacy code path want.
 *
 * Duplicates are JOINED, not dropped: RFC 7230 §3.2.2 makes a repeated field
 * equivalent to one comma-joined field, and `cookie` is the documented
 * exception that joins with `"; "` (RFC 6265 §5.4). Taking the last value —
 * which is what Bun's own parser does, and the reason the meta ships an ordered
 * array in the first place — would silently discard a header the guest sent.
 */
function foldHeaders(pairs: readonly [string, string][]): Record<string, string> {
  const folded: Record<string, string> = {};
  for (const [rawName, value] of pairs) {
    const name = rawName.trim().toLowerCase();
    const existing = folded[name];
    folded[name] = existing === undefined ? value : `${existing}${name === 'cookie' ? '; ' : ', '}${value}`;
  }
  return folded;
}

/**
 * Re-match the policy against the path that will ACTUALLY be sent.
 *
 * Substitution only rewrites bytes where a handle sat, but a handle in the path
 * means those bytes are part of the request target — so the admitted path and
 * the sent path can differ. Exported and called by both transports at the same
 * point in their own sequence, rather than folded into `prepareRelayHead`, so
 * neither path's error PRECEDENCE moves: the legacy route still reports its
 * `413 body exceeds 1 MiB after substitution` before this 403, exactly as it
 * does today.
 */
export function assertPolicyAdmitsPath(
  policy: SecretEgressPolicy,
  url: URL,
  method: NonNullable<SecretBrokerRequest['method']>,
): void {
  if (!matchRule(policy, { host: url.hostname, method, path: url.pathname })) {
    throw new SecretBrokerError(
      'policy_denied',
      'outbound request does not match the secret policy',
      403,
    );
  }
}

/**
 * Every head-side security check, for BOTH transports.
 *
 * The url, the method and the headers are never streamed — the legacy route
 * gets them in its JSON envelope and the streaming route gets them whole in
 * `x-kortix-relay-meta`. Only the BODY streams. So the entire policy gate lives
 * here, in one implementation, called from both: https-only, no userinfo, port
 * pinned to empty-or-443, `matchRule`, header sanitation, forced
 * `accept-encoding: identity`, the per-hop `admitted` re-filter, header
 * substitution with its CRLF re-check, path/query substitution, the
 * unsafe-target check, and the legacy `inject` slot.
 *
 * Duplicating any of it per transport is exactly how the accept-encoding
 * two-list divergence incident happened. That class of bug is not acceptable on
 * the policy gate, so there is one function and no second copy.
 */
export function prepareRelayHead(
  policy: SecretEgressPolicy,
  secret: string,
  input: RelayHeadInput,
  substitutions: readonly SecretSubstitution[] = [],
): PreparedRelayHead {
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

  const headers = sanitizeHeaders(foldHeaders(input.headers));
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
  }

  // ── Legacy injection ──────────────────────────────────────────────────────
  //
  // A stored policy that carries an `inject` slot still injects exactly as it
  // did before substitution existed. A substitution-only row (the new default,
  // §6 of the exposure model) carries no slot and is served purely by the block
  // above — there is nothing to inject and nothing to name.
  const slot = rule.inject ?? policy.inject;
  let bodyInject: { path: string } | null = null;
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
      bodyInject = { path: slot.path };
    }
  }

  return {
    url,
    method,
    headers,
    admitted,
    applied,
    injectedRouteSecret: slot != null,
    bodyInject,
    substituted: [...applied],
    carriesSecret: applied.size > 0 || slot != null,
  };
}

export function prepareSecretBrokerRequest(
  policy: SecretEgressPolicy,
  secret: string,
  input: SecretBrokerRequest,
  substitutions: readonly SecretSubstitution[] = [],
): PreparedBrokerRequest {
  // ORDER MATTERS, and it is the LEGACY order on purpose.
  //
  // `/broker` is frozen: a daemon baked into a sandbox image months ago still
  // branches on its codes. Before the head/body split, `decodeBody` (base64
  // validation + the 1 MiB 413) and the GET/HEAD-body check ran BEFORE
  // `sanitizeHeaders`. Running the head first silently changed the answer for a
  // request that is wrong in two ways at once — e.g. a 2 MiB body plus a
  // blocked `host` header went from `413 request body exceeds 1 MiB` to
  // `400 request header is managed by Kortix: host`. Keep the old precedence.
  let body = decodeBody(input.body_base64);
  if ((input.method === 'GET' || input.method === 'HEAD') && body && body.byteLength > 0) {
    throw new SecretBrokerError(
      'invalid_request',
      `${input.method} requests cannot contain a body`,
      400,
    );
  }

  // The url/method/header half is the SHARED gate — see `prepareRelayHead`.
  // Everything below is body handling, which is the only part the two
  // transports genuinely do differently.
  const head = prepareRelayHead(
    policy,
    secret,
    { url: input.url, method: input.method, headers: Object.entries(input.headers ?? {}) },
    substitutions,
  );
  const { url, method, headers, admitted, applied } = head;

  if (admitted.length > 0) {
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
    assertPolicyAdmitsPath(policy, url, method);
  }

  if (head.bodyInject) {
    body = injectJsonBody(body, head.bodyInject.path, secret);
    headers['content-type'] = 'application/json';
  }
  if (body) headers['content-length'] = String(body.byteLength);

  return {
    url,
    method,
    headers,
    body,
    substituted: [...applied],
    carriesSecret: applied.size > 0 || head.injectedRouteSecret,
  };
}

/**
 * The streaming secret-relay WIRE CONTRACT — one module, imported by BOTH the
 * API (`apps/api/src/projects/routes/secret-relay.ts`) and the in-guest daemon
 * (`apps/kortix-sandbox-agent-server/src/egress-shim/relay-client.ts`).
 *
 * ## Why the metadata is a header and not a body
 *
 * The relay's request body IS the guest's request body, verbatim — no base64,
 * no JSON envelope. That is the entire point: a JSON-RPC envelope forces both
 * ends to buffer, which is where the legacy `/broker` route's 1 MiB request and
 * 5 MiB response caps come from. So everything that is NOT body bytes — url,
 * method, headers — travels in `x-kortix-relay-meta`, base64url-encoded JSON.
 *
 * ## Why headers are an ORDERED ARRAY of pairs and not an object
 *
 * Measured on bun 1.3.14: Bun's HTTP header parser silently collapses duplicate
 * headers outside its known-header table to the LAST value. `X-Dup: one` +
 * `X-Dup: two` arrives as `two`; the same happens to `x-forwarded-for`,
 * `forwarded`, `warning`, `x-request-id` and every custom `X-*`. Bun has no
 * `rawHeaders`, and `Headers.getAll()` throws for anything but `set-cookie`. So
 * the API CANNOT reconstruct the guest's header list from the wire, and the shim
 * has to ship it as one opaque field. An object would lose duplicates all over
 * again.
 *
 * ## Why this file has zero dependencies
 *
 * It is a subpath export (`@kortix/api-contract/secret-relay`) with no zod and
 * no node-only API beyond `Buffer`, so `bun build --compile` pulls THIS module
 * into the sandbox binary and not `index.ts`. The repo's previous answer to
 * "two sides must agree" was a hand copy plus a disk-reading tripwire test
 * (`blocked-headers.test.ts`) — that pattern exists precisely because a hand
 * copy of ten strings drifted and broke every deployed daemon (the
 * accept-encoding incident). A base64/JSON codec is far riskier to duplicate,
 * so both sides get literally the same module.
 *
 * Validation here is hand-written rather than zod: the runtime path parses one
 * of these per relayed request, and a zod parse on the hot path is pure
 * overhead. `index.ts` carries zod mirrors of these shapes for the OpenAPI docs
 * surface only.
 */

/** Protocol version. Bumped only for a change old daemons cannot parse. */
export const RELAY_VERSION = 1 as const;

/** Present on the request to declare the protocol, and on the response to confirm it. */
export const RELAY_VERSION_HEADER = 'x-kortix-relay';
/** base64url(JSON) request metadata — url, method, ordered headers, body shape. */
export const RELAY_META_HEADER = 'x-kortix-relay-meta';
/**
 * base64url(JSON) UPSTREAM status + safe headers, on a successful relay.
 *
 * Its PRESENCE is the disambiguator, and that is the single most load-bearing
 * rule in this contract: present ⟺ Kortix reached the upstream and the payload's
 * `status` is the upstream's. Absent ⟺ Kortix itself refused or failed, and the
 * relay's own HTTP status plus `x-kortix-relay-error` say why. The upstream
 * status is deliberately NOT mirrored onto the relay's own status line, because
 * a bare `403` would then be ambiguous between "Kortix policy denied" and
 * "Stripe said 403" — a distinction the legacy JSON envelope preserves and the
 * agent needs in order to act.
 */
export const RELAY_STATUS_HEADER = 'x-kortix-relay-status';
/** The `SecretBrokerErrorCode` when Kortix refused, alongside the JSON envelope. */
export const RELAY_ERROR_HEADER = 'x-kortix-relay-error';
/** Capability probe marker — one bodyless POST per shim process. */
export const RELAY_PROBE_HEADER = 'x-kortix-relay-probe';
/** The HMAC ticket that carries the IAM verdict into the websocket upgrade. */
export const RELAY_TICKET_HEADER = 'x-kortix-relay-ticket';

/**
 * Length, in bytes, of the END-OF-STREAM SENTINEL.
 *
 * ## Why a sentinel exists at all
 *
 * The obvious end-of-stream signal is "the chunked response ended without its
 * final `0\r\n\r\n`". It does not work. Measured on bun 1.3.14, across four
 * shapes (source `Readable` destroyed with an error, `controller.error()`,
 * `pull()` throwing, and a declared `content-length` cut short): Bun ALWAYS
 * writes `0\r\n\r\n` and the client's `fetch` resolves cleanly. Raw wire bytes
 * from a `net.Socket` client:
 *
 *   HTTP/1.1 200 OK … Transfer-Encoding: chunked\r\n\r\n
 *   12\r\nevent: a…\r\n12\r\nevent: b…\r\n0\r\n\r\n
 *
 * — with the source stream destroyed mid-body. So a truncated relay (upstream
 * socket reset, idle timeout, response byte budget) was indistinguishable from
 * a complete one, and the agent parsed half a JSON document as the whole answer.
 *
 * The fix is a POSITIVE signal instead of a negative one: on a clean end the
 * API appends `eos` — 32 random bytes, unguessable, minted per response — and
 * the shim strips it. Its ABSENCE is what says "truncated", and no truncation
 * point can forge it.
 *
 * ## Why it is opt-in
 *
 * A daemon baked before this contract existed would hand the sentinel bytes to
 * the guest as trailing garbage. So the client asks for it (`meta.eos: true`)
 * and only then does the API mint one (`status.eos`). Old daemon, no request,
 * no sentinel, byte-for-byte today's behaviour. That is why the protocol
 * version stays at 1: both new fields are additive and optional.
 */
export const RELAY_EOS_BYTES = 32;

/** Lowercase hex of `RELAY_EOS_BYTES` random bytes. */
const EOS_HEX = new RegExp(`^[0-9a-f]{${RELAY_EOS_BYTES * 2}}$`);

/**
 * Encoded-byte ceiling for the meta header.
 *
 * 64 KiB, comfortably inside every proxy header limit in the path while leaving
 * room for a large cookie jar. Enforced on BOTH ends: the shim refuses to build
 * a header the API would reject, and the API refuses to decode one that arrived
 * anyway.
 */
export const RELAY_META_MAX_BYTES = 65536;

/** Methods the relay carries. Mirrors `SecretBrokerRequestSchema.method`. */
export const RELAY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type RelayMethod = (typeof RELAY_METHODS)[number];

/** Same cap as the legacy broker's `headers` record. */
const MAX_HEADERS = 64;

/** RFC 7230 token. Header names are lowercased before this is applied. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface SecretRelayMeta {
  v: typeof RELAY_VERSION;
  /** Absolute https URL. Advisory — the API re-validates and re-matches policy. */
  url: string;
  method: RelayMethod;
  /** Ordered `[name, value]` pairs, names lowercased, DUPLICATES PRESERVED. */
  headers: Array<[string, string]>;
  /**
   * The body's shape, not its bytes.
   *
   * `length` is the guest's declared `content-length` AFTER the shim has undone
   * any `content-encoding`, or `null` when unknown (a chunked guest request).
   * The API uses it to choose framing: a known length under the exact-length
   * threshold keeps today's byte-for-byte buffered behaviour, an unknown or
   * large one streams chunked.
   */
  body: { present: false } | { present: true; length: number | null };
  /**
   * `true` ⟺ this client strips and verifies the end-of-stream sentinel.
   *
   * Absent or `false` means a daemon baked before the sentinel existed, and the
   * API must not append one. See `RELAY_EOS_BYTES`.
   */
  eos?: boolean;
}

export interface SecretRelayStatus {
  v: typeof RELAY_VERSION;
  /** The UPSTREAM status, never the relay's own. */
  status: number;
  /** Whitelisted response headers, ordered, duplicates preserved, echo-redacted. */
  headers: Array<[string, string]>;
  /**
   * Hex of the `RELAY_EOS_BYTES` sentinel this response will END with, if it
   * completes. Present ⟺ the client asked for it in `meta.eos`.
   */
  eos?: string;
}

/** A malformed or out-of-contract relay header. Callers map it to a 400. */
export class RelayCodecError extends Error {
  constructor(
    readonly code: 'relay_meta_invalid' | 'relay_meta_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'RelayCodecError';
  }
}

function invalid(message: string): never {
  throw new RelayCodecError('relay_meta_invalid', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an ordered header list.
 *
 * Rejecting CR and LF here is not belt-and-braces: these values are written
 * onto a real request line by `node:https`, so a value carrying `\r\n` is a
 * request-splitting primitive. The API applies the same check again after
 * substitution, because substitution can introduce bytes that were not here.
 */
function parseHeaders(raw: unknown, field: string): Array<[string, string]> {
  if (!Array.isArray(raw)) invalid(`${field} must be an array of [name, value] pairs`);
  if (raw.length > MAX_HEADERS) invalid(`${field} must contain at most ${MAX_HEADERS} entries`);
  const headers: Array<[string, string]> = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2)
      invalid(`${field} entries must be [name, value]`);
    const [name, value] = entry as [unknown, unknown];
    if (typeof name !== 'string' || typeof value !== 'string') {
      invalid(`${field} entries must be strings`);
    }
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(lower)) invalid(`invalid header name: ${name}`);
    if (value.includes('\r') || value.includes('\n')) invalid(`invalid header value: ${lower}`);
    headers.push([lower, value]);
  }
  return headers;
}

/**
 * The URL check the shim's copy is only ADVISORY about.
 *
 * The API re-runs the identical constraints (and the policy match, and the SSRF
 * resolve) before anything leaves — this exists so a malformed target fails at
 * the codec with a legible code instead of deeper in the transport.
 */
function parseUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) invalid('url is invalid');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalid('url must be absolute');
  }
  if (url.protocol !== 'https:') invalid('url must use HTTPS');
  if (url.username || url.password) invalid('url must not contain credentials');
  return raw;
}

function decodeJson(encoded: string, field: string): unknown {
  if (typeof encoded !== 'string' || encoded.length === 0) invalid(`${field} is missing`);
  if (encoded.length > RELAY_META_MAX_BYTES) {
    throw new RelayCodecError(
      'relay_meta_too_large',
      `${field} exceeds ${RELAY_META_MAX_BYTES} bytes`,
    );
  }
  // base64url only — the alphabet a header can carry unquoted.
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) invalid(`${field} is not base64url`);
  let text: string;
  try {
    text = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    invalid(`${field} is not base64url`);
  }
  try {
    return JSON.parse(text);
  } catch {
    invalid(`${field} is not valid JSON`);
  }
}

function encodeJson(value: unknown, field: string): string {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  if (encoded.length > RELAY_META_MAX_BYTES) {
    throw new RelayCodecError(
      'relay_meta_too_large',
      `${field} exceeds ${RELAY_META_MAX_BYTES} bytes`,
    );
  }
  return encoded;
}

export function encodeRelayMeta(meta: SecretRelayMeta): string {
  return encodeJson(meta, RELAY_META_HEADER);
}

export function decodeRelayMeta(encoded: string): SecretRelayMeta {
  const raw = decodeJson(encoded, RELAY_META_HEADER);
  if (!isRecord(raw)) invalid('meta must be an object');
  if (raw.v !== RELAY_VERSION) invalid(`unsupported relay protocol version: ${String(raw.v)}`);
  const method = raw.method;
  if (typeof method !== 'string' || !(RELAY_METHODS as readonly string[]).includes(method)) {
    invalid(`unsupported method: ${String(method)}`);
  }
  const body = raw.body;
  if (!isRecord(body) || typeof body.present !== 'boolean') invalid('body shape is invalid');
  let parsedBody: SecretRelayMeta['body'];
  if (body.present === false) {
    parsedBody = { present: false };
  } else {
    const length = body.length;
    if (length === null || length === undefined) {
      parsedBody = { present: true, length: null };
    } else if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
      invalid('body.length must be a non-negative integer or null');
    } else {
      parsedBody = { present: true, length };
    }
  }
  if (raw.eos !== undefined && typeof raw.eos !== 'boolean') invalid('eos must be a boolean');
  return {
    v: RELAY_VERSION,
    url: parseUrl(raw.url),
    method: method as RelayMethod,
    headers: parseHeaders(raw.headers, RELAY_META_HEADER),
    body: parsedBody,
    ...(raw.eos === true ? { eos: true } : {}),
  };
}

export function encodeRelayStatus(status: SecretRelayStatus): string {
  return encodeJson(status, RELAY_STATUS_HEADER);
}

export function decodeRelayStatus(encoded: string): SecretRelayStatus {
  const raw = decodeJson(encoded, RELAY_STATUS_HEADER);
  if (!isRecord(raw)) invalid('status must be an object');
  if (raw.v !== RELAY_VERSION) invalid(`unsupported relay protocol version: ${String(raw.v)}`);
  const status = raw.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    invalid('status must be an integer HTTP status');
  }
  const eos = raw.eos;
  if (eos !== undefined && (typeof eos !== 'string' || !EOS_HEX.test(eos))) {
    invalid(`eos must be ${RELAY_EOS_BYTES * 2} lowercase hex characters`);
  }
  return {
    v: RELAY_VERSION,
    status,
    headers: parseHeaders(raw.headers, RELAY_STATUS_HEADER),
    ...(typeof eos === 'string' ? { eos } : {}),
  };
}

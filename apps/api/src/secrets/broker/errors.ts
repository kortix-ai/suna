// The wire contract of the secret broker: the byte/timeout budgets, the header
// allowlists, the error-code vocabulary, and `SecretBrokerError`. Every other
// module under `broker/` speaks this contract.

export const MAX_REQUEST_BYTES = 1_048_576;
export const MAX_RESPONSE_BYTES = 5_242_880;
export const MAX_REDIRECTS = 3;
export const REQUEST_TIMEOUT_MS = 30_000;
export const REDACTED = Buffer.from('[REDACTED]');

// `BLOCKED_REQUEST_HEADERS` (from `@kortix/api-contract/secret-relay`, enforced
// in request-gate.ts) is FRAMING / hop-by-hop headers
// only. These are rejected with a 400 because the
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
// old broker behaviour is unchanged. The shim drops the same set before relaying.

export const SAFE_RESPONSE_HEADERS = new Set([
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

export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type SecretBrokerErrorCode =
  // ── The legacy /broker vocabulary. UNCHANGED — a daemon baked into a sandbox
  //    image months ago still branches on these strings. ────────────────────
  | 'invalid_request'
  | 'policy_denied'
  | 'unsafe_destination'
  | 'upstream_failed'
  | 'upstream_timeout'
  | 'response_too_large'
  // ── Streaming relay only. Additive: nothing above changes meaning. ───────
  /** `x-kortix-relay-meta` is missing, malformed, or out of contract (400). */
  | 'relay_meta_invalid'
  /** The encoded meta header exceeds `RELAY_META_MAX_BYTES` (400). */
  | 'relay_meta_too_large'
  /** The guest's request body exceeded `KORTIX_RELAY_MAX_REQUEST_BYTES` (413). */
  | 'relay_request_too_large'
  /** The upstream response exceeded `KORTIX_RELAY_MAX_RESPONSE_BYTES` (502). */
  | 'relay_response_too_large'
  /** `KORTIX_SECRET_RELAY_STREAM_ENABLED=false` — the kill switch (503). */
  | 'relay_disabled'
  /** A 3xx arrived after the request body was already streamed (502). */
  | 'redirect_not_replayable'
  /** The upstream body failed mid-stream, after the 200 was committed (502). */
  | 'upstream_stream_failed'
  /** A websocket upgrade arrived with the WS relay disabled (501). */
  | 'websocket_relay_unavailable'
  /**
   * The upstream answered with a `content-encoding` despite being asked for
   * `identity`, so the echo scan cannot see plaintext in its body (502).
   *
   * FAIL CLOSED. `prepareRelayHead` forces `accept-encoding: identity` on the
   * upstream leg precisely so `StreamSubstituter` can find and redact a secret
   * the upstream reflects back (debug/echo endpoints and several error shapes
   * echo `Authorization` verbatim). A DEFLATE stream does not contain those
   * bytes, so nothing matches, nothing is redacted, and the guest inflates the
   * real credential locally — the exact leak the whole design prevents. The
   * alternative is decompressing server-side, which reintroduces a
   * decompression-bomb budget on an intentionally uncapped path.
   */
  | 'upstream_encoding_unsupported';

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

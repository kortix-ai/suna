export type UpstreamErrorKind = 'http' | 'network' | 'timeout' | 'circuit_open' | 'client_abort';

export class TimeoutError extends Error {
  readonly kind: UpstreamErrorKind = 'timeout';
  constructor(message = 'upstream timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

// The INBOUND client disconnected (tab closed, stop hit, TCP reset) — distinct
// from an upstream-side NetworkError/TimeoutError. Never retried (there's no
// one left to serve) and never counted against the shared provider circuit
// breaker (the upstream did nothing wrong).
export class ClientAbortError extends Error {
  readonly kind: UpstreamErrorKind = 'client_abort';
  constructor(message = 'client disconnected') {
    super(message);
    this.name = 'ClientAbortError';
  }
}

export class NetworkError extends Error {
  readonly kind: UpstreamErrorKind = 'network';
  constructor(
    message = 'upstream network error',
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class CircuitOpenError extends Error {
  readonly kind: UpstreamErrorKind = 'circuit_open';
  constructor(readonly provider: string) {
    super(`circuit open for upstream "${provider}"`);
    this.name = 'CircuitOpenError';
  }
}

export class UpstreamHttpError extends Error {
  readonly kind: UpstreamErrorKind = 'http';
  constructor(
    readonly status: number,
    readonly body: string,
    readonly provider?: string,
  ) {
    super(`upstream HTTP ${status}`);
    this.name = 'UpstreamHttpError';
  }
}

// Reason a route model produced NO upstream candidates at all — thrown by a
// host's `resolveUpstream` hook (instead of the generic empty-array return
// used for merely "irrelevant to this route model") so the pipeline can carry
// a specific, actionable code/message/suggestion all the way to the client
// instead of collapsing every cause into one generic "No upstream configured"
// string. See packages/llm-gateway/src/pipeline/handler.ts's dispatch loop.
export type NoUpstreamReasonCode =
  | 'model_not_found'
  | 'model_disabled_on_deployment'
  | 'plan_upgrade_required'
  | 'provider_not_connected'
  | 'provider_reauth_required';

export class GatewayResolutionError extends Error {
  constructor(
    readonly code: NoUpstreamReasonCode,
    message: string,
    readonly suggestion: string,
  ) {
    super(message);
    this.name = 'GatewayResolutionError';
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : '';
}

// Substrings that reliably indicate a TERMINAL, permanent client-auth failure
// across every provider shape this gateway talks to — OpenAI/Anthropic-style
// JSON error codes, AWS SigV4/STS credential exceptions (Bedrock), and generic
// "Unauthorized" wording. Matched case-insensitively against an error's
// `.message`.
//
// Exists because not every upstream failure carries a clean numeric HTTP
// status by the time it reaches `defaultIsRetryable`/`indicatesUpstreamDown`:
// an AWS credential/SigV4 resolution error can throw before any HTTP response
// ever exists, and some AI-SDK error classes don't expose `.statusCode` at
// all (see transports/ai-sdk/index.ts's `toTransportError`). Without this
// fallback those errors collapse to a generic retryable NetworkError, and a
// dead credential gets retried into a permanently empty, hung turn instead of
// failing fast (2026-07-17 incident: invalid upstream key retried 11+ times
// over 2+ minutes with no error ever surfaced to the session).
const TERMINAL_AUTH_FAILURE_MARKERS = [
  'invalid_api_key',
  'invalid x-api-key',
  'incorrect api key',
  'authentication_error',
  'invalid api key',
  'unrecognizedclientexception',
  'invalidsignatureexception',
  'accessdeniedexception',
  'security token included in the request is invalid',
];

export function looksLikeTerminalAuthFailure(message: string | undefined | null): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return TERMINAL_AUTH_FAILURE_MARKERS.some((marker) => lower.includes(marker));
}

export function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof CircuitOpenError) return false;
  if (err instanceof ClientAbortError) return false;
  if (err instanceof UpstreamHttpError) {
    // 401/403 are a dead credential or a permission the caller doesn't have —
    // never a transient host issue, so never worth retrying. Called out
    // explicitly (rather than left to fall through to `false` below it) so
    // the intent is documented and independently testable — see
    // TERMINAL_AUTH_FAILURE_MARKERS above for the same rule applied when no
    // clean status is available at all.
    if (err.status === 401 || err.status === 403) return false;
    return err.status === 429 || (err.status >= 500 && err.status <= 599);
  }
  // A generic/NetworkError-shaped error can still be a terminal auth failure in
  // disguise (see TERMINAL_AUTH_FAILURE_MARKERS) — check before the
  // TimeoutError/NetworkError defaults below ever get a chance to call it
  // retryable.
  if (looksLikeTerminalAuthFailure(errorText(err))) return false;
  if (err instanceof TimeoutError) return true;
  if (err instanceof NetworkError) return true;
  return true;
}

// A circuit breaker exists to fail fast when an upstream is genuinely DOWN —
// network failures, timeouts, 5xx. This is deliberately NOT the same set as
// `defaultIsRetryable`: a 429/402/403 is per-credential flow control (rate
// limit, quota, billing), not a host-health signal. Breakers are keyed by
// provider and SHARED across every caller of that provider, so counting one
// tenant's rate-limited BYOK key as a "failure" would open the breaker for all
// other tenants whose own keys are fine. A 429 is therefore still retried and
// failed-over, but it never trips the breaker.
export function indicatesUpstreamDown(err: unknown): boolean {
  if (err instanceof ClientAbortError) return false;
  // A dead credential is this caller's problem, not the host's — same
  // reasoning as the 429/402/403 carve-out above, extended to the
  // statusCode-less shape (see TERMINAL_AUTH_FAILURE_MARKERS): must never trip
  // the shared breaker for every other tenant on this provider.
  if (looksLikeTerminalAuthFailure(errorText(err))) return false;
  if (err instanceof TimeoutError) return true;
  if (err instanceof NetworkError) return true;
  if (err instanceof UpstreamHttpError) return err.status >= 500 && err.status <= 599;
  return false;
}

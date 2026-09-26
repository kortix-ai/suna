export type UpstreamErrorKind = 'http' | 'network' | 'timeout' | 'client_abort' | 'misconfigured';

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

// A resolved descriptor is structurally unusable — today, specifically, a
// missing/blank/unparseable `baseUrl` (see callUpstream's `assertUsableBaseUrl`
// in http/call-upstream.ts). This is a CONFIGURATION defect, never a transient
// upstream condition: no baseUrl was actually contacted, so retrying it or
// tripping the shared per-provider circuit breaker would only slow down the
// (correct) failure and punish every OTHER tenant's requests to the same
// provider for a problem that is this one candidate's alone. Whichever engine
// builds the outgoing request (native's `${baseUrl}/chat/completions` string
// concat, or the ai-sdk engine's `createOpenAICompatible({baseURL: baseURL ||
// ''})`) would otherwise fail deep inside a provider SDK/fetch with an opaque,
// hard-to-diagnose "Invalid URL" — for a STREAMING ai-sdk call that failure
// mode is worse still: it surfaces as a 200-status SSE stream carrying an
// in-band `error` frame instead of ever throwing, which a naive client could
// mistake for a successful (if garbled) response. Failing fast here, before
// either engine ever builds a request, converts that into a clean, correctly-
// classified, immediately-diagnosable error the instant a bad descriptor is
// about to be dispatched — regardless of which engine or provider it is.
export class UpstreamMisconfiguredError extends Error {
  readonly kind: UpstreamErrorKind = 'misconfigured';
  constructor(
    readonly provider: string,
    reason: string,
  ) {
    super(`upstream misconfigured for provider "${provider}": ${reason}`);
    this.name = 'UpstreamMisconfiguredError';
  }
}

export class UpstreamHttpError extends Error {
  readonly kind: UpstreamErrorKind = 'http';
  constructor(
    readonly status: number,
    readonly body: string,
    readonly provider?: string,
    /**
     * The upstream response headers, lower-cased, when the transport captured
     * them (`APICallError.responseHeaders`). Only `retry-after` is read today —
     * the pipeline relays it to the client CLAMPED (see
     * `clampRetryAfterSeconds`), because OpenCode >= 1.18.17 obeys a
     * `Retry-After` verbatim up to 24.8 days.
     */
    readonly headers?: Record<string, string>,
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
// string. See pipeline/simple-handler.ts and pipeline/dispatch.ts.
export type NoUpstreamReasonCode =
  | 'model_not_found'
  | 'model_disabled_on_deployment'
  | 'model_disabled'
  | 'provider_disabled'
  | 'plan_upgrade_required'
  | 'provider_not_connected'
  | 'provider_reauth_required'
  | 'provider_pool_rate_limited';

export class GatewayResolutionError extends Error {
  constructor(
    readonly code: NoUpstreamReasonCode,
    message: string,
    readonly suggestion: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'GatewayResolutionError';
  }
}

// Substrings that reliably indicate a TERMINAL, permanent client-auth failure
// across every provider shape this gateway talks to — OpenAI/Anthropic-style
// JSON error codes, AWS SigV4/STS credential exceptions (Bedrock), and generic
// "Unauthorized" wording. Matched case-insensitively against an error's
// `.message`.
//
// Exists because not every upstream failure carries a clean numeric HTTP
// status by the time it is classified: an AWS credential/SigV4 resolution error can throw before any HTTP response
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

/**
 * Did the upstream refuse this exact request PARAMETER (an OpenAI-shaped
 * `invalid_request_error` / `unknown_parameter` naming it)? Distinct from every
 * other 400: the request is fine without that one field, so the caller can
 * strip it and try once more instead of failing the turn.
 *
 * SampleCo 2026-08-25: Bedrock's `global.openai.gpt-5.6-sol` profile answered
 * `{"code":"unknown_parameter","param":"reasoning_effort"}` to a wire shape the
 * gateway believed was right (#6879; corrected to the nested `reasoning.effort`
 * by #6893). Whatever the next wrong claim is, it must cost one retry, never
 * the turn.
 */
export function isUnknownParameterRejection(err: unknown, param: string): boolean {
  if (!(err instanceof UpstreamHttpError) || err.status !== 400) return false;
  const text = `${err.message} ${err.body}`;
  if (!text.includes(param)) return false;
  return /unknown_parameter|unknown parameter|unrecognized request argument|unsupported parameter/i.test(
    text,
  );
}

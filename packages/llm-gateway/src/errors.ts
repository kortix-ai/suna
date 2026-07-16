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
  | 'provider_key_private'
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

export function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof CircuitOpenError) return false;
  if (err instanceof ClientAbortError) return false;
  if (err instanceof TimeoutError) return true;
  if (err instanceof NetworkError) return true;
  if (err instanceof UpstreamHttpError) {
    return err.status === 429 || (err.status >= 500 && err.status <= 599);
  }
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
  if (err instanceof TimeoutError) return true;
  if (err instanceof NetworkError) return true;
  if (err instanceof UpstreamHttpError) return err.status >= 500 && err.status <= 599;
  return false;
}

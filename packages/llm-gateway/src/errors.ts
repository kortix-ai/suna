export type UpstreamErrorKind = 'http' | 'network' | 'timeout' | 'circuit_open';

export class TimeoutError extends Error {
  readonly kind: UpstreamErrorKind = 'timeout';
  constructor(message = 'upstream timed out') {
    super(message);
    this.name = 'TimeoutError';
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

export function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof CircuitOpenError) return false;
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
  if (err instanceof TimeoutError) return true;
  if (err instanceof NetworkError) return true;
  if (err instanceof UpstreamHttpError) return err.status >= 500 && err.status <= 599;
  return false;
}

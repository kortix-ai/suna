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
  constructor(message = 'upstream network error', readonly cause?: unknown) {
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

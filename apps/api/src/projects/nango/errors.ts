export type NangoErrorCode =
  | 'github_provider_failed'
  | 'github_provider_rate_limited'
  | 'github_reconnect_required'
  | 'nango_unavailable';

const messages: Record<NangoErrorCode, string> = {
  github_provider_failed: 'The GitHub credential broker returned an invalid response.',
  github_provider_rate_limited: 'The GitHub credential broker rate-limited the request.',
  github_reconnect_required: 'The GitHub connection must be reconnected.',
  nango_unavailable: 'The GitHub credential broker is unavailable.',
};

export class NangoError extends Error {
  readonly code: NangoErrorCode;
  readonly status: number;
  readonly retryAfter?: string;
  readonly upstreamStatus?: number;

  constructor(
    code: NangoErrorCode,
    status: number,
    options: { retryAfter?: string; upstreamStatus?: number } = {},
  ) {
    super(messages[code]);
    this.name = 'NangoError';
    this.code = code;
    this.status = status;
    this.retryAfter = options.retryAfter;
    this.upstreamStatus = options.upstreamStatus;
  }
}

export function invalidNangoResponse(upstreamStatus?: number): NangoError {
  return new NangoError('github_provider_failed', 502, {
    ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
  });
}

export function nangoUnavailable(upstreamStatus?: number): NangoError {
  return new NangoError('nango_unavailable', 503, {
    ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
  });
}

export function nangoRateLimited(retryAfter?: string): NangoError {
  return new NangoError('github_provider_rate_limited', 429, {
    ...(retryAfter ? { retryAfter } : {}),
    upstreamStatus: 429,
  });
}

export function githubReconnectRequired(upstreamStatus: number): NangoError {
  return new NangoError('github_reconnect_required', 409, { upstreamStatus });
}

export function isNangoError(error: unknown): error is NangoError {
  return error instanceof NangoError;
}

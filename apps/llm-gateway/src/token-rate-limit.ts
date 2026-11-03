import { createHash } from 'node:crypto';
import { gatewayErrorResponse } from '@kortix/llm-gateway';
import { TokenBucketRateLimiter } from '@kortix/shared/rate-limit';

/**
 * The per-credential request limit on every model route of this service. It
 * runs before the body is read and before the admit call to the API.
 *
 * Sandboxes can call this service directly (`LLM_GATEWAY_BASE_URL` on the
 * API). Their requests then skip the API's `/v1/llm` limit. This applies the
 * same limit under the same setting, `KORTIX_LLM_GATEWAY_REQS_PER_MIN`
 * (default 600 per minute per credential).
 *
 * The key is a SHA-256 of the credential, so no raw secret stays in memory.
 * A request without a credential is not counted: the pipeline refuses it with
 * 401 before it calls the API.
 *
 * Each gateway task counts alone, so the fleet allows limit × tasks. This
 * stops a runaway loop or a flood on one credential. It is not a quota.
 *
 * Returns the 429 response, or null when the request may continue.
 */
export function createTokenRateLimit(limitPerMinute: number): (request: Request, headers?: Headers) => Response | null {
  const limiter = new TokenBucketRateLimiter('gateway_token');
  return (request, headers = new Headers()) => {
    const credential = credentialOf(request);
    if (!credential) return null;
    const key = createHash('sha256').update(credential).digest('hex');
    const result = limiter.check(key, { limit: limitPerMinute, windowMs: 60_000 });
    headers.set('RateLimit-Limit', String(result.limit));
    headers.set('RateLimit-Remaining', String(result.remaining));
    headers.set('RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));
    if (result.allowed) return null;
    // A refusal must also stop the upload: an unread body is still buffered.
    request.body?.cancel().catch(() => {});
    const retryAfterSeconds = Math.max(1, Math.ceil((result.retryAfterMs ?? result.resetMs) / 1000));
    const response = rateLimitedResponse(new URL(request.url).pathname, retryAfterSeconds);
    headers.forEach((value, name) => response.headers.set(name, value));
    return response;
  };
}

/** The bearer token, or the `x-api-key` that Anthropic SDKs send instead. */
function credentialOf(request: Request): string | null {
  const bearer = /^Bearer\s+(\S+)$/i.exec((request.headers.get('authorization') ?? '').trim())?.[1];
  return bearer || request.headers.get('x-api-key')?.trim() || null;
}

const MESSAGE = 'Too many requests for this credential. Retry shortly.';

/** A 429 in the envelope of the route's protocol: Anthropic for Messages and Claude Code, OpenAI otherwise. */
function rateLimitedResponse(path: string, retryAfterSeconds: number): Response {
  if (path.endsWith('/messages') || path.includes('/claude-code/')) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: MESSAGE } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
    });
  }
  return gatewayErrorResponse(429, {
    message: MESSAGE,
    code: 'rate_limited',
    provider: '',
    requestedModel: '',
    resolvedModel: '',
    requestId: '',
    suggestion: 'Slow down. The limit is per credential per minute.',
    retryAfterSeconds,
  });
}

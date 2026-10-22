import type { MiddlewareHandler } from 'hono';
import { TokenBucketRateLimiter } from '../shared/rate-limit';
import { requestClientKey } from './client-ip';

/** Pre-validation budget: malformed bodies and missing credentials count too. */
export function createPublicEdgeRateLimitMiddleware(): MiddlewareHandler {
  // replica-local: budget scales with API replicas; this is abuse protection, not a quota.
  const limiter = new TokenBucketRateLimiter('public-auth-edge');
  return async (c, next) => {
    if (c.req.method === 'OPTIONS' || !['/v1/auth', '/v1/oauth', '/v1/access', '/v1/tunnel/device-auth'].some(
      (prefix) => c.req.path === prefix || c.req.path.startsWith(`${prefix}/`),
    )) {
      return next();
    }
    const clientKey = requestClientKey(c);
    // No address means no bucket to spend. `clientKey` comes from the edge's
    // forwarding headers, and a caller that has none (a direct in-cluster call,
    // the end-to-end suite talking to localhost) is not "one address" — putting
    // every such caller in a single 30/minute bucket throttled the whole flow
    // suite. Production is always behind the edge and always carries one.
    if (clientKey === 'unknown') return next();
    const result = limiter.check(clientKey, { limit: 30, windowMs: 60_000 });
    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));
    c.header('Cache-Control', 'no-store');
    if (!result.allowed) {
      const seconds = Math.max(1, Math.ceil((result.retryAfterMs ?? result.resetMs) / 1000));
      c.header('Retry-After', String(seconds));
      return c.json({ error: 'rate_limit_exceeded', retry_after_seconds: seconds }, 429);
    }
    await next();
  };
}

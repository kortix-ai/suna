import { createHash } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { bearerToken } from '../shared/bearer-token';
import { KEY_PREFIX_SANDBOX } from '../shared/crypto';
import { TokenBucketRateLimiter } from '../shared/rate-limit';
import { isTokenValidated } from '../shared/token-hash';
import { requestClientKey } from './client-ip';

/**
 * The budget a request spends: its client address, or, for a sandbox token this
 * process already validated, that sandbox's own.
 *
 * Session boxes share their Platinum host's egress address (two boxes on one
 * host both reached the API from 51.158.248.121, 2026-11-03), so every box on a
 * host was one client here: their turn-stream, boot-timeline, config-release,
 * journal and asset calls drew on one 300/minute budget, and a preview's boxes
 * got 429s. A `kortix_sb_` token that matched a live key row on this process
 * (`isTokenValidated`, token-hash.ts: 10 minutes, kept apart from unknown
 * tokens so a flood cannot evict it) spends a budget of its own instead. An
 * unknown or forged token still spends the address's budget, so the limit an
 * attacker meets is unchanged. The bucket is keyed by a digest, never the token.
 */
function budgetKey(c: Context, clientKey: string): string {
  const token = bearerToken(c.req.header('Authorization'));
  if (!token?.startsWith(KEY_PREFIX_SANDBOX) || !isTokenValidated(token)) return clientKey;
  return `sandbox:${createHash('sha256').update(token).digest('base64url')}`;
}

/** Pre-validation budget: malformed bodies and missing credentials count too. */
export function createPublicEdgeRateLimitMiddleware(): MiddlewareHandler {
  // replica-local: budget scales with API replicas; this is abuse protection, not a quota.
  const authLimiter = new TokenBucketRateLimiter('public-auth-edge');
  // replica-local: general abuse budget, independent of the stricter auth budget.
  const apiLimiter = new TokenBucketRateLimiter('public-api-edge');
  return async (c, next) => {
    if (c.req.method === 'OPTIONS' || ['/v1/health', '/v1/health/live', '/v1/health/ready'].includes(c.req.path)) {
      return next();
    }
    const clientKey = requestClientKey(c);
    // No address means no bucket to spend. `clientKey` comes from the edge's
    // forwarding headers, and a caller that has none (a direct in-cluster call,
    // the end-to-end suite talking to localhost) is not "one address" — putting
    // every such caller in a single 30/minute bucket throttled the whole flow
    // suite. Production is always behind the edge and always carries one.
    if (clientKey === 'unknown') return next();
    const isAuth = ['/v1/auth', '/v1/oauth', '/v1/access', '/v1/tunnel/device-auth'].some(
      (prefix) => c.req.path === prefix || c.req.path.startsWith(`${prefix}/`),
    );
    const key = budgetKey(c, clientKey);
    const result = isAuth
      ? authLimiter.check(key, { limit: 30, windowMs: 60_000 })
      : apiLimiter.check(key, { limit: 300, windowMs: 60_000 });
    const setBudgetHeaders = () => {
      c.header('X-RateLimit-Limit', String(result.limit));
      c.header('X-RateLimit-Remaining', String(result.remaining));
      c.header('X-RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));
    };
    setBudgetHeaders();
    c.header('Cache-Control', 'no-store');
    if (!result.allowed) {
      const seconds = Math.max(1, Math.ceil((result.retryAfterMs ?? result.resetMs) / 1000));
      c.header('Retry-After', String(seconds));
      return c.json({ error: 'rate_limit_exceeded', retry_after_seconds: seconds }, 429);
    }
    await next();
    // A route that answers with a Response it built (proxies, streams) drops the
    // headers set above; set them again on the final response (KRTX-4302).
    // An upgrade response is not rebuilt, and an inner limiter's own budget
    // headers stay.
    if (c.res.status !== 101 && !c.res.headers.has('X-RateLimit-Limit')) setBudgetHeaders();
  };
}

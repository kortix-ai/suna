import type { Context, Next } from 'hono';
import { config } from '../config';
import { recordAuditEvent } from './audit';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
  retryAfterMs?: number;
}

interface AuditContext {
  accountId?: string | null;
  actorUserId?: string | null;
  resourceType: string;
  resourceId?: string | null;
  action: string;
  metadata?: Record<string, unknown>;
}

export class TokenBucketRateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly namespace: string) {}

  check(key: string, policy: RateLimitPolicy): RateLimitResult {
    const limit = Math.max(1, Math.floor(policy.limit));
    const windowMs = Math.max(1000, Math.floor(policy.windowMs));
    const now = Date.now();
    const bucketKey = `${this.namespace}:${key}`;
    let bucket = this.buckets.get(bucketKey);

    if (!bucket) {
      bucket = { tokens: limit - 1, lastRefill: now };
      this.buckets.set(bucketKey, bucket);
      return { allowed: true, limit, remaining: bucket.tokens, resetMs: windowMs };
    }

    const elapsed = now - bucket.lastRefill;
    const refill = Math.floor((elapsed / windowMs) * limit);
    if (refill > 0) {
      bucket.tokens = Math.min(limit, bucket.tokens + refill);
      bucket.lastRefill = now;
    }

    const resetMs = Math.max(windowMs - (now - bucket.lastRefill), 1000);
    if (bucket.tokens <= 0) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetMs,
        retryAfterMs: resetMs,
      };
    }

    bucket.tokens -= 1;
    return { allowed: true, limit, remaining: bucket.tokens, resetMs };
  }

  reset() {
    this.buckets.clear();
  }
}

function positiveInt(value: unknown, fallback: number) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function clientIp(c: Context) {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('x-real-ip')
    || 'unknown';
}

function setHeaders(c: Context, result: RateLimitResult) {
  c.header('X-RateLimit-Limit', String(result.limit));
  c.header('X-RateLimit-Remaining', String(result.remaining));
  c.header('X-RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));
  if (!result.allowed && result.retryAfterMs) {
    c.header('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
  }
}

async function auditRateLimitHit(c: Context, context: AuditContext, result: RateLimitResult) {
  await recordAuditEvent({
    accountId: context.accountId ?? null,
    actorUserId: context.actorUserId ?? null,
    action: context.action,
    resourceType: context.resourceType,
    resourceId: context.resourceId ?? null,
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') || null,
    metadata: {
      ...(context.metadata ?? {}),
      rate_limit: {
        limit: result.limit,
        remaining: result.remaining,
        retry_after_ms: result.retryAfterMs ?? null,
      },
    },
  }).catch((error) => {
    console.error('[rate-limit] Failed to record audit event:', error);
  });
}

export async function enforceRateLimit(
  c: Context,
  limiter: TokenBucketRateLimiter,
  key: string,
  policy: RateLimitPolicy,
  auditContext: AuditContext,
): Promise<Response | null> {
  const result = limiter.check(key, policy);
  setHeaders(c, result);

  if (result.allowed) return null;

  await auditRateLimitHit(c, auditContext, result);
  return c.json({
    error: 'rate_limit_exceeded',
    message: 'Rate limit exceeded. Please retry shortly.',
    retry_after_seconds: Math.ceil((result.retryAfterMs ?? result.resetMs) / 1000),
  }, 429);
}

const inviteAcceptLimiter = new TokenBucketRateLimiter('invite_accept');
const sandboxProxyLimiter = new TokenBucketRateLimiter('sandbox_proxy');
export const sessionLlmLimiter = new TokenBucketRateLimiter('session_llm');

export function createInviteAcceptRateLimitMiddleware() {
  return async (c: Context, next: Next) => {
    const inviteId = c.req.param('inviteId') || null;
    const denied = await enforceRateLimit(
      c,
      inviteAcceptLimiter,
      clientIp(c),
      {
        limit: positiveInt((config as any).KORTIX_INVITE_ACCEPT_REQS_PER_MIN, 20),
        windowMs: 60_000,
      },
      {
        action: `RATE_LIMIT ${c.req.method} ${c.req.path}`,
        resourceType: 'account_invite',
        resourceId: inviteId,
        metadata: { limiter: 'invite_accept' },
      },
    );
    if (denied) return denied;
    await next();
  };
}

export function createSandboxProxyRateLimitMiddleware() {
  return async (c: Context, next: Next) => {
    const sandboxId = c.req.param('sandboxId') || 'unknown';
    const denied = await enforceRateLimit(
      c,
      sandboxProxyLimiter,
      sandboxId,
      {
        limit: positiveInt((config as any).KORTIX_PROXY_REQS_PER_MIN, 600),
        windowMs: 60_000,
      },
      {
        actorUserId: ((c as any).get('userId') as string | undefined) ?? null,
        action: `RATE_LIMIT ${c.req.method} ${c.req.path}`,
        resourceType: 'sandbox_proxy',
        resourceId: sandboxId,
        metadata: { limiter: 'sandbox_proxy' },
      },
    );
    if (denied) return denied;
    await next();
  };
}

export function resetRateLimiters() {
  inviteAcceptLimiter.reset();
  sandboxProxyLimiter.reset();
  sessionLlmLimiter.reset();
}

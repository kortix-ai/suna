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

const UUID_V4_REGEX = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

// Hard cap on distinct live buckets per limiter. A limiter keyed on any
// attacker-influenced value (e.g. the public-session-share id) would otherwise
// grow this Map without bound under a flood of unique keys → process-wide OOM.
// When exceeded we evict the oldest-inserted entries (idle ones first).
const MAX_BUCKETS = 50_000;

export class TokenBucketRateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly namespace: string) {}

  private evictIfNeeded() {
    if (this.buckets.size < MAX_BUCKETS) return;
    // Map preserves insertion order and entries are refreshed in place (never
    // re-inserted), so the head is the least-recently-created. Drop ~10% to
    // amortize the sweep across many inserts.
    const dropCount = Math.ceil(MAX_BUCKETS * 0.1);
    let dropped = 0;
    for (const key of this.buckets.keys()) {
      this.buckets.delete(key);
      if (++dropped >= dropCount) break;
    }
  }

  check(key: string, policy: RateLimitPolicy): RateLimitResult {
    const limit = Math.max(1, Math.floor(policy.limit));
    const windowMs = Math.max(1000, Math.floor(policy.windowMs));
    const now = Date.now();
    const bucketKey = `${this.namespace}:${key}`;
    let bucket = this.buckets.get(bucketKey);

    if (!bucket) {
      this.evictIfNeeded();
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
const publicSessionShareLimiter = new TokenBucketRateLimiter('public_session_share');
const demoRequestLimiter = new TokenBucketRateLimiter('demo_request');
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

/**
 * Guards the anonymous `/v1/public/session-shares/:shareId*` family — same
 * shape as `createInviteAcceptRateLimitMiddleware` (no authenticated identity
 * to key on), but keyed on the share id path param rather than client IP:
 * every visitor to one shared link is legitimately behind the same bucket,
 * while a single caller trying many share ids from behind a shared NAT/VPN
 * doesn't starve everyone else's shares. Every call also fetches from the
 * sandbox daemon (list sessions + read messages), so this is deliberately
 * tighter than the plain metadata-only invite-accept limiter.
 */
export function createPublicSessionShareRateLimitMiddleware() {
  return async (c: Context, next: Next) => {
    // Key on the share id when it's a well-formed uuid (every visitor to one
    // shared link shares that bucket); otherwise fall back to client IP. This
    // MUST run before the raw param can key the bucket Map — an attacker
    // looping unique garbage ids would otherwise allocate an unbounded number
    // of buckets (the id is never a real share, so it never reaches the
    // handler's own validation) and OOM the process.
    const rawShareId = c.req.param('shareId');
    const shareId = rawShareId && UUID_V4_REGEX.test(rawShareId) ? rawShareId : `ip:${clientIp(c)}`;
    const denied = await enforceRateLimit(
      c,
      publicSessionShareLimiter,
      shareId,
      {
        limit: positiveInt((config as any).KORTIX_PUBLIC_SESSION_SHARE_REQS_PER_MIN, 60),
        windowMs: 60_000,
      },
      {
        action: `RATE_LIMIT ${c.req.method} ${c.req.path}`,
        resourceType: 'public_session_share',
        resourceId: shareId,
        metadata: { limiter: 'public_session_share' },
      },
    );
    if (denied) return denied;
    await next();
  };
}

/**
 * Guards the public, unauthenticated `POST /v1/system/demo-request` lead-capture
 * endpoint. No identity to key on (anyone on the marketing site can submit), so
 * it's keyed on client IP — deliberately tight, since every allowed request
 * fires an internal notification email.
 */
export function createDemoRequestRateLimitMiddleware() {
  return async (c: Context, next: Next) => {
    const denied = await enforceRateLimit(
      c,
      demoRequestLimiter,
      clientIp(c),
      {
        limit: positiveInt((config as any).KORTIX_DEMO_REQUEST_REQS_PER_MIN, 10),
        windowMs: 60_000,
      },
      {
        action: `RATE_LIMIT ${c.req.method} ${c.req.path}`,
        resourceType: 'demo_request',
        resourceId: null,
        metadata: { limiter: 'demo_request' },
      },
    );
    if (denied) return denied;
    await next();
  };
}

export function resetRateLimiters() {
  inviteAcceptLimiter.reset();
  sandboxProxyLimiter.reset();
  publicSessionShareLimiter.reset();
  demoRequestLimiter.reset();
  sessionLlmLimiter.reset();
}

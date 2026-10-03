import { createHash } from 'node:crypto';
import type { Context, Next } from 'hono';
import { config } from '../config';
import { requestClientIp, requestClientKey } from './client-ip';
import { shareIdFromPublicRef } from './public-share-ref';
import { recordAuditEvent } from './audit';
import { RATE_LIMIT_EXCEEDED_ACTION } from './rate-limit-audit';

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
    ip: requestClientIp(c),
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

async function rateLimitExceededResponse(
  c: Context,
  result: RateLimitResult,
  auditContext: AuditContext,
): Promise<Response> {
  await auditRateLimitHit(c, auditContext, result);
  return c.json(
    {
      error: 'rate_limit_exceeded',
      message: 'Rate limit exceeded. Please retry shortly.',
      retry_after_seconds: Math.ceil((result.retryAfterMs ?? result.resetMs) / 1000),
    },
    429,
  );
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

  return rateLimitExceededResponse(c, result, auditContext);
}

// replica-local: every limiter below counts in this process, so the fleet allows
// limit × API replicas. They stop runaways and floods; none meters a quota.
const inviteAcceptLimiter = new TokenBucketRateLimiter('invite_accept');
const sandboxProxyLimiter = new TokenBucketRateLimiter('sandbox_proxy');
const publicSessionShareLimiter = new TokenBucketRateLimiter('public_session_share');
const demoRequestLimiter = new TokenBucketRateLimiter('demo_request');
const checkEmailLimiter = new TokenBucketRateLimiter('check_email');
const projectWebhookLimiter = new TokenBucketRateLimiter('project_webhook');
const projectWebhookManifestRefreshLimiter = new TokenBucketRateLimiter(
  'project_webhook_manifest_refresh',
);
const projectSecretWriteLimiter = new TokenBucketRateLimiter('project_secret_write');
const projectSessionCreateLimiter = new TokenBucketRateLimiter('project_session_create');
const llmGatewayLimiter = new TokenBucketRateLimiter('llm_gateway');

/**
 * Per-project budget on session CREATES (the 2026-08-21 storm's other half: a
 * per-minute trigger created a session every tick, forever — 60 provider
 * provisions an hour from one project, none ever cleaned up). Checked from the
 * session-create path (lib/sessions.ts), not a route mount, because creates
 * arrive through several routes (UI, triggers, channels, KaaB).
 *
 * In-process bucket — same replica-multiplied honesty as the secret-write
 * budget above, and the same verdict: this stops runaway loops, it does not
 * meter exact quotas.
 */
export function consumeProjectSessionCreateBudget(projectId: string): RateLimitResult {
  return projectSessionCreateLimiter.check(projectId, {
    limit: positiveInt((config as any).KORTIX_PROJECT_SESSION_CREATES_PER_HOUR, 100),
    windowMs: 60 * 60_000,
  });
}

/**
 * Per-project budget on secret WRITES (POST/PUT/PATCH/DELETE under
 * /:projectId/secrets*). Reads pass untouched.
 *
 * INCIDENT 2026-08-21: agents in two projects used secrets as a config store
 * and wrote them in loops (one made 1,017 writes in a morning). Every write
 * fans an env push to every active sandbox in the project, so the loops became
 * a provider-API storm that got the whole Daytona org rate-limited — failing
 * session creates and wakes for every other customer. No human workflow writes
 * secrets 100 times in an hour; an agent loop does.
 *
 * In-process buckets, so the effective ceiling is limit × API replicas when a
 * loop happens to spread across pods. That is accepted: the goal is stopping
 * hundreds-per-hour runaways, not metering exact quotas.
 */
export function createProjectSecretWriteRateLimitMiddleware() {
  return async (c: Context, next: Next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const projectId = c.req.param('projectId') || 'unknown';
    const result = projectSecretWriteLimiter.check(projectId, {
      limit: positiveInt((config as any).KORTIX_PROJECT_SECRET_WRITES_PER_HOUR, 100),
      windowMs: 60 * 60_000,
    });
    setHeaders(c, result);
    if (!result.allowed) {
      return c.json(
        {
          error: 'rate_limit_exceeded',
          message:
            'This project has hit its secret-write limit. Secrets are for credentials, not fast-changing state — store loop data elsewhere, or retry later.',
          code: 'project_secret_write_limit',
          retry_after_seconds: Math.ceil((result.retryAfterMs ?? result.resetMs) / 1000),
        },
        429,
      );
    }
    await next();
  };
}

function createAuditedRateLimitMiddleware(
  limiter: TokenBucketRateLimiter,
  select: (c: Context) => { key: string; policy: RateLimitPolicy; auditContext: AuditContext },
) {
  return async (c: Context, next: Next) => {
    const { key, policy, auditContext } = select(c);
    const denied = await enforceRateLimit(c, limiter, key, policy, auditContext);
    if (denied) return denied;
    await next();
  };
}

export function createInviteAcceptRateLimitMiddleware() {
  return createAuditedRateLimitMiddleware(inviteAcceptLimiter, (c) => {
    const inviteId = c.req.param('inviteId') || null;
    return {
      key: requestClientKey(c),
      policy: {
        limit: positiveInt((config as any).KORTIX_INVITE_ACCEPT_REQS_PER_MIN, 20),
        windowMs: 60_000,
      },
      auditContext: {
        action: RATE_LIMIT_EXCEEDED_ACTION,
        resourceType: 'account_invite',
        resourceId: inviteId,
        metadata: { limiter: 'invite_accept' },
      },
    };
  });
}

export function createSandboxProxyRateLimitMiddleware() {
  return createAuditedRateLimitMiddleware(sandboxProxyLimiter, (c) => {
    const sandboxId = c.req.param('sandboxId') || 'unknown';
    return {
      key: sandboxId,
      policy: {
        limit: positiveInt((config as any).KORTIX_PROXY_REQS_PER_MIN, 600),
        windowMs: 60_000,
      },
      auditContext: {
        actorUserId: ((c as any).get('userId') as string | undefined) ?? null,
        action: RATE_LIMIT_EXCEEDED_ACTION,
        resourceType: 'sandbox_proxy',
        resourceId: sandboxId,
        metadata: { limiter: 'sandbox_proxy' },
      },
    };
  });
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
  return createAuditedRateLimitMiddleware(publicSessionShareLimiter, (c) => {
    // Key on the share id when the ref names one (every visitor to one
    // shared link shares that bucket); otherwise fall back to client IP. This
    // MUST run before the raw param can key the bucket Map — an attacker
    // looping unique garbage ids would otherwise allocate an unbounded number
    // of buckets (the id is never a real share, so it never reaches the
    // handler's own validation) and OOM the process.
    // A `kps_` token and its share id name the same share, so both key the
    // same bucket.
    const shareId = shareIdFromPublicRef(c.req.param('shareId') ?? '') ?? `ip:${requestClientKey(c)}`;
    return {
      key: shareId,
      policy: {
        limit: positiveInt((config as any).KORTIX_PUBLIC_SESSION_SHARE_REQS_PER_MIN, 60),
        windowMs: 60_000,
      },
      auditContext: {
        action: RATE_LIMIT_EXCEEDED_ACTION,
        resourceType: 'public_session_share',
        resourceId: shareId,
        metadata: { limiter: 'public_session_share' },
      },
    };
  });
}

/**
 * Guards the public, unauthenticated `POST /v1/system/demo-request` lead-capture
 * endpoint. No identity to key on (anyone on the marketing site can submit), so
 * it's keyed on client IP — deliberately tight, since every allowed request
 * fires an internal notification email.
 */
export function createDemoRequestRateLimitMiddleware() {
  return createAuditedRateLimitMiddleware(demoRequestLimiter, (c) => {
    return {
      key: requestClientKey(c),
      policy: {
        limit: positiveInt((config as any).KORTIX_DEMO_REQUEST_REQS_PER_MIN, 10),
        windowMs: 60_000,
      },
      auditContext: {
        action: RATE_LIMIT_EXCEEDED_ACTION,
        resourceType: 'demo_request',
        resourceId: null,
        metadata: { limiter: 'demo_request' },
      },
    };
  });
}

/**
 * Guards the public, unauthenticated `POST /v1/access/check-email` endpoint.
 * Its response drives the unified auth flow (sign-in vs registration), which
 * makes it an account-existence oracle by construction — the limiter is what
 * keeps it useless for bulk enumeration. Keyed on client IP through the
 * trusted-proxy rule (shared/client-ip.ts), so a caller cannot choose its own
 * bucket with a forged `x-forwarded-for`. A call relayed by the web server
 * action is keyed on the web server's address; that action treats a 429 as
 * `unknown` and continues through the adaptive flow.
 */
export function createCheckEmailRateLimitMiddleware() {
  return createAuditedRateLimitMiddleware(checkEmailLimiter, (c) => {
    return {
      key: requestClientKey(c),
      policy: {
        limit: positiveInt((config as any).KORTIX_CHECK_EMAIL_REQS_PER_MIN, 60),
        windowMs: 60_000,
      },
      auditContext: {
        action: RATE_LIMIT_EXCEEDED_ACTION,
        resourceType: 'access_check_email',
        resourceId: null,
        metadata: { limiter: 'check_email' },
      },
    };
  });
}

/**
 * Guards public project webhooks before the handler loads Git-backed trigger
 * configuration. The rejection path does not write an audit row. An attacker
 * must not convert a request flood into a database-write flood.
 */
export function createProjectWebhookRateLimitMiddleware() {
  return async (c: Context, next: Next) => {
    const projectId = c.req.param('projectId') || 'unknown';
    const result = projectWebhookLimiter.check(`${projectId}:${requestClientKey(c)}`, {
      limit: positiveInt((config as any).KORTIX_PROJECT_WEBHOOK_REQS_PER_MIN, 120),
      windowMs: 60_000,
    });
    setHeaders(c, result);
    if (!result.allowed) {
      return c.json(
        {
          error: 'rate_limit_exceeded',
          message: 'Rate limit exceeded. Please retry shortly.',
          retry_after_seconds: Math.ceil((result.retryAfterMs ?? result.resetMs) / 1000),
        },
        429,
      );
    }
    await next();
  };
}

/**
 * Bound forced Git mirror refreshes by project, independent of source IP.
 * Each API replica owns a local mirror, so each replica needs its own budget.
 */
export function consumeProjectWebhookManifestRefreshBudget(projectId: string): boolean {
  return projectWebhookManifestRefreshLimiter.check(projectId, {
    limit: 1,
    windowMs: 30_000,
  }).allowed;
}

/**
 * Per-principal budget on the LLM gateway mount (`/v1/llm/*` and its
 * `/v1/llm-gateway/*` alias), the reverse proxy to the standalone gateway.
 * The standalone gateway meters spend and sheds on memory pressure, but
 * nothing throttles a principal at this boundary. This is defence-in-depth,
 * not a quota: in-limit traffic keeps its exact behavior plus the standard
 * `X-RateLimit-*` headers.
 *
 * Key: the presented credential, hashed so no raw secret is retained in the
 * bucket Map. One gateway key or PAT belongs to exactly one account/project,
 * so the credential is the principal — and this avoids a per-request identity
 * database read on the inference hot path. A request without a bearer falls
 * back to the client address, so omitting the header cannot escape the limit.
 *
 * The proxy answers with a raw `Response` that replaces Hono's prepared one,
 * so headers set before `next()` would be dropped. They are applied again
 * after `next()`, when `c` points at the final response.
 */
export function createLlmGatewayRateLimitMiddleware() {
  return async (c: Context, next: Next) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec((c.req.header('authorization') ?? '').trim());
    const token = bearer?.[1];
    const key = token
      ? `tok:${createHash('sha256').update(token).digest('hex')}`
      : `ip:${requestClientKey(c)}`;
    const result = llmGatewayLimiter.check(key, {
      limit: positiveInt((config as any).KORTIX_LLM_GATEWAY_REQS_PER_MIN, 600),
      windowMs: 60_000,
    });
    if (!result.allowed) {
      setHeaders(c, result);
      return rateLimitExceededResponse(c, result, {
        action: RATE_LIMIT_EXCEEDED_ACTION,
        resourceType: 'llm_gateway',
        resourceId: null,
        metadata: { limiter: 'llm_gateway' },
      });
    }
    await next();
    setHeaders(c, result);
  };
}

export function resetRateLimiters() {
  inviteAcceptLimiter.reset();
  sandboxProxyLimiter.reset();
  publicSessionShareLimiter.reset();
  demoRequestLimiter.reset();
  checkEmailLimiter.reset();
  projectWebhookLimiter.reset();
  projectWebhookManifestRefreshLimiter.reset();
  projectSecretWriteLimiter.reset();
  projectSessionCreateLimiter.reset();
  llmGatewayLimiter.reset();
}

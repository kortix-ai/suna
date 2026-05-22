// Per-account session policy enforcement. Runs on every authenticated
// request that targets a specific account (i.e. routes mounted under
// /:accountId/*). Cheap when no policy is configured — one composite
// SELECT then early-exit.
//
// Enforcement order:
//   1. Lifetime: now - JWT.iat > max_lifetime_minutes → 401 + mark revoked
//   2. Idle:     now - last_seen_at > idle_timeout_minutes → 401 + mark revoked
//   3. Revoked:  revoked_at is set → 401
// then update last_seen_at (lazy, > 60s since last write).
//
// PATs are exempt (no session_id, no iat for our purposes). Skip when
// the auth method isn't 'supabase'.

import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq, sql } from 'drizzle-orm';
import { accountSessionActivity, accounts } from '@kortix/db';
import { db } from '../shared/db';

/** Skip the update query if last_seen_at was touched more recently than
 *  this. Bounds DB write pressure under chatty clients. */
const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

interface PolicyAndActivity {
  maxLifetimeMinutes: number | null;
  idleTimeoutMinutes: number | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Look up the session policy + this session's activity row in one
 * round-trip. LEFT JOIN so the policy comes back even when the activity
 * row doesn't exist yet.
 */
async function loadPolicyAndActivity(
  accountId: string,
  userId: string,
  sessionId: string,
): Promise<PolicyAndActivity | null> {
  const [row] = await db
    .select({
      maxLifetimeMinutes: accounts.sessionMaxLifetimeMinutes,
      idleTimeoutMinutes: accounts.sessionIdleTimeoutMinutes,
      lastSeenAt: accountSessionActivity.lastSeenAt,
      revokedAt: accountSessionActivity.revokedAt,
    })
    .from(accounts)
    .leftJoin(
      accountSessionActivity,
      and(
        eq(accountSessionActivity.accountId, accounts.accountId),
        eq(accountSessionActivity.userId, userId),
        eq(accountSessionActivity.sessionId, sessionId),
      ),
    )
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  return row ?? null;
}

async function markRevoked(
  accountId: string,
  userId: string,
  sessionId: string,
  reason: 'idle' | 'lifetime',
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  // Upsert: revoke if the row exists, create-then-revoke if not (race-
  // safe in case we race a first-sight insert).
  await db
    .insert(accountSessionActivity)
    .values({
      accountId,
      userId,
      sessionId,
      revokedAt: new Date(),
      revokedReason: reason,
      ip,
      userAgent,
    })
    .onConflictDoUpdate({
      target: [
        accountSessionActivity.accountId,
        accountSessionActivity.userId,
        accountSessionActivity.sessionId,
      ],
      set: {
        revokedAt: sql`COALESCE(${accountSessionActivity.revokedAt}, now())`,
        revokedReason: sql`COALESCE(${accountSessionActivity.revokedReason}, ${reason})`,
      },
    });
}

async function touchActivity(
  accountId: string,
  userId: string,
  sessionId: string,
  ip: string | null,
  userAgent: string | null,
  lastSeenAt: Date | null,
): Promise<void> {
  // Skip when we wrote recently — keeps DB write pressure bounded
  // under a chatty client (e.g. polling, SSE).
  if (
    lastSeenAt &&
    Date.now() - lastSeenAt.getTime() < ACTIVITY_WRITE_INTERVAL_MS
  ) {
    return;
  }
  await db
    .insert(accountSessionActivity)
    .values({ accountId, userId, sessionId, ip, userAgent })
    .onConflictDoUpdate({
      target: [
        accountSessionActivity.accountId,
        accountSessionActivity.userId,
        accountSessionActivity.sessionId,
      ],
      set: { lastSeenAt: new Date() },
    });
}

/**
 * Decide whether a session should be denied. Pure — exported for tests.
 *
 *   - nowMs: current time in milliseconds
 *   - iatSeconds: JWT.iat (seconds epoch); null = no max-lifetime check
 *   - policy: account-level limits
 *   - lastSeenAt: previous activity timestamp, null = first sight
 *   - revokedAt: already-revoked timestamp
 *
 * Returns 'allow' or the reason for denial.
 */
export function evaluateSessionGate(args: {
  nowMs: number;
  iatSeconds: number | null;
  maxLifetimeMinutes: number | null;
  idleTimeoutMinutes: number | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}): 'allow' | 'revoked' | 'lifetime_exceeded' | 'idle_timeout' {
  if (args.revokedAt) return 'revoked';

  if (args.maxLifetimeMinutes != null && args.iatSeconds != null) {
    const ageMs = args.nowMs - args.iatSeconds * 1000;
    if (ageMs > args.maxLifetimeMinutes * 60_000) return 'lifetime_exceeded';
  }

  if (args.idleTimeoutMinutes != null && args.lastSeenAt) {
    const idleMs = args.nowMs - args.lastSeenAt.getTime();
    if (idleMs > args.idleTimeoutMinutes * 60_000) return 'idle_timeout';
  }

  return 'allow';
}

/**
 * Mount this on /v1/accounts/:accountId/* AFTER auth middleware. It
 * needs userId, sessionId, sessionIat populated on context.
 */
export function accountSessionGate(): MiddlewareHandler {
  return async (c: Context, next) => {
    const accountId =
      c.req.param('accountId') ?? c.req.param('id') ?? (c.get('accountId') as string | undefined);
    if (!accountId) {
      // Routes without an :accountId can't be gated; nothing to do.
      await next();
      return;
    }

    // PATs and Kortix API keys don't carry a session_id — they're
    // already governed by token lifecycle policies elsewhere.
    const authType = c.get('authType') as string | undefined;
    if (authType !== 'supabase') {
      await next();
      return;
    }

    const userId = c.get('userId') as string | undefined;
    const sessionId = c.get('sessionId') as string | undefined;
    if (!userId || !sessionId) {
      // JWT didn't carry a session_id — pre-Supabase-3.0 token shape.
      // Treat as ungatable; never block a real, valid token.
      await next();
      return;
    }

    const policy = await loadPolicyAndActivity(accountId, userId, sessionId);
    if (!policy) {
      // Account doesn't exist; let the downstream route 404 with its
      // own message instead of inventing one here.
      await next();
      return;
    }
    if (
      policy.maxLifetimeMinutes == null &&
      policy.idleTimeoutMinutes == null &&
      !policy.revokedAt
    ) {
      // No policy AND no force-logout outstanding → skip the write
      // entirely. Hot-path on accounts that haven't opted in.
      await next();
      return;
    }

    const iatSeconds = c.get('sessionIat') as number | undefined;
    const verdict = evaluateSessionGate({
      nowMs: Date.now(),
      iatSeconds: typeof iatSeconds === 'number' ? iatSeconds : null,
      maxLifetimeMinutes: policy.maxLifetimeMinutes,
      idleTimeoutMinutes: policy.idleTimeoutMinutes,
      lastSeenAt: policy.lastSeenAt,
      revokedAt: policy.revokedAt,
    });

    if (verdict !== 'allow') {
      const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
        ?? c.req.header('x-real-ip')
        ?? null;
      const userAgent = c.req.header('user-agent') ?? null;
      // Persist the revocation reason so the next request through
      // this session short-circuits without re-evaluating gates.
      if (verdict === 'idle_timeout' || verdict === 'lifetime_exceeded') {
        await markRevoked(
          accountId,
          userId,
          sessionId,
          verdict === 'idle_timeout' ? 'idle' : 'lifetime',
          ip,
          userAgent,
        ).catch((err) => {
          console.warn('[session-gate] markRevoked failed', err);
        });
      }
      throw new HTTPException(401, {
        message: `session ${verdict.replace('_', ' ')} — please sign in again`,
      });
    }

    // Update last_seen lazily.
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      ?? c.req.header('x-real-ip')
      ?? null;
    const userAgent = c.req.header('user-agent') ?? null;
    touchActivity(accountId, userId, sessionId, ip, userAgent, policy.lastSeenAt).catch((err) => {
      console.warn('[session-gate] touchActivity failed', err);
    });

    await next();
  };
}

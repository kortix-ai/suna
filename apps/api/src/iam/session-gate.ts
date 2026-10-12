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

import { accountSessionActivity, accounts } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';

// The middleware that applies this policy to a request (`accountSessionGate`)
// lives in `middleware/session-gate.ts`. Re-exported here so every importer
// keeps working.
export { accountSessionGate } from '../middleware/session-gate';

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
export async function loadPolicyAndActivity(
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

export async function markRevoked(
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

/** Returns true when this call inserted a brand-new activity row
 *  (first time we've seen this session against this account). The
 *  caller emits an `auth.session.first_sight` audit event on true. */
export async function touchActivity(
  accountId: string,
  userId: string,
  sessionId: string,
  ip: string | null,
  userAgent: string | null,
  lastSeenAt: Date | null,
): Promise<{ firstSight: boolean }> {
  // Skip when we wrote recently — keeps DB write pressure bounded
  // under a chatty client (e.g. polling, SSE).
  if (lastSeenAt && Date.now() - lastSeenAt.getTime() < ACTIVITY_WRITE_INTERVAL_MS) {
    return { firstSight: false };
  }
  // Distinguish first-sight (insert) from refresh (update) using
  // `xmax = 0` — Postgres sets xmax to 0 for new rows but to the
  // current xid for updates. Cheap, single round-trip.
  const rows = await db.execute<{ first_sight: boolean }>(sql`
    INSERT INTO kortix.account_session_activity
      (account_id, user_id, session_id, ip, user_agent)
    VALUES (${accountId}::uuid, ${userId}::uuid, ${sessionId}::uuid, ${ip}, ${userAgent})
    ON CONFLICT (account_id, user_id, session_id)
      DO UPDATE SET last_seen_at = now()
    RETURNING (xmax = 0) AS first_sight
  `);
  const data = (rows as unknown as { rows: Array<{ first_sight: boolean }> }).rows ?? rows;
  return { firstSight: (data as Array<{ first_sight: boolean }>)[0]?.first_sight === true };
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

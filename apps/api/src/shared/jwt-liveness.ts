/**
 * "Is the session behind this verified access token still live?"
 *
 * `jwt-verify.ts` checks signature and expiry locally (on hosted envs only for
 * ES256: their `SUPABASE_JWT_SECRET` is a random value since 2026-10-21, so an
 * HS256 token goes to GoTrue). What it cannot see is
 * revocation: sign-out, a ban, a deleted user, a GoTrue-side session revoke.
 *
 * 2026-10-20: the check reads `auth.sessions` + `auth.users` in the same
 * Postgres GoTrue writes to — one primary-key lookup per request, no cache, no
 * staleness window. A sign-out deletes the session row, so the next request
 * is refused on every replica at once. Before, every request paid a
 * `GET /auth/v1/user` HTTP hop to GoTrue, which ran this same lookup itself.
 *
 * GoTrue stays the fallback for a token without a `session_id` claim and for a
 * failed DB read. A GoTrue failure throws: the caller fails closed.
 */

import { sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db, hasDatabase } from './db';
import { getSupabase } from './supabase';
import { isUuid } from './validate';

export interface LiveUser {
  id: string;
  email: string;
}

export interface SessionClaims {
  sub: string;
  session_id?: string;
}

type GoTrueLoader = (token: string) => Promise<LiveUser | null>;
type SessionLoader = (userId: string, sessionId: string) => Promise<LiveUser | null>;

/** The same verdict GoTrue's `/user` gives: the session row exists and its user may sign in. */
async function askDatabase(userId: string, sessionId: string): Promise<LiveUser | null> {
  const rows = (await db.execute(sql`
    SELECT u.id::text AS id, coalesce(u.email, '') AS email
      FROM auth.sessions s
      JOIN auth.users u ON u.id = s.user_id
     WHERE s.id = ${sessionId}::uuid
       AND s.user_id = ${userId}::uuid
       AND (s.not_after IS NULL OR s.not_after > now())
       AND u.deleted_at IS NULL
       AND (u.banned_until IS NULL OR u.banned_until <= now())
     LIMIT 1
  `)) as unknown as LiveUser[];
  return rows[0] ?? null;
}

async function askGoTrue(token: string): Promise<LiveUser | null> {
  const {
    data: { user },
    error,
  } = await getSupabase().auth.getUser(token);
  if (error) {
    // A 4xx is GoTrue's verdict on the token (revoked, deleted, bad JWT). Any
    // other failure is GoTrue being unreachable: throw so the caller fails
    // closed without recording a verdict.
    const status = (error as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) return null;
    throw error;
  }
  if (!user) return null;
  return { id: user.id, email: user.email ?? '' };
}

let goTrueLoader: GoTrueLoader = askGoTrue;
let lastLookupWarningAt = -Infinity;
let sessionLoader: SessionLoader = askDatabase;

/**
 * The live user behind a verified `token`, or null when its session is gone.
 * Throws when neither the DB nor GoTrue can answer.
 */
export async function confirmJwtLive(token: string, claims: SessionClaims): Promise<LiveUser | null> {
  const sessionId = claims.session_id;
  if (hasDatabase && sessionId && isUuid(sessionId) && isUuid(claims.sub)) {
    try {
      return await sessionLoader(claims.sub, sessionId);
    } catch (err) {
      // GoTrue answers instead. One line a minute: a lookup that always fails
      // (no grant on `auth`, an API DB that is not GoTrue's) puts every
      // request back on the GoTrue hop, and that must be visible.
      if (Date.now() - lastLookupWarningAt >= 60_000) {
        lastLookupWarningAt = Date.now();
        logger.warn('jwt-liveness: auth.sessions lookup failed, asking GoTrue', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return goTrueLoader(token);
}

/** Test seam: replace the GoTrue loader (null restores it). */
export function __setJwtLivenessLoaderForTests(next: GoTrueLoader | null): void {
  goTrueLoader = next ?? askGoTrue;
}

/** Test seam: replace the `auth.sessions` lookup (null restores it). */
export function __setSessionLivenessLoaderForTests(next: SessionLoader | null): void {
  sessionLoader = next ?? askDatabase;
}

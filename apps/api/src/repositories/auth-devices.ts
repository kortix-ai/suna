// A person's signed-in devices: their live Supabase auth sessions.
//
// GoTrue gives a client no way to list the account's sessions — a browser can
// only see its own. The API reads `auth.sessions` directly, the same table
// `auth.signOut({ scope: 'others' })` deletes from. Sessions an OAuth app holds
// (`oauth_client_id`) are not devices; Connected apps lists those.

import { and, eq, sql } from 'drizzle-orm';
import { accountSessionActivity, pushDeviceTokens } from '@kortix/db';
import { db } from '../shared/db';
import { deleteWebPushSubscriptionsForSignIn } from '../notifications/web-push-subscriptions';

export interface SignedInDeviceRow {
  session_id: string;
  user_agent: string | null;
  ip: string | null;
  signed_in_at: string;
  last_active_at: string;
}

/** Live sessions for `userId`, most recently active first. */
export async function listSignedInDevices(userId: string): Promise<SignedInDeviceRow[]> {
  // `refreshed_at` is `timestamp without time zone` in UTC; the others carry a zone.
  return (await db.execute(sql`
    SELECT s.id::text AS session_id,
           s.user_agent,
           host(s.ip) AS ip,
           to_char(COALESCE(s.created_at, s.updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS signed_in_at,
           to_char(GREATEST(s.refreshed_at, s.updated_at AT TIME ZONE 'UTC', s.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_active_at
    FROM auth.sessions s
    WHERE s.user_id = ${userId}::uuid
      AND s.oauth_client_id IS NULL
      AND (s.not_after IS NULL OR s.not_after > now())
    ORDER BY GREATEST(s.refreshed_at, s.updated_at AT TIME ZONE 'UTC', s.created_at AT TIME ZONE 'UTC') DESC
    LIMIT 100
  `)) as unknown as SignedInDeviceRow[];
}

/**
 * End one of `userId`'s sessions. Deleting the row cascades to its refresh
 * tokens, so the device cannot renew. Its access token would live until it
 * expires (~1 h); stamping `account_session_activity` makes the session gate
 * refuse it on every account-scoped route now. The push tokens that sign-in
 * registered go too, so its lock screen stops showing pushes (KRTX-1722), and
 * so do its browser's Web Push subscriptions (KRTX-1742).
 * Returns false when the session is not the caller's or no longer exists.
 */
export async function signOutDevice(userId: string, sessionId: string): Promise<boolean> {
  const deleted = (await db.execute(sql`
    DELETE FROM auth.sessions
    WHERE id = ${sessionId}::uuid AND user_id = ${userId}::uuid
    RETURNING id
  `)) as unknown as unknown[];
  if (deleted.length === 0) return false;
  await db
    .update(accountSessionActivity)
    .set({
      revokedAt: sql`COALESCE(${accountSessionActivity.revokedAt}, now())`,
      revokedReason: sql`COALESCE(${accountSessionActivity.revokedReason}, 'user')`,
      revokedBy: userId,
    })
    .where(
      and(eq(accountSessionActivity.userId, userId), eq(accountSessionActivity.sessionId, sessionId)),
    );
  await db
    .delete(pushDeviceTokens)
    .where(and(eq(pushDeviceTokens.userId, userId), eq(pushDeviceTokens.authSessionId, sessionId)));
  await deleteWebPushSubscriptionsForSignIn(sessionId);
  return true;
}

// Web Push subscriptions (`kortix.web_push_subscriptions`, KRTX-1742). One row
// per browser endpoint, owned by the user who registered it last and bound to
// that sign-in: a push goes only while the sign-in lives, like a phone token.
import { and, desc, eq, getTableColumns, inArray, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import { webPushSubscriptions, type Database } from '@kortix/db';
import { isAllowedWebPushHost } from '@kortix/shared/notification-kinds';
import { db as defaultDb } from '../shared/db';
import { qualifiedColumn } from '../shared/sql-qualified-column';

export const WEB_PUSH_ENDPOINT_MAX_CHARS = 2048;
export const WEB_PUSH_SUBSCRIPTIONS_PER_USER = 10;

export interface WebPushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type WebPushSubscriptionValidation =
  | { ok: true }
  | { ok: false; error: 'unsupported_push_service' | 'invalid_endpoint' | 'invalid_keys' };

export type WebPushSubscriptionRow = typeof webPushSubscriptions.$inferSelect;

/** Decoded bytes of a base64url value (padding tolerated), or null when it is not base64url. */
function base64urlBytes(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  const bare = value.replace(/=+$/, '');
  return /^[A-Za-z0-9_-]+$/.test(bare) ? Buffer.from(bare, 'base64url') : null;
}

/** https, no userinfo, no port, a known push service host, valid key lengths. */
export function validateWebPushSubscriptionInput(input: WebPushSubscriptionInput): WebPushSubscriptionValidation {
  if (typeof input?.endpoint !== 'string' || input.endpoint.length > WEB_PUSH_ENDPOINT_MAX_CHARS) {
    return { ok: false, error: 'invalid_endpoint' };
  }
  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    return { ok: false, error: 'invalid_endpoint' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return { ok: false, error: 'invalid_endpoint' };
  if (!isAllowedWebPushHost(url.hostname)) return { ok: false, error: 'unsupported_push_service' };
  const p256dh = base64urlBytes(input.keys?.p256dh);
  const auth = base64urlBytes(input.keys?.auth);
  // A 65-byte uncompressed P-256 point (0x04 prefix) and a 16-byte secret.
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4 || !auth || auth.length !== 16) {
    return { ok: false, error: 'invalid_keys' };
  }
  return { ok: true };
}

/**
 * Upsert by endpoint for `userId` (reassigns a reused endpoint); keeps at
 * most 10 per user by evicting the least recently registered. Throws on
 * input `validateWebPushSubscriptionInput` refuses.
 */
export async function registerWebPushSubscription(
  input: WebPushSubscriptionInput & { userId: string; authSessionId: string; aal: string },
  database: Database = defaultDb,
): Promise<void> {
  const valid = validateWebPushSubscriptionInput(input);
  if (!valid.ok) throw new Error(`invalid web push subscription: ${valid.error}`);
  const keys = {
    p256dh: base64urlBytes(input.keys.p256dh)!.toString('base64url'),
    auth: base64urlBytes(input.keys.auth)!.toString('base64url'),
  };
  const owner = { userId: input.userId, authSessionId: input.authSessionId, aal: input.aal, ...keys };
  await database.transaction(async (tx) => {
    await tx
      .insert(webPushSubscriptions)
      .values({ endpoint: input.endpoint, ...owner })
      .onConflictDoUpdate({ target: webPushSubscriptions.endpoint, set: { ...owner, updatedAt: sql`now()` } });
    const keep = tx
      .select({ endpoint: webPushSubscriptions.endpoint })
      .from(webPushSubscriptions)
      .where(and(eq(webPushSubscriptions.userId, input.userId), ne(webPushSubscriptions.endpoint, input.endpoint)))
      .orderBy(desc(webPushSubscriptions.updatedAt))
      .limit(WEB_PUSH_SUBSCRIPTIONS_PER_USER - 1);
    await tx
      .delete(webPushSubscriptions)
      .where(and(
        eq(webPushSubscriptions.userId, input.userId),
        ne(webPushSubscriptions.endpoint, input.endpoint),
        notInArray(webPushSubscriptions.endpoint, keep),
      ));
  });
}

/** True while the row's registering sign-in exists and has not reached its time box. */
function signInLives(): SQL {
  const signIn = qualifiedColumn(webPushSubscriptions.authSessionId);
  return sql`EXISTS (
    SELECT 1 FROM auth.sessions s
    WHERE s.id = ${signIn} AND (s.not_after IS NULL OR s.not_after > now()))`;
}

/**
 * The user's subscriptions whose registering sign-in still lives (the
 * `listByUser` rule for phone tokens). Rows whose sign-in ended (sign-out,
 * password change, session time box) are deleted here.
 */
export async function listDeliverableWebPushSubscriptions(
  userId: string,
  database: Database = defaultDb,
): Promise<WebPushSubscriptionRow[]> {
  const rows = await database
    .select({ ...getTableColumns(webPushSubscriptions), live: sql<boolean>`${signInLives()}` })
    .from(webPushSubscriptions)
    .where(eq(webPushSubscriptions.userId, userId));
  const dead = rows.filter((row) => !row.live).map((row) => row.endpoint);
  if (dead.length > 0) {
    await database
      .delete(webPushSubscriptions)
      .where(and(inArray(webPushSubscriptions.endpoint, dead), sql`NOT ${signInLives()}`));
  }
  return rows.filter((row) => row.live).map(({ live: _live, ...row }) => row);
}

/** Delete endpoints the push service reported gone (404/410). */
export async function deleteWebPushEndpoints(endpoints: readonly string[], database: Database = defaultDb): Promise<number> {
  if (endpoints.length === 0) return 0;
  const deleted = await database
    .delete(webPushSubscriptions)
    .where(inArray(webPushSubscriptions.endpoint, [...endpoints]))
    .returning({ endpoint: webPushSubscriptions.endpoint });
  return deleted.length;
}

/** Delete the caller's own row. True when a row was deleted. */
export async function deleteWebPushSubscription(userId: string, endpoint: string, database: Database = defaultDb): Promise<boolean> {
  const deleted = await database
    .delete(webPushSubscriptions)
    .where(and(eq(webPushSubscriptions.userId, userId), eq(webPushSubscriptions.endpoint, endpoint)))
    .returning({ endpoint: webPushSubscriptions.endpoint });
  return deleted.length > 0;
}

/** A sign-in ended (device sign-out): drop its subscriptions. */
export async function deleteWebPushSubscriptionsForSignIn(authSessionId: string, database: Database = defaultDb): Promise<number> {
  const deleted = await database
    .delete(webPushSubscriptions)
    .where(eq(webPushSubscriptions.authSessionId, authSessionId))
    .returning({ endpoint: webPushSubscriptions.endpoint });
  return deleted.length;
}

/** Account erasure: drop every subscription of the user. */
export async function deleteWebPushSubscriptionsForUser(userId: string, database: Database = defaultDb): Promise<number> {
  const deleted = await database
    .delete(webPushSubscriptions)
    .where(eq(webPushSubscriptions.userId, userId))
    .returning({ endpoint: webPushSubscriptions.endpoint });
  return deleted.length;
}

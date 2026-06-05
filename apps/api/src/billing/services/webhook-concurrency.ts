import { sql } from 'drizzle-orm';
import { stripeWebhookEventsProcessed } from '@kortix/db';
import { db } from '../../shared/db';

export async function recordWebhookEvent(eventId: string, eventType: string): Promise<boolean> {
  const inserted = await db
    .insert(stripeWebhookEventsProcessed)
    .values({ eventId, eventType })
    .onConflictDoNothing({ target: stripeWebhookEventsProcessed.eventId })
    .returning({ eventId: stripeWebhookEventsProcessed.eventId });
  return inserted.length > 0;
}

function accountLockKey(accountId: string): bigint {
  let h = 14695981039346656037n;
  for (const ch of `stripe_account:${accountId}`) {
    h ^= BigInt(ch.charCodeAt(0));
    h = (h * 1099511628211n) & 0x7fffffffffffffffn;
  }
  return h;
}

export async function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${accountLockKey(accountId)})`);
    return fn();
  });
}

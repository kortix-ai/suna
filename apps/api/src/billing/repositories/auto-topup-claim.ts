import { creditAccounts } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

/**
 * Claim the right to start one auto-topup charge, across every API replica.
 * A compare-and-set on `auto_topup_last_charged`: it moves from the value the
 * caller read to `now()` only if no other replica moved it first. Returns the
 * claim timestamp (the Stripe idempotency key's source), or null when another
 * replica holds the claim. A time-bucketed key alone does not do this: two
 * replicas on either side of a bucket boundary get different keys and both
 * charge.
 */
export async function claimAutoTopupCharge(
  accountId: string,
  observedLastCharged: string | null,
): Promise<string | null> {
  const rows = await db
    .update(creditAccounts)
    .set({ autoTopupLastCharged: sql`now()` })
    .where(
      and(
        eq(creditAccounts.accountId, accountId),
        sql`${creditAccounts.autoTopupLastCharged} IS NOT DISTINCT FROM ${observedLastCharged}::timestamptz`,
      ),
    )
    .returning({ claimedAt: creditAccounts.autoTopupLastCharged });
  return rows[0]?.claimedAt ?? null;
}

/**
 * Turn auto top-up off, the same single-winner way: true only for the call
 * that turned it off, so exactly one caller tells the owners (KRTX-1718).
 */
export async function disableAutoTopupIfEnabled(accountId: string): Promise<boolean> {
  const rows = await db
    .update(creditAccounts)
    .set({ autoTopupEnabled: false, updatedAt: new Date().toISOString() })
    .where(and(eq(creditAccounts.accountId, accountId), eq(creditAccounts.autoTopupEnabled, true)))
    .returning({ accountId: creditAccounts.accountId });
  return rows.length > 0;
}

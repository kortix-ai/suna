import { and, eq, ne } from 'drizzle-orm';
import { billingCustomers } from '@kortix/db';
import { db } from '../../shared/db';

type BillingCustomerRow = typeof billingCustomers.$inferSelect;

function pickCanonicalCustomer(rows: BillingCustomerRow[]): BillingCustomerRow | null {
  if (rows.length === 0) return null;

  const activeRows = rows.filter((row) => row.active !== false);
  const candidates = activeRows.length > 0 ? activeRows : rows;

  candidates.sort((a, b) => {
    const providerScore = (row: BillingCustomerRow) => (row.provider === 'stripe' ? 1 : 0);
    return providerScore(b) - providerScore(a) || a.id.localeCompare(b.id);
  });

  return candidates[0] ?? null;
}

async function listKortixCustomersByAccountId(accountId: string): Promise<BillingCustomerRow[]> {
  return db
    .select()
    .from(billingCustomers)
    .where(eq(billingCustomers.accountId, accountId));
}

/**
 * Every Stripe customer id ever associated with this account — kortix
 * billing_customers, active AND inactive, deduped. The legacy→per-seat
 * migration uses this to cancel subs that live on a deactivated/older
 * customer, not just the canonical one (a user can have several Stripe
 * customers; their machine subs may be on a non-canonical one).
 */
export async function listAccountStripeCustomerIds(accountId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const row of await listKortixCustomersByAccountId(accountId)) {
    if ((row.provider ?? 'stripe') === 'stripe' && row.id) ids.add(row.id);
  }
  return Array.from(ids);
}

async function deactivateConflictingCustomers(accountId: string, canonicalId: string, provider?: string | null) {
  const conditions = [
    eq(billingCustomers.accountId, accountId),
    ne(billingCustomers.id, canonicalId),
  ];

  if (provider) {
    conditions.push(eq(billingCustomers.provider, provider));
  }

  await db
    .update(billingCustomers)
    .set({ active: false })
    .where(and(...conditions));
}

export async function getCustomerByAccountId(accountId: string) {
  const rows = await listKortixCustomersByAccountId(accountId);

  return pickCanonicalCustomer(rows);
}

export async function getCustomerByStripeId(stripeCustomerId: string) {
  const [row] = await db
    .select()
    .from(billingCustomers)
    .where(eq(billingCustomers.id, stripeCustomerId))
    .limit(1);

  return row ?? null;
}

export async function upsertCustomer(data: {
  accountId: string;
  id: string;
  email?: string | null;
  provider?: string | null;
  active?: boolean | null;
}) {
  const existing = await getCustomerByAccountId(data.accountId);
  if (existing && existing.id !== data.id && existing.provider === (data.provider ?? existing.provider)) {
    await db
      .update(billingCustomers)
      .set({
        email: data.email,
        active: data.active ?? existing.active,
        provider: data.provider ?? existing.provider,
      })
      .where(eq(billingCustomers.id, existing.id));

    return existing;
  }

  await db
    .insert(billingCustomers)
    .values(data)
    .onConflictDoUpdate({
      target: billingCustomers.id,
      set: {
        email: data.email,
        active: data.active,
        provider: data.provider,
      },
    });

  await deactivateConflictingCustomers(data.accountId, data.id, data.provider);

  return {
    accountId: data.accountId,
    id: data.id,
    email: data.email ?? null,
    provider: data.provider ?? null,
    active: data.active ?? null,
  };
}

/**
 * Remove a stored Stripe customer row by its id. Used to drop a stale mapping —
 * a customer id created under a different Stripe account (e.g. after the key was
 * repointed) that no longer exists, so a fresh one can be created and persisted.
 */
export async function deleteCustomerByStripeId(stripeCustomerId: string): Promise<void> {
  await db.delete(billingCustomers).where(eq(billingCustomers.id, stripeCustomerId));
}

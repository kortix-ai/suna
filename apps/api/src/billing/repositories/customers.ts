import { and, eq, ne } from 'drizzle-orm';
import { billingCustomers, billingCustomersInBasejump } from '@kortix/db';
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

async function getLegacyCustomerByAccountId(accountId: string) {
  const rows = await db
    .select()
    .from(billingCustomersInBasejump)
    .where(eq(billingCustomersInBasejump.accountId, accountId));

  return pickCanonicalCustomer(rows as BillingCustomerRow[]);
}

async function getLegacyCustomerByStripeId(stripeCustomerId: string) {
  const [row] = await db
    .select()
    .from(billingCustomersInBasejump)
    .where(eq(billingCustomersInBasejump.id, stripeCustomerId))
    .limit(1);

  return row ?? null;
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

async function syncLegacyCustomerToKortix(legacy: {
  accountId: string;
  id: string;
  email?: string | null;
  provider?: string | null;
  active?: boolean | null;
}) {
  await db
    .insert(billingCustomers)
    .values({
      accountId: legacy.accountId,
      id: legacy.id,
      email: legacy.email,
      provider: legacy.provider,
      active: legacy.active ?? true,
    })
    .onConflictDoUpdate({
      target: billingCustomers.id,
      set: {
        email: legacy.email,
        active: legacy.active ?? true,
        provider: legacy.provider,
      },
    });

  await deactivateConflictingCustomers(legacy.accountId, legacy.id, legacy.provider);

  return {
    accountId: legacy.accountId,
    id: legacy.id,
    email: legacy.email ?? null,
    provider: legacy.provider ?? null,
    active: legacy.active ?? true,
  };
}

export async function getCustomerByAccountId(accountId: string) {
  const legacy = await getLegacyCustomerByAccountId(accountId);
  if (legacy) {
    return syncLegacyCustomerToKortix(legacy);
  }

  const rows = await listKortixCustomersByAccountId(accountId);

  return pickCanonicalCustomer(rows);
}

export async function getCustomerByStripeId(stripeCustomerId: string) {
  const [row] = await db
    .select()
    .from(billingCustomers)
    .where(eq(billingCustomers.id, stripeCustomerId))
    .limit(1);

  if (row) return row;

  const legacy = await getLegacyCustomerByStripeId(stripeCustomerId);
  if (legacy) {
    return syncLegacyCustomerToKortix(legacy);
  }

  return null;
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

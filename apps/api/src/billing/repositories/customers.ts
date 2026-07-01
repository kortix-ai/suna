import { Effect } from 'effect';
import { and, eq, ne } from 'drizzle-orm';
import { billingCustomers, billingCustomersInBasejump } from '@kortix/db';
import { billingDb as database } from '../effect';

type BillingCustomerRow = typeof billingCustomers.$inferSelect;

const runCustomerEffect = <A>(effect: Effect.Effect<A, unknown>) =>
  Effect.runPromise(effect);

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

const listKortixCustomersByAccountIdEffect = (accountId: string) =>
  Effect.gen(function* () {
    return yield* Effect.tryPromise(() =>
      database
        .select()
        .from(billingCustomers)
        .where(eq(billingCustomers.accountId, accountId)),
    );
  });

/**
 * Every Stripe customer id ever associated with this account — kortix
 * billing_customers (active AND inactive) + the legacy basejump table, deduped.
 * The legacy→per-seat migration uses this to cancel subs that live on a
 * deactivated/older customer, not just the canonical one (a user can have
 * several Stripe customers; their machine subs may be on a non-canonical one).
 */
export async function listAccountStripeCustomerIds(accountId: string): Promise<string[]> {
  return runCustomerEffect(Effect.gen(function* () {
    const ids = new Set<string>();
    for (const row of yield* listKortixCustomersByAccountIdEffect(accountId)) {
      if ((row.provider ?? 'stripe') === 'stripe' && row.id) ids.add(row.id);
    }
    const legacy = yield* Effect.tryPromise(() =>
      database
        .select()
        .from(billingCustomersInBasejump)
        .where(eq(billingCustomersInBasejump.accountId, accountId)),
    ).pipe(Effect.catchAll(() => Effect.succeed([])));
    for (const row of legacy as BillingCustomerRow[]) if (row.id) ids.add(row.id);
    return Array.from(ids);
  }));
}

const getLegacyCustomerByAccountIdEffect = (accountId: string) =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise(() =>
      database
        .select()
        .from(billingCustomersInBasejump)
        .where(eq(billingCustomersInBasejump.accountId, accountId)),
    ).pipe(Effect.catchAll(() => Effect.succeed([])));

    return pickCanonicalCustomer(rows as BillingCustomerRow[]);
  });

const getLegacyCustomerByStripeIdEffect = (stripeCustomerId: string) =>
  Effect.gen(function* () {
    const [row] = yield* Effect.tryPromise(() =>
      database
        .select()
        .from(billingCustomersInBasejump)
        .where(eq(billingCustomersInBasejump.id, stripeCustomerId))
        .limit(1),
    ).pipe(Effect.catchAll(() => Effect.succeed([])));

    return row ?? null;
  });

const deactivateConflictingCustomersEffect = (accountId: string, canonicalId: string, provider?: string | null) => {
  const conditions = [
    eq(billingCustomers.accountId, accountId),
    ne(billingCustomers.id, canonicalId),
  ];

  if (provider) {
    conditions.push(eq(billingCustomers.provider, provider));
  }

  return Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      database
        .update(billingCustomers)
        .set({ active: false })
        .where(and(...conditions)),
    );
  });
};

const syncLegacyCustomerToKortixEffect = (legacy: {
  accountId: string;
  id: string;
  email?: string | null;
  provider?: string | null;
  active?: boolean | null;
}) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      database
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
        }),
    );

    yield* deactivateConflictingCustomersEffect(legacy.accountId, legacy.id, legacy.provider);

    return {
      accountId: legacy.accountId,
      id: legacy.id,
      email: legacy.email ?? null,
      provider: legacy.provider ?? null,
      active: legacy.active ?? true,
    };
  });

export async function getCustomerByAccountId(accountId: string) {
  return runCustomerEffect(Effect.gen(function* () {
    const legacy = yield* getLegacyCustomerByAccountIdEffect(accountId);
    if (legacy) {
      return yield* syncLegacyCustomerToKortixEffect(legacy);
    }

    const rows = yield* listKortixCustomersByAccountIdEffect(accountId);

    return pickCanonicalCustomer(rows);
  }));
}

export async function getCustomerByStripeId(stripeCustomerId: string) {
  return runCustomerEffect(Effect.gen(function* () {
    const [row] = yield* Effect.tryPromise(() =>
      database
        .select()
        .from(billingCustomers)
        .where(eq(billingCustomers.id, stripeCustomerId))
        .limit(1),
    );

    if (row) return row;

    const legacy = yield* getLegacyCustomerByStripeIdEffect(stripeCustomerId);
    if (legacy) {
      return yield* syncLegacyCustomerToKortixEffect(legacy);
    }

    return null;
  }));
}

export async function upsertCustomer(data: {
  accountId: string;
  id: string;
  email?: string | null;
  provider?: string | null;
  active?: boolean | null;
}) {
  return runCustomerEffect(Effect.gen(function* () {
    const existing = yield* Effect.promise(() => getCustomerByAccountId(data.accountId));
    if (existing && existing.id !== data.id && existing.provider === (data.provider ?? existing.provider)) {
      yield* Effect.tryPromise(() =>
        database
          .update(billingCustomers)
          .set({
            email: data.email,
            active: data.active ?? existing.active,
            provider: data.provider ?? existing.provider,
          })
          .where(eq(billingCustomers.id, existing.id)),
      );

      return existing;
    }

    yield* Effect.tryPromise(() =>
      database
        .insert(billingCustomers)
        .values(data)
        .onConflictDoUpdate({
          target: billingCustomers.id,
          set: {
            email: data.email,
            active: data.active,
            provider: data.provider,
          },
        }),
    );

    yield* deactivateConflictingCustomersEffect(data.accountId, data.id, data.provider);

    return {
      accountId: data.accountId,
      id: data.id,
      email: data.email ?? null,
      provider: data.provider ?? null,
      active: data.active ?? null,
    };
  }));
}

/**
 * Remove a stored Stripe customer row by its id. Used to drop a stale mapping —
 * a customer id created under a different Stripe account (e.g. after the key was
 * repointed) that no longer exists, so a fresh one can be created and persisted.
 */
export async function deleteCustomerByStripeId(stripeCustomerId: string): Promise<void> {
  return runCustomerEffect(Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      database.delete(billingCustomers).where(eq(billingCustomers.id, stripeCustomerId)),
    );
  }));
}

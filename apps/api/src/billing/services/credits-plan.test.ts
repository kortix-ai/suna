import { describe, expect, mock, test } from 'bun:test';

// Production price catalog: the legacy prices below only exist there.
mock.module('../../config', () => ({
  config: new Proxy({} as Record<PropertyKey, unknown>, {
    get: (_target, key) => (key === 'INTERNAL_KORTIX_ENV' ? 'prod' : undefined),
  }),
}));

const {
  billingPeriodForSubscription,
  canonicalTier,
  getTier,
  monthlyCreditsForSubscription,
  planForSubscription,
  planMonthlyUsd,
  revenueCatProductMonthlyUsd,
} = await import('./tiers');

const CREDITS_PRICE = 'price_1UQEUsG6l1KZGqIrSUPCdtIO';
const CREDITS_TEST_PRICE = 'price_1UQERpG6l1KZGqIrIH1EuX7p';

function sub(items: Array<{ id: string; quantity?: number; unit?: number; interval?: 'month' | 'year' }>, metadata = {}) {
  return {
    metadata,
    items: {
      data: items.map((it) => ({
        quantity: it.quantity ?? 1,
        price: { id: it.id, unit_amount: it.unit ?? null, recurring: { interval: it.interval ?? 'month' } },
      })),
    },
  } as any;
}

describe('canonicalTier: every legacy plan key folds into credits', () => {
  test.each(['pro', 'per_seat', 'starter', 'team', 'scale', 'tier_2_20', 'tier_6_50', 'tier_25_200', 'tier_200_1000', 'tier_150_1200'])(
    '%s → credits',
    (key) => {
      expect(canonicalTier(key)).toBe('credits');
      expect(getTier(key).name).toBe('credits');
    },
  );

  test('current keys are themselves; unknown and null fail closed to none', () => {
    for (const key of ['none', 'free', 'credits', 'enterprise'] as const) expect(canonicalTier(key)).toBe(key);
    expect(canonicalTier('garbage')).toBe('none');
    expect(canonicalTier(null)).toBe('none');
  });

  test('every paid amount gets the same plan: managed models, 2,000 Apps', () => {
    expect(getTier('credits').models).toEqual(['all']);
    expect(getTier('tier_2_20').appLimit).toBe(2000);
  });
});

describe('monthlyCreditsForSubscription: the one allowance rule', () => {
  test('credits price: quantity × $0.01', () => {
    expect(monthlyCreditsForSubscription(sub([{ id: CREDITS_PRICE, quantity: 10_000 }]))).toBe(100);
    expect(monthlyCreditsForSubscription(sub([{ id: CREDITS_TEST_PRICE, quantity: 2_000 }]))).toBe(20);
  });

  test('per-seat: the full $40 a seat becomes credits (was $25)', () => {
    expect(monthlyCreditsForSubscription(sub([{ id: 'price_1TdyruG6l1KZGqIrMzPVmQSO', quantity: 6 }]))).toBe(240);
  });

  test('legacy monthly prices grant their price', () => {
    expect(monthlyCreditsForSubscription(sub([{ id: 'price_1RILb4G6l1KZGqIrhomjgDnO' }]))).toBe(20);
    expect(monthlyCreditsForSubscription(sub([{ id: 'price_1RILb3G6l1KZGqIrmauYPOiN' }]))).toBe(1000);
  });

  test('legacy yearly prices keep the monthly allowance, not price ÷ 12', () => {
    expect(monthlyCreditsForSubscription(sub([{ id: 'price_1ReH9uG6l1KZGqIrsvMLHViC', unit: 204_000, interval: 'year' }]))).toBe(200);
  });

  test('an unknown price grants its list price per month', () => {
    expect(monthlyCreditsForSubscription(sub([{ id: 'price_machine', unit: 4_000 }]))).toBe(40);
    expect(monthlyCreditsForSubscription(sub([{ id: 'price_machine_y', unit: 48_000, interval: 'year' }]))).toBe(40);
  });

  test('the free price grants 0 (the free plan has its own $2)', () => {
    expect(monthlyCreditsForSubscription(sub([{ id: 'price_1RIGvuG6l1KZGqIrw14abxeL', unit: 0 }]))).toBe(0);
  });
});

describe('planForSubscription: the price decides', () => {
  test('credits, legacy and per-seat prices are the credits plan; the free price is free', () => {
    expect(planForSubscription(sub([{ id: CREDITS_PRICE }]))).toBe('credits');
    expect(planForSubscription(sub([{ id: 'price_1TdyruG6l1KZGqIrMzPVmQSO' }]))).toBe('credits');
    expect(planForSubscription(sub([{ id: 'price_1RIGvuG6l1KZGqIrw14abxeL' }], { plan_key: 'tier_2_20' }))).toBe('free');
  });

  test('an unknown price falls back to our metadata, canonicalized', () => {
    expect(planForSubscription(sub([{ id: 'price_machine' }], { tier_key: 'pro' }))).toBe('credits');
    // The oldest subscriptions carry `tier`, not `tier_key`.
    expect(planForSubscription(sub([{ id: 'price_old_free', unit: 0 }], { tier: 'free' }))).toBe('free');
  });

  // 2026-10-15 prod audit: paying subscriptions with neither a known price nor
  // plan metadata resolved to no plan, so their accounts stayed on Free.
  test('with no known price and no metadata, the amount decides', () => {
    expect(planForSubscription(sub([{ id: 'price_unknown', unit: 2000 }], { trial_start: 'x' }))).toBe('credits');
    // $0 with no metadata: the stored plan decides (a comped account keeps its plan).
    expect(planForSubscription(sub([{ id: 'price_unknown', unit: 0 }]))).toBeNull();
    expect(planForSubscription({ items: { data: [] } })).toBeNull();
  });

  test.each(['plan_key', 'tier_key', 'tier'])(
    'Enterprise %s metadata cannot assign an operator-owned plan',
    (key) => {
      const metadata = { [key]: 'enterprise' };
      expect(planForSubscription(sub([{ id: 'price_unknown', unit: 2000 }], metadata))).toBe('credits');
      expect(planForSubscription(sub([{ id: 'price_unknown', unit: 0 }], metadata))).toBeNull();
      expect(planForSubscription(sub([{ id: CREDITS_PRICE }], metadata))).toBe('credits');
      expect(planForSubscription(sub([{ id: 'price_1RIGvuG6l1KZGqIrw14abxeL' }], metadata))).toBe('free');
    },
  );

  test('billing period comes from the price', () => {
    expect(billingPeriodForSubscription(sub([{ id: CREDITS_PRICE }]))).toBe('monthly');
    expect(billingPeriodForSubscription(sub([{ id: 'price_1ReH9uG6l1KZGqIrsvMLHViC', interval: 'year' }]))).toBe('yearly');
    expect(billingPeriodForSubscription(sub([{ id: 'price_1RqtrUG6l1KZGqIrEb8hLsk3', interval: 'year' }]))).toBe('yearly_commitment');
  });
});

describe('planMonthlyUsd: stored amount, legacy fallback', () => {
  test('the stored amount wins', () => {
    expect(planMonthlyUsd({ tier: 'credits', planMonthlyUsd: '150.00' })).toBe(150);
  });

  test('a row not yet backfilled falls back to its legacy plan', () => {
    expect(planMonthlyUsd({ tier: 'tier_6_50' })).toBe(50);
    expect(planMonthlyUsd({ tier: 'per_seat', seatCount: 3 })).toBe(120);
    expect(planMonthlyUsd({ tier: 'free' })).toBe(2);
  });

  test('mobile products map to monthly amounts', () => {
    expect(revenueCatProductMonthlyUsd('kortix_plus_monthly')).toBe(20);
    expect(revenueCatProductMonthlyUsd('ultra:ultra-monthly')).toBe(200);
    expect(revenueCatProductMonthlyUsd('unknown')).toBeNull();
  });
});

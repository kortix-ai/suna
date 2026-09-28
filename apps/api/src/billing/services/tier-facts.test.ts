/**
 * Billing facts every surface reads: which billing model is which, who pays for
 * compute, and which plans the pricing grid may advertise.
 *
 * Credit plans METER COMPUTE. The meter's gate used to be `isPerSeatAccount`,
 * which read literally hands every other billing model free compute — an
 * unbilled hole straight through the credit tiers. The candidate SQL that
 * mirrors `accountRowMetersCompute` runs on PostgreSQL in
 * compute-metering.integration.test.ts.
 *
 * Pure functions over the tier tables; no mocks.
 */
import { describe, expect, test } from 'bun:test';
import {
  accountMetersCompute,
  accountRowMetersCompute,
  isCreditPlanAccount,
  isPerSeatAccount,
} from './tiers';

describe('billing-model predicates', () => {
  // A credit account must never take seat paths (Stripe quantity, seat grants).
  test.each([
    ['per_seat', true, false],
    ['credit', false, true],
    ['legacy', false, false],
    ['', false, false],
    [null, false, false],
    [undefined, false, false],
  ])('%p: per-seat %p, credit plan %p', (model, perSeat, creditPlan) => {
    expect(isPerSeatAccount(model)).toBe(perSeat);
    expect(isCreditPlanAccount(model)).toBe(creditPlan);
  });
});

describe('compute metering covers every paying model', () => {
  test('both per_seat and credit are metered', () => {
    // The bug this pins: the meter gated on `isPerSeatAccount`, so a credit
    // account would have run unmetered — the customer pays a flat fee and the
    // compute it buys is never charged against the pool.
    expect(accountMetersCompute('per_seat')).toBe(true);
    expect(accountMetersCompute('credit')).toBe(true);
  });

  test('legacy and unset are NOT metered', () => {
    // Legacy customers never agreed to compute metering; charging them would be
    // the mirror-image bug.
    for (const m of ['legacy', null, undefined]) expect(accountMetersCompute(m)).toBe(false);
  });

  test('a free or trial account meters compute even though its billing_model is the legacy default', () => {
    // `billing_model` DEFAULTS to 'legacy', so every account that never
    // completed a checkout carries it: 233,380 free accounts and every admin
    // trial on prod (2026-09-18). Reading that default as "legacy customer"
    // gave them free, uncapped compute — one trial account ran 16,909 sandboxes
    // and was charged $0, while trial-admin.ts sized its grant on "sandbox
    // compute always debits the wallet".
    for (const tier of ['free', 'none', null, undefined]) {
      expect(accountRowMetersCompute({ billingModel: 'legacy', tier })).toBe(true);
      expect(accountRowMetersCompute({ billingModel: null, tier })).toBe(true);
    }
    // A per_seat tier on a legacy row is a seat plan whose model flip was missed.
    expect(accountRowMetersCompute({ billingModel: 'legacy', tier: 'per_seat' })).toBe(true);
  });

  test('a legacy PAID subscriber stays unmetered', () => {
    // These customers bought a flat plan that never included compute metering.
    // Charging them is a pricing decision, not a bug fix — it is one line in
    // LEGACY_PAID_TIERS_UNMETERED when that decision is made.
    for (const tier of ['tier_2_20', 'tier_6_50', 'tier_25_200', 'tier_200_1000', 'pro']) {
      expect(accountRowMetersCompute({ billingModel: 'legacy', tier })).toBe(false);
    }
  });

  test('a metered billing_model wins over any tier', () => {
    for (const tier of ['free', 'tier_2_20', 'per_seat', null]) {
      expect(accountRowMetersCompute({ billingModel: 'per_seat', tier })).toBe(true);
      expect(accountRowMetersCompute({ billingModel: 'credit', tier })).toBe(true);
    }
  });

  test('no credit account at all meters nothing', () => {
    expect(accountRowMetersCompute(null)).toBe(false);
    expect(accountRowMetersCompute(undefined)).toBe(false);
  });

});

/**
 * A plan may be advertised only once it can actually be sold.
 *
 * Checkout resolves a Stripe price and throws `No price configured for this
 * tier` when there is none. The v3 credit plans are defined before their Stripe
 * products exist, so listing them on `hidden: false` alone would put options in
 * the grid that fail the instant anyone clicks them.
 *
 * `getVisibleTiers()` therefore derives visibility from buyability, and a
 * hidden tier stays off the grid even when it has a price.
 */
describe('visibility follows buyability', () => {
  test('every advertised tier has a resolvable monthly price', async () => {
    const { getVisibleTiers, resolvePriceId } = await import('./tiers');
    const visible = getVisibleTiers();
    expect(visible.length).toBeGreaterThan(0);
    for (const tier of visible) {
      expect(resolvePriceId(tier.name, 'monthly')).not.toBeNull();
    }
  });

  test('grandfathered seats are never advertised, priced or not', async () => {
    const { getVisibleTiers } = await import('./tiers');
    expect(getVisibleTiers().some((t) => t.name === 'per_seat')).toBe(false);
  });
});

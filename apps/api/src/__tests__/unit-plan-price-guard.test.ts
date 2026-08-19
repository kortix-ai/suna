import { describe, expect, mock, test } from 'bun:test';

// Price-coverage tripwire: a plan the catalog calls sellable must resolve a
// real PROD Stripe price, and every no-price state must be an explicit,
// reviewed enumeration — not a silent getVisibleTiers() filter. tiers.ts boots
// env validation, so pin the config to prod for the price-table switch.
mock.module('../config', () => ({
  config: { INTERNAL_KORTIX_ENV: 'prod', KORTIX_LLM_MARKUP: undefined },
}));

const { PLAN_CATALOG, listPlanRecords } = await import('../billing/services/plan-catalog');
const { resolvePriceId, resolvePerSeatPriceId } = await import('../billing/services/tiers');

// Grandfathered/retired records that are KNOWN to have no Stripe price. Adding
// a key here is a reviewed decision; a key missing from here AND from Stripe is
// a broken plan.
const KNOWN_PRICELESS = new Set([
  'tier_150_1200', // legacy Enterprise Max — never had a price in any env
  'starter', // v3 flat plans: never sold, retired in the catalog
  'team',
  'scale',
]);

describe('plan price coverage (prod)', () => {
  test('the sellable seat plan resolves a prod per-seat price', () => {
    expect(resolvePerSeatPriceId()).toBeTruthy();
  });

  test('every current-status paid plan resolves a prod monthly price', () => {
    for (const record of listPlanRecords()) {
      if (record.status !== 'current') continue;
      if (record.price.amountUsd === 0 || record.shape === 'contract') continue;
      expect(resolvePriceId(record.key, 'monthly'), `current plan ${record.key}`).toBeTruthy();
    }
  });

  test('every priced non-current plan either resolves a price or is explicitly enumerated priceless', () => {
    for (const record of listPlanRecords()) {
      if (record.status === 'current' || record.status === 'non_plan') continue;
      if (record.price.amountUsd === 0 || record.shape === 'contract') continue;
      if (record.shape === 'seat') continue; // priced via resolvePerSeatPriceId above
      const price = resolvePriceId(record.key, 'monthly');
      if (!price) {
        expect(
          KNOWN_PRICELESS.has(record.key),
          `${record.key} has no prod price and is not in KNOWN_PRICELESS — either add the Stripe price or enumerate it deliberately`,
        ).toBe(true);
      }
    }
  });

  test('the priceless allowlist contains no key that actually has a price (stale entries)', () => {
    for (const key of KNOWN_PRICELESS) {
      expect(PLAN_CATALOG[key], `unknown catalog key ${key}`).toBeTruthy();
      expect(resolvePriceId(key, 'monthly'), `${key} gained a price — remove it from KNOWN_PRICELESS`).toBeNull();
    }
  });
});

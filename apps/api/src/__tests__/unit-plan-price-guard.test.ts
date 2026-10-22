import { describe, expect, mock, test } from 'bun:test';

// Price-coverage tripwire: the plans the catalog calls sellable (`free` and
// `credits`) must resolve a real PROD Stripe price, and the top-up packages
// must resolve a price per whole-dollar amount. tiers.ts boots env validation,
// so pin the config to prod for the price-table switch.
mock.module('../config', () => ({
  config: { INTERNAL_KORTIX_ENV: 'prod', KORTIX_LLM_MARKUP: undefined },
}));

const { PLAN_CATALOG } = await import('../billing/services/plan-catalog');
const { resolveFreePriceId, resolveCreditsPriceId, resolveCreditPriceId, planForPrice } = await import(
  '../billing/services/tiers'
);

describe('plan price coverage (prod)', () => {
  test('the credits plan resolves a prod subscription price that maps back to credits', () => {
    const priceId = resolveCreditsPriceId();
    expect(priceId).toBeTruthy();
    expect(planForPrice(priceId)).toBe('credits');
  });

  test('the free plan resolves a prod $0 price that maps back to free', () => {
    const priceId = resolveFreePriceId();
    expect(priceId).toBeTruthy();
    expect(planForPrice(priceId)).toBe('free');
  });

  test('every current-status plan that bills resolves a prod price', () => {
    const billed: string[] = [];
    for (const record of Object.values(PLAN_CATALOG).sort((a, b) => a.rank - b.rank)) {
      if (record.status !== 'current' || record.shape === 'contract') continue;
      billed.push(record.key);
      const priceId = record.key === 'free' ? resolveFreePriceId() : resolveCreditsPriceId();
      expect(priceId, `current plan ${record.key}`).toBeTruthy();
    }
    expect(billed).toEqual(['free', 'credits']);
  });

  test('every preset top-up amount resolves a prod price', () => {
    for (const amount of [10, 25, 50, 100, 250, 500]) {
      expect(resolveCreditPriceId(amount), `top-up $${amount}`).toBeTruthy();
    }
    expect(resolveCreditPriceId(7)).toBeNull();
  });

  test('an unknown price maps to no plan', () => {
    expect(planForPrice('price_not_a_real_price')).toBeNull();
    expect(planForPrice(null)).toBeNull();
  });
});

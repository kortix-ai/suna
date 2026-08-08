/**
 * Billing v3 — flat credit plans, and the seat plan they replace.
 *
 * Seats priced humans. The cost driver is agents, and agents run unattended: a
 * two-person team can run fifty of them, and a Kortix-as-a-Backend customer
 * serves end users who are not seats at all. So the plan now carries the credit
 * pool and the concurrency limit, and headcount leaves the price.
 *
 * Three properties are worth pinning, because each one fails silently:
 *
 *   1. NO included managed LLM (`models: []`). If a tier were given `['all']`
 *      the wallet would quietly start funding inference again, and a fixed
 *      monthly price would go back to being short model prices.
 *   2. Existing per-seat customers are GRANDFATHERED — same price, same grant,
 *      same session cap, and crucially their managed-model access is NOT
 *      withdrawn under them.
 *   3. Credit plans METER COMPUTE. The meter's gate used to be
 *      `isPerSeatAccount`, which read literally hands every other billing model
 *      free compute — an unbilled hole straight through the new tiers.
 *
 * Pure functions over the tier tables; no mocks.
 */
import { describe, expect, test } from 'bun:test';
import {
  INCLUDED_CREDITS_PER_SEAT_USD,
  PER_SEAT_PRICE_USD,
  accountIsFreeTierForModels,
  TOKEN_PRICE_MULTIPLIER,
  accountMetersCompute,
  getTier,
  isCreditPlanAccount,
  isLegacyAccount,
  isPerSeatAccount,
  tierGrantsAllModels,
} from '../../billing/services/tiers';

/** The ladder Marko approved. */
const CREDIT_PLANS = [
  { key: 'starter', price: 40, credits: 25, concurrency: 3 },
  { key: 'team', price: 200, credits: 125, concurrency: 10 },
  { key: 'scale', price: 800, credits: 500, concurrency: 30 },
] as const;

describe('the credit-plan ladder', () => {
  test.each(CREDIT_PLANS.map((p) => [p.key, p] as const))(
    '%s carries its price, pool and concurrency',
    (_key, plan) => {
      const tier = getTier(plan.key);
      expect(tier.monthlyPrice).toBe(plan.price);
      expect(tier.monthlyCredits).toBe(plan.credits);
      expect(tier.concurrentSessionLimit).toBe(plan.concurrency);
    },
  );

  test('every plan is sellable and visible', () => {
    for (const plan of CREDIT_PLANS) {
      const tier = getTier(plan.key);
      expect(tier.hidden).toBe(false);
      expect(tier.canPurchaseCredits).toBe(true);
    }
  });

  test('price : credits holds at 1.6 : 1 across the ladder', () => {
    // The ratio IS the ladder's coherence — it fixes gross margin at ~48% when a
    // plan burns its whole pool. A tier added off-ratio silently prices at a
    // different margin from its neighbours.
    for (const plan of CREDIT_PLANS) {
      expect(plan.price / plan.credits).toBeCloseTo(1.6, 10);
    }
  });

  test('a fully-burned pool still leaves ~48% gross margin', () => {
    // COGS is the pool at cost: customer-facing credits already carry the 1.2x
    // markup, so the real spend is pool / 1.2.
    for (const plan of CREDIT_PLANS) {
      const cogs = plan.credits / TOKEN_PRICE_MULTIPLIER;
      const margin = (plan.price - cogs) / plan.price;
      expect(margin).toBeGreaterThan(0.47);
      expect(margin).toBeLessThan(0.49);
    }
  });

  test('concurrency rises with price', () => {
    // "higher credit pools AND higher session concurrency" — a ladder where
    // concurrency is flat gives a bigger plan nothing but a bigger wallet.
    const limits = CREDIT_PLANS.map((p) => getTier(p.key).concurrentSessionLimit);
    for (let i = 1; i < limits.length; i++) expect(limits[i]).toBeGreaterThan(limits[i - 1]);
  });
});

describe('no included managed LLM', () => {
  test.each(CREDIT_PLANS.map((p) => p.key))('%s grants no managed models', (key) => {
    expect(getTier(key).models).toEqual([]);
    expect(tierGrantsAllModels(key)).toBe(false);
  });

  test.each(CREDIT_PLANS.map((p) => p.key))('%s wallet funds compute only', (key) => {
    // Same mechanism the free tier already uses: the wallet pays for sandbox
    // compute, managed premium inference is blocked, and BYOK / OpenCode /
    // ChatGPT-subscription paths are untouched.
    //
    // Asserted through the tier DATA and `tierGrantsAllModels`, deliberately NOT
    // through `accountIsFreeTierForModels`: the gateway's resolve-candidates
    // suite stubs that predicate to `tier === 'free'`, and because mock.module
    // shares one registry across co-run files, this test would read their stub
    // and fail on a green codebase. The data is the source of truth anyway —
    // the predicate is derived from it.
    expect(getTier(key).models.includes('all')).toBe(false);
    expect(tierGrantsAllModels(key)).toBe(false);
  });
});

describe('grandfathered per-seat accounts', () => {
  const seat = getTier('per_seat');

  test('price and grant are untouched', () => {
    expect(seat.monthlyPrice).toBe(PER_SEAT_PRICE_USD);
    expect(seat.monthlyCredits).toBe(INCLUDED_CREDITS_PER_SEAT_USD);
  });

  test('managed-model access is NOT withdrawn', () => {
    // The point of grandfathering. Flipping this to [] would silently revoke
    // paid-for inference from every existing customer at the next deploy.
    expect(seat.models).toEqual(['all']);
    expect(tierGrantsAllModels('per_seat')).toBe(true);
    expect(accountIsFreeTierForModels('per_seat')).toBe(false);
  });

  test('the session cap is untouched', () => {
    expect(seat.concurrentSessionLimit).toBe(200);
  });

  test('hidden from the self-serve grid but still resolvable', () => {
    // Hidden stops NEW signups; it must not stop an existing subscription from
    // resolving its own tier.
    expect(seat.hidden).toBe(true);
    expect(getTier('per_seat').name).toBe('per_seat');
  });
});

describe('billing-model predicates', () => {
  test('credit is its own model, distinct from seats and legacy', () => {
    expect(isCreditPlanAccount('credit')).toBe(true);
    expect(isPerSeatAccount('credit')).toBe(false);
    expect(isLegacyAccount('credit')).toBe(false);
  });

  test('per_seat is unchanged', () => {
    expect(isPerSeatAccount('per_seat')).toBe(true);
    expect(isCreditPlanAccount('per_seat')).toBe(false);
    expect(isLegacyAccount('per_seat')).toBe(false);
  });

  test('legacy and unset stay legacy', () => {
    for (const m of ['legacy', null, undefined]) {
      expect(isLegacyAccount(m)).toBe(true);
      expect(isCreditPlanAccount(m)).toBe(false);
    }
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

  test('the meter query lists exactly the metered models', async () => {
    // A second copy of this set lives in compute-metering.ts as a SQL `inArray`.
    // Drift there does not throw — it just stops charging one model.
    const src = await Bun.file(
      new URL('../../billing/services/compute-metering.ts', import.meta.url).pathname,
    ).text();
    const m = src.match(/const METERED_BILLING_MODELS = \[([^\]]+)\]/);
    expect(m).not.toBeNull();
    const listed = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(listed).toEqual(['credit', 'per_seat']);
    for (const model of listed) expect(accountMetersCompute(model)).toBe(true);
  });
});

/**
 * A plan may be advertised only once it can actually be sold.
 *
 * Checkout resolves a Stripe price and throws `No price configured for this
 * tier` when there is none. The v3 plans are defined here before their Stripe
 * products exist, so listing them on `hidden: false` alone would put three
 * options in the grid that fail the instant anyone clicks them.
 *
 * `getVisibleTiers()` therefore derives visibility from buyability. The plans
 * stay dark on their own and light up on their own when the prices land — no
 * flag to remember, and no window where the grid sells what billing cannot.
 */
describe('visibility follows buyability', () => {
  test('every advertised tier has a resolvable monthly price', async () => {
    const { getVisibleTiers, resolvePriceId } = await import('../../billing/services/tiers');
    const visible = getVisibleTiers();
    expect(visible.length).toBeGreaterThan(0);
    for (const tier of visible) {
      expect(resolvePriceId(tier.name, 'monthly')).not.toBeNull();
    }
  });

  test('the credit plans are dark until their Stripe prices exist', async () => {
    const { getVisibleTiers, resolvePriceId } = await import('../../billing/services/tiers');
    const visible = new Set(getVisibleTiers().map((t) => t.name));
    for (const plan of CREDIT_PLANS) {
      // Asserted as an implication, not a bare `false`: the day the prices are
      // added this test should keep passing, not start failing.
      const buyable = resolvePriceId(plan.key, 'monthly') !== null;
      expect(visible.has(plan.key)).toBe(buyable);
    }
  });

  test('grandfathered seats are never advertised, priced or not', async () => {
    const { getVisibleTiers } = await import('../../billing/services/tiers');
    expect(getVisibleTiers().some((t) => t.name === 'per_seat')).toBe(false);
  });
});

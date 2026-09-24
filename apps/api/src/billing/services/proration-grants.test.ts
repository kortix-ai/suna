import { describe, expect, test } from 'bun:test';
import { computeProrationGrant, type ProrationLine } from './proration-grants';

const SEAT_PRICE = 'price_seat_test';
// Configured legacy prices (tiers.ts): monthly price = monthly credits for these.
const TIER_6_50 = 'price_1RILb4G6l1KZGqIr5q0sybWn';
const TIER_12_100 = 'price_1RILb4G6l1KZGqIr5Y20ZLHm';
const TIER_200_1000 = 'price_1RILb3G6l1KZGqIrmauYPOiN';

const line = (amount: number, priceId: string | null, proration = true): ProrationLine => ({ amount, priceId, proration });

describe('computeProrationGrant', () => {
  test('added seats: net prorated seat charge × $25/$40', () => {
    expect(computeProrationGrant([line(-8000, SEAT_PRICE), line(12000, SEAT_PRICE)], { perSeatPriceId: SEAT_PRICE }))
      .toEqual({ kind: 'seats', netCents: 4000, credits: 25 });
  });

  test('a seat added with one day left buys one day of allowance, not a full month', () => {
    // 1 → 2 seats with 1/30 of the period left: $40/30 = $1.33.
    const decision = computeProrationGrant([line(-133, SEAT_PRICE), line(267, SEAT_PRICE)], { perSeatPriceId: SEAT_PRICE });
    expect(decision.kind).toBe('seats');
    expect(decision.kind === 'seats' && decision.credits).toBe(0.84);
  });

  test('removed seats grant nothing', () => {
    expect(computeProrationGrant([line(-4000, SEAT_PRICE)], { perSeatPriceId: SEAT_PRICE }).kind).toBe('none');
  });

  test('non-proration lines are ignored', () => {
    expect(computeProrationGrant([line(4000, SEAT_PRICE, false)], { perSeatPriceId: SEAT_PRICE }).kind).toBe('none');
  });

  test('plan upgrade: net charge at the target credits-per-dollar', () => {
    expect(computeProrationGrant([line(-2500, TIER_6_50), line(5000, TIER_12_100)], { perSeatPriceId: SEAT_PRICE }))
      .toEqual({ kind: 'upgrade', netCents: 2500, credits: 25, fromTier: 'tier_6_50', toTier: 'tier_12_100' });
  });

  test('an upgrade grant never exceeds one month of the target allowance', () => {
    const decision = computeProrationGrant([line(-100, TIER_6_50), line(500_000, TIER_200_1000)], { perSeatPriceId: SEAT_PRICE });
    expect(decision.kind === 'upgrade' && decision.credits).toBe(1000);
  });

  test('a downgrade grants nothing', () => {
    expect(computeProrationGrant([line(-5000, TIER_12_100), line(2500, TIER_6_50)], { perSeatPriceId: SEAT_PRICE }).kind).toBe('none');
  });

  test('prices that map to no plan grant nothing', () => {
    expect(computeProrationGrant([line(-100, 'price_unknown_a'), line(900, 'price_unknown_b')], { perSeatPriceId: SEAT_PRICE }).kind).toBe('none');
  });
});

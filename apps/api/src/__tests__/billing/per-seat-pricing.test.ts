// Billing v2 — pure-math unit tests for per-seat pricing: seat grants,
// auto-topup defaults, the claim-card gate, renewal grants, and the LLM markup.
// No mocks needed since these are pure functions on the tiers module. The
// compute price is pinned in billing/services/compute-metering.test.ts.

import { afterEach, describe, test, expect } from 'bun:test';
import {
  defaultAutoTopupForSeats,
  grantForSeats,
  INCLUDED_CREDITS_RATIO,
  canClaimPerSeat,
  llmPriceMarkup,
  resolveRenewalGrant,
} from '../../billing/services/tiers';

describe('Per-seat pricing math', () => {
  test('seat grant equals $25 included credits × seat count (NOT the $40 price)', () => {
    // The $40 seat includes $25 of usage credits; the other $15 is platform margin.
    expect(grantForSeats(1)).toBe(25);
    expect(grantForSeats(5)).toBe(125);
    expect(grantForSeats(10)).toBe(250);
  });

  test('seat counts below 1 are clamped to 1', () => {
    expect(grantForSeats(0)).toBe(25);
    expect(grantForSeats(-3)).toBe(25);
  });

  test('auto-topup defaults scale with seat count', () => {
    // A quarter seat-month of threshold and one seat-month of refill, per seat.
    expect(defaultAutoTopupForSeats(1)).toEqual({ threshold: 5, amount: 20 });
    expect(defaultAutoTopupForSeats(10)).toEqual({ threshold: 50, amount: 200 });
    expect(defaultAutoTopupForSeats(0)).toEqual({ threshold: 5, amount: 20 });
  });
});

describe('canClaimPerSeat — the "Claim seat-based pricing" card gate', () => {
  // The bug this guards against: a brand-new free user (billing_model null/legacy,
  // no machine) was shown the claim card; clicking it dead-ended on "nothing to
  // switch", and the card hid the normal top-up path — stranding them out of credits.

  test('NEW free user (legacy default, no machine) → hidden (regression)', () => {
    expect(canClaimPerSeat({ billingModel: null, hasLegacyMachine: false })).toBe(false);
    expect(canClaimPerSeat({ billingModel: undefined, hasLegacyMachine: false })).toBe(false);
    expect(canClaimPerSeat({ billingModel: 'legacy', hasLegacyMachine: false })).toBe(false);
  });

  test('genuine legacy account with a machine to migrate → shown', () => {
    expect(canClaimPerSeat({ billingModel: 'legacy', hasLegacyMachine: true })).toBe(true);
    expect(canClaimPerSeat({ billingModel: null, hasLegacyMachine: true })).toBe(true);
  });

  test('already on per-seat → hidden, even with a machine', () => {
    expect(canClaimPerSeat({ billingModel: 'per_seat', hasLegacyMachine: true })).toBe(false);
    expect(canClaimPerSeat({ billingModel: 'per_seat', hasLegacyMachine: false })).toBe(false);
  });

  test('active yearly commitment → hidden (migration would no-op)', () => {
    const future = new Date('2030-01-01T00:00:00Z');
    const now = new Date('2026-06-05T00:00:00Z');
    expect(canClaimPerSeat({
      billingModel: 'legacy', hasLegacyMachine: true,
      commitmentType: 'yearly_commitment', commitmentEndDate: future, now,
    })).toBe(false);
  });

  test('expired yearly commitment → shown again', () => {
    const past = new Date('2025-01-01T00:00:00Z');
    const now = new Date('2026-06-05T00:00:00Z');
    expect(canClaimPerSeat({
      billingModel: 'legacy', hasLegacyMachine: true,
      commitmentType: 'yearly_commitment', commitmentEndDate: past, now,
    })).toBe(true);
  });

  test('non-yearly commitment does not block the claim', () => {
    const future = new Date('2030-01-01T00:00:00Z');
    const now = new Date('2026-06-05T00:00:00Z');
    expect(canClaimPerSeat({
      billingModel: 'legacy', hasLegacyMachine: true,
      commitmentType: 'monthly', commitmentEndDate: future, now,
    })).toBe(true);
  });
});

describe('resolveRenewalGrant — the ONE renewal-grant rule', () => {
  test('the included-usage ratio is $25 of every $40', () => {
    expect(INCLUDED_CREDITS_RATIO).toBe(0.625);
  });

  test('per-seat: seats × $25, authoritative over the invoice amount', () => {
    expect(
      resolveRenewalGrant({ tierName: 'per_seat', billingModel: 'per_seat', seatCount: 3, amountPaidUsd: 120 }),
    ).toEqual({ credits: 75, description: 'Monthly renewal: 75 credits (3 seats)' });
    // Discounted invoice: the seat count still decides the grant.
    expect(
      resolveRenewalGrant({ tierName: 'per_seat', billingModel: 'per_seat', seatCount: 1, amountPaidUsd: 20 }).credits,
    ).toBe(25);
    // per-seat billing_model wins even when the tier column lags.
    expect(
      resolveRenewalGrant({ tierName: 'pro', billingModel: 'per_seat', seatCount: 2, amountPaidUsd: 80 }).credits,
    ).toBe(50);
  });

  test('a tier with a configured monthly grant keeps it unchanged', () => {
    expect(
      resolveRenewalGrant({ tierName: 'free', billingModel: 'legacy', seatCount: null, amountPaidUsd: 0 }),
    ).toEqual({ credits: 2, description: 'Monthly renewal: 2 credits' });
  });

  test('legacy zero-grant tiers resolve by the money that moved (stranded-payer regression)', () => {
    // The $40/mo "Kortix Computer · Pro" machine sub on legacy tier `pro`
    // (monthlyCredits 0) used to grant NOTHING on every paid renewal.
    expect(
      resolveRenewalGrant({ tierName: 'pro', billingModel: 'legacy', seatCount: null, amountPaidUsd: 40 }),
    ).toEqual({ credits: 25, description: 'Monthly renewal: 25 credits (legacy subscription, $40 paid)' });
    expect(
      resolveRenewalGrant({ tierName: 'pro', billingModel: null, seatCount: null, amountPaidUsd: 60 }).credits,
    ).toBe(37.5);
    expect(
      resolveRenewalGrant({ tierName: 'pro', billingModel: null, seatCount: null, amountPaidUsd: 80 }).credits,
    ).toBe(50);
  });

  test('nothing paid → nothing granted; negative amounts clamp to 0', () => {
    expect(resolveRenewalGrant({ tierName: 'pro', billingModel: null, seatCount: null, amountPaidUsd: 0 }).credits).toBe(0);
    expect(resolveRenewalGrant({ tierName: 'pro', billingModel: null, seatCount: null, amountPaidUsd: -5 }).credits).toBe(0);
  });
});

describe('LLM gateway markup', () => {
  const original = process.env.KORTIX_LLM_MARKUP;
  afterEach(() => {
    if (original === undefined) delete process.env.KORTIX_LLM_MARKUP;
    else process.env.KORTIX_LLM_MARKUP = original;
  });

  test('default markup is 1.2 (20% margin)', () => {
    delete process.env.KORTIX_LLM_MARKUP;
    expect(llmPriceMarkup()).toBe(1.2);
  });

  test('env override is honored', () => {
    process.env.KORTIX_LLM_MARKUP = '1.35';
    expect(llmPriceMarkup()).toBeCloseTo(1.35, 5);
  });

  test('values below 1 are rejected (never undercut OpenRouter)', () => {
    process.env.KORTIX_LLM_MARKUP = '0.8';
    expect(llmPriceMarkup()).toBe(1.2);
    process.env.KORTIX_LLM_MARKUP = '0';
    expect(llmPriceMarkup()).toBe(1.2);
    process.env.KORTIX_LLM_MARKUP = '-2';
    expect(llmPriceMarkup()).toBe(1.2);
  });

  test('non-numeric values fall back to default', () => {
    process.env.KORTIX_LLM_MARKUP = 'foo';
    expect(llmPriceMarkup()).toBe(1.2);
    process.env.KORTIX_LLM_MARKUP = '';
    expect(llmPriceMarkup()).toBe(1.2);
  });

});

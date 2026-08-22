// Billing v2 — pure-math unit tests for per-seat pricing and compute metering.
// No mocks needed since these are pure functions on the tiers/compute modules.

import { describe, test, expect } from 'bun:test';
import {
  CREDITS_PER_DOLLAR,
  PER_SEAT_PRICE_USD,
  TYPICAL_COMPUTE_BUDGET_PER_SEAT_USD,
  TYPICAL_LLM_BUDGET_PER_SEAT_USD,
  COMPUTE_CPU_PRICE_PER_CORE_SECOND,
  COMPUTE_MEMORY_PRICE_PER_GB_SECOND,
  COMPUTE_DISK_PRICE_PER_GB_SECOND,
  AUTO_TOPUP_DEFAULT_THRESHOLD_PER_SEAT,
  AUTO_TOPUP_DEFAULT_AMOUNT_PER_SEAT,
  DEFAULT_LLM_PRICE_MARKUP,
  defaultAutoTopupForSeats,
  grantForSeats,
  INCLUDED_CREDITS_RATIO,
  isPerSeatAccount,
  isLegacyAccount,
  canClaimPerSeat,
  llmPriceMarkup,
  resolveRenewalGrant,
} from '../../billing/services/tiers';

import { calculateComputeCost } from '../../billing/services/compute-metering';

describe('Per-seat pricing math', () => {
  test('$40/seat; typical compute+LLM budget split is a display figure ($25)', () => {
    expect(PER_SEAT_PRICE_USD).toBe(40);
    // Display-only "typical" split — illustrative usage, not a wallet partition,
    // so it doesn't have to equal the seat price.
    expect(TYPICAL_COMPUTE_BUDGET_PER_SEAT_USD + TYPICAL_LLM_BUDGET_PER_SEAT_USD).toBe(25);
  });

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
    const oneSeat = defaultAutoTopupForSeats(1);
    expect(oneSeat.threshold).toBe(AUTO_TOPUP_DEFAULT_THRESHOLD_PER_SEAT);
    expect(oneSeat.amount).toBe(AUTO_TOPUP_DEFAULT_AMOUNT_PER_SEAT);

    const tenSeats = defaultAutoTopupForSeats(10);
    expect(tenSeats.threshold).toBe(50);
    expect(tenSeats.amount).toBe(200);
  });
});

describe('billing_model guards', () => {
  test('isPerSeatAccount returns true only for explicit per_seat', () => {
    expect(isPerSeatAccount('per_seat')).toBe(true);
    expect(isPerSeatAccount('legacy')).toBe(false);
    expect(isPerSeatAccount(null)).toBe(false);
    expect(isPerSeatAccount(undefined)).toBe(false);
    expect(isPerSeatAccount('')).toBe(false);
  });

  test('isLegacyAccount returns true for anything not per_seat (safe default)', () => {
    expect(isLegacyAccount('legacy')).toBe(true);
    expect(isLegacyAccount(null)).toBe(true);
    expect(isLegacyAccount(undefined)).toBe(true);
    expect(isLegacyAccount('per_seat')).toBe(false);
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

  test('per-seat and the amount rule agree at the standard seat price', () => {
    const seats = 4;
    const bySeats = resolveRenewalGrant({
      tierName: 'per_seat', billingModel: 'per_seat', seatCount: seats, amountPaidUsd: PER_SEAT_PRICE_USD * seats,
    }).credits;
    expect(bySeats).toBe(PER_SEAT_PRICE_USD * seats * INCLUDED_CREDITS_RATIO);
  });

  test('nothing paid → nothing granted; negative amounts clamp to 0', () => {
    expect(resolveRenewalGrant({ tierName: 'pro', billingModel: null, seatCount: null, amountPaidUsd: 0 }).credits).toBe(0);
    expect(resolveRenewalGrant({ tierName: 'pro', billingModel: null, seatCount: null, amountPaidUsd: -5 }).credits).toBe(0);
  });
});

describe('Compute cost calculation', () => {
  const spec = { cpuCores: 2, memoryGb: 4, diskGb: 20, gpuCount: 0 };

  test('zero duration yields zero cost', () => {
    expect(calculateComputeCost(spec, 0)).toBe(0);
    expect(calculateComputeCost(spec, -5)).toBe(0);
  });

  test('cost matches 1.2× the published Daytona resource rates', () => {
    const seconds = 3600; // one hour
    const expected =
      (spec.cpuCores * COMPUTE_CPU_PRICE_PER_CORE_SECOND * seconds +
        spec.memoryGb * COMPUTE_MEMORY_PRICE_PER_GB_SECOND * seconds +
        spec.diskGb * COMPUTE_DISK_PRICE_PER_GB_SECOND * seconds);

    const actual = calculateComputeCost(spec, seconds);
    expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
  });

  test('hourly cost for a 2vCPU/4GB/20GB sandbox is exactly $0.201312', () => {
    const hourCost = calculateComputeCost(spec, 3600);
    expect(hourCost).toBeCloseTo(0.201312, 8);
  });

  test('2,500 credits covers about 125 hours of default compute', () => {
    const creditValueUsd = 2500 / CREDITS_PER_DOLLAR;
    const computeHours = creditValueUsd / calculateComputeCost(spec, 3600);
    expect(computeHours).toBeCloseTo(124.1853, 4);
  });

  test('all hosted providers use the same customer compute price', () => {
    const daytona = calculateComputeCost(spec, 3600, 'daytona');
    expect(calculateComputeCost(spec, 3600, 'platinum')).toBeCloseTo(daytona, 8);
    expect(calculateComputeCost(spec, 3600, 'e2b')).toBeCloseTo(daytona, 8);
  });

  test('cost scales linearly with both spec and time', () => {
    const baseline = calculateComputeCost(spec, 60);
    const doubleTime = calculateComputeCost(spec, 120);
    expect(doubleTime / baseline).toBeCloseTo(2, 5);

    const doubleSpec = calculateComputeCost(
      { ...spec, cpuCores: spec.cpuCores * 2, memoryGb: spec.memoryGb * 2, diskGb: spec.diskGb * 2 },
      60,
    );
    expect(doubleSpec / baseline).toBeCloseTo(2, 5);
  });

  test('monthly heavy usage exceeds the typical compute budget', () => {
    // 8h × 22 days of compute exceeds the $15 typical compute budget per seat,
    // funded from the fungible seat wallet.
    const monthlySeconds = 8 * 3600 * 22;
    const monthlyCost = calculateComputeCost(spec, monthlySeconds);
    expect(monthlyCost).toBeGreaterThan(TYPICAL_COMPUTE_BUDGET_PER_SEAT_USD);
    expect(monthlyCost).toBeLessThan(PER_SEAT_PRICE_USD);
    expect(monthlyCost).toBeCloseTo(35.430912, 5);
  });
});

describe('LLM gateway markup', () => {
  const original = process.env.KORTIX_LLM_MARKUP;
  const restore = () => {
    if (original === undefined) delete process.env.KORTIX_LLM_MARKUP;
    else process.env.KORTIX_LLM_MARKUP = original;
  };

  test('default markup is 1.2 (20% margin)', () => {
    delete process.env.KORTIX_LLM_MARKUP;
    expect(DEFAULT_LLM_PRICE_MARKUP).toBe(1.2);
    expect(llmPriceMarkup()).toBe(1.2);
    restore();
  });

  test('env override is honored', () => {
    process.env.KORTIX_LLM_MARKUP = '1.35';
    expect(llmPriceMarkup()).toBeCloseTo(1.35, 5);
    restore();
  });

  test('values below 1 are rejected (never undercut OpenRouter)', () => {
    process.env.KORTIX_LLM_MARKUP = '0.8';
    expect(llmPriceMarkup()).toBe(1.2);
    process.env.KORTIX_LLM_MARKUP = '0';
    expect(llmPriceMarkup()).toBe(1.2);
    process.env.KORTIX_LLM_MARKUP = '-2';
    expect(llmPriceMarkup()).toBe(1.2);
    restore();
  });

  test('non-numeric values fall back to default', () => {
    process.env.KORTIX_LLM_MARKUP = 'foo';
    expect(llmPriceMarkup()).toBe(1.2);
    process.env.KORTIX_LLM_MARKUP = '';
    expect(llmPriceMarkup()).toBe(1.2);
    restore();
  });

  test('markup of 1.5 yields 50% margin over upstream', () => {
    process.env.KORTIX_LLM_MARKUP = '1.5';
    const upstreamCost = 0.10;
    expect(upstreamCost * llmPriceMarkup()).toBeCloseTo(0.15, 5);
    restore();
  });
});

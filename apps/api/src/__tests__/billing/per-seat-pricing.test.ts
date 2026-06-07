// Billing v2 — pure-math unit tests for per-seat pricing and compute metering.
// No mocks needed since these are pure functions on the tiers/compute modules.

import { describe, test, expect } from 'bun:test';
import {
  PER_SEAT_PRICE_USD,
  TYPICAL_COMPUTE_BUDGET_PER_SEAT_USD,
  TYPICAL_LLM_BUDGET_PER_SEAT_USD,
  COMPUTE_CPU_PRICE_PER_CORE_SECOND,
  COMPUTE_MEMORY_PRICE_PER_GB_SECOND,
  COMPUTE_DISK_PRICE_PER_GB_SECOND,
  COMPUTE_PRICE_MARKUP,
  DAYTONA_DISCOUNT,
  AUTO_TOPUP_DEFAULT_THRESHOLD_PER_SEAT,
  AUTO_TOPUP_DEFAULT_AMOUNT_PER_SEAT,
  DEFAULT_LLM_PRICE_MARKUP,
  defaultAutoTopupForSeats,
  grantForSeats,
  isPerSeatAccount,
  isLegacyAccount,
  canClaimPerSeat,
  llmPriceMarkup,
} from '../../billing/services/tiers';

import { calculateComputeCost } from '../../billing/services/compute-metering';

describe('Per-seat pricing math', () => {
  test('$40/seat; typical compute+LLM budget split is a display figure ($20)', () => {
    expect(PER_SEAT_PRICE_USD).toBe(40);
    // Display-only "typical" split — illustrative usage, not a wallet partition,
    // so it doesn't have to equal the seat price.
    expect(TYPICAL_COMPUTE_BUDGET_PER_SEAT_USD + TYPICAL_LLM_BUDGET_PER_SEAT_USD).toBe(20);
  });

  test('seat grant equals $40 × seat count (single fungible wallet)', () => {
    expect(grantForSeats(1)).toBe(40);
    expect(grantForSeats(5)).toBe(200);
    expect(grantForSeats(10)).toBe(400);
  });

  test('seat counts below 1 are clamped to 1', () => {
    expect(grantForSeats(0)).toBe(40);
    expect(grantForSeats(-3)).toBe(40);
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

describe('Compute cost calculation', () => {
  const spec = { cpuCores: 2, memoryGb: 4, diskGb: 20, gpuCount: 0 };

  test('zero duration yields zero cost', () => {
    expect(calculateComputeCost(spec, 0)).toBe(0);
    expect(calculateComputeCost(spec, -5)).toBe(0);
  });

  test('cost matches reserved-spec × time × markup formula', () => {
    const seconds = 3600; // one hour
    const expected =
      (spec.cpuCores * COMPUTE_CPU_PRICE_PER_CORE_SECOND * seconds +
        spec.memoryGb * COMPUTE_MEMORY_PRICE_PER_GB_SECOND * seconds +
        spec.diskGb * COMPUTE_DISK_PRICE_PER_GB_SECOND * seconds) *
      DAYTONA_DISCOUNT *
      COMPUTE_PRICE_MARKUP;

    const actual = calculateComputeCost(spec, seconds);
    expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
  });

  test('hourly cost for a 2vCPU/4GB/20GB sandbox is roughly $0.10–0.15', () => {
    const hourCost = calculateComputeCost(spec, 3600);
    expect(hourCost).toBeGreaterThan(0.10);
    expect(hourCost).toBeLessThan(0.15);
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

  test('monthly heavy usage exceeds typical compute budget (overage funded via topup)', () => {
    // 8h × 22 days of compute exceeds the $12 typical compute budget per seat,
    // funded from the fungible seat wallet.
    const monthlySeconds = 8 * 3600 * 22;
    const monthlyCost = calculateComputeCost(spec, monthlySeconds);
    expect(monthlyCost).toBeGreaterThan(TYPICAL_COMPUTE_BUDGET_PER_SEAT_USD);
    expect(monthlyCost).toBeLessThan(PER_SEAT_PRICE_USD);
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

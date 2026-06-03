// Billing v2 — pure-math unit tests for per-seat pricing and compute metering.
// No mocks needed since these are pure functions on the tiers/compute modules.

import { describe, test, expect } from 'bun:test';
import {
  PER_SEAT_PRICE_USD,
  TYPICAL_COMPUTE_BUDGET_PER_SEAT_USD,
  TYPICAL_LLM_BUDGET_PER_SEAT_USD,
  defaultAutoTopupForSeats,
  isPerSeatAccount,
  llmPriceMarkup,
} from '../../billing/services/tiers';

describe('Per-seat pricing math', () => {
  test('$20/seat — typical budget split is display-only and adds up', () => {
    expect(PER_SEAT_PRICE_USD).toBe(20);
    expect(TYPICAL_COMPUTE_BUDGET_PER_SEAT_USD + TYPICAL_LLM_BUDGET_PER_SEAT_USD).toBe(20);
  });

  test('auto-topup defaults scale with seat count', () => {
    const oneSeat = defaultAutoTopupForSeats(1);
    expect(oneSeat.threshold).toBe(5);
    expect(oneSeat.amount).toBe(20);

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

});
describe('LLM gateway markup', () => {
  const original = process.env.KORTIX_LLM_MARKUP;
  const restore = () => {
    if (original === undefined) delete process.env.KORTIX_LLM_MARKUP;
    else process.env.KORTIX_LLM_MARKUP = original;
  };

  test('default markup is 1.2 (20% margin)', () => {
    delete process.env.KORTIX_LLM_MARKUP;
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

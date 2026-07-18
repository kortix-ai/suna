import { describe, expect, test } from 'bun:test';
import {
  isPureHoldRefund,
  reconcileBillingHold,
} from '../llm-gateway/billing-hold-reconciliation';

describe('reconcileBillingHold — the atomic admission-hold settlement math', () => {
  test('real cost exceeds the hold → collect the difference (top-up)', () => {
    expect(reconcileBillingHold(0.5, 0.01)).toEqual({ toDeduct: 0.49, toRefund: 0 });
  });

  test('real cost is below the hold → refund the unused portion', () => {
    expect(reconcileBillingHold(0, 0.01)).toEqual({ toDeduct: 0, toRefund: 0.01 });
  });

  test('real cost exactly matches the hold → nothing to move either way', () => {
    expect(reconcileBillingHold(0.01, 0.01)).toEqual({ toDeduct: 0, toRefund: 0 });
  });

  test('a pre-dispatch-failure hold refund (finalCost always 0) always fully refunds the hold', () => {
    expect(reconcileBillingHold(0, 0.01)).toEqual({ toDeduct: 0, toRefund: 0.01 });
    expect(reconcileBillingHold(0, 1)).toEqual({ toDeduct: 0, toRefund: 1 });
  });

  test('never returns a negative toDeduct or toRefund', () => {
    for (const [cost, hold] of [
      [0.5, 0.01],
      [0, 0.01],
      [0.01, 0.01],
      [100, 0.01],
      [0, 5],
    ] as const) {
      const { toDeduct, toRefund } = reconcileBillingHold(cost, hold);
      expect(toDeduct).toBeGreaterThanOrEqual(0);
      expect(toRefund).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('isPureHoldRefund', () => {
  test('true for a zero-usage, zero-cost event carrying a hold', () => {
    expect(
      isPureHoldRefund({
        billingHoldUsd: 0.01,
        promptTokens: 0,
        completionTokens: 0,
        finalCost: 0,
      }),
    ).toBe(true);
  });

  test('false when there is no hold at all', () => {
    expect(
      isPureHoldRefund({ promptTokens: 0, completionTokens: 0, finalCost: 0 }),
    ).toBe(false);
  });

  test('false when real usage/cost is present even with a hold (the normal settle() path)', () => {
    expect(
      isPureHoldRefund({
        billingHoldUsd: 0.01,
        promptTokens: 100,
        completionTokens: 20,
        finalCost: 0.05,
      }),
    ).toBe(false);
  });

  test('false when only completionTokens is non-zero', () => {
    expect(
      isPureHoldRefund({
        billingHoldUsd: 0.01,
        promptTokens: 0,
        completionTokens: 5,
        finalCost: 0,
      }),
    ).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import { autoTopupFailure, failureDisablesAutoTopup } from './auto-topup-failure';

const AT = '2026-10-08T03:00:00.000Z';
const row = (over: Partial<Parameters<typeof autoTopupFailure>[0]>) => ({
  autoTopupEnabled: true,
  autoTopupDisabledReason: null,
  autoTopupConsecutiveFailures: 0,
  autoTopupLastCharged: null,
  ...over,
});

describe('autoTopupFailure (KRTX-1718)', () => {
  test('no failed charge: nothing to show', () => {
    expect(autoTopupFailure(row({ autoTopupLastCharged: AT }))).toEqual({
      disabled_reason: null,
      last_failure_reason: null,
      last_failure_at: null,
    });
  });

  test('a soft failure while still on: the failure shows, auto top-up is not off', () => {
    expect(
      autoTopupFailure(row({ autoTopupDisabledReason: 'processing_error', autoTopupConsecutiveFailures: 1, autoTopupLastCharged: AT })),
    ).toEqual({ disabled_reason: null, last_failure_reason: 'processing_error', last_failure_at: AT });
  });

  test('a hard decline turned it off: the reason is the disabled reason', () => {
    expect(
      autoTopupFailure(
        row({ autoTopupEnabled: false, autoTopupDisabledReason: 'insufficient_funds', autoTopupConsecutiveFailures: 1, autoTopupLastCharged: new Date(AT) }),
      ),
    ).toEqual({ disabled_reason: 'insufficient_funds', last_failure_reason: 'insufficient_funds', last_failure_at: AT });
  });

  test('the third soft failure turned it off', () => {
    expect(
      autoTopupFailure(row({ autoTopupEnabled: false, autoTopupDisabledReason: 'no_payment_method', autoTopupConsecutiveFailures: 3, autoTopupLastCharged: AT }))
        .disabled_reason,
    ).toBe('no_payment_method');
  });

  test('turned off by hand after one soft failure: not a disabled reason', () => {
    expect(
      autoTopupFailure(row({ autoTopupEnabled: false, autoTopupDisabledReason: 'processing_error', autoTopupConsecutiveFailures: 1, autoTopupLastCharged: AT })),
    ).toEqual({ disabled_reason: null, last_failure_reason: 'processing_error', last_failure_at: AT });
  });

  test('which failures disable', () => {
    expect(failureDisablesAutoTopup('expired_card', 1)).toBe(true);
    expect(failureDisablesAutoTopup('payment_intent_status:requires_action', 2)).toBe(false);
    expect(failureDisablesAutoTopup('payment_intent_status:requires_action', 3)).toBe(true);
  });
});

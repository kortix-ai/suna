import { describe, test, expect } from 'bun:test';
import { validateAutoTopupConfig } from '../../billing/services/auto-topup';

describe('validateAutoTopupConfig — guards against spam-vector configurations', () => {
  test('disabled config is always valid', () => {
    expect(validateAutoTopupConfig({ enabled: false, threshold: 0, amount: 0 })).toBeNull();
  });

  test('threshold below minimum is rejected', () => {
    const err = validateAutoTopupConfig({ enabled: true, threshold: 0.5, amount: 20 });
    expect(err).toContain('Threshold must be at least');
  });

  test('amount below minimum is rejected', () => {
    const err = validateAutoTopupConfig({ enabled: true, threshold: 5, amount: 0.5 });
    expect(err).toContain('Reload amount must be at least $1');
  });

  test('amount equal to threshold is REJECTED (would loop forever)', () => {
    // Without the buffer, $5 topup at $5 threshold means every subsequent
    // debit triggers another charge — the email-spam scenario the user
    // wanted to prevent.
    const err = validateAutoTopupConfig({ enabled: true, threshold: 5, amount: 5 });
    expect(err).toContain('above the threshold');
  });

  test('amount slightly below threshold is REJECTED', () => {
    const err = validateAutoTopupConfig({ enabled: true, threshold: 10, amount: 9 });
    expect(err).toContain('above the threshold');
  });

  test('amount = threshold + buffer is accepted', () => {
    expect(validateAutoTopupConfig({ enabled: true, threshold: 5, amount: 6 })).toBeNull();
  });

  test('amount well above threshold is accepted', () => {
    expect(validateAutoTopupConfig({ enabled: true, threshold: 5, amount: 20 })).toBeNull();
    expect(validateAutoTopupConfig({ enabled: true, threshold: 1, amount: 5 })).toBeNull();
  });
});

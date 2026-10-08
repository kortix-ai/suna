import { describe, expect, test } from 'bun:test';
import { autoTopupFailureNotice } from './auto-topup-failure-notice';

const AT = '2026-10-08T03:00:00.000Z';
const base = { enabled: true, threshold: 5, amount: 20, disabled_reason: null, last_failure_reason: null, last_failure_at: null };

describe('autoTopupFailureNotice (KRTX-1718)', () => {
  test('no failure, or no settings: no notice', () => {
    expect(autoTopupFailureNotice(base, 'en')).toBeNull();
    expect(autoTopupFailureNotice(undefined, 'en')).toBeNull();
  });

  test('turned off by a failed charge: the turned-off notice with the reason', () => {
    const notice = autoTopupFailureNotice(
      { ...base, enabled: false, disabled_reason: 'insufficient_funds', last_failure_reason: 'insufficient_funds', last_failure_at: AT },
      'en',
    );
    expect(notice?.key).toBe('turnedOffAfterFailure');
    expect(notice?.values.reason).toBe('insufficient_funds');
    expect(notice?.values.date).toContain('2026');
  });

  test('still on after a soft failure: the retrying notice', () => {
    expect(
      autoTopupFailureNotice({ ...base, last_failure_reason: 'processing_error', last_failure_at: AT }, 'en')?.key,
    ).toBe('lastChargeFailed');
  });

  test('turned off by hand after a soft failure: nothing retries, no notice', () => {
    expect(
      autoTopupFailureNotice({ ...base, enabled: false, last_failure_reason: 'processing_error', last_failure_at: AT }, 'en'),
    ).toBeNull();
  });
});

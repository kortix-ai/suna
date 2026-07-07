import { describe, expect, test } from 'bun:test';

import { resolveCreateFailure } from './new-session-failure';

describe('resolveCreateFailure', () => {
  test('billing rejections open the upgrade dialog and stay on the page', () => {
    expect(resolveCreateFailure('subscription_required')).toBe('upgrade');
    expect(resolveCreateFailure('no_account')).toBe('upgrade');
  });

  test('the concurrent-session cap stays silent (global 429 handler owns it)', () => {
    expect(resolveCreateFailure('concurrent_session_limit')).toBe('silent');
  });

  test('everything else — including codeless network failures — surfaces a toast, never a redirect', () => {
    expect(resolveCreateFailure(undefined)).toBe('toast');
    expect(resolveCreateFailure('TIMEOUT')).toBe('toast');
    expect(resolveCreateFailure('internal_error')).toBe('toast');
  });
});

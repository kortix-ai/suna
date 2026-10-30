import { describe, expect, test } from 'bun:test';

import { isSilentTimeoutError, isSilentTimeoutMessage } from './timeout-toast-policy';

describe('timeout toast policy', () => {
  test('suppresses typed client and API request deadlines', () => {
    expect(
      isSilentTimeoutError({
        code: 'TIMEOUT',
        message: 'Request timed out after 30s: /projects/p/sessions/s/audit',
      }),
    ).toBe(true);
    expect(
      isSilentTimeoutError({
        status: 503,
        code: 'request_deadline',
        message: 'Request exceeded the 25s server processing deadline',
      }),
    ).toBe(true);
  });

  test('suppresses exact SDK and API deadline messages for direct errorToast calls', () => {
    expect(
      isSilentTimeoutMessage('Request timed out after 30s: /projects/p/sessions/s/audit'),
    ).toBe(true);
    expect(isSilentTimeoutMessage('Request exceeded the 25s server processing deadline')).toBe(
      true,
    );
  });

  test('does not suppress unrelated failures or generic third-party timeout text', () => {
    expect(isSilentTimeoutError({ status: 503, code: '503', message: 'sandbox waking up' })).toBe(
      false,
    );
    expect(isSilentTimeoutMessage('Network request timed out, please retry')).toBe(false);
    expect(isSilentTimeoutMessage('Failed to save project')).toBe(false);
  });
});

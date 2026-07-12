import { describe, expect, mock, test } from 'bun:test';

mock.module('../config', () => ({
  config: {
    KORTIX_BILLING_INTERNAL_ENABLED: false,
    INTERNAL_SERVICE_KEY: 'internal-test-key',
  },
}));

const { billingApp } = await import('../billing');

describe('billing cron route auth', () => {
  test('rejects ordinary authenticated users before rotation code can run', async () => {
    const res = await billingApp.request('/cron/yearly-rotation', {
      method: 'POST',
      headers: { Authorization: 'Bearer user-jwt' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Internal cron authentication required' });
  });

  test('allows the internal service key for scheduler callers', async () => {
    const res = await billingApp.request('/cron/free-tier-rotation', {
      method: 'POST',
      headers: { 'X-Kortix-Internal-Key': 'internal-test-key' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: true, reason: 'billing disabled' });
  });
});

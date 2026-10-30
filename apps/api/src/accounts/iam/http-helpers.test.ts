import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import {
  resolveBillingFromRow,
  type BillingRow,
} from '../../billing/services/resolve-billing';

let row: BillingRow | null = { tier: 'free' };
let entitled = false;
mock.module('../../billing/services/entitlements', () => ({
  accountHasEntitlement: async () => entitled,
}));
mock.module('../../billing/services/billing-cache', () => ({
  resolveAccountBilling: async () => resolveBillingFromRow(row),
}));
mock.module('../../shared/audit', () => ({ recordAuditEvent: async () => {} }));
const { requireEntitlement } = await import('./http-helpers');
const app = new Hono();
app.post(
  '/roles',
  async (c) =>
    (await requireEntitlement(c, 'synthetic-account', 'rbac')) ??
    c.json({ created: true }),
);

describe('IAM payment-required guidance', () => {
  test.each([
    [{ tier: 'free' }, 'Free'],
    [{ tier: 'credits' }, 'Credits'],
    [null, 'No Plan'],
  ] satisfies [BillingRow | null, string][])(
    'names the current billing plan for %j',
    async (billingRow, label) => {
      row = billingRow;
      const response = await app.request('/roles', { method: 'POST' });
      expect(response.status).toBe(402);
      const body = await response.json();
      expect(body.code).toBe('entitlement_required');
      expect(body.entitlement).toBe('rbac');
      expect(body.error).toContain(`Current plan: ${label}.`);
      expect(body.error).toContain('Enterprise demo');
      expect(body.error).toContain('talk to sales');
      expect(body.error).toContain('/settings/billing');
    },
  );

  test('allows an entitled account without a payment error', async () => {
    entitled = true;
    try {
      const response = await app.request('/roles', { method: 'POST' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ created: true });
    } finally {
      entitled = false;
    }
  });
});

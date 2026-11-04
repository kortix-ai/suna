import { expect, mock, test } from 'bun:test';
let sends = 0;
let calls = 0;
mock.module('./sales-customer-lookup', () => ({ enrichSalesCustomer: async (payload: Record<string, unknown>) => payload }));
mock.module('./sales-delivery', () => ({ SALES_MAX_ATTEMPTS: 20, salesRetryDelay: () => 1000, deliverSalesEvent: async () => { sends++; return null; } }));
mock.module('../config', () => ({ config: { SIGNUP_WEBHOOK_URL: 'https://example.test', SIGNUP_WEBHOOK_SECRET: 'synthetic' } }));
mock.module('../shared/db', () => ({ db: { execute: async () => ++calls === 1 ? [{ event_id: 'synthetic', payload: {}, attempts: 1 }] : [] } }));
const { processSalesOutbox } = await import('./sales-outbox');
test('a lease lost during slow enrichment prevents dispatch', async () => {
  sends = 0;
  calls = 0;
  // The real DB contract returns no row when the lease has expired or changed.
  await processSalesOutbox();
  expect(sends).toBe(0);
});

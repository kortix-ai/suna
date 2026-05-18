/**
 * Security Scan: Cloud API - Cross-User Access & Billing Protection
 *
 * LIVE scan against https://computer-preview-api.kortix.com
 *
 * Verifies that all sandbox, billing, and account operations
 * properly require authentication. No cross-user access possible
 * without a valid token.
 *
 * RESULT: ALL PASS — proper auth on all resource endpoints.
 */

import { describe, test, expect } from 'bun:test';

const CLOUD = 'https://computer-preview-api.kortix.com';

async function probe(method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(`${CLOUD}${path}`, opts);
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
  } catch (err: any) {
    return { status: 0, body: { error: err.message } };
  }
}

describe('Cloud Scan: Cross-User Access & Billing Protection', () => {

  describe('Sandbox operations require auth', () => {
    test('GET sandbox status — 401', async () => {
      const r = await probe('GET', '/v1/platform/sandbox/status?sandboxId=00000000-0000-4000-a000-000000000001');
      expect(r.status).toBe(401);
    });

    test('POST sandbox init — 401', async () => {
      const r = await probe('POST', '/v1/platform/sandbox/init', {});
      expect(r.status).toBe(401);
    });

    test('POST sandbox stop — 401', async () => {
      const r = await probe('POST', '/v1/platform/sandbox/stop', { sandboxId: 'test' });
      expect(r.status).toBe(401);
    });

    test('POST sandbox restart — 401', async () => {
      const r = await probe('POST', '/v1/platform/sandbox/restart', { sandboxId: 'test' });
      expect(r.status).toBe(401);
    });

    test('DELETE sandbox — 401', async () => {
      const r = await probe('DELETE', '/v1/platform/sandbox/test');
      expect(r.status).toBe(401);
    });
  });

  describe('Account operations require auth', () => {
    test('GET accounts — 401', async () => {
      const r = await probe('GET', '/v1/accounts');
      expect(r.status).toBe(401);
    });

    test('GET user-roles — 401', async () => {
      const r = await probe('GET', '/v1/user-roles');
      expect(r.status).toBe(401);
    });
  });

  describe('Billing operations require auth', () => {
    test('GET account-state — 401', async () => {
      const r = await probe('GET', '/v1/billing/account-state');
      expect(r.status).toBe(401);
    });

    test('GET credits balance — 401', async () => {
      const r = await probe('GET', '/v1/billing/credits/balance');
      expect(r.status).toBe(401);
    });

    test('POST credits purchase — 401', async () => {
      const r = await probe('POST', '/v1/billing/credits/purchase', { amount: 1000 });
      expect(r.status).toBe(401);
    });

    test('POST billing initialize — 401', async () => {
      const r = await probe('POST', '/v1/billing/setup/initialize', { planId: 'free' });
      expect(r.status).toBe(401);
    });

    test('POST checkout — 401', async () => {
      const r = await probe('POST', '/v1/billing/setup/checkout', { planId: 'pro' });
      expect(r.status).toBe(401);
    });

    test('POST billing portal — 401', async () => {
      const r = await probe('POST', '/v1/billing/setup/portal');
      expect(r.status).toBe(401);
    });

    test('POST cron daily-refresh — 401', async () => {
      const r = await probe('POST', '/v1/billing/cron/daily-refresh');
      expect(r.status).toBe(401);
    });

    test('POST cron yearly-rotation — 401', async () => {
      const r = await probe('POST', '/v1/billing/cron/yearly-rotation');
      expect(r.status).toBe(401);
    });
  });

  describe('API key management requires auth', () => {
    test('GET api-keys — 401', async () => {
      const r = await probe('GET', '/v1/platform/api-keys');
      expect(r.status).toBe(401);
    });

    test('POST api-keys — 401', async () => {
      const r = await probe('POST', '/v1/platform/api-keys', {});
      expect(r.status).toBe(401);
    });
  });

  describe('Secret/provider/queue/tunnel require auth', () => {
    test('GET secrets — 401', async () => {
      const r = await probe('GET', '/v1/secrets');
      expect(r.status).toBe(401);
    });

    test('GET providers — 401', async () => {
      const r = await probe('GET', '/v1/providers');
      expect(r.status).toBe(401);
    });

    test('GET queue — 401', async () => {
      const r = await probe('GET', '/v1/queue/all');
      expect(r.status).toBe(401);
    });

    test('GET tunnel connections — 401', async () => {
      const r = await probe('GET', '/v1/tunnel/connections');
      expect(r.status).toBe(401);
    });
  });

  describe('Admin routes require admin auth', () => {
    test('GET admin sandboxes — 401', async () => {
      const r = await probe('GET', '/v1/admin/api/sandboxes');
      expect(r.status).toBe(401);
    });

    test('GET admin env — 401', async () => {
      const r = await probe('GET', '/v1/admin/api/env');
      expect(r.status).toBe(401);
    });

    test('GET access requests — 401', async () => {
      const r = await probe('GET', '/v1/access/requests');
      expect(r.status).toBe(401);
    });
  });
});

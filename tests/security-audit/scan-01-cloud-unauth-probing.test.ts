/**
 * Security Scan: Cloud API - Unauthenticated Route Probing
 *
 * LIVE scan against https://computer-preview-api.kortix.com
 * Verifies every protected endpoint rejects unauthenticated requests (401)
 * and public endpoints do not leak sensitive information.
 *
 * FINDINGS:
 * - All protected endpoints correctly return 401
 * - /health exposes env mode ("cloud"), channel adapters, tunnel status
 * - /v1/access/signup-status reveals if signups are enabled (by design)
 * - /v1/setup/install-status reveals if platform is installed (by design)
 */

import { describe, test, expect } from 'bun:test';

const CLOUD = 'https://computer-preview-api.kortix.com';

async function probe(method: string, path: string, body?: any): Promise<{
  status: number;
  body: any;
}> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
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

describe('Cloud Scan: Unauthenticated Route Probing', () => {

  describe('Public endpoints accessible without auth', () => {
    test('GET /health returns 200', async () => {
      const r = await probe('GET', '/health');
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('ok');
    });

    test('GET /v1/health returns 200', async () => {
      const r = await probe('GET', '/v1/health');
      expect(r.status).toBe(200);
    });

    test('GET /v1/system/status returns 200', async () => {
      const r = await probe('GET', '/v1/system/status');
      expect(r.status).toBe(200);
    });

    test('POST /v1/prewarm returns 200', async () => {
      const r = await probe('POST', '/v1/prewarm');
      expect(r.status).toBe(200);
    });

    test('GET /v1/access/signup-status returns 200', async () => {
      const r = await probe('GET', '/v1/access/signup-status');
      expect(r.status).toBe(200);
    });

    test('GET /v1/setup/install-status returns 200', async () => {
      const r = await probe('GET', '/v1/setup/install-status');
      expect(r.status).toBe(200);
    });

    test('GET /v1/platform/sandbox/version returns 200 (public version info)', async () => {
      const r = await probe('GET', '/v1/platform/sandbox/version');
      expect(r.status).toBe(200);
      expect(r.body.version).toBeDefined();
    });
  });

  describe('Public endpoints do not leak secrets', () => {
    test('/health does not expose database/api secrets', async () => {
      const r = await probe('GET', '/health');
      const json = JSON.stringify(r.body);
      expect(json).not.toContain('postgresql://');
      expect(json).not.toContain('postgres://');
      expect(json).not.toContain('DATABASE_URL');
      expect(json).not.toContain('API_KEY_SECRET');
      expect(json).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(json).not.toContain('INTERNAL_SERVICE_KEY');
      expect(json).not.toContain('STRIPE_SECRET_KEY');
      expect(json).not.toContain('OPENROUTER_API_KEY');
    });

    test('/v1/system/status does not expose internal config', async () => {
      const r = await probe('GET', '/v1/system/status');
      const json = JSON.stringify(r.body);
      expect(json).not.toContain('secret');
      expect(json).not.toContain('password');
    });
  });

  describe('Supabase-auth protected endpoints return 401', () => {
    const routes = [
      '/v1/accounts',
      '/v1/user-roles',
      '/v1/billing/account-state',
      '/v1/legacy/threads',
      '/v1/setup/supabase-status',
      '/v1/billing/setup/plans',
      '/v1/billing/credits/packages',
    ];
    for (const path of routes) {
      test(`GET ${path} returns 401`, async () => {
        const r = await probe('GET', path);
        expect(r.status).toBe(401);
      });
    }
  });

  describe('Combined-auth protected endpoints return 401', () => {
    const routes = [
      '/v1/servers',
      '/v1/queue/all',
      '/v1/tunnel/connections',
    ];
    for (const path of routes) {
      test(`GET ${path} returns 401`, async () => {
        const r = await probe('GET', path);
        expect(r.status).toBe(401);
      });
    }
  });

  describe('API-key protected endpoints return 401', () => {
    const routes = [
      '/v1/router/models',
    ];
    for (const path of routes) {
      test(`GET ${path} returns 401`, async () => {
        const r = await probe('GET', path);
        expect(r.status).toBe(401);
      });
    }
  });

  describe('Admin endpoints return 401', () => {
    const routes = [
      '/v1/admin/api/sandboxes',
      '/v1/admin/api/env',
      '/v1/admin/api/health',
      '/v1/access/requests',
    ];
    for (const path of routes) {
      test(`GET ${path} returns 401`, async () => {
        const r = await probe('GET', path);
        expect(r.status).toBe(401);
      });
    }
  });

  describe('Non-existent routes return 404 with no info leakage', () => {
    test('GET /v1/does-not-exist returns 404', async () => {
      const r = await probe('GET', '/v1/does-not-exist');
      expect(r.status).toBe(404);
      expect(r.body.message).toBe('Not found');
    });

    test('GET /.env returns 404', async () => {
      const r = await probe('GET', '/.env');
      expect(r.status).toBe(404);
    });

    test('GET /.git/config returns 404', async () => {
      const r = await probe('GET', '/.git/config');
      expect(r.status).toBe(404);
    });

    test('404 does not suggest routes', async () => {
      const r = await probe('GET', '/v1/does-not-exist');
      const json = JSON.stringify(r.body);
      expect(json).not.toContain('Did you mean');
      expect(json).not.toContain('Available');
    });
  });
});

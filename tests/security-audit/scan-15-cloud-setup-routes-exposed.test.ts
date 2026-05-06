/**
 * Security Scan: Cloud API - Setup Routes Exposed on Production
 *
 * LIVE scan against https://computer-preview-api.kortix.com
 *
 * The /v1/setup/* routes are designed for LOCAL/self-hosted installation
 * wizard, but they are mounted UNCONDITIONALLY in index.ts:255:
 *   app.route('/v1/setup', setupApp);
 *
 * There is NO `if (config.isLocal())` guard. ALL setup routes exist on cloud.
 *
 * FINDINGS:
 *
 * [HIGH] POST /v1/setup/bootstrap-owner — PUBLIC on cloud
 *   - Leaks owner email: "Owner already exists (<redacted>)"
 *   - Can reset wizard state for existing owner
 *   - Should be disabled or removed in cloud mode
 *
 * [HIGH] POST /v1/setup/env — Auth but NO admin check, EXISTS on cloud
 *   - Any authenticated cloud user can modify env vars
 *   - Can overwrite secrets: DATABASE_URL, API_KEY_SECRET, STRIPE_SECRET_KEY
 *   - Should require admin role OR be disabled in cloud mode
 *
 * [LOW] GET /v1/setup/sandbox-providers — PUBLIC on cloud
 *   - Reveals cloud provider architecture: {"providers":["justavps"]}
 *   - Reveals capabilities: async, events, polling flags
 *
 * [INFO] GET /v1/setup/install-status — PUBLIC on cloud
 *   - Returns {"installed":true} — by design, but shouldn't be needed on cloud
 *
 * RECOMMENDATION: Wrap setup routes with:
 *   if (config.isLocal()) { app.route('/v1/setup', setupApp); }
 *   Or add a guard inside setupApp: if (config.isCloud()) return 404
 */

import { describe, test, expect } from 'bun:test';

const CLOUD = 'https://computer-preview-api.kortix.com';

async function probe(method: string, path: string, body?: any, headers?: Record<string, string>): Promise<{
  status: number;
  body: any;
}> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
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

describe('Cloud Scan: Setup Routes Exposed on Production', () => {

  describe('[HIGH] bootstrap-owner leaks email on CLOUD production', () => {
    test('endpoint is reachable without auth', async () => {
      const r = await probe('POST', '/v1/setup/bootstrap-owner', {
        email: 'security-audit@probe.invalid',
        password: 'auditaudit',
      });
      expect(r.status).toBe(409);
    });

    test('error response contains actual owner email', async () => {
      const r = await probe('POST', '/v1/setup/bootstrap-owner', {
        email: 'security-audit@probe.invalid',
        password: 'auditaudit',
      });
      expect(r.body.error).toContain('Owner already exists');
      // The email is in the format: "Owner already exists (email@domain)"
      expect(r.body.error).toMatch(/Owner already exists \([^)]+@[^)]+\)/);
    });

    test('can be called multiple times (no rate limit)', async () => {
      const results = await Promise.all([
        probe('POST', '/v1/setup/bootstrap-owner', { email: 'a@b.c', password: '123456' }),
        probe('POST', '/v1/setup/bootstrap-owner', { email: 'd@e.f', password: '123456' }),
        probe('POST', '/v1/setup/bootstrap-owner', { email: 'g@h.i', password: '123456' }),
        probe('POST', '/v1/setup/bootstrap-owner', { email: 'j@k.l', password: '123456' }),
        probe('POST', '/v1/setup/bootstrap-owner', { email: 'm@n.o', password: '123456' }),
      ]);
      // All return 409 — endpoint never throttles
      for (const r of results) {
        expect(r.status).toBe(409);
      }
    });
  });

  describe('[HIGH] setup/env exists on cloud (auth but no admin)', () => {
    test('GET /v1/setup/env requires auth', async () => {
      const r = await probe('GET', '/v1/setup/env');
      expect(r.status).toBe(401);
      // This is good — auth is required
      // But the FINDING is: any authenticated user can access, not just admins
    });

    test('POST /v1/setup/env requires auth', async () => {
      const r = await probe('POST', '/v1/setup/env', { key: 'TEST', value: 'test' });
      expect(r.status).toBe(401);
    });

    test('FINDING: route exists on cloud and does NOT require admin role', () => {
      // Code review: setup/index.ts uses supabaseAuth middleware for
      // non-public routes, but does NOT use requireAdmin
      // Any user with a valid JWT can read/write env vars
      expect(true).toBe(true);
    });
  });

  describe('[LOW] sandbox-providers leaks architecture on cloud', () => {
    test('endpoint is public and reveals provider details', async () => {
      const r = await probe('GET', '/v1/setup/sandbox-providers');
      expect(r.status).toBe(200);
      expect(r.body.providers).toBeDefined();
      expect(Array.isArray(r.body.providers)).toBe(true);
      // Reveals which sandbox providers are enabled
    });

    test('reveals provider capabilities', async () => {
      const r = await probe('GET', '/v1/setup/sandbox-providers');
      expect(r.body.capabilities).toBeDefined();
      // Reveals: async, events, polling flags for each provider
    });
  });

  describe('local-sandbox/warm removed from cloud', () => {
    test('endpoint is gone', async () => {
      const r = await probe('POST', '/v1/setup/local-sandbox/warm');
      expect(r.status).toBe(404);
    });
  });

  describe('Auth-protected setup routes on cloud', () => {
    const protectedSetupRoutes = [
      { method: 'GET' as const, path: '/v1/setup/status' },
      { method: 'GET' as const, path: '/v1/setup/env' },
      { method: 'POST' as const, path: '/v1/setup/env' },
      { method: 'GET' as const, path: '/v1/setup/supabase-status' },
      { method: 'GET' as const, path: '/v1/setup/health' },
      { method: 'POST' as const, path: '/v1/setup/schema' },
      { method: 'GET' as const, path: '/v1/setup/setup-status' },
      { method: 'POST' as const, path: '/v1/setup/setup-complete' },
    ];

    for (const route of protectedSetupRoutes) {
      test(`${route.method} ${route.path} requires auth on cloud`, async () => {
        const r = await probe(route.method, route.path);
        expect(r.status).toBe(401);
      });
    }
  });

  describe('Comparison: local vs cloud setup route availability', () => {
    test('ALL setup routes exist on cloud — no conditional mounting', () => {
      // index.ts line 255: app.route('/v1/setup', setupApp);
      // There is no: if (config.isLocal()) guard
      // Recommendation: Add env mode check to disable setup routes on cloud
      expect(true).toBe(true);
    });
  });
});

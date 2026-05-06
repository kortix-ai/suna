/**
 * Security Scan: Cloud API - ALL Setup Routes Should Return 404
 *
 * LIVE scan against https://computer-preview-api.kortix.com
 *
 * Setup routes are for local/self-hosted ONLY. They should NOT exist on cloud.
 * Currently they're mounted unconditionally in index.ts:255.
 *
 * Fix in index.ts:
 *   if (config.isLocal()) {
 *     app.route('/v1/setup', setupApp);
 *   }
 *
 * This test documents every setup route that currently responds on cloud
 * and what it returns. ALL of these should return 404 on cloud.
 */

import { describe, test, expect } from 'bun:test';

const CLOUD = 'https://computer-preview-api.kortix.com';

async function probe(method: string, path: string, body?: any): Promise<{
  status: number;
  body: any;
}> {
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

describe('Cloud Scan: Setup Routes Should Be Disabled (all should 404)', () => {

  describe('PUBLIC setup routes that should NOT exist on cloud', () => {
    test('GET /v1/setup/install-status — returns 200 (should be 404 on cloud)', async () => {
      const r = await probe('GET', '/v1/setup/install-status');
      // Currently returns 200 {"installed":true}
      // Should return 404 on cloud — not needed
      expect(r.status).toBe(200);
      // EXPECTED after fix: expect(r.status).toBe(404);
    });

    test('GET /v1/setup/sandbox-providers — returns 200 (should be 404 on cloud)', async () => {
      const r = await probe('GET', '/v1/setup/sandbox-providers');
      // Currently returns 200 with provider architecture details
      expect(r.status).toBe(200);
      expect(r.body.providers).toContain('justavps');
    });

    test('POST /v1/setup/bootstrap-owner — returns 409 (should be 404 on cloud)', async () => {
      const r = await probe('POST', '/v1/setup/bootstrap-owner', {
        email: 'probe@test.invalid',
        password: 'probe123',
      });
      // Currently returns 409 AND LEAKS THE OWNER EMAIL
      expect(r.status).toBe(409);
      expect(r.body.error).toContain('Owner already exists');
    });

    test('POST /v1/setup/local-sandbox/warm — removed', async () => {
      const r = await probe('POST', '/v1/setup/local-sandbox/warm');
      expect(r.status).toBe(404);
    });

    test('GET /v1/setup/local-sandbox/warm/status — removed', async () => {
      const r = await probe('GET', '/v1/setup/local-sandbox/warm/status');
      expect(r.status).toBe(404);
    });
  });

  describe('AUTH-PROTECTED setup routes that should NOT exist on cloud', () => {
    test('GET /v1/setup/status — returns 401 (should be 404 on cloud)', async () => {
      const r = await probe('GET', '/v1/setup/status');
      // Returns 401 (auth required) — but the route shouldn't exist at all
      expect(r.status).toBe(401);
    });

    test('GET /v1/setup/env — returns 401 (should be 404 on cloud)', async () => {
      const r = await probe('GET', '/v1/setup/env');
      expect(r.status).toBe(401);
    });

    test('POST /v1/setup/env — returns 401 (should be 404 on cloud)', async () => {
      const r = await probe('POST', '/v1/setup/env', { key: 'TEST', value: 'x' });
      expect(r.status).toBe(401);
    });

    test('GET /v1/setup/supabase-status — returns 401 (should be 404 on cloud)', async () => {
      const r = await probe('GET', '/v1/setup/supabase-status');
      expect(r.status).toBe(401);
    });

    test('GET /v1/setup/health — returns 401 (should be 404 on cloud)', async () => {
      const r = await probe('GET', '/v1/setup/health');
      expect(r.status).toBe(401);
    });

    test('POST /v1/setup/schema — returns 401 (should be 404 on cloud)', async () => {
      const r = await probe('POST', '/v1/setup/schema');
      expect(r.status).toBe(401);
    });

    test('GET /v1/setup/setup-status — returns 401 (should be 404 on cloud)', async () => {
      const r = await probe('GET', '/v1/setup/setup-status');
      expect(r.status).toBe(401);
    });

    test('POST /v1/setup/setup-complete — returns 401 (should be 404 on cloud)', async () => {
      const r = await probe('POST', '/v1/setup/setup-complete');
      expect(r.status).toBe(401);
    });

    test('GET /v1/setup/setup-wizard-step — returns 401 (should be 404 on cloud)', async () => {
      const r = await probe('GET', '/v1/setup/setup-wizard-step');
      expect(r.status).toBe(401);
    });

    test('POST /v1/setup/setup-wizard-step — returns 401 (should be 404 on cloud)', async () => {
      const r = await probe('POST', '/v1/setup/setup-wizard-step', { step: 1 });
      expect(r.status).toBe(401);
    });
  });

  describe('Summary: routes that should not exist on cloud', () => {
    test('13 setup routes exist on cloud — ALL should be removed', () => {
      const routesOnCloud = [
        'GET /v1/setup/install-status',        // public, returns 200
        'GET /v1/setup/sandbox-providers',      // public, returns 200
        'POST /v1/setup/bootstrap-owner',       // public, LEAKS EMAIL
        'GET /v1/setup/status',                 // auth, returns 401
        'GET /v1/setup/env',                    // auth, NO ADMIN CHECK
        'POST /v1/setup/env',                   // auth, NO ADMIN CHECK
        'GET /v1/setup/supabase-status',        // auth, returns 401
        'GET /v1/setup/health',                 // auth, returns 401
        'POST /v1/setup/schema',                // auth, returns 401
        'GET /v1/setup/setup-status',           // auth, returns 401
        'POST /v1/setup/setup-complete',        // auth, returns 401
        'GET /v1/setup/setup-wizard-step',      // auth, returns 401
        'POST /v1/setup/setup-wizard-step',     // auth, returns 401
      ];
      expect(routesOnCloud.length).toBe(15);
    });
  });
});

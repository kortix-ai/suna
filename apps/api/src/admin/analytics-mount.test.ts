/**
 * The analytics router has NO auth middleware of its own — it relies entirely on
 * inheriting `adminApp.use('*', supabaseAuth, requireAdmin)`. That is a safe
 * design only while the mount stays below the gate, and nothing in the type
 * system enforces the ordering.
 *
 * These tests drive the real `adminApp` and assert an unauthenticated request to
 * each analytics route is rejected before the handler runs. If someone moves the
 * `adminApp.route('/analytics', analyticsApp)` line above the `use('*')` block,
 * or drops the gate, these fail instead of the endpoints quietly becoming
 * public.
 */
import { describe, expect, test } from 'bun:test';

import { adminApp } from './index';

const ANALYTICS_ROUTES = ['/analytics/activity', '/analytics/usage'] as const;

describe('admin analytics auth inheritance', () => {
  for (const path of ANALYTICS_ROUTES) {
    test(`GET ${path} without a token is rejected by the inherited admin gate`, async () => {
      const response = await adminApp.request(path, { method: 'GET' });
      // 401 is the contract. Accept 403 too so the test still proves "rejected"
      // if the gate's anon status ever changes — what it must never do is 200.
      expect([401, 403]).toContain(response.status);
    });

    test(`GET ${path} with a garbage bearer token is still rejected`, async () => {
      const response = await adminApp.request(path, {
        method: 'GET',
        headers: { Authorization: 'Bearer not-a-real-jwt' },
      });
      expect([401, 403]).toContain(response.status);
    });
  }

  test('the analytics routes are actually registered on adminApp', () => {
    // A typo in the mount path would make the tests above pass for the wrong
    // reason (404 is not in the accepted set, but a future refactor could make
    // it so). Assert the routes exist in Hono's table.
    const registered = new Set(
      (adminApp as unknown as { routes: Array<{ method: string; path: string }> }).routes
        .filter((r) => r.method.toUpperCase() === 'GET')
        .map((r) => r.path),
    );
    for (const path of ANALYTICS_ROUTES) {
      expect(registered.has(path)).toBe(true);
    }
  });
});

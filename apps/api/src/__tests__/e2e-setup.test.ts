/**
 * Billing no-DB guard tests.
 */

import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Billing no-DB guard', () => {
  it('buildLocalAccountState returns valid structure', async () => {
    const { buildLocalAccountState } = await import('../billing/services/account-state');
    const state = buildLocalAccountState();

    expect(state.credits).toBeDefined();
    expect(state.credits.total).toBe(0);
    expect(state.credits.can_run).toBe(true);

    expect(state.subscription).toBeDefined();
    expect(state.subscription.tier_key).toBe('free');
    expect(state.subscription.status).toBe('active');

    expect(state.tier).toBeDefined();
    expect(state.tier.name).toBe('free');
    expect(state.tier.display_name).toBe('Free');
  });

  it('account-state route uses hasDatabase guard', async () => {
    const { hasDatabase } = await import('../shared/db');
    const { accountStateRouter } = await import('../billing/routes/account-state');
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as any).set('userId', '00000000-0000-0000-0000-000000000000');
      await next();
    });
    app.route('/account-state', accountStateRouter);

    const res = await app.request('/account-state');
    expect(res.status).toBe(200);
    const data = await res.json();

    if (!hasDatabase) {
      // No DB: should return local mock state
      expect(data.credits.total).toBe(0);
      expect(data.subscription.tier_key).toBe('free');
    } else {
      // DB available: should return real state (won't be 999999)
      expect(data.credits).toBeDefined();
      expect(data.subscription).toBeDefined();
    }
  }, 10_000);

});

describe('Database guard checks', () => {
  it('hasDatabase is exposed as a boolean', async () => {
    const { hasDatabase } = await import('../shared/db');
    expect(typeof hasDatabase).toBe('boolean');
  });

  it('account-state route source checks hasDatabase', async () => {
    const content = readFileSync(
      resolve(__dirname, '../billing/routes/account-state.ts'),
      'utf-8'
    );
    expect(content).toContain('hasDatabase');
    expect(content).toContain('buildLocalAccountState');
  });
});

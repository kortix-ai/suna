/**
 * E2E tests for /v1/setup/* routes (local-only).
 *
 * These tests verify:
 *  1. Setup routes are mounted in local mode
 *  2. GET /v1/setup/status returns system info
 *  3. GET /v1/setup/health returns service health
 *
 * Also verifies billing and scheduler no-DB guards.
 */

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { Hono } from 'hono';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { resolve } from 'path';

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', '00000000-0000-0000-0000-000000000000');
    c.set('userEmail', 'test@example.com');
    await next();
  },
}));

const { setupApp } = await import('../setup');

const TEST_DIR = `/tmp/kortix-setup-test-${Date.now()}`;

// ─── Test app factory ───────────────────────────────────────────────────────

function createSetupTestApp() {
  const app = new Hono();
  app.route('/v1/setup', setupApp);
  app.notFound((c) => c.json({ error: true, message: 'Not found', status: 404 }, 404));
  return app;
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(() => {
  // Create test project structure
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(resolve(TEST_DIR, 'scripts'), { recursive: true });
  mkdirSync(resolve(TEST_DIR, 'deploy', 'docker', 'sandbox'), { recursive: true });
  mkdirSync(resolve(TEST_DIR, 'apps', 'api'), { recursive: true });
  mkdirSync(resolve(TEST_DIR, 'apps/web'), { recursive: true });

  writeFileSync(resolve(TEST_DIR, 'docker-compose.local.yml'), 'services:\n  test:\n    image: hello-world\n');
  writeFileSync(resolve(TEST_DIR, 'scripts', 'setup-env.sh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(resolve(TEST_DIR, '.env.example'), 'ENV_MODE=local\nANTHROPIC_API_KEY=\n');
  writeFileSync(resolve(TEST_DIR, 'deploy', 'docker', 'sandbox', '.env.example'), 'ANTHROPIC_API_KEY=\nENV_MODE=local\n');

  // Point CWD at the test dir so getProjectRoot() finds it
  process.chdir(TEST_DIR);
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('/v1/setup', () => {

  describe('GET /v1/setup/status', () => {
    it('returns 200', async () => {
      const app = createSetupTestApp();
      const res = await app.request('/v1/setup/status');
      expect(res.status).toBe(200);
    });

    it('returns envMode', async () => {
      const app = createSetupTestApp();
      const res = await app.request('/v1/setup/status');
      const data = await res.json();
      expect(data.envMode).toBeDefined();
    });

    it('returns dockerRunning boolean', async () => {
      const app = createSetupTestApp();
      const res = await app.request('/v1/setup/status');
      const data = await res.json();
      expect(typeof data.dockerRunning).toBe('boolean');
    });

    it('reports envExists correctly (initially false)', async () => {
      // Remove .env if it exists
      rmSync(resolve(TEST_DIR, '.env'), { force: true });
      const app = createSetupTestApp();
      const res = await app.request('/v1/setup/status');
      const data = await res.json();
      expect(data.envExists).toBe(false);
    });
  });

  describe('GET /v1/setup/health', () => {
    it('returns 200', async () => {
      const app = createSetupTestApp();
      const res = await app.request('/v1/setup/health');
      expect(res.status).toBe(200);
    });

    it('reports API as ok (self-check)', async () => {
      const app = createSetupTestApp();
      const res = await app.request('/v1/setup/health');
      const data = await res.json();
      expect(data.api).toBeDefined();
      expect(data.api.ok).toBe(true);
    });

    it('reports provider config status', async () => {
      const app = createSetupTestApp();
      const res = await app.request('/v1/setup/health');
      const data = await res.json();
      expect(data.daytona).toBeDefined();
      expect(typeof data.daytona.ok).toBe('boolean');
    });
  });
});

// ─── Billing no-DB guard tests ──────────────────────────────────────────────

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
    expect(state.subscription.is_trial).toBe(false);

    expect(Array.isArray(state.models)).toBe(true);


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
  });

  it('minimal account-state route uses hasDatabase guard', async () => {
    const { hasDatabase } = await import('../shared/db');
    const { accountStateRouter } = await import('../billing/routes/account-state');
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as any).set('userId', '00000000-0000-0000-0000-000000000000');
      await next();
    });
    app.route('/account-state', accountStateRouter);

    const res = await app.request('/account-state/minimal');
    expect(res.status).toBe(200);
    const data = await res.json();

    if (!hasDatabase) {
      expect(data.credits.total).toBe(0);
    } else {
      expect(data.credits).toBeDefined();
    }
  });
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

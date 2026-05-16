/**
 * E2E tests for /v1/providers/* routes (local-only).
 *
 * These tests verify the unified provider API that replaces
 * the flat key-value approach from /v1/setup/env:
 *
 *  1. GET /v1/providers — list all providers with connection status
 *  2. GET /v1/providers/schema — full provider registry
 *  3. PUT /v1/providers/:id/connect — store API key(s)
 *  4. DELETE /v1/providers/:id/disconnect — remove stored key(s)
 *  5. GET /v1/providers/health — system health check
 *  6. Legacy /v1/setup/env still works after provider changes
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import { resolve } from 'path';

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', '00000000-0000-0000-0000-000000000000');
    c.set('userEmail', 'test@example.com');
    await next();
  },
}));

const { providersApp } = await import('../providers/routes');
const { setupApp } = await import('../setup');
const { PROVIDER_REGISTRY } = await import('../providers/registry');

const TEST_DIR = `/tmp/kortix-providers-test-${Date.now()}`;

// ─── Test app factory ───────────────────────────────────────────────────────

function createTestApp() {
  const app = new Hono();
  app.route('/v1/providers', providersApp);
  app.route('/v1/setup', setupApp);
  app.notFound((c) => c.json({ error: true, message: 'Not found', status: 404 }, 404));
  return app;
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(resolve(TEST_DIR, 'scripts'), { recursive: true });
  mkdirSync(resolve(TEST_DIR, 'deploy', 'docker', 'sandbox'), { recursive: true });
  mkdirSync(resolve(TEST_DIR, 'apps', 'api'), { recursive: true });
  mkdirSync(resolve(TEST_DIR, 'apps/web'), { recursive: true });

  writeFileSync(
    resolve(TEST_DIR, 'docker-compose.local.yml'),
    'services:\n  test:\n    image: hello-world\n',
  );
  writeFileSync(resolve(TEST_DIR, 'scripts', 'setup-env.sh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(resolve(TEST_DIR, '.env.example'), 'ENV_MODE=local\nANTHROPIC_API_KEY=\n');
  writeFileSync(resolve(TEST_DIR, 'deploy', 'docker', 'sandbox', '.env.example'), 'ANTHROPIC_API_KEY=\nENV_MODE=local\n');

  process.chdir(TEST_DIR);
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  // Clean env files between tests
  rmSync(resolve(TEST_DIR, '.env'), { force: true });
});

// ─── Tests: GET /v1/providers ───────────────────────────────────────────────

describe('GET /v1/providers', () => {
  it('returns 200', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers');
    expect(res.status).toBe(200);
  });

  it('returns providers array', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers');
    const data = await res.json();
    expect(data.providers).toBeDefined();
    expect(Array.isArray(data.providers)).toBe(true);
  });

  it('lists all registered providers', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers');
    const data = await res.json();
    expect(data.providers.length).toBe(PROVIDER_REGISTRY.length);
  });

  it('each provider has required fields', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers');
    const data = await res.json();
    for (const p of data.providers) {
      expect(p.id).toBeDefined();
      expect(p.name).toBeDefined();
      expect(p.category).toBeDefined();
      expect(typeof p.connected).toBe('boolean');
      expect(p.source).toBeDefined();
      expect(p.maskedKeys).toBeDefined();
    }
  });

  it('all providers disconnected when no .env', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers');
    const data = await res.json();
    for (const p of data.providers) {
      expect(p.connected).toBe(false);
      expect(p.source).toBe('none');
    }
  });

  it('shows provider as connected after key is set', async () => {
    writeFileSync(resolve(TEST_DIR, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test-key-12345678\n');
    const app = createTestApp();
    const res = await app.request('/v1/providers');
    const data = await res.json();
    const anthropic = data.providers.find((p: any) => p.id === 'anthropic');
    expect(anthropic.connected).toBe(true);
    expect(anthropic.source).toBe('env');
  });

  it('masks API key values', async () => {
    writeFileSync(resolve(TEST_DIR, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test-key-12345678\n');
    const app = createTestApp();
    const res = await app.request('/v1/providers');
    const data = await res.json();
    const anthropic = data.providers.find((p: any) => p.id === 'anthropic');
    expect(anthropic.maskedKeys.ANTHROPIC_API_KEY).not.toBe('sk-ant-test-key-12345678');
    expect(anthropic.maskedKeys.ANTHROPIC_API_KEY).toContain('...');
  });

  it('includes categories (llm, tool)', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers');
    const data = await res.json();
    const categories = new Set(data.providers.map((p: any) => p.category));
    expect(categories.has('llm')).toBe(true);
    expect(categories.has('tool')).toBe(true);
  });

  it('includes Anthropic provider', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers');
    const data = await res.json();
    const anthropic = data.providers.find((p: any) => p.id === 'anthropic');
    expect(anthropic).toBeDefined();
  });
});

// ─── Tests: GET /v1/providers/schema ────────────────────────────────────────

describe('GET /v1/providers/schema', () => {
  it('returns 200', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers/schema');
    expect(res.status).toBe(200);
  });

  it('returns array of provider definitions', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers/schema');
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(PROVIDER_REGISTRY.length);
  });

  it('each definition has envKeys array', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers/schema');
    const data = await res.json();
    for (const def of data) {
      expect(def.id).toBeDefined();
      expect(def.name).toBeDefined();
      expect(def.category).toBeDefined();
      expect(Array.isArray(def.envKeys)).toBe(true);
      expect(def.envKeys.length).toBeGreaterThan(0);
    }
  });

  it('LLM providers have helpUrl', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers/schema');
    const data = await res.json();
    const llms = data.filter((d: any) => d.category === 'llm');
    for (const llm of llms) {
      expect(llm.helpUrl).toBeDefined();
      expect(llm.helpUrl.startsWith('http')).toBe(true);
    }
  });
});

// ─── Tests: PUT /v1/providers/:id/connect ───────────────────────────────────

describe('PUT /v1/providers/:id/connect', () => {
  it('connects a provider by saving its key', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers/anthropic/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { ANTHROPIC_API_KEY: 'sk-ant-test-connect-1234' } }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('key is written to .env', async () => {
    const app = createTestApp();
    await app.request('/v1/providers/anthropic/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { ANTHROPIC_API_KEY: 'sk-ant-env-check' } }),
    });
    const content = readFileSync(resolve(TEST_DIR, '.env'), 'utf-8');
    expect(content).toContain('ANTHROPIC_API_KEY=sk-ant-env-check');
  });

  it('root .env gets ENV_MODE=local', async () => {
    const app = createTestApp();
    await app.request('/v1/providers/anthropic/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { ANTHROPIC_API_KEY: 'sk-ant-check' } }),
    });
    const content = readFileSync(resolve(TEST_DIR, '.env'), 'utf-8');
    expect(content).toContain('ENV_MODE=local');
  });

  it('provider shows as connected after connect', async () => {
    const app = createTestApp();
    await app.request('/v1/providers/anthropic/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { ANTHROPIC_API_KEY: 'sk-ant-connected' } }),
    });
    const listRes = await app.request('/v1/providers');
    const data = await listRes.json();
    const anthropic = data.providers.find((p: any) => p.id === 'anthropic');
    expect(anthropic.connected).toBe(true);
  });

  it('rejects unknown provider', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers/unknown-provider/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { FAKE_KEY: 'value' } }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects invalid body', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers/anthropic/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: 'not-an-object' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects keys that do not belong to provider', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers/anthropic/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { OPENAI_API_KEY: 'sk-wrong-provider' } }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects empty keys', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers/anthropic/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { ANTHROPIC_API_KEY: '   ' } }),
    });
    expect(res.status).toBe(400);
  });

  it('preserves existing keys when connecting a new provider', async () => {
    const app = createTestApp();
    // Connect anthropic first
    await app.request('/v1/providers/anthropic/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { ANTHROPIC_API_KEY: 'sk-ant-first' } }),
    });
    // Then connect openai
    await app.request('/v1/providers/openai/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { OPENAI_API_KEY: 'sk-proj-second' } }),
    });

    const content = readFileSync(resolve(TEST_DIR, '.env'), 'utf-8');
    expect(content).toContain('ANTHROPIC_API_KEY=sk-ant-first');
    expect(content).toContain('OPENAI_API_KEY=sk-proj-second');

    // Both should show as connected
    const listRes = await app.request('/v1/providers');
    const data = await listRes.json();
    const anthropic = data.providers.find((p: any) => p.id === 'anthropic');
    const openai = data.providers.find((p: any) => p.id === 'openai');
    expect(anthropic.connected).toBe(true);
    expect(openai.connected).toBe(true);
  });
});

// ─── Tests: DELETE /v1/providers/:id/disconnect ─────────────────────────────

describe('DELETE /v1/providers/:id/disconnect', () => {
  it('disconnects a provider by removing its key', async () => {
    const app = createTestApp();
    // First connect
    await app.request('/v1/providers/anthropic/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { ANTHROPIC_API_KEY: 'sk-ant-to-remove' } }),
    });
    // Then disconnect
    const res = await app.request('/v1/providers/anthropic/disconnect', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('key is removed from .env', async () => {
    const app = createTestApp();
    await app.request('/v1/providers/anthropic/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { ANTHROPIC_API_KEY: 'sk-ant-to-remove2' } }),
    });
    await app.request('/v1/providers/anthropic/disconnect', { method: 'DELETE' });

    const content = readFileSync(resolve(TEST_DIR, '.env'), 'utf-8');
    expect(content).not.toContain('ANTHROPIC_API_KEY');
  });

  it('provider shows as disconnected after disconnect', async () => {
    const app = createTestApp();
    await app.request('/v1/providers/anthropic/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { ANTHROPIC_API_KEY: 'sk-ant-connected' } }),
    });
    await app.request('/v1/providers/anthropic/disconnect', { method: 'DELETE' });

    const listRes = await app.request('/v1/providers');
    const data = await listRes.json();
    const anthropic = data.providers.find((p: any) => p.id === 'anthropic');
    expect(anthropic.connected).toBe(false);
  });

  it('does not affect other providers when disconnecting one', async () => {
    const app = createTestApp();
    // Connect both
    await app.request('/v1/providers/anthropic/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { ANTHROPIC_API_KEY: 'sk-ant-keep' } }),
    });
    await app.request('/v1/providers/openai/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { OPENAI_API_KEY: 'sk-proj-keep' } }),
    });
    // Disconnect only anthropic
    await app.request('/v1/providers/anthropic/disconnect', { method: 'DELETE' });

    const listRes = await app.request('/v1/providers');
    const data = await listRes.json();
    const anthropic = data.providers.find((p: any) => p.id === 'anthropic');
    const openai = data.providers.find((p: any) => p.id === 'openai');
    expect(anthropic.connected).toBe(false);
    expect(openai.connected).toBe(true);

    const content = readFileSync(resolve(TEST_DIR, '.env'), 'utf-8');
    expect(content).not.toContain('ANTHROPIC_API_KEY');
    expect(content).toContain('OPENAI_API_KEY=sk-proj-keep');
  });

  it('rejects unknown provider', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers/unknown-provider/disconnect', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});

// ─── Tests: GET /v1/providers/health ────────────────────────────────────────

describe('GET /v1/providers/health', () => {
  it('returns 200', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers/health');
    expect(res.status).toBe(200);
  });

  it('reports API as ok', async () => {
    const app = createTestApp();
    const res = await app.request('/v1/providers/health');
    const data = await res.json();
    expect(data.api).toBeDefined();
    expect(data.api.ok).toBe(true);
  });

});

// ─── Tests: Legacy setup env interop ────────────────────────────────────────

describe('Legacy /v1/setup/env still works after provider changes', () => {
  it('GET /v1/setup/env reflects keys set via providers API', async () => {
    const app = createTestApp();
    // Connect via new API
    await app.request('/v1/providers/anthropic/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { ANTHROPIC_API_KEY: 'sk-ant-compat-test' } }),
    });
    // Check via old API
    const res = await app.request('/v1/setup/env');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.configured.ANTHROPIC_API_KEY).toBe(true);
  });

  it('POST /v1/setup/env works and is visible in providers API', async () => {
    const app = createTestApp();
    // Save via old API
    await app.request('/v1/setup/env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { OPENAI_API_KEY: 'sk-proj-compat-test' } }),
    });
    // Check via new API
    const res = await app.request('/v1/providers');
    const data = await res.json();
    const openai = data.providers.find((p: any) => p.id === 'openai');
    expect(openai.connected).toBe(true);
  });
});

// ─── Tests: Full Flow (simulates Docker setup experience) ───────────────────

describe('Full setup flow simulation', () => {
  it('complete flow: list → connect → verify → disconnect → verify', async () => {
    const app = createTestApp();

    // 1. Initially all disconnected
    const list1 = await app.request('/v1/providers');
    const data1 = await list1.json();
    const connected1 = data1.providers.filter((p: any) => p.connected);
    expect(connected1.length).toBe(0);

    // 2. Connect Anthropic (LLM)
    const connect1 = await app.request('/v1/providers/anthropic/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { ANTHROPIC_API_KEY: 'sk-ant-flow-test' } }),
    });
    expect(connect1.status).toBe(200);

    // 3. Connect Tavily (Tool)
    const connect2 = await app.request('/v1/providers/tavily/connect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { TAVILY_API_KEY: 'tvly-flow-test' } }),
    });
    expect(connect2.status).toBe(200);

    // 4. Verify both connected
    const list2 = await app.request('/v1/providers');
    const data2 = await list2.json();
    const connected2 = data2.providers.filter((p: any) => p.connected);
    expect(connected2.length).toBe(2);

    const anthropic = data2.providers.find((p: any) => p.id === 'anthropic');
    const tavily = data2.providers.find((p: any) => p.id === 'tavily');
    expect(anthropic.connected).toBe(true);
    expect(tavily.connected).toBe(true);

    // 5. Verify old API also sees them
    const oldEnv = await app.request('/v1/setup/env');
    const oldData = await oldEnv.json();
    expect(oldData.configured.ANTHROPIC_API_KEY).toBe(true);
    expect(oldData.configured.TAVILY_API_KEY).toBe(true);

    // 6. Disconnect Tavily
    const disconnect = await app.request('/v1/providers/tavily/disconnect', {
      method: 'DELETE',
    });
    expect(disconnect.status).toBe(200);

    // 7. Verify only Anthropic remains
    const list3 = await app.request('/v1/providers');
    const data3 = await list3.json();
    const anthropic3 = data3.providers.find((p: any) => p.id === 'anthropic');
    const tavily3 = data3.providers.find((p: any) => p.id === 'tavily');
    expect(anthropic3.connected).toBe(true);
    expect(tavily3.connected).toBe(false);
  });
});

import { afterEach, describe, expect, test } from 'bun:test';

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) {
    process.env[name] = value;
  }
}

setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'platinum');
setTestEnv('KORTIX_URL', 'https://api.example.test');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('RECALL_BASE_URL', 'https://us-west-2.recall.ai/api/v1');
setTestEnv('PLATINUM_API_URL', 'https://platinum.test');
setTestEnv('PLATINUM_API_KEY', 'pt_live_testkey');

const { waitForActive, requireExternalTemplateId } = await import('./platinum');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('requireExternalTemplateId (PHASE 2 EXACT ID)', () => {
  test('accepts a non-empty id', () => {
    expect(requireExternalTemplateId('tpl_123', 'from-build for x')).toBe('tpl_123');
  });
  test.each([undefined, null, '', '   '])('rejects %p — never falls back to the name list', (bad) => {
    expect(() => requireExternalTemplateId(bad, 'from-build for x')).toThrow(/did not return a template id/);
  });
});

describe('waitForActive — PHASE 2 poll error classification', () => {
  test('a 401 during polling fails immediately (does not burn the deadline)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse('bad key', 401);
    }) as unknown as typeof fetch;

    const started = Date.now();
    await expect(waitForActive('kortix-default-abc', undefined, 'tpl_abc')).rejects.toThrow(/401/);
    expect(Date.now() - started).toBeLessThan(2_000); // immediate, not a 12-min wait
    expect(calls).toBe(1);
  }, 10_000);

  test('a TLS cert failure fails immediately', async () => {
    globalThis.fetch = (async () => {
      const inner = Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' });
      throw Object.assign(new TypeError('fetch failed'), { cause: inner });
    }) as unknown as typeof fetch;

    await expect(waitForActive('kortix-default-abc', undefined, 'tpl_abc')).rejects.toThrow();
  }, 10_000);

  test('an id that resolves to a different name is rejected (adopt mismatch)', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ id: 'tpl_abc', name: 'kortix-default-OTHER', state: 'ready' })) as unknown as typeof fetch;

    await expect(waitForActive('kortix-default-abc', undefined, 'tpl_abc')).rejects.toThrow(/mismatched template/);
  }, 10_000);

  test('resolves when the exact id reports ready', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ id: 'tpl_abc', name: 'kortix-default-abc', state: 'ready' })) as unknown as typeof fetch;

    await expect(waitForActive('kortix-default-abc', undefined, 'tpl_abc')).resolves.toBeUndefined();
  }, 10_000);

  test('a transient 503 does NOT fail the wait — it retries to ready', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return jsonResponse('unavailable', 503);
      return jsonResponse({ id: 'tpl_abc', name: 'kortix-default-abc', state: 'ready' });
    }) as unknown as typeof fetch;

    await expect(waitForActive('kortix-default-abc', undefined, 'tpl_abc')).resolves.toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(2);
  }, 15_000);

  test('an explicit provider "failed" state is terminal', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ id: 'tpl_abc', name: 'kortix-default-abc', state: 'failed' })) as unknown as typeof fetch;

    await expect(waitForActive('kortix-default-abc', undefined, 'tpl_abc')).rejects.toThrow(/build failed/);
  }, 10_000);
});

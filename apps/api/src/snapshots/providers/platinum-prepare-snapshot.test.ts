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
setTestEnv('PLATINUM_API_URL', 'https://platinum.test');
setTestEnv('PLATINUM_API_KEY', 'pt_live_testkey');

const { PlatinumAdapter } = await import('./platinum');

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PlatinumAdapter.prepareSnapshot', () => {
  test('materializes the exact id resolved for the active snapshot name', async () => {
    const ids: string[] = [];
    const adapter = new PlatinumAdapter(
      async (id) => {
        ids.push(id);
      },
      () => true,
    );
    globalThis.fetch = (async () =>
      jsonResponse([
        { id: 'tpl_other', name: 'kortix-default-other', state: 'ready' },
        { id: 'tpl_exact', name: 'kortix-default-current', state: 'ready' },
      ])) as unknown as typeof fetch;

    await adapter.prepareSnapshot('kortix-default-current');

    expect(ids).toEqual(['tpl_exact']);
  });

  test('does not materialize a missing snapshot', async () => {
    let calls = 0;
    const adapter = new PlatinumAdapter(
      async () => {
        calls += 1;
      },
      () => true,
    );
    globalThis.fetch = (async () => jsonResponse([])) as unknown as typeof fetch;

    await adapter.prepareSnapshot('kortix-default-missing');

    expect(calls).toBe(0);
  });

  test.each(['building', 'failed', 'pending'])(
    'does not materialize a %s snapshot',
    async (state) => {
      let calls = 0;
      const adapter = new PlatinumAdapter(
        async () => {
          calls += 1;
        },
        () => true,
      );
      globalThis.fetch = (async () =>
        jsonResponse([
          { id: `tpl_${state}`, name: 'kortix-default-current', state },
        ])) as unknown as typeof fetch;

      await adapter.prepareSnapshot('kortix-default-current');

      expect(calls).toBe(0);
    },
  );

  test('propagates materialization failures to the fail-open builder boundary', async () => {
    const adapter = new PlatinumAdapter(
      async () => {
        throw new Error('materializer unavailable');
      },
      () => true,
    );
    globalThis.fetch = (async () =>
      jsonResponse([
        { id: 'tpl_exact', name: 'kortix-default-current', state: 'ready' },
      ])) as unknown as typeof fetch;

    await expect(adapter.prepareSnapshot('kortix-default-current')).rejects.toThrow(
      'materializer unavailable',
    );
  });

  test('does not resolve or materialize when fast cold boot is disabled', async () => {
    let fetchCalls = 0;
    let materializeCalls = 0;
    const adapter = new PlatinumAdapter(
      async () => {
        materializeCalls += 1;
      },
      () => false,
    );
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return jsonResponse([{ id: 'tpl_exact', name: 'kortix-default-current', state: 'ready' }]);
    }) as unknown as typeof fetch;

    await adapter.prepareSnapshot('kortix-default-current');

    expect(fetchCalls).toBe(0);
    expect(materializeCalls).toBe(0);
  });
});

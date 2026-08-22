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

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : (input as Request).url;
}

describe('PlatinumAdapter.getSnapshotBuildCapacity', () => {
  test('reads exactly templates.used and templates.cap from the org quota endpoint', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: requestUrl(input),
        method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      });
      return jsonResponse({
        templates: { used: 4, cap: 12, atomicAdmission: true, ignored: 99 },
        sandboxes: { used: 80, cap: 100 },
      });
    }) as unknown as typeof fetch;

    await expect(new PlatinumAdapter().getSnapshotBuildCapacity()).resolves.toEqual({
      used: 4,
      cap: 12,
    });
    expect(requests).toEqual([
      { url: 'https://platinum.test/v1/auth/orgs/quota', method: 'GET' },
    ]);
  });

  test('accepts zero usage and a completely full quota', async () => {
    for (const capacity of [
      { used: 0, cap: 1 },
      { used: 9, cap: 9 },
    ]) {
      globalThis.fetch = (async () =>
        jsonResponse({ templates: { ...capacity, atomicAdmission: true } })) as unknown as typeof fetch;
      await expect(new PlatinumAdapter().getSnapshotBuildCapacity()).resolves.toEqual(capacity);
    }
  });

  test('fails closed when the provider does not advertise atomic admission', async () => {
    for (const atomicAdmission of [undefined, false, 'true', 1]) {
      globalThis.fetch = (async () =>
        jsonResponse({ templates: { used: 4, cap: 12, atomicAdmission } })) as unknown as typeof fetch;
      await expect(new PlatinumAdapter().getSnapshotBuildCapacity()).rejects.toThrow(
        /atomic template admission capability/,
      );
    }
  });

  test('rejects malformed quota shapes and values', async () => {
    const malformed = [
      {},
      { templates: null },
      { templates: [] },
      { templates: {} },
      { templates: { used: 0 } },
      { templates: { cap: 1 } },
      { templates: { used: '0', cap: 1 } },
      { templates: { used: 0, cap: '1' } },
      { templates: { used: 0.5, cap: 1 } },
      { templates: { used: 0, cap: 1.5 } },
      { templates: { used: -1, cap: 1 } },
      { templates: { used: 0, cap: -1 } },
      { templates: { used: 0, cap: 0 } },
      { templates: { used: 2, cap: 1 } },
    ];

    for (const body of malformed) {
      globalThis.fetch = (async () => jsonResponse(body)) as unknown as typeof fetch;
      await expect(new PlatinumAdapter().getSnapshotBuildCapacity()).rejects.toThrow(
        /Malformed Platinum template build capacity/,
      );
    }
  });

  test('propagates 401, 403, and 5xx responses', async () => {
    for (const status of [401, 403, 500, 503]) {
      globalThis.fetch = (async () =>
        jsonResponse({ error: `status-${status}` }, status)) as unknown as typeof fetch;
      await expect(new PlatinumAdapter().getSnapshotBuildCapacity()).rejects.toThrow(
        new RegExp(`-> ${status} `),
      );
    }
  });

  test('propagates transport failures', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('network unavailable');
    }) as unknown as typeof fetch;

    await expect(new PlatinumAdapter().getSnapshotBuildCapacity()).rejects.toThrow(
      'network unavailable',
    );
  });
});

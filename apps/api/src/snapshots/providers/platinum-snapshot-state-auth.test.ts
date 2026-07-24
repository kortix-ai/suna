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
setTestEnv('PLATINUM_API_URL', 'https://platinum.example.test');
setTestEnv('PLATINUM_API_KEY', 'pt_live_test-key');
setTestEnv('KORTIX_URL', 'https://api.example.test');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('RECALL_BASE_URL', 'https://us-west-2.recall.ai/api/v1');

const { platinumProvider } = await import('./platinum');
const { isPermanentTransitionError } = await import(
  '../../projects/provider-transition/provider-transition-core'
);

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Regression for the "auth 403 not mistaken for missing" invariant (red-team
 * #4). Before this fix, `getSnapshotState` swallowed EVERY lookup failure —
 * including a dead/revoked Platinum key — into the generic `'unknown'` state.
 * That is not "missing" (good), but the provider-migration runner then wraps
 * it in a message-less "provider state indeterminate" error, which
 * `isPermanentTransitionError` cannot recognize as permanent — a real 401/403
 * was silently downgraded to a transient retry (~5 backed-off attempts before
 * dead-lettering with the WRONG error class). `getSnapshotState` must
 * propagate an auth failure so the caller classifies it correctly, while every
 * OTHER lookup error (network blip, 5xx) keeps degrading to 'unknown'.
 */
describe('PlatinumAdapter.getSnapshotState — auth failures are never swallowed to "unknown"', () => {
  test('a 401 from GET /v1/templates propagates (never returned as a state)', async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":"invalid API key"}', { status: 401 })) as unknown as typeof fetch;

    await expect(platinumProvider.getSnapshotState('kortix-ppwarm-test')).rejects.toThrow();
  });

  test('a 403 from GET /v1/templates propagates AND is classified permanent end to end', async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":"forbidden"}', { status: 403 })) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await platinumProvider.getSnapshotState('kortix-ppwarm-test');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // The exact invariant the transition core's failure classifier depends on:
    // the rethrown message must still carry the ' 403' the classifier matches.
    expect(isPermanentTransitionError(caught)).toBe(true);
  });

  test('a non-auth failure (network blip, 5xx) still degrades to "unknown" — unaffected callers', async () => {
    globalThis.fetch = (async () => {
      throw new Error('fetch failed: ECONNRESET');
    }) as unknown as typeof fetch;

    await expect(platinumProvider.getSnapshotState('kortix-ppwarm-test')).resolves.toBe('unknown');

    globalThis.fetch = (async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
    await expect(platinumProvider.getSnapshotState('kortix-ppwarm-test')).resolves.toBe('unknown');
  });
});

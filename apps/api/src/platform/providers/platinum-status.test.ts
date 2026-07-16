import { beforeEach, expect, mock, test } from 'bun:test';

mock.module('../../config', () => ({
  config: {
    PLATINUM_API_KEY: 'pt_test',
    PLATINUM_API_URL: 'https://platinum.example.test',
    KORTIX_URL: 'https://api.example.test',
    KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15,
    PLATINUM_TEMPLATE: 'kortix-computer',
  },
  SANDBOX_VERSION: 'test-version',
}));

mock.module('../service-key', () => ({
  serviceKeyForExternalId: async () => null,
}));

mock.module('../sandbox-frontend-url', () => ({
  sandboxFrontendBaseUrl: () => 'https://app.example.test',
}));

let fetchStatus = 404;
let fetchBody: Record<string, unknown> = { error: 'not found', code: 'not_found' };

beforeEach(() => {
  fetchStatus = 404;
  fetchBody = { error: 'not found', code: 'not_found' };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(fetchBody), {
      status: fetchStatus,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
});

test('getStatus() reports missing Platinum sandboxes as removed', async () => {
  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  await expect(provider.getStatus('sbx_missing')).resolves.toBe('removed');
});

test('getStatus() preserves transitional Platinum failures as unknown', async () => {
  fetchStatus = 409;
  fetchBody = { error: 'sandbox not running', code: 'sandbox_not_running' };

  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  await expect(provider.getStatus('sbx_starting')).resolves.toBe('unknown');
});

test('recoverInPlace() restores a terminal sandbox backup without changing identity', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), method: String(init?.method ?? 'GET') });
    if (String(input).endsWith('/restore-from-backup')) {
      return new Response(JSON.stringify({ id: 'sbx_data', state: 'restoring' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ id: 'sbx_data', state: 'failed-start', backup_state: 'completed' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  await expect(provider.recoverInPlace('sbx_data')).resolves.toBe('recovering');
  expect(calls).toContainEqual({
    url: 'https://platinum.example.test/v1/sandboxes/sbx_data/restore-from-backup',
    method: 'POST',
  });
  expect(calls.some((call) => call.url.includes('/v1/sandboxes?'))).toBe(false);
});

test('recoverInPlace() refuses to create a replacement for an unbacked terminal sandbox', async () => {
  fetchStatus = 200;
  fetchBody = {
    id: 'sbx_unbacked',
    state: 'failed-start',
    backupState: 'none',
  };

  const { PlatinumProvider } = await import('./platinum');
  const provider = new PlatinumProvider();

  await expect(provider.recoverInPlace('sbx_unbacked')).resolves.toBe('unavailable');
});

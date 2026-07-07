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
let fetchBody = { error: 'not found', code: 'not_found' };

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

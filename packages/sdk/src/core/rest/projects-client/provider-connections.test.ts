import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { listUserProviderConnections, saveUserProviderApiKey, deleteUserProviderConnection,
  startUserProviderOAuth, pollUserProviderOAuth, listProjectPersonalProviders, setProjectPersonalProvider } from './provider-connections';

const originalFetch = globalThis.fetch;
let calls: { url: string; method: string; body: unknown; auth: string | null }[];
let status: number;
beforeEach(() => {
  calls = []; status = 200;
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'user-jwt' });
  globalThis.fetch = mock(async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init.headers).get('authorization') });
    return new Response(JSON.stringify({ items: [], ok: true }), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

test('personal providers use user-authenticated routes without a project id', async () => {
  await listUserProviderConnections();
  await saveUserProviderApiKey('openai', 'own-key');
  await startUserProviderOAuth('codex');
  await pollUserProviderOAuth('codex', 'sealed-flow');
  await deleteUserProviderConnection('openai');
  expect(calls.map(c => [new URL(c.url).pathname, c.method, c.body])).toEqual([
    ['/provider-connections', 'GET', undefined],
    ['/provider-connections/openai', 'PUT', { api_key: 'own-key' }],
    ['/provider-connections/codex/start', 'POST', {}],
    ['/provider-connections/codex/poll', 'POST', { flow_id: 'sealed-flow' }],
    ['/provider-connections/openai', 'DELETE', undefined],
  ]);
  expect(calls.every(c => c.auth === 'Bearer user-jwt')).toBe(true);
});

test('project binding encodes identifiers and supports explicit disable', async () => {
  await listProjectPersonalProviders('project/one');
  await setProjectPersonalProvider('project/one', 'provider/two', false);
  expect(calls.map(c => [new URL(c.url).pathname, c.method, c.body])).toEqual([
    ['/projects/project%2Fone/personal-providers', 'GET', undefined],
    ['/projects/project%2Fone/personal-providers/provider%2Ftwo', 'PUT', { enabled: false }],
  ]);
});

test('management errors reach the caller', async () => {
  status = 403;
  await expect(saveUserProviderApiKey('openai', 'own-key')).rejects.toThrow();
  await expect(setProjectPersonalProvider('p', 'openai', true)).rejects.toThrow();
});

test('the client facade exposes the same personal provider operations', async () => {
  const { createKortix } = await import('../../client/kortix');
  const client = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'user-jwt' });
  expect(client.providerConnections.list).toBe(listUserProviderConnections);
  expect(client.providerConnections.setProject).toBe(setProjectPersonalProvider);
});

import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { getEnterpriseDemo, setEnterpriseDemo } from './iam-enterprise';

let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const enabled = init?.method === 'PUT' ? JSON.parse(String(init.body)).enabled : true;
    return new Response(JSON.stringify({ enabled, state: enabled ? 'demo' : 'off' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

// The Enterprise demo is self-serve again (2026-10-15): an owner or admin turns
// the Enterprise features on for the account, marked "Demo", and sales hears.
test('getEnterpriseDemo reads GET /accounts/:id/iam/enterprise-demo', async () => {
  expect(await getEnterpriseDemo('acc-1')).toBe(true);
  expect(calls.map((c) => [c.method, c.url])).toEqual([['GET', 'http://api.test/v1/accounts/acc-1/iam/enterprise-demo']]);
});

test('setEnterpriseDemo sends PUT {enabled} and returns the new value', async () => {
  expect(await setEnterpriseDemo('acc-1', false)).toBe(false);
  expect(calls).toEqual([
    { method: 'PUT', url: 'http://api.test/v1/accounts/acc-1/iam/enterprise-demo', body: { enabled: false } },
  ]);
});

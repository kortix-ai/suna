import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { listAgentIdentities, listGroups, listPolicies, listRoles } from './iam';

let reportedErrors = 0;

beforeEach(() => {
  reportedErrors = 0;
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ message: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
  configureKortix({
    backendUrl: 'http://test.local',
    getToken: async () => 'tok',
    onError: () => {
      reportedErrors += 1;
    },
  });
});

test('IAM background reads suppress the global error sink', async () => {
  await Promise.allSettled([
    listGroups('acc-1'),
    listPolicies('acc-1'),
    listRoles('acc-1'),
    listAgentIdentities('acc-1'),
  ]);
  expect(reportedErrors).toBe(0);
});

test('session oversight: GET reads the account policy and PATCH sends the explicit flag', async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const payload = method === 'GET' ? { enabled: false, can_change: true } : { enabled: true };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const { getSessionOversight, setSessionOversight } = await import('./iam');

  expect(await getSessionOversight('acc-1')).toEqual({ enabled: false, can_change: true });
  expect(await setSessionOversight('acc-1', true)).toEqual({ enabled: true });

  expect(calls.map((c) => [c.method, new URL(c.url).pathname, c.body])).toEqual([
    ['GET', '/accounts/acc-1/iam/session-oversight', undefined],
    ['PATCH', '/accounts/acc-1/iam/session-oversight', { enabled: true }],
  ]);
});

test('session oversight: an owner-only refusal is not reported to the global error sink', async () => {
  const { setSessionOversight } = await import('./iam');
  await expect(setSessionOversight('acc-1', true)).rejects.toBeDefined();
  expect(reportedErrors).toBe(0);
});

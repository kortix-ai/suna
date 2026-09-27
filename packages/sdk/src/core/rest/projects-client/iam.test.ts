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

test('SSO domain verification: POST verify-domain returns the provider with its verification state', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const provider = {
    sso_provider_id: 'p1',
    supabase_sso_provider_id: 's1',
    name: 'IdP',
    primary_domain: 'example.test',
    group_claim_name: 'groups',
    auto_create_members: true,
    auto_provision_groups: false,
    enforce_sso: true,
    domain_verified: true,
    domain_verified_at: '2026-09-24T00:00:00.000Z',
    domain_verification: {
      record_type: 'TXT',
      record_name: '_kortix-verification.example.test',
      record_value: 'kortix-verification=abc',
    },
    created_at: '2026-09-24T00:00:00.000Z',
    updated_at: '2026-09-24T00:00:00.000Z',
  };
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ provider }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const { verifySsoDomain } = await import('./iam');
  const verified = await verifySsoDomain('acc-1');

  expect(calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
    ['POST', '/accounts/acc-1/iam/sso/provider/verify-domain'],
  ]);
  expect(verified.domain_verified).toBe(true);
  expect(verified.domain_verification?.record_name).toBe('_kortix-verification.example.test');
});

test('SSO domain verification: a missing TXT record is not reported to the global error sink', async () => {
  const { verifySsoDomain } = await import('./iam');
  await expect(verifySsoDomain('acc-1')).rejects.toBeDefined();
  expect(reportedErrors).toBe(0);
});

import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  createAccountSecretResource, deleteAccountSecretResource, grantAccountSecretResource,
  listAccountSecretResources, revokeAccountSecretResourceGrant, rotateAccountSecretResource,
  setAccountSecretResourceAccess,
  getSessionProviderSecretPool, setSessionProviderSecretPool,
  listSessionProviderSecretPools,
} from './account-secret-resources';

const calls: Array<{ url: string; method: string; body: unknown }> = [];
beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = mock(async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(init.method === 'GET' ? { secrets: [], provider_id: 'anthropic', configured: false, secret_ids: [] } : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
});

test('account secret resource calls use stable IDs and never send a value on reads', async () => {
  await listAccountSecretResources('account');
  await createAccountSecretResource('account', { label: 'Primary', provider_id: 'anthropic', name: 'ANTHROPIC_API_KEY', value: 'key', consumer: 'llm_gateway', strategy: 'broker' });
  await rotateAccountSecretResource('account', 'secret', 'new-key');
  await grantAccountSecretResource('account', 'secret', 'member');
  await revokeAccountSecretResourceGrant('account', 'secret', 'member');
  await deleteAccountSecretResource('account', 'secret');
  expect(calls.map((call) => [call.method, call.url])).toEqual([
    ['GET', 'http://test.local/accounts/account/secret-resources'],
    ['POST', 'http://test.local/accounts/account/secret-resources'],
    ['PUT', 'http://test.local/accounts/account/secret-resources/secret/value'],
    ['PUT', 'http://test.local/accounts/account/secret-resources/secret/grants/member'],
    ['DELETE', 'http://test.local/accounts/account/secret-resources/secret/grants/member'],
    ['DELETE', 'http://test.local/accounts/account/secret-resources/secret'],
  ]);
  expect(calls[0]?.body).toBeNull();
  expect(calls[2]?.body).toEqual({ value: 'new-key' });
});

test('session pool preserves inherited, empty, and selected states', async () => {
  await getSessionProviderSecretPool('project', 'session', 'anthropic');
  await setSessionProviderSecretPool('project', 'session', 'anthropic', []);
  await setSessionProviderSecretPool('project', 'session', 'anthropic', ['secret-a', 'secret-b']);
  await setSessionProviderSecretPool('project', 'session', 'anthropic', null);
  expect(calls.slice(1).map((call) => call.body)).toEqual([
    { secret_ids: [] }, { secret_ids: ['secret-a', 'secret-b'] }, { secret_ids: null },
  ]);
});

test('project access and member restriction use one scoped request', async () => {
  await listAccountSecretResources('account', 'project');
  await createAccountSecretResource('account', {
    project_id: 'project', label: 'Primary', provider_id: 'anthropic', name: 'ANTHROPIC_API_KEY',
    value: 'key', consumer: 'llm_gateway', strategy: 'broker',
  });
  await setAccountSecretResourceAccess('account', 'secret', 'members', ['member']);
  expect(calls.map((call) => [call.method, call.url])).toEqual([
    ['GET', 'http://test.local/accounts/account/secret-resources?project_id=project'],
    ['POST', 'http://test.local/accounts/account/secret-resources'],
    ['PUT', 'http://test.local/accounts/account/secret-resources/secret/access'],
  ]);
  expect(calls[1]?.body).toMatchObject({ project_id: 'project' });
  expect(calls[2]?.body).toEqual({ mode: 'members', user_ids: ['member'] });
});

test('list preserves an empty configured pool after its last resource disappears', async () => {
  const result = { pools: [{ provider_id: 'anthropic', configured: true, secret_ids: [] }], can_edit: false };
  globalThis.fetch = mock(async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: null });
    return Response.json(result);
  }) as unknown as typeof fetch;
  expect(await listSessionProviderSecretPools('project/id', 'session/id')).toEqual(result);
  expect(calls).toEqual([{
    url: 'http://test.local/projects/project%2Fid/sessions/session%2Fid/provider-secret-pools',
    method: 'GET', body: null,
  }]);
});

test('grant editors can handle a failure once without a duplicate global notification', async () => {
  let notifications = 0;
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError: () => { notifications++; } });
  globalThis.fetch = mock(async () => Response.json({ error: 'Access change denied' }, { status: 403 })) as unknown as typeof fetch;
  await expect(grantAccountSecretResource('account', 'secret', 'member', { showErrors: false })).rejects.toMatchObject({ status: 403 });
  await expect(revokeAccountSecretResourceGrant('account', 'secret', 'member', { showErrors: false })).rejects.toMatchObject({ status: 403 });
  expect(notifications).toBe(0);
  await expect(grantAccountSecretResource('account', 'secret', 'member')).rejects.toMatchObject({ status: 403 });
  expect(notifications).toBe(1);
});

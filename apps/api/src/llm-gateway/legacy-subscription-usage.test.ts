import { afterEach, beforeEach, expect, mock, setSystemTime, test } from 'bun:test';
import { SecretUndecryptableError } from '../secrets/undecryptable';

const accountId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
let secretId = crypto.randomUUID();
const input = { accountId, projectId, userId };
const at = new Date('2026-11-05T12:00:00Z');
let codex: any;
let broken = false;
let bound = true;
const resolve = mock(async (_input: unknown) => {
  if (broken) throw new SecretUndecryptableError('Project secret CODEX_AUTH_JSON');
  return codex;
});
const credential = mock(async () => ({ access: 'synthetic-access', accountId: 'synthetic-provider-account' }));
mock.module('../projects/surface', () => ({ resolveProjectSecretForConsumer: resolve }));
mock.module('./credentials/codex', () => ({ resolveCodexCredential: credential, resolveCodexAccountCredential: credential, CODEX_USER_AGENT: 'synthetic-agent' }));
mock.module('../secrets/account-resource', () => ({ readAccountSecret: () => null, decryptAccountSecret: (_account: string, value: string) => {
  if (value === 'broken') throw new Error('Cannot decrypt');
  return value;
} }));
mock.module('../shared/db', () => ({ db: {} }));
mock.module('../secrets/project-account', () => ({ projectInAccount: async () => bound }));
const { listLegacySubscriptionConnections, refreshLegacySubscriptionUsage } = await import('./legacy-subscription-usage');
afterEach(() => setSystemTime());

beforeEach(() => {
  codex = null;
  broken = false;
  bound = true;
  secretId = crypto.randomUUID();
  resolve.mockClear();
  credential.mockClear();
});

test('discovers the existing project ChatGPT login without exposing values', async () => {
  codex = { accountId, secretId, ownerUserId: userId, updatedAt: at, value: JSON.stringify({ openai: { access: 'synthetic-access' } }) };
  const rows = await listLegacySubscriptionConnections(input);
  expect(rows.map(row => [row.secret_id, row.provider_id, row.storage, row.status])).toEqual([
    [secretId, 'codex', 'project', 'ok'],
  ]);
  expect(JSON.stringify(rows)).not.toContain('synthetic-access');
  expect(JSON.stringify(rows)).not.toContain('synthetic-claude-token');
  expect(resolve.mock.calls[0]?.[0]).toMatchObject({ accountId, projectId, actorUserId: userId, principalUserId: userId, name: 'CODEX_AUTH_JSON', consumer: 'llm_gateway' });
});

test('a denied project credential is absent and cannot be refreshed', async () => {
  expect(await listLegacySubscriptionConnections(input)).toEqual([]);
  const fetcher = mock(async (_url: string, _init: RequestInit) => new Response('{}'));
  expect(await refreshLegacySubscriptionUsage({ ...input, secretId, storage: 'project' }, fetcher)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(credential).not.toHaveBeenCalled();
});

test('a different project secret cannot be refreshed', async () => {
  codex = { accountId, secretId, ownerUserId: userId, updatedAt: at, value: '{}' };
  const fetcher = mock(async (_url: string, _init: RequestInit) => new Response('{}'));
  expect(await refreshLegacySubscriptionUsage({ ...input, secretId: projectId, storage: 'project' }, fetcher)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

test('undecryptable existing logins show reconnect cards', async () => {
  broken = true;
  const rows = await listLegacySubscriptionConnections(input);
  expect(rows.map(row => [row.provider_id, row.status])).toEqual([['codex', 'undecryptable']]);
});

test('reads usage with the stored ChatGPT access token', async () => {
  codex = { accountId, secretId, ownerUserId: userId, updatedAt: at, value: JSON.stringify({ openai: { access: 'synthetic-access' } }) };
  const fetcher = mock(async (_url: string, _init: RequestInit) => Response.json({ rate_limit: { primary_window: { used_percent: 82, limit_window_seconds: 18000 } } }));
  const result = await refreshLegacySubscriptionUsage({ ...input, secretId, storage: 'project' }, fetcher);
  expect(result?.usage?.windows[0]?.used_percent).toBe(82);
  expect(credential).not.toHaveBeenCalled();
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/wham/usage');
});

test('usage polling never rotates an expired ChatGPT login', async () => {
  codex = { accountId, secretId, ownerUserId: userId, updatedAt: at, value: JSON.stringify({ openai: { access: 'stored-expired-access', refresh: 'never-use-refresh', expires: 1, accountId: 'stored-account' } }) };
  const requests: Request[] = [];
  const fetcher = mock(async (url: string, init: RequestInit) => { requests.push(new Request(url, init)); return Response.json({ rate_limit: { primary_window: { used_percent: 82, limit_window_seconds: 18000 } } }); });
  await refreshLegacySubscriptionUsage({ ...input, secretId, storage: 'project' }, fetcher);
  expect(credential).not.toHaveBeenCalled();
  expect(requests.map(r => r.url)).toEqual(['https://chatgpt.com/backend-api/wham/usage']);
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer stored-expired-access');
});

test('a foreign project is refused before reading any login or cached usage', async () => {
  bound = false;
  codex = { accountId, secretId, ownerUserId: null, updatedAt: at, value: JSON.stringify({ openai: { access: 'synthetic-access' } }) };
  const fetcher = mock(async (_url: string, _init: RequestInit) => Response.json({}));
  expect(await listLegacySubscriptionConnections(input)).toEqual([]);
  expect(await refreshLegacySubscriptionUsage({ ...input, secretId, storage: 'project' }, fetcher)).toBeNull();
  expect(resolve).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

test('concurrent and repeated reads share one provider request for one minute', async () => {
  codex = { accountId, secretId, ownerUserId: null, updatedAt: at, value: JSON.stringify({ openai: { access: 'synthetic-access' } }) };
  const fetcher = mock(async (_url: string, _init: RequestInit) => Response.json({ rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18000 } } }));
  const read = () => refreshLegacySubscriptionUsage({ ...input, secretId, storage: 'project' }, fetcher);
  const results = await Promise.all([read(), read()]);
  expect(await read()).toEqual(results[0]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(resolve).toHaveBeenCalledTimes(3);
});

test('cached usage never bypasses tenant validation and a minute allows a fresh provider read', async () => {
  const now = Date.now();
  setSystemTime(new Date(now));
  codex = { accountId, secretId, ownerUserId: null, updatedAt: at, value: JSON.stringify({ openai: { access: 'synthetic-access' } }) };
  const fetcher = mock(async (_url: string, _init: RequestInit) => Response.json({}));
  const read = () => refreshLegacySubscriptionUsage({ ...input, secretId, storage: 'project' }, fetcher);
  await read();
  bound = false;
  expect(await read()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  bound = true;
  setSystemTime(new Date(now + 59_999));
  await read();
  expect(fetcher).toHaveBeenCalledTimes(1);
  setSystemTime(new Date(now + 60_001));
  await read();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('equivalent account and project UUID casing cannot bypass the provider read window', async () => {
  const canonical = { ...input, accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  codex = { accountId: canonical.accountId, secretId, ownerUserId: null, updatedAt: at, value: JSON.stringify({ openai: { access: 'synthetic-access' } }) };
  const fetcher = mock(async (_url: string, _init: RequestInit) => Response.json({}));
  await refreshLegacySubscriptionUsage({ ...canonical, secretId, storage: 'project' }, fetcher);
  await refreshLegacySubscriptionUsage({ ...canonical, accountId: canonical.accountId.toUpperCase(), projectId: canonical.projectId.toUpperCase(), secretId, storage: 'project' }, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

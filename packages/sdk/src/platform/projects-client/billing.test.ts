import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../config';
import { fetchAccountStateWithToken, getAccountState, getDefaultAccountState } from './billing';

let calls: { url: string; method: string; headers: Record<string, string> }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      headers: (opts.headers as Record<string, string>) ?? {},
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('getAccountState hits /billing/account-state and returns the parsed body', async () => {
  const state = { ...getDefaultAccountState(), subscription: { ...getDefaultAccountState().subscription, tier_key: 'pro' } };
  nextResponse = { status: 200, body: state };
  const result = await getAccountState();
  expect(last().url).toContain('/billing/account-state');
  expect(result.subscription.tier_key).toBe('pro');
});

test('getAccountState forwards skipCache and accountId as query params', async () => {
  nextResponse = { status: 200, body: getDefaultAccountState() };
  await getAccountState({ skipCache: true, accountId: 'acc-1' });
  expect(last().url).toContain('skip_cache=true');
  expect(last().url).toContain('account_id=acc-1');
});

test('getAccountState degrades to the default shape when billing is disabled (404)', async () => {
  nextResponse = { status: 404, body: { message: 'billing is not enabled for this deployment' } };
  const result = await getAccountState();
  expect(result).toEqual(getDefaultAccountState());
});

test('getAccountState throws on a genuine server error (not the graceful-disabled case)', async () => {
  nextResponse = { status: 500, body: { message: 'internal error' } };
  await expect(getAccountState()).rejects.toBeTruthy();
});

test('fetchAccountStateWithToken sends an explicit bearer token, bypassing the ambient seam', async () => {
  nextResponse = {
    status: 200,
    body: { subscription: { tier_key: 'free' }, tier: { name: 'free' }, credits: { can_run: true } },
  };
  const result = await fetchAccountStateWithToken({
    backendUrl: 'http://backend.local/v1',
    accessToken: 'server-token',
  });
  expect(last().url).toBe('http://backend.local/v1/billing/account-state');
  expect(last().headers.Authorization).toBe('Bearer server-token');
  expect(result?.subscription?.tier_key).toBe('free');
});

test('fetchAccountStateWithToken returns null on a non-2xx response instead of throwing', async () => {
  nextResponse = { status: 401, body: { message: 'unauthorized' } };
  const result = await fetchAccountStateWithToken({
    backendUrl: 'http://backend.local/v1',
    accessToken: 'stale-token',
  });
  expect(result).toBeNull();
});

test('fetchAccountStateWithToken returns null without throwing when no token is given', async () => {
  const result = await fetchAccountStateWithToken({ backendUrl: 'http://backend.local/v1', accessToken: '' });
  expect(result).toBeNull();
  expect(calls.length).toBe(0);
});

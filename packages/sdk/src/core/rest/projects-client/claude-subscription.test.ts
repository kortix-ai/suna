import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  completeClaudeSubscriptionLogin,
  disconnectClaudeSubscription,
  getClaudeSubscription,
  setClaudeSubscriptionToken,
  startClaudeSubscriptionLogin,
  type ClaudeSubscriptionStatus,
} from './claude-subscription';

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let next: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  next = { status: 200, body: {} };
  globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1]!;

const connected: ClaudeSubscriptionStatus = {
  connected: true,
  source: 'setup_token',
  connected_at: '2026-10-31T03:00:00.000Z',
  usable: true,
};

test('getClaudeSubscription GETs the caller status', async () => {
  next = { status: 200, body: connected };
  expect(await getClaudeSubscription('p1')).toEqual(connected);
  expect(last()).toEqual({ url: 'http://test.local/projects/p1/claude-subscription', method: 'GET', body: undefined });
});

test('startClaudeSubscriptionLogin POSTs login/start and returns the sign-in link', async () => {
  const started = { flow_id: '00000000-0000-4000-8000-000000000001', authorize_url: 'https://claude.com/cai/oauth/authorize?x=1', expires_at: '2026-10-31T03:10:00.000Z' };
  next = { status: 200, body: started };
  expect(await startClaudeSubscriptionLogin('p1')).toEqual(started);
  expect(last().method).toBe('POST');
  expect(last().url).toBe('http://test.local/projects/p1/claude-subscription/login/start');
});

test('completeClaudeSubscriptionLogin POSTs the flow id and the pasted code', async () => {
  next = { status: 200, body: connected };
  expect(await completeClaudeSubscriptionLogin('p1', { flowId: 'f1', code: 'abc#def' })).toEqual(connected);
  expect(last()).toEqual({ url: 'http://test.local/projects/p1/claude-subscription/login/complete', method: 'POST', body: { flow_id: 'f1', code: 'abc#def' } });
});

test('setClaudeSubscriptionToken PUTs a pasted token', async () => {
  next = { status: 200, body: { ...connected, source: 'pasted' } };
  expect((await setClaudeSubscriptionToken('p1', 'sk-ant-oat01-x')).source).toBe('pasted');
  expect(last()).toEqual({ url: 'http://test.local/projects/p1/claude-subscription/token', method: 'PUT', body: { token: 'sk-ant-oat01-x' } });
});

test('disconnectClaudeSubscription DELETEs the login', async () => {
  next = { status: 200, body: { connected: false, source: null, connected_at: null, usable: false } };
  expect((await disconnectClaudeSubscription('p1')).connected).toBe(false);
  expect(last().method).toBe('DELETE');
  expect(last().url).toBe('http://test.local/projects/p1/claude-subscription');
});

test('a refused code rejects with the server message', async () => {
  next = { status: 400, body: { error: 'invalid_code', code: 'invalid_code', message: 'Claude did not accept that code.' } };
  await expect(completeClaudeSubscriptionLogin('p1', { flowId: 'f1', code: 'bad' })).rejects.toThrow('Claude did not accept that code.');
});

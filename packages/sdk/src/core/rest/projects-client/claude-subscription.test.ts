import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  completeClaudeSubscriptionLogin,
  getClaudeSubscription,
  setClaudeSubscriptionToken,
  startClaudeSubscriptionLogin,
  type ClaudeSubscriptionConnected,
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

const status: ClaudeSubscriptionStatus = { connected: true, accounts: 2 };
const connected: ClaudeSubscriptionConnected = { connected: true, secret_id: '00000000-0000-4000-8000-0000000000aa' };

test('getClaudeSubscription GETs whether the caller can use a Claude account here', async () => {
  next = { status: 200, body: status };
  expect(await getClaudeSubscription('p1')).toEqual(status);
  expect(last()).toEqual({ url: 'http://test.local/projects/p1/claude-subscription', method: 'GET', body: undefined });
});

test('startClaudeSubscriptionLogin POSTs login/start with no body fields when the caller names none', async () => {
  const started = { flow_id: '00000000-0000-4000-8000-000000000001', authorize_url: 'https://claude.com/cai/oauth/authorize?x=1', expires_at: '2026-10-31T03:10:00.000Z' };
  next = { status: 200, body: started };
  expect(await startClaudeSubscriptionLogin('p1')).toEqual(started);
  expect(last()).toEqual({ url: 'http://test.local/projects/p1/claude-subscription/login/start', method: 'POST', body: {} });
});

test('startClaudeSubscriptionLogin sends the account name and sharing like a ChatGPT sign-in', async () => {
  next = { status: 200, body: { flow_id: 'f', authorize_url: 'https://claude.com/x', expires_at: 'e' } };
  await startClaudeSubscriptionLogin('p1', { resourceLabel: 'Work Max', sharing: { mode: 'private', ownerId: 'u1' } });
  expect(last().body).toEqual({ resource_label: 'Work Max', sharing: { mode: 'private', ownerId: 'u1' } });
});

test('startClaudeSubscriptionLogin reconnects an existing account by its id', async () => {
  next = { status: 200, body: { flow_id: 'f', authorize_url: 'https://claude.com/x', expires_at: 'e' } };
  await startClaudeSubscriptionLogin('p1', { resourceId: 's1' });
  expect(last().body).toEqual({ resource_id: 's1' });
});

test('completeClaudeSubscriptionLogin POSTs the flow id and the pasted code, and returns the stored account id', async () => {
  next = { status: 200, body: connected };
  expect(await completeClaudeSubscriptionLogin('p1', { flowId: 'f1', code: 'abc#def' })).toEqual(connected);
  expect(last()).toEqual({ url: 'http://test.local/projects/p1/claude-subscription/login/complete', method: 'POST', body: { flow_id: 'f1', code: 'abc#def' } });
});

test('setClaudeSubscriptionToken PUTs a pasted token with the account name and sharing', async () => {
  next = { status: 200, body: connected };
  expect(await setClaudeSubscriptionToken('p1', 'sk-ant-oat01-x', { resourceLabel: 'Laptop', sharing: { mode: 'private', ownerId: 'u1' } })).toEqual(connected);
  expect(last()).toEqual({ url: 'http://test.local/projects/p1/claude-subscription/token', method: 'PUT', body: { token: 'sk-ant-oat01-x', resource_label: 'Laptop', sharing: { mode: 'private', ownerId: 'u1' } } });
});

test('a refused code rejects with the server message', async () => {
  next = { status: 400, body: { error: 'invalid_code', code: 'invalid_code', message: 'Claude did not accept that code.' } };
  await expect(completeClaudeSubscriptionLogin('p1', { flowId: 'f1', code: 'bad' })).rejects.toThrow('Claude did not accept that code.');
});

test('a refused sign-in or token reaches the caller only: the caller shows it beside the field, so no app-wide error toast', async () => {
  const reported: unknown[] = [];
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError: (error) => reported.push(error) });
  try {
    next = { status: 400, body: { error: 'invalid_code', message: 'Claude did not accept that code.', code: 'invalid_code' } };
    await expect(completeClaudeSubscriptionLogin('p1', { flowId: 'f1', code: 'nope' })).rejects.toThrow('Claude did not accept that code.');
    next = { status: 400, body: { error: 'invalid_token', message: 'Paste the whole token.', code: 'invalid_token' } };
    await expect(setClaudeSubscriptionToken('p1', 'nope')).rejects.toThrow('Paste the whole token.');
    next = { status: 503, body: { error: 'claude_unavailable', message: 'Claude Code is not installed on this server' } };
    await expect(startClaudeSubscriptionLogin('p1')).rejects.toThrow();
    expect(reported).toEqual([]);
  } finally {
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  }
});

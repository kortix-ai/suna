import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { validateToken } from './accounts';

let calls: { url: string; method: string }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET' });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('validateToken hits GET /accounts/me and returns { valid: true, identity } on success', async () => {
  nextResponse = {
    status: 200,
    body: {
      user_id: 'u1',
      email: 'a@b.com',
      accounts: [{ account_id: 'acc-1', slug: 'acc-1', name: 'Acme', role: 'owner' }],
    },
  };
  const result = await validateToken();
  expect(last().url).toContain('/accounts/me');
  expect(last().method).toBe('GET');
  expect(result.valid).toBe(true);
  expect(result.identity?.user_id).toBe('u1');
  expect(result.error).toBeUndefined();
});

test('validateToken never throws — returns { valid: false, error } on a 401', async () => {
  nextResponse = { status: 401, body: { message: 'invalid token' } };
  const result = await validateToken();
  expect(result.valid).toBe(false);
  expect(result.identity).toBeUndefined();
  expect(result.error).toBeTruthy();
});

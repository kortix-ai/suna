/**
 * `listAccountTokens` answers two different questions and the caller says
 * which.
 *
 * Bare, it is the account-wide list it has always been: every row the account
 * owns, which includes other members' keys, the session connector tokens the
 * runtime mints per sandbox, and service-account bearers. That is an
 * administrative read.
 *
 * With `{ mine: true }` it is the read behind a person's own settings page:
 * only the keys THEY minted by hand. The narrowing happens server-side
 * (`listPersonalAccountTokens`, `apps/api/src/repositories/account-tokens.ts`)
 * because a browser cannot filter on `user_id` / `session_id` /
 * `service_account_id` — the list payload carries none of them.
 */
import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { listAccountTokens } from './tokens';

let calls: { url: string; method: string }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: [] };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: [] };
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

test('listAccountTokens() asks for the account-wide list — no narrowing', async () => {
  await listAccountTokens('acc-1');
  expect(last().url).toBe('http://test.local/accounts/tokens?account_id=acc-1');
  expect(last().method).toBe('GET');
});

test('listAccountTokens(id, { mine: true }) narrows to the caller’s own keys', async () => {
  await listAccountTokens('acc-1', { mine: true });
  expect(last().url).toBe('http://test.local/accounts/tokens?account_id=acc-1&mine=true');
});

test('`mine` works without an account id — the API resolves the caller’s account', async () => {
  await listAccountTokens(undefined, { mine: true });
  expect(last().url).toBe('http://test.local/accounts/tokens?mine=true');
});

test('`{ mine: false }` sends no flag rather than `mine=false`', async () => {
  await listAccountTokens('acc-1', { mine: false });
  expect(last().url).toBe('http://test.local/accounts/tokens?account_id=acc-1');
});

test('returns the token rows the API answered with', async () => {
  nextResponse = {
    status: 200,
    body: [
      {
        token_id: 't1',
        name: 'my laptop',
        project_id: null,
        public_key: 'pk_abc',
        status: 'active',
        expires_at: null,
        last_used_at: null,
        created_at: '2026-08-18T00:00:00.000Z',
        revoked_at: null,
      },
    ],
  };
  const tokens = await listAccountTokens('acc-1', { mine: true });
  expect(tokens.map((t) => t.token_id)).toEqual(['t1']);
});

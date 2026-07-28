import { beforeEach, expect, mock, test } from 'bun:test';
import { fetchAccountsWithToken } from './accounts';
import { fetchProjectsForAccountWithToken, provisionProjectWithToken } from './projects';

let calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      headers: (opts.headers as Record<string, string>) ?? {},
      body: opts.body ? JSON.parse(opts.body as string) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const last = () => calls[calls.length - 1];

test('fetchAccountsWithToken sends an explicit bearer token to /v1/accounts', async () => {
  nextResponse = { status: 200, body: [{ account_id: 'a1', name: 'Acme' }] };
  const result = await fetchAccountsWithToken({
    backendUrl: 'http://backend.local/v1',
    accessToken: 'server-token',
  });
  expect(last().url).toBe('http://backend.local/v1/accounts');
  expect(last().headers.Authorization).toBe('Bearer server-token');
  expect(result?.[0]?.account_id).toBe('a1');
});

test('fetchAccountsWithToken returns null on failure instead of throwing', async () => {
  nextResponse = { status: 500, body: {} };
  const result = await fetchAccountsWithToken({
    backendUrl: 'http://backend.local/v1',
    accessToken: 'server-token',
  });
  expect(result).toBeNull();
});

test('fetchProjectsForAccountWithToken scopes the query by account_id', async () => {
  nextResponse = { status: 200, body: [{ project_id: 'p1' }] };
  const result = await fetchProjectsForAccountWithToken(
    { backendUrl: 'http://backend.local/v1', accessToken: 'server-token' },
    'acc-1',
  );
  expect(last().url).toBe('http://backend.local/v1/projects?account_id=acc-1');
  expect(result?.[0]?.project_id).toBe('p1');
});

test('provisionProjectWithToken posts seed_starter + returns the created project', async () => {
  nextResponse = { status: 200, body: { project_id: 'p2', name: 'My First Project' } };
  const result = await provisionProjectWithToken(
    { backendUrl: 'http://backend.local/v1', accessToken: 'server-token' },
    { account_id: 'acc-1', name: 'My First Project', seed_starter: true },
  );
  expect(last().url).toBe('http://backend.local/v1/projects/provision');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ account_id: 'acc-1', name: 'My First Project', seed_starter: true });
  expect(result.ok).toBe(true);
  expect(result.ok && result.project.project_id).toBe('p2');
});

test('provisionProjectWithToken reports project_limit_reached distinctly from other 403s', async () => {
  nextResponse = { status: 403, body: { code: 'project_limit_reached' } };
  const limited = await provisionProjectWithToken(
    { backendUrl: 'http://backend.local/v1', accessToken: 'server-token' },
    { name: 'x' },
  );
  expect(limited).toEqual({ ok: false, limitReached: true });

  nextResponse = { status: 403, body: { code: 'forbidden' } };
  const forbidden = await provisionProjectWithToken(
    { backendUrl: 'http://backend.local/v1', accessToken: 'server-token' },
    { name: 'x' },
  );
  expect(forbidden).toEqual({ ok: false, limitReached: false });
});

test('provisionProjectWithToken returns a non-limit failure without throwing on other errors', async () => {
  nextResponse = { status: 500, body: {} };
  const result = await provisionProjectWithToken(
    { backendUrl: 'http://backend.local/v1', accessToken: 'server-token' },
    { name: 'x' },
  );
  expect(result).toEqual({ ok: false, limitReached: false });
});

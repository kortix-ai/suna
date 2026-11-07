import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api/errors';
import { configureKortix } from '../../http/config';
import { type ProjectSearchHit, searchWorkspace } from './project-search';

let calls: { url: string; method: string }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };
let hostErrors: unknown[] = [];

beforeEach(() => {
  calls = [];
  hostErrors = [];
  nextResponse = { status: 200, body: {} };
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok', onError: (e: unknown) => hostErrors.push(e) });
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET' });
    return new Response(JSON.stringify(nextResponse.body), { status: nextResponse.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

const hit: ProjectSearchHit = {
  path: '/Company/plans/q3.md',
  name: 'q3.md',
  kind: 'file',
  snippet: 'the Q3 launch plan',
  mtime: '2026-11-02T10:00:00.000Z',
  size: 120,
  access: 'write',
};

test('searchProject GETs /projects/:id/search with q and returns hits and next_cursor', async () => {
  nextResponse = { status: 200, body: { hits: [hit], next_cursor: 'abc' } };
  expect(await searchWorkspace('P1', { q: 'launch plan' })).toEqual({ hits: [hit], next_cursor: 'abc' });
  expect(calls).toEqual([{ url: 'http://test.local/v1/workspaces/P1/search?q=launch+plan', method: 'GET' }]);
});

test('searchProject passes path, limit and cursor, and encodes them', async () => {
  nextResponse = { status: 200, body: { hits: [], next_cursor: null } };
  await searchWorkspace('P1', { q: 'a&b', path: '/Company/plans & notes', limit: 5, cursor: 'c1' });
  expect(calls[0]!.url).toBe('http://test.local/v1/workspaces/P1/search?q=a%26b&path=%2FCompany%2Fplans+%26+notes&limit=5&cursor=c1');
});

test('a refusal rejects with the ApiError and raises no app-wide error', async () => {
  nextResponse = { status: 400, body: { error: 'q is required: 1-200 characters', code: 'invalid_input' } };
  const error = await searchWorkspace('P1', { q: '' }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(400);
  expect(hostErrors).toEqual([]);
});

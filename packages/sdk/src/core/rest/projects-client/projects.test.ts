import { beforeEach, expect, mock, test } from 'bun:test';

import { provisionProjectWithToken } from './projects';

let nextResponse: () => Response = () => new Response('{}', { status: 200 });

beforeEach(() => {
  globalThis.fetch = mock(async () => nextResponse()) as unknown as typeof fetch;
});

const opts = { backendUrl: 'http://backend.test/v1', accessToken: 'tok' };
const input = { account_id: 'acc-1', name: 'My First Project', seed_starter: true };

test('returns ok:true with the parsed project on a real 200 body', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ project_id: 'proj-1', name: 'My First Project' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const result = await provisionProjectWithToken(opts, input);
  expect(result.ok).toBe(true);
  expect(result.ok && result.project.project_id).toBe('proj-1');
});

// Regression: a 200 whose body has no project_id used to be reported as a
// fake success — the caller would build an unusable `/projects/undefined` path.
test('reports not-ok when the response is 200 but the body has no project_id', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ name: 'My First Project' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const result = await provisionProjectWithToken(opts, input);
  expect(result).toEqual({ ok: false, limitReached: false });
});

test('reports not-ok when the 200 body is not valid JSON', async () => {
  nextResponse = () => new Response('not json', { status: 200 });

  const result = await provisionProjectWithToken(opts, input);
  expect(result).toEqual({ ok: false, limitReached: false });
});

test('reports limitReached on a 403 with the project_limit_reached code', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ code: 'project_limit_reached' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });

  const result = await provisionProjectWithToken(opts, input);
  expect(result).toEqual({ ok: false, limitReached: true });
});

test('returns ok:false without hitting the network when credentials are missing', async () => {
  const calls: unknown[] = [];
  globalThis.fetch = mock(async (...args: unknown[]) => {
    calls.push(args);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;

  const result = await provisionProjectWithToken({ backendUrl: '', accessToken: '' }, input);
  expect(result).toEqual({ ok: false, limitReached: false });
  expect(calls).toHaveLength(0);
});

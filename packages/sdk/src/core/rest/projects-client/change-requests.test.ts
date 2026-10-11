import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { updateChangeRequest } from './change-requests';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

test('updateChangeRequest PATCHes the title and description and returns the change request', async () => {
  nextResponse = { status: 200, body: { cr_id: 'cr-1', title: 'New title', description: 'Body' } };
  const cr = await updateChangeRequest('P1', 'cr-1', { title: 'New title', description: 'Body' });
  expect(calls[0]).toEqual({
    url: 'http://test.local/projects/P1/change-requests/cr-1',
    method: 'PATCH',
    body: { title: 'New title', description: 'Body' },
  });
  expect(cr.title).toBe('New title');
});

test('updateChangeRequest throws when the change request is not open', async () => {
  nextResponse = { status: 409, body: { error: 'Cannot edit a merged change request' } };
  await expect(updateChangeRequest('P1', 'cr-1', { title: 'x' })).rejects.toThrow('Cannot edit a merged change request');
});

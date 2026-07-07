import { test, expect, beforeEach, mock } from 'bun:test';
import * as realAuth from '../platform/auth';

let calls: { url: string; method: string; body?: string }[] = [];
let nextResponse: () => Response = () =>
  new Response(JSON.stringify({ success: true, data: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

mock.module('../platform/auth', () => ({
  ...realAuth,
  authenticatedFetch: async (url: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined });
    return nextResponse();
  },
}));

const { triggersRequest } = await import('./triggers');
const last = () => calls[calls.length - 1];

beforeEach(() => {
  calls = [];
  nextResponse = () =>
    new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
});

test('GETs the trigger list at {baseUrl}/kortix/triggers{path}', async () => {
  await triggersRequest('http://sbx.test', '');
  expect(last().url).toBe('http://sbx.test/kortix/triggers');
  expect(last().method).toBe('GET');
});

test('strips a trailing slash on the base url before appending the path', async () => {
  await triggersRequest('http://sbx.test/', '/abc123');
  expect(last().url).toBe('http://sbx.test/kortix/triggers/abc123');
});

test('POSTs a JSON body with Content-Type set', async () => {
  await triggersRequest('http://sbx.test', '', { method: 'POST', body: JSON.stringify({ name: 'nightly' }) });
  expect(last().method).toBe('POST');
  expect(JSON.parse(last().body!)).toEqual({ name: 'nightly' });
});

test('returns the parsed JSON body on success', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ success: true, data: { id: 't-1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const result = await triggersRequest<{ success: boolean; data: { id: string } }>('http://sbx.test', '/t-1');
  expect(result.data.id).toBe('t-1');
});

test('throws the daemon error message on a non-2xx response', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ error: 'Trigger not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  await expect(triggersRequest('http://sbx.test', '/missing')).rejects.toThrow('Trigger not found');
});

test('falls back to a generic message when the error body has neither error nor message', async () => {
  nextResponse = () => new Response(JSON.stringify({}), { status: 500, headers: { 'content-type': 'application/json' } });
  await expect(triggersRequest('http://sbx.test', '')).rejects.toThrow('Request failed with 500');
});

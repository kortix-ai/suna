import { test, expect, beforeEach, mock } from 'bun:test';
import * as realAuth from '../platform/auth';

let calls: { url: string; method: string; body?: string }[] = [];
let nextResponse: () => Response = () =>
  new Response(JSON.stringify({ secrets: { FOO: 'bar' } }), {
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

const Env = await import('./env');
const last = () => calls[calls.length - 1];
const BASE = 'http://sbx.test';

beforeEach(() => {
  calls = [];
  nextResponse = () =>
    new Response(JSON.stringify({ secrets: { FOO: 'bar' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
});

test('listEnv hits GET /env on the given baseUrl and returns the secrets map', async () => {
  const secrets = await Env.listEnv(BASE);
  expect(last().url).toBe('http://sbx.test/env');
  expect(last().method).toBe('GET');
  expect(secrets).toEqual({ FOO: 'bar' });
});

test('setEnv PUTs to /env/:key with a JSON value body', async () => {
  await Env.setEnv(BASE, 'ELEVENLABS_API_KEY', 'shh');
  expect(last().url).toBe('http://sbx.test/env/ELEVENLABS_API_KEY');
  expect(last().method).toBe('PUT');
  expect(JSON.parse(last().body!)).toEqual({ value: 'shh' });
});

test('setEnv URL-encodes the key', async () => {
  await Env.setEnv(BASE, 'A B', 'v');
  expect(last().url).toBe('http://sbx.test/env/A%20B');
});

test('deleteEnv DELETEs /env/:key', async () => {
  await Env.deleteEnv(BASE, 'OPENAI_API_KEY');
  expect(last().url).toBe('http://sbx.test/env/OPENAI_API_KEY');
  expect(last().method).toBe('DELETE');
});

test('env namespace exposes list/set/delete', () => {
  expect(typeof Env.env.list).toBe('function');
  expect(typeof Env.env.set).toBe('function');
  expect(typeof Env.env.delete).toBe('function');
});

test('listEnv throws when called without a baseUrl (no fallback to a global "active" instance)', async () => {
  await expect(Env.listEnv('')).rejects.toThrow('Server URL not ready');
  expect(calls).toHaveLength(0);
});

// Two callers keying their own caches on different instance URLs must never
// cross-wire — each call hits exactly the baseUrl it was given.
test('listEnv against two different instance URLs never crosses wires', async () => {
  await Env.listEnv('http://instance-a.test');
  expect(last().url).toBe('http://instance-a.test/env');

  await Env.listEnv('http://instance-b.test');
  expect(last().url).toBe('http://instance-b.test/env');
});

test('setEnv surfaces the daemon error body on failure', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ error: 'quota exceeded' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  await expect(Env.setEnv(BASE, 'K', 'V')).rejects.toThrow('quota exceeded');
});

// Per-operation fallback messages (used when the daemon's error body carries
// neither `error` nor a statusText worth showing) — restores the pre-refactor
// per-endpoint strings instead of a single generic message.
test('listEnv falls back to "Failed to load secrets" when the daemon gives no error body', async () => {
  nextResponse = () => new Response('', { status: 500, statusText: '' });
  await expect(Env.listEnv(BASE)).rejects.toThrow('Failed to load secrets');
});

test('setEnv falls back to "Failed to save secret" when the daemon gives no error body', async () => {
  nextResponse = () => new Response('', { status: 500, statusText: '' });
  await expect(Env.setEnv(BASE, 'K', 'V')).rejects.toThrow('Failed to save secret');
});

test('deleteEnv falls back to "Failed to delete secret" when the daemon gives no error body', async () => {
  nextResponse = () => new Response('', { status: 500, statusText: '' });
  await expect(Env.deleteEnv(BASE, 'K')).rejects.toThrow('Failed to delete secret');
});

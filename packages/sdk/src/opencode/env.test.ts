import { test, expect, beforeEach, mock } from 'bun:test';
import * as realServerStore from '../state/server-store';
import * as realAuth from '../platform/auth';

let calls: { url: string; method: string; body?: string }[] = [];
let activeUrl = 'http://sbx.test';
let nextResponse: () => Response = () =>
  new Response(JSON.stringify({ secrets: { FOO: 'bar' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

mock.module('../state/server-store', () => ({
  ...realServerStore,
  getActiveOpenCodeUrl: () => activeUrl,
}));
mock.module('../platform/auth', () => ({
  ...realAuth,
  authenticatedFetch: async (url: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined });
    return nextResponse();
  },
}));

const Env = await import('./env');
const last = () => calls[calls.length - 1];

beforeEach(() => {
  calls = [];
  activeUrl = 'http://sbx.test';
  nextResponse = () =>
    new Response(JSON.stringify({ secrets: { FOO: 'bar' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
});

test('listEnv hits GET /env and returns the secrets map', async () => {
  const secrets = await Env.listEnv();
  expect(last().url).toBe('http://sbx.test/env');
  expect(last().method).toBe('GET');
  expect(secrets).toEqual({ FOO: 'bar' });
});

test('setEnv PUTs to /env/:key with a JSON value body', async () => {
  await Env.setEnv('ELEVENLABS_API_KEY', 'shh');
  expect(last().url).toBe('http://sbx.test/env/ELEVENLABS_API_KEY');
  expect(last().method).toBe('PUT');
  expect(JSON.parse(last().body!)).toEqual({ value: 'shh' });
});

test('setEnv URL-encodes the key', async () => {
  await Env.setEnv('A B', 'v');
  expect(last().url).toBe('http://sbx.test/env/A%20B');
});

test('deleteEnv DELETEs /env/:key', async () => {
  await Env.deleteEnv('OPENAI_API_KEY');
  expect(last().url).toBe('http://sbx.test/env/OPENAI_API_KEY');
  expect(last().method).toBe('DELETE');
});

test('env namespace exposes list/set/delete', () => {
  expect(typeof Env.env.list).toBe('function');
  expect(typeof Env.env.set).toBe('function');
  expect(typeof Env.env.delete).toBe('function');
});

test('listEnv throws when the active runtime url is not ready', async () => {
  activeUrl = '';
  await expect(Env.listEnv()).rejects.toThrow('Server URL not ready');
});

test('setEnv surfaces the daemon error body on failure', async () => {
  nextResponse = () =>
    new Response(JSON.stringify({ error: 'quota exceeded' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  await expect(Env.setEnv('K', 'V')).rejects.toThrow('quota exceeded');
});

import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  type CustomLlmProvider,
  deleteCustomLlmProvider,
  listCustomLlmProviders,
  putCustomLlmProvider,
} from './custom-llm-providers';

const provider: CustomLlmProvider = {
  id: 'my-llm',
  name: 'My LLM',
  base_url: 'https://llm.example.test/v1',
  models: [{ id: 'model-a', name: 'Model A' }],
  secret_name: 'CUSTOM_MY_LLM_API_KEY',
  has_key: true,
  configured: true,
};
let calls: { url: string; method: string; body: unknown; headers: Headers }[] = [];
let reply: (url: string) => Response;
beforeEach(() => {
  calls = [];
  reply = () => Response.json({ providers: [provider] });
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'test-token' });
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? 'GET',
      body: options.body ? JSON.parse(String(options.body)) : undefined,
      headers: new Headers(options.headers),
    });
    return reply(String(url));
  }) as unknown as typeof fetch;
});

test('lists the project custom providers, unwrapped from { providers }', async () => {
  expect(await listCustomLlmProviders('project-1')).toEqual([provider]);
  expect(calls[0].method).toBe('GET');
  expect(calls[0].url).toBe('http://test.local/v1/projects/project-1/custom-providers');
  expect(calls[0].headers.get('authorization')).toBe('Bearer test-token');
});

test('saves one provider with PUT and returns the stored row', async () => {
  reply = () => Response.json(provider);
  const input = { name: 'My LLM', base_url: 'https://llm.example.test/v1', models: [{ id: 'model-a', name: 'Model A' }] };
  expect(await putCustomLlmProvider('project-1', 'my-llm', input)).toEqual(provider);
  expect(calls[0].method).toBe('PUT');
  expect(calls[0].url).toBe('http://test.local/v1/projects/project-1/custom-providers/my-llm');
  expect(calls[0].body).toEqual(input);
});

test('deletes the definition, then its CUSTOM_<ID>_API_KEY project secret', async () => {
  reply = (url) => (url.includes('/secrets/') ? Response.json({ ok: true }) : new Response(null, { status: 204 }));
  await expect(deleteCustomLlmProvider('project-1', 'my-llm')).resolves.toBeUndefined();
  expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
    'DELETE http://test.local/v1/projects/project-1/custom-providers/my-llm',
    'DELETE http://test.local/v1/projects/project-1/secrets/CUSTOM_MY_LLM_API_KEY',
  ]);
});

test('a missing definition (a legacy key-only row) or a missing key is not an error', async () => {
  reply = () => Response.json({ error: 'not found' }, { status: 404 });
  await expect(deleteCustomLlmProvider('project-1', 'old_key')).resolves.toBeUndefined();
  expect(calls.map((call) => call.url)).toEqual([
    'http://test.local/v1/projects/project-1/custom-providers/old_key',
    'http://test.local/v1/projects/project-1/secrets/CUSTOM_OLD_KEY_API_KEY',
  ]);
});

test('any other delete failure throws and keeps the key', async () => {
  reply = () => Response.json({ error: 'denied' }, { status: 403 });
  await expect(deleteCustomLlmProvider('project-1', 'my-llm')).rejects.toMatchObject({ status: 403 });
  expect(calls).toHaveLength(1);
});

test('a rejected save throws with the API code', async () => {
  reply = () => Response.json({ error: 'reserved', code: 'reserved_provider_id' }, { status: 400 });
  await expect(
    putCustomLlmProvider('project-1', 'openai', { name: 'x', base_url: 'https://x.test', models: [{ id: 'm', name: 'm' }] }),
  ).rejects.toMatchObject({ status: 400, code: 'reserved_provider_id' });
});

import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { getProjectModelAccess, setProjectModelAccess } from './model-access';

const policy = { disabledProviders: ['kortix'], disabledModels: ['openai/gpt-test'] };
let calls: { url: string; method: string; body: unknown; headers: Headers }[] = [];
let status = 200;
beforeEach(() => {
  calls = [];
  status = 200;
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'test-token' });
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET',
      body: options.body ? JSON.parse(String(options.body)) : undefined,
      headers: new Headers(options.headers) });
    return Response.json(status === 200 ? policy : { error: 'Change the default first.', code: 'cannot_disable_default' }, { status });
  }) as unknown as typeof fetch;
});

test('reads project access through authenticated SDK transport', async () => {
  expect(await getProjectModelAccess('project-1')).toEqual(policy);
  expect(calls[0].url).toContain('/projects/project-1/model-access');
  expect(calls[0].headers.get('authorization')).toBe('Bearer test-token');
});

test('changes one provider without replacing model preferences', async () => {
  expect(await setProjectModelAccess('project-1', { target: 'provider', id: 'kortix', enabled: false })).toEqual(policy);
  expect(calls[0].method).toBe('PUT');
  expect(calls[0].body).toEqual({ target: 'provider', id: 'kortix', enabled: false });
});

test('re-enables a model with its full nested wire id', async () => {
  await setProjectModelAccess('project-1', { target: 'model', id: 'openrouter/vendor/model', enabled: true });
  expect(calls[0].body).toEqual({ target: 'model', id: 'openrouter/vendor/model', enabled: true });
});

test('propagates a rejected default disable', async () => {
  status = 409;
  await expect(setProjectModelAccess('project-1', { target: 'provider', id: 'kortix', enabled: false })).rejects.toThrow();
});

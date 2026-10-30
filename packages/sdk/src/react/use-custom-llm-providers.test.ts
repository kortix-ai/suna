import { expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import { qk } from './query-keys';
import { useCustomLlmProviders } from './use-custom-llm-providers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = {
  id: 'my-llm',
  name: 'My LLM',
  base_url: 'https://llm.example.test/v1',
  models: [{ id: 'model-a', name: 'Model A' }],
  secret_name: 'CUSTOM_MY_LLM_API_KEY',
  has_key: false,
  configured: true,
};
const input = { name: 'My LLM', base_url: 'https://llm.example.test/v1', models: [{ id: 'model-a', name: 'Model A' }] };
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const keyOf = (args: unknown) => JSON.stringify((args as { queryKey?: unknown } | undefined)?.queryKey);

test('lists, saves and removes; every write refreshes the provider list and the model picker', async () => {
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    const method = options.method ?? 'GET';
    calls.push(`${method} ${String(url)}`);
    if (method === 'PUT') return Response.json(row);
    if (method === 'DELETE' && String(url).includes('/secrets/')) return Response.json({ ok: true });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ providers: [row] });
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = mock(client.invalidateQueries.bind(client));
  client.invalidateQueries = invalidate;
  let value!: ReturnType<typeof useCustomLlmProviders>;
  function Probe() { value = useCustomLlmProviders('p1'); return null; }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  });
  await settle();
  expect(value.isLoading).toBe(false);
  expect(value.error).toBeNull();
  expect(value.providers).toEqual([row]);
  expect(client.getQueryData<unknown>(qk.project.customLlmProviders('p1'))).toEqual([row]);

  const refreshed = [
    qk.project.customLlmProviders('p1'),
    qk.project.modelPicker('p1'),
    ['project-providers', 'p1'],
  ].map((key) => JSON.stringify(key));

  await act(async () => { expect(await value.save('my-llm', input)).toEqual(row); });
  expect(calls).toContain('PUT http://test.local/v1/projects/p1/custom-providers/my-llm');
  for (const key of refreshed) expect(invalidate.mock.calls.some(([args]) => keyOf(args) === key)).toBe(true);

  invalidate.mockClear();
  await act(async () => { await value.remove('my-llm'); });
  expect(calls).toContain('DELETE http://test.local/v1/projects/p1/custom-providers/my-llm');
  expect(calls).toContain('DELETE http://test.local/v1/projects/p1/secrets/CUSTOM_MY_LLM_API_KEY');
  for (const key of [...refreshed, JSON.stringify(qk.project.secrets('p1'))]) {
    expect(invalidate.mock.calls.some(([args]) => keyOf(args) === key)).toBe(true);
  }
  expect(value.isSaving).toBe(false);

  await act(async () => root.unmount());
  client.clear();
});

test('no project: no request, an empty settled list', async () => {
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  const fetchMock = mock(async () => Response.json({ providers: [row] }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let value!: ReturnType<typeof useCustomLlmProviders>;
  function Probe() { value = useCustomLlmProviders(null); return null; }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  });
  await settle();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(value.providers).toEqual([]);
  expect(value.isLoading).toBe(false);
  await act(async () => root.unmount());
  client.clear();
});

import { expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import { useModelAccess } from './use-model-access';
import { qk } from './query-keys';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('a successful policy write refreshes both picker caches; a rejection preserves access', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let policy = { disabledProviders: [] as string[], disabledModels: [] as string[], enforced: true };
  let reject = false;
  globalThis.fetch = mock(async (_url: unknown, options: RequestInit = {}) => {
    if (options.method === 'PUT') {
      if (reject) return Response.json({ error: 'Default is protected' }, { status: 409 });
      policy = { ...policy, disabledProviders: ['kortix'] };
    }
    return Response.json(policy);
  }) as unknown as typeof fetch;
  let value: ReturnType<typeof useModelAccess>;
  function Probe() { value = useModelAccess('p1'); return null; }
  const invalidate = mock(client.invalidateQueries.bind(client));
  client.invalidateQueries = invalidate;
  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await act(async () => { await value!.setEnabled({ target: 'provider', id: 'kortix', enabled: false }); await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(value!.data?.disabledProviders).toEqual(['kortix']);
  expect(invalidate.mock.calls.some(([args]) => JSON.stringify(args?.queryKey) === JSON.stringify(qk.project.modelPicker('p1')))).toBe(true);
  expect(invalidate.mock.calls.some(([args]) => JSON.stringify(args?.queryKey) === JSON.stringify(['project-providers', 'p1']))).toBe(true);
  reject = true;
  await act(async () => {
    await expect(value!.setEnabled({ target: 'provider', id: 'kortix', enabled: true })).rejects.toThrow();
  });
  expect(value!.data?.disabledProviders).toEqual(['kortix']);
  await act(async () => root!.unmount());
  client.clear();
});

test('changing the default invalidates the access policy that locks its provider switch', async () => {
  const { useModelDefaults } = await import('./use-model-defaults');
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  globalThis.fetch = mock(async () => Response.json({})) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = mock(client.invalidateQueries.bind(client));
  client.invalidateQueries = invalidate;
  let defaults: ReturnType<typeof useModelDefaults>;
  function Probe() { defaults = useModelDefaults('p1'); return null; }
  let root: ReturnType<typeof create>;
  await act(async () => { root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe))); });
  await act(async () => { await defaults!.setProjectDefault({ providerID: 'kortix', modelID: 'openai/new-default' }); });
  expect(invalidate.mock.calls.some(([args]) => JSON.stringify(args?.queryKey) === JSON.stringify(qk.project.modelAccess('p1')))).toBe(true);
  await act(async () => root!.unmount());
  client.clear();
});

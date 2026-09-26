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

/**
 * A DISABLED react-query never leaves `status: 'pending'` — with no fetch to
 * settle it, `isPending` stays true forever. `useModelAccess` is disabled
 * whenever `projectId` is null/undefined, which `provider-connect.tsx` does on
 * purpose, so the exported `isLoading` must read the enabled-aware half of the
 * state (`fetchStatus`) and not `isPending` alone.
 *
 * This is the 2026-09-17 composer-model-picker defect class (PR #7380, and the
 * `learnings` entry "A disabled react-query is `isPending` forever"): a spinner
 * that outlives every request, because the gate is reading a flag that is
 * waiting for a fetch which was never scheduled.
 *
 * The second half is load-bearing: it stops "always false" from passing.
 */
test('a null projectId reports settled, not an endless load, while a real one still reports its first fetch', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const policy = { disabledProviders: [] as string[], disabledModels: [] as string[], enforced: true };
  const fetchMock = mock(async () => Response.json(policy));
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const whileDisabled: boolean[] = [];
  function Disabled() { whileDisabled.push(useModelAccess(null).isLoading); return null; }
  let disabledRoot: ReturnType<typeof create>;
  await act(async () => {
    disabledRoot = create(React.createElement(QueryClientProvider, { client }, React.createElement(Disabled)));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(whileDisabled.length).toBeGreaterThan(0);
  expect(whileDisabled).toEqual(whileDisabled.map(() => false));
  await act(async () => disabledRoot!.unmount());

  const whileEnabled: boolean[] = [];
  let value: ReturnType<typeof useModelAccess>;
  function Enabled() { value = useModelAccess('p1'); whileEnabled.push(value.isLoading); return null; }
  let enabledRoot: ReturnType<typeof create>;
  await act(async () => {
    enabledRoot = create(React.createElement(QueryClientProvider, { client }, React.createElement(Enabled)));
  });
  expect(whileEnabled[0]).toBe(true);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(value!.isLoading).toBe(false);
  expect(value!.data?.enforced).toBe(true);
  await act(async () => enabledRoot!.unmount());
  client.clear();
});

import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

let sandboxUrl = 'https://image.example/v1/p/synthetic/8000';
let getToken: () => Promise<string | null> = async () => 'initial';
mock.module('@/contexts/SandboxContext', () => ({ useSandboxContext: () => ({ sandboxUrl }) }));
mock.module('@/api/config', () => ({ getAuthToken: () => getToken() }));
const { configureKortix } = await import('@kortix/sdk');
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { useSandboxImage } = await import('./use-sandbox-image');
let value: ReturnType<typeof useSandboxImage>;
let root: ReactTestRenderer | undefined;
let requests: RequestInit[] = [];
const originalFetch = globalThis.fetch;
let response: () => Promise<Response> = async () => new Response(null, { headers: { 'content-length': '8388609' } });
function Probe({ path, enabled = true }: { path: string; enabled?: boolean }) {
  value = useSandboxImage(path, enabled);
  return null;
}
async function mount(path: string, enabled = true) {
  requests = [];
  configureKortix({ backendUrl: 'https://image.example/v1', getToken: () => getToken(), fetch: async (_url, init) => { requests.push(init ?? {}); return response(); } });
  Object.assign(globalThis, { fetch: async (_url: RequestInfo | URL, init?: RequestInit) => { requests.push(init ?? {}); return response(); } });
  await act(async () => { root = create(React.createElement(Probe, { path, enabled })); });
}
afterEach(async () => {
  await act(async () => { root?.unmount(); root = undefined; });
  globalThis.fetch = originalFetch;
  getToken = async () => 'initial';
  response = async () => new Response(null, { headers: { 'content-length': '8388609' } });
});
test('large images wait for a tap; native failure refreshes once then becomes terminal', async () => {
  await mount('large');
  expect(value.phase).toBe('tap-to-load');
  expect(value.sizeBytes).toBe(8388609);
  expect(requests[0]?.method).toBe('HEAD');
  expect(value.source?.headers).toEqual({ Authorization: 'Bearer initial' });
  await act(async () => value.loadAnyway());
  expect(value.phase).toBe('load');
  getToken = async () => 'fresh';
  await act(async () => value.handleError());
  expect(value.attempt).toBe(1);
  expect(value.source?.headers).toEqual({ Authorization: 'Bearer fresh' });
  await act(async () => value.handleError());
  expect(value.phase).toBe('error');
  expect(requests).toHaveLength(1);
});
for (const header of [null, 'invalid', '8388608']) {
  test(`successful probe ${header} loads and caches across remounts`, async () => {
    response = async () => new Response(null, { headers: header === null ? {} : { 'content-length': header } });
    await mount(`cache-${header}`);
    expect(value.phase).toBe('load');
    expect(value.sizeBytes).toBe(header === '8388608' ? 8388608 : null);
    await act(async () => root?.unmount());
    await mount(`cache-${header}`);
    expect(requests).toHaveLength(0);
  });
}
for (const status of [401, 500]) {
  test(`non-success ${status} is unknown and not cached, even without a token`, async () => {
    getToken = async () => null;
    response = async () => new Response(null, { status });
    await mount(`status-${status}`);
    expect(value.phase).toBe('load');
    expect(value.source?.headers).toBeUndefined();
    expect(requests).toHaveLength(1);
    await act(async () => root?.unmount());
    await mount(`status-${status}`);
    expect(requests).toHaveLength(1);
  });
}
test('failed token and failed network still expose an unauthenticated native source', async () => {
  getToken = async () => { throw new Error('synthetic token failure'); };
  response = async () => { throw new Error('synthetic network failure'); };
  await mount('network');
  expect(value.phase).toBe('load');
  expect(value.sizeBytes).toBeNull();
  expect(value.source?.headers).toBeUndefined();
  expect(requests).toHaveLength(1);
});
test('URL switches abort probes and ignore their late state completions', async () => {
  let finish: (response: Response) => void = () => {};
  response = () => new Promise((resolve) => { finish = resolve; });
  await mount('pending');
  const signal = requests[0]?.signal;
  response = async () => new Response(null, { headers: { 'content-length': '1' } });
  await act(async () => root?.update(React.createElement(Probe, { path: 'replacement' })));
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(new Response(null, { headers: { 'content-length': '99999999' } })));
  expect(value.sizeBytes).toBe(1);
  expect(value.phase).toBe('load');
});
test('unmount before token completion sends no probe', async () => {
  let finish: (token: string) => void = () => {};
  getToken = () => new Promise((resolve) => { finish = resolve; });
  await mount('unmount');
  await act(async () => root?.unmount());
  await act(async () => finish('late'));
  expect(requests).toHaveLength(0);
});
test('disabled images do not probe', async () => {
  await mount('disabled', false);
  expect(value.phase).toBe('probing');
  expect(requests).toHaveLength(0);
});

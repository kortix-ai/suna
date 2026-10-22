import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { configureKortix } from '@kortix/sdk';

const sandboxUrl = 'https://image.example/v1/p/synthetic/8000';
let getToken: () => Promise<string | null> = async () => 'initial';
mock.module('@/contexts/SandboxContext', () => ({ useSandboxContext: () => ({ sandboxUrl }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { useSandboxImage } = await import('./use-sandbox-image');
let value: ReturnType<typeof useSandboxImage>;
let root: ReactTestRenderer | undefined;
let requests: RequestInit[] = [];
let response: () => Promise<Response> = async () => new Response(null, { headers: { 'content-length': '8388609' } });
function Probe({ path, enabled = true }: { path: string; enabled?: boolean }) {
  value = useSandboxImage(path, enabled);
  return null;
}
async function mount(path: string, enabled = true) {
  requests = [];
  // The probe runs through the SDK's one configured seam: getToken + fetch.
  configureKortix({ backendUrl: 'https://image.example/v1', getToken: () => getToken(), fetch: async (_url, init) => { requests.push(init ?? {}); return response(); } });
  await act(async () => { root = create(React.createElement(Probe, { path, enabled })); });
}
afterEach(async () => {
  await act(async () => { root?.unmount(); root = undefined; });
  getToken = async () => 'initial';
  response = async () => new Response(null, { headers: { 'content-length': '8388609' } });
});
test('large images wait for a tap; native failure refreshes once then becomes terminal', async () => {
  await mount('large');
  expect(value.phase).toBe('tap-to-load');
  expect(value.sizeBytes).toBe(8388609);
  expect(requests[0]?.method).toBe('HEAD');
  expect(requests[0]?.headers).toEqual({ Authorization: 'Bearer initial' });
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
  test(`non-success ${status} is unknown, not replayed, and not cached`, async () => {
    response = async () => new Response(null, { status });
    await mount(`status-${status}`);
    expect(value.phase).toBe('load');
    expect(value.sizeBytes).toBeNull();
    expect(requests).toHaveLength(1);
    await act(async () => root?.unmount());
    await mount(`status-${status}`);
    // Not cached: the remount probes again (mount() resets the request log).
    expect(requests).toHaveLength(1);
  });
}
test('a missing or failed token sends no probe and exposes an unauthenticated native source', async () => {
  // The SDK seam never sends without a token (synthetic 401): the probe reads
  // as unknown, the native loader still runs unauthenticated.
  for (const failing of [false, true]) {
    getToken = failing
      ? async () => { throw new Error('synthetic token failure'); }
      : async () => null;
    await mount(`no-token-${failing}`);
    expect(value.phase).toBe('load');
    expect(value.sizeBytes).toBeNull();
    expect(value.source?.headers).toBeUndefined();
    expect(requests).toHaveLength(0);
  }
});
test('a failed probe network call is unknown and the native source keeps its token', async () => {
  response = async () => { throw new Error('synthetic network failure'); };
  await mount('network');
  expect(value.phase).toBe('load');
  expect(value.sizeBytes).toBeNull();
  expect(value.source?.headers).toEqual({ Authorization: 'Bearer initial' });
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

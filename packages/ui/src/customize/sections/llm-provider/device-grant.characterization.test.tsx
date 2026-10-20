import { afterAll, afterEach, expect, jest, mock, test } from 'bun:test';
import React from 'react';
import { Window } from 'happy-dom';
const originalGlobals = Object.getOwnPropertyDescriptors(globalThis);
const window = new Window();
Object.assign(globalThis, { window, document: window.document });
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const sdk = await import('@kortix/sdk');
const sdkReact = await import('@kortix/sdk/react');
const start = mock(async (..._args: Parameters<typeof sdk.startProjectProviderOAuth>) => ({ flow_id: 'flow', verification_url: 'https://example.test', user_code: 'CODE', interval_ms: 2000, expires_at: Date.now() + 10000 }));
let responses: Array<{ status: string; error?: string } | Error> = [];
const poll = mock(async () => {
  const result = responses.shift() ?? { status: 'pending' };
  if (result instanceof Error) throw result;
  return result;
});
const refresh = mock(() => {});
mock.module('@kortix/sdk', () => ({ ...sdk, startProjectProviderOAuth: start, pollProjectProviderOAuth: poll, listProjectSecrets: async () => [], listProjectProviderOAuth: async () => [] }));
mock.module('@kortix/sdk/react', () => ({ ...sdkReact, refreshProjectProviderState: refresh }));
const { useSubscriptionSignIn } = await import('./chatgpt-subscription-connect');
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => jest.useRealTimers());
afterAll(() => {
  for (const key of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']) {
    const descriptor = originalGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  window.happyDOM.abort();
});

for (const outcome of ['success', 'failed', 'failed-default', 'expired', 'timeout', 'cancelled', 'start-error', 'start-non-error', 'retry'] as const) {
  test(`existing subscription hook: ${outcome}`, async () => {
    jest.useFakeTimers();
    start.mockClear(); poll.mockClear(); refresh.mockClear();
    responses = outcome === 'retry' ? [new Error('transient'), { status: 'success' }] : [{ status: outcome === 'failed-default' ? 'failed' : outcome, ...(outcome === 'failed' ? { error: 'Denied' } : {}) }];
    if (outcome === 'start-error') start.mockImplementationOnce(async () => { throw new Error('Start broke'); });
    if (outcome === 'start-non-error') start.mockImplementationOnce(async () => { throw 'oops'; });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const invalidate = mock(async () => {});
    client.invalidateQueries = invalidate;
    const connected = mock((_id: string) => {});
    let current: ReturnType<typeof useSubscriptionSignIn> | undefined;
    function state() {
      if (!current) throw new Error('Hook has not rendered');
      return current;
    }
    function Probe() { current = useSubscriptionSignIn({ projectId: 'project', onConnected: connected }); return null; }
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(<QueryClientProvider client={client}><Probe /></QueryClientProvider>); });
    let running: Promise<void> | undefined;
    await act(async () => { running = state().start(); await Promise.resolve(); });
    expect(start.mock.calls).toEqual([['project', 'openai', {}]]);
    if (!outcome.startsWith('start-')) {
      expect(state().phase).toBe('waiting');
      expect(state().challenge).toEqual({ url: 'https://example.test', code: 'CODE' });
    }
    if (outcome === 'cancelled') await act(async () => state().cancel());
    for (let i = 0; i < 6; i++) await act(async () => { jest.advanceTimersByTime(2000); await Promise.resolve(); });
    await act(async () => { await running; });
    const success = outcome === 'success' || outcome === 'retry';
    expect(state().phase).toBe(success ? 'done' : 'idle');
    expect(state().error).toBe(outcome === 'failed' ? 'Denied' : outcome === 'failed-default' ? 'Authorization failed' : outcome === 'expired' || outcome === 'timeout' ? 'Authorization timed out. Try again.' : outcome === 'start-error' ? 'Start broke' : outcome === 'start-non-error' ? 'Failed to connect ChatGPT subscription' : null);
    expect(state().challenge).toEqual(success ? { url: 'https://example.test', code: 'CODE' } : null);
    expect(connected.mock.calls).toEqual(success ? [['codex']] : []);
    expect(invalidate.mock.calls.length).toBe(success ? 2 : 0);
    expect(refresh.mock.calls.length).toBe(success ? 1 : 0);
    expect(poll.mock.calls.length).toBe(outcome.startsWith('start-') || outcome === 'cancelled' ? 0 : outcome === 'timeout' ? 5 : outcome === 'retry' ? 2 : 1);
    await act(async () => renderer?.unmount());
    client.clear();
  });
}

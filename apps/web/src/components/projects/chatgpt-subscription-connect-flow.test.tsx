/**
 * Characterization tests for `useChatGptConnectFlow` after the device-OAuth
 * start/poll loop moved into the SDK (`runProjectProviderOAuthFlow`).
 *
 * The hook's own contract is what a React host does with each flow outcome:
 * sharing validation before any request, the challenge view while waiting,
 * the translated success toast plus the query invalidations on success, the
 * error mapping for failed / expired / start-failed outcomes, and the cancel
 * path that clears the challenge and stays quiet. The polling protocol
 * itself (cadence, deadline, retry) is characterized in the SDK's
 * `secrets.test.ts`; these tests drive the real SDK flow against a scripted
 * fetch under fake timers.
 */

import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { configureKortix } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';

import { qk } from '@kortix/sdk/react';

const toastSuccess = mock((_message: string) => {});
const refreshProvider = mock((_queryClient: unknown, _projectId: string, _opts?: unknown) => {});
const realToast = await import('@/components/ui/toast');
const realSdkReact = await import('@kortix/sdk/react');

mock.module('@/components/ui/toast', () => ({ ...realToast, successToast: toastSuccess }));
mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  refreshProjectProviderState: refreshProvider,
}));

const { useChatGptConnectFlow } = await import('./chatgpt-subscription-connect');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const startBody = {
  flow_id: 'flow-1',
  verification_url: 'https://example.test/device',
  user_code: 'ABCD-1234',
  expires_at: Number.MAX_SAFE_INTEGER,
  interval_ms: 5_000,
};
const credential = {
  provider_id: 'codex',
  expires_in_ms: null,
  updated_at: '2026-10-02T00:00:00Z',
};

const calls: { url: string; method: string; body: unknown }[] = [];
let script: { status: number; body: unknown }[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  calls.length = 0;
  toastSuccess.mockClear();
  refreshProvider.mockClear();
  script = [];
  configureKortix({
    backendUrl: 'http://api.test/v1',
    getToken: async () => 'token',
    fetch: async (url, init = {}) => {
      calls.push({
        url: String(url),
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const step = script.shift();
      if (!step) throw new Error(`unexpected fetch: ${String(url)}`);
      return new Response(JSON.stringify(step.body), {
        status: step.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
});

afterEach(() => {
  jest.useRealTimers();
});

async function mountFlow(
  props: Omit<Parameters<typeof useChatGptConnectFlow>[0], 'projectId'> = {},
) {
  const queryClient = new QueryClient();
  const invalidate = mock(async (..._args: Parameters<typeof queryClient.invalidateQueries>) => {});
  queryClient.invalidateQueries = invalidate;
  const state: {
    flow?: ReturnType<typeof useChatGptConnectFlow>;
    renderer?: ReactTestRenderer;
  } = {};
  function Probe() {
    state.flow = useChatGptConnectFlow({
      ...props,
      projectId: 'proj-1',
    });
    return null;
  }
  await act(async () => {
    state.renderer = create(
      createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)),
    );
  });
  /** Drain pending microtasks so the flow's awaits resume inside act. */
  const drain = async () => {
    for (let i = 0; i < 8; i++) await act(async () => void (await Promise.resolve()));
  };
  /** Advance the fake clock and drain. */
  const advance = async (ms: number) => {
    await act(async () => {
      jest.advanceTimersByTime(ms);
      await Promise.resolve();
    });
  };
  if (!state.renderer) throw new Error('Probe did not mount');
  return {
    flow: () => {
      if (!state.flow) throw new Error('Probe did not render the flow');
      return state.flow;
    },
    invalidate,
    renderer: state.renderer,
    drain,
    advance,
  };
}

describe('useChatGptConnectFlow', () => {
  test('waits with the challenge, then completes with a toast and the invalidations', async () => {
    script.push({ status: 200, body: startBody });
    script.push({ status: 200, body: { status: 'pending' } });
    script.push({ status: 200, body: { status: 'success', credential } });
    const mounted = await mountFlow({ onConnected: () => {} });

    await act(async () => {
      void mounted.flow().connect();
    });
    await mounted.drain();
    expect(calls[0]?.url).toBe('http://api.test/v1/projects/proj-1/oauth/openai/start');
    expect(mounted.flow().isWaiting).toBe(true);
    expect(mounted.flow().challenge).toEqual({
      url: 'https://example.test/device',
      code: 'ABCD-1234',
    });

    await mounted.advance(5_000);
    expect(calls[1]?.url).toBe('http://api.test/v1/projects/proj-1/oauth/openai/poll');
    expect(mounted.flow().isWaiting).toBe(true);
    await mounted.advance(5_000);
    await mounted.drain();
    expect(mounted.flow().isDone).toBe(true);
    expect(mounted.flow().error).toBeNull();
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(mounted.invalidate).toHaveBeenCalledTimes(1);
    expect(mounted.invalidate.mock.calls[0]?.[0]).toEqual({
      queryKey: qk.project.secrets('proj-1'),
    });
    expect(refreshProvider).toHaveBeenCalledTimes(1);
    expect(refreshProvider.mock.calls[0]?.[2]).toEqual({ expectProviderId: 'codex' });
  });

  test('refuses to start without a sharing selection and never calls the API', async () => {
    const mounted = await mountFlow({ sharing: { mode: 'members', memberIds: [], groupIds: [] } });
    await act(async () => {
      void mounted.flow().connect();
    });
    await mounted.drain();
    expect(calls).toHaveLength(0);
    expect(mounted.flow().error).toBe('Pick at least one member, or choose another access option.');
    expect(mounted.flow().phase).toBe('idle');
  });

  test('a denied authorization clears the challenge and never invalidates', async () => {
    script.push({ status: 200, body: startBody });
    script.push({ status: 200, body: { status: 'failed', error: 'The user denied the request' } });
    const mounted = await mountFlow();
    await act(async () => {
      void mounted.flow().connect();
    });
    await mounted.drain();
    await mounted.advance(5_000);
    await mounted.drain();
    expect(mounted.flow().phase).toBe('idle');
    expect(mounted.flow().error).toBe('The user denied the request');
    expect(mounted.flow().challenge).toBeNull();
    expect(mounted.invalidate).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(refreshProvider).not.toHaveBeenCalled();
  });

  test('an expired or timed-out flow reports the timeout copy', async () => {
    script.push({ status: 200, body: startBody });
    script.push({ status: 200, body: { status: 'expired' } });
    const mounted = await mountFlow();
    await act(async () => {
      void mounted.flow().connect();
    });
    await mounted.drain();
    await mounted.advance(5_000);
    await mounted.drain();
    expect(mounted.flow().error).toBe('Authorization timed out. Try again.');
    expect(mounted.flow().phase).toBe('idle');
  });

  test('a failed start surfaces the API error', async () => {
    script.push({ status: 403, body: { message: 'forbidden' } });
    const mounted = await mountFlow();
    await act(async () => {
      void mounted.flow().connect();
    });
    await mounted.drain();
    expect(mounted.flow().phase).toBe('idle');
    expect(mounted.flow().error).toBe('forbidden');
    expect(mounted.invalidate).not.toHaveBeenCalled();
  });

  test('cancelling during the wait clears the challenge and stays quiet afterwards', async () => {
    script.push({ status: 200, body: startBody });
    script.push({ status: 200, body: { status: 'pending' } });
    script.push({ status: 200, body: { status: 'success', credential } });
    const mounted = await mountFlow();
    await act(async () => {
      void mounted.flow().connect();
    });
    await mounted.drain();
    expect(mounted.flow().isWaiting).toBe(true);

    await act(async () => mounted.flow().cancel());
    expect(mounted.flow().phase).toBe('idle');
    expect(mounted.flow().challenge).toBeNull();
    expect(mounted.flow().error).toBeNull();

    // The abandoned flow resolves to `cancelled` and must not touch state.
    await mounted.advance(5_000);
    await mounted.drain();
    await mounted.advance(5_000);
    await mounted.drain();
    expect(mounted.flow().phase).toBe('idle');
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(mounted.invalidate).not.toHaveBeenCalled();
    expect(refreshProvider).not.toHaveBeenCalled();
  });
});

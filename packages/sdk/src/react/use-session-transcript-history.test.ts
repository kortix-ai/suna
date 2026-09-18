import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import { useSessionTranscriptHistory } from './use-session-transcript-history';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let root: ReactTestRenderer | undefined;
let client: QueryClient;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  client?.clear();
  globalThis.fetch = originalFetch;
});

function transcript(rootId = 'ses_history') {
  return {
    available: true,
    source: 'mirror',
    complete: true,
    reason: null,
    captured_at: '2026-09-16T00:00:00Z',
    opencode_session_id: rootId,
    message_count: 1,
    messages: [
      {
        info: {
          id: 'msg_history',
          sessionID: rootId,
          role: 'assistant',
          time: { created: 1, completed: 2 },
        },
        parts: [{ id: 'prt_history', type: 'text', text: 'Saved reply' }],
      },
    ],
  };
}

async function mount(enabled: boolean, sessionId = 's1') {
  configureKortix({
    backendUrl: 'http://test.local/v1',
    getToken: async () => 'token',
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let value: ReturnType<typeof useSessionTranscriptHistory>;
  function Probe(props: { enabled: boolean; sessionId: string }) {
    value = useSessionTranscriptHistory('p1', props.sessionId, props.enabled);
    return null;
  }
  const render = (sid: string, active: boolean) =>
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe, { sessionId: sid, enabled: active }),
    );
  await act(async () => {
    root = create(render(sessionId, enabled));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return {
    value: () => value!,
    update: async (sid: string, active = enabled) => {
      await act(async () => {
        root!.update(render(sid, active));
      });
    },
  };
}

test('enabled history reads the database without any start, snapshot, or runtime request', async () => {
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return Response.json(transcript());
  }) as unknown as typeof fetch;
  const hook = await mount(true);
  expect(hook.value().rootSessionId).toBe('ses_history');
  expect(hook.value().envelope?.messages[0].info.time).toEqual({
    created: 1,
    completed: 2,
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain('/sessions/s1/transcript?shape=sync');
  expect(requests[0]).toContain('history=true');
});

test('disabled history performs no read and exposes no stored transcript', async () => {
  const fetcher = mock(async () => Response.json(transcript()));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  const hook = await mount(false);
  expect(fetcher).not.toHaveBeenCalled();
  expect(hook.value()).toEqual({ envelope: null, rootSessionId: null });
});

test('switching sessions immediately drops the previous transcript while the new read waits', async () => {
  globalThis.fetch = mock(async (url: unknown) => {
    if (String(url).includes('/s2/')) return new Promise<Response>(() => {});
    return Response.json(transcript());
  }) as unknown as typeof fetch;
  const hook = await mount(true);
  expect(hook.value().rootSessionId).toBe('ses_history');
  await hook.update('s2');
  expect(hook.value()).toEqual({ envelope: null, rootSessionId: null });
});

test('turning the flag off removes the early history result', async () => {
  globalThis.fetch = mock(async () => Response.json(transcript())) as unknown as typeof fetch;
  const hook = await mount(true);
  await hook.update('s1', false);
  expect(hook.value()).toEqual({ envelope: null, rootSessionId: null });
});

test('missing history falls back without inventing an empty conversation or root', async () => {
  globalThis.fetch = mock(async () =>
    Response.json({
      ...transcript(),
      available: false,
      source: 'none',
      messages: [],
    }),
  ) as unknown as typeof fetch;
  const hook = await mount(true);
  expect(hook.value()).toEqual({ envelope: null, rootSessionId: null });
});

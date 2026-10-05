import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import { claimOpenBundle, openSessionBundle, resetSessionOpenBundles } from '../core/session/open-bundle';
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
  resetSessionOpenBundles();
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
  expect(hook.value()).toEqual({ envelope: null, rootSessionId: null, emptyRootSessionId: null, isLoading: false });
});

test('switching sessions immediately drops the previous transcript while the new read waits', async () => {
  globalThis.fetch = mock(async (url: unknown) => {
    if (String(url).includes('/s2/')) return new Promise<Response>(() => {});
    return Response.json(transcript());
  }) as unknown as typeof fetch;
  const hook = await mount(true);
  expect(hook.value().rootSessionId).toBe('ses_history');
  await hook.update('s2');
  expect(hook.value()).toEqual({ envelope: null, rootSessionId: null, emptyRootSessionId: null, isLoading: true });
});

test('turning the flag off removes the early history result', async () => {
  globalThis.fetch = mock(async () => Response.json(transcript())) as unknown as typeof fetch;
  const hook = await mount(true);
  await hook.update('s1', false);
  expect(hook.value()).toEqual({ envelope: null, rootSessionId: null, emptyRootSessionId: null, isLoading: false });
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
  expect(hook.value()).toEqual({ envelope: null, rootSessionId: null, emptyRootSessionId: null, isLoading: false });
});

test('a read with no answer yet is loading; an answer, found or not, is not', async () => {
  let answer!: (response: Response) => void;
  globalThis.fetch = mock(
    async () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  ) as unknown as typeof fetch;
  const hook = await mount(true);
  expect(hook.value().isLoading).toBe(true);
  expect(hook.value().envelope).toBeNull();
  await act(async () => {
    answer(Response.json(transcript()));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(hook.value().isLoading).toBe(false);
  expect(hook.value().rootSessionId).toBe('ses_history');
});

test('a complete saved copy with no messages names its root as proven empty, and paints nothing', async () => {
  globalThis.fetch = mock(async () =>
    Response.json({ ...transcript(), message_count: 0, total: 0, messages: [] }),
  ) as unknown as typeof fetch;
  const probe = await mount(true);
  expect(probe.value().envelope).toBeNull();
  expect(probe.value().emptyRootSessionId).toBe('ses_history');
});

test('only a complete, available copy that counts zero proves a conversation empty', async () => {
  const answers = [
    { ...transcript(), complete: false, message_count: 0, total: 0, messages: [] },
    { ...transcript(), available: false, source: 'none', message_count: 0, total: 0, messages: [] },
    // An older API sends no total; it never sends an available empty window.
    { ...transcript(), message_count: 0, messages: [] },
    { ...transcript(), total: 1 },
  ];
  for (const answer of answers) {
    globalThis.fetch = mock(async () => Response.json(answer)) as unknown as typeof fetch;
    const probe = await mount(true, `s-${answers.indexOf(answer)}`);
    expect(probe.value().emptyRootSessionId).toBeNull();
    if (root) await act(async () => root?.unmount());
    root = undefined;
    client.clear();
  }
});

// The session-open snapshot (`GET .../snapshot`) carries the same saved window.
// An open used to download it twice: once in the snapshot, once here.
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    observed_at: '2026-09-16T00:00:01Z',
    session: { session_id: 's1', runtime_session_id: 'ses_history', opencode_session_id: 'ses_history' },
    turn: { known: false, reason: 'test' },
    queue: { known: false, reason: 'test' },
    transcript: { known: true, requested: true, ...transcript() },
    config: { known: true, base_ref: null, agent_name: null, llm_gateway_enabled: false },
    models: { known: false, reason: 'llm_gateway_disabled' },
    audit: { known: false, reason: 'test' },
    ...overrides,
  };
}

function serve(snapshotResponse: () => Promise<Response>) {
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    if (String(url).includes('/snapshot')) return snapshotResponse();
    return Response.json(transcript());
  }) as unknown as typeof fetch;
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  return requests;
}

/** Open the session and wait for its snapshot to answer. */
async function openAndSettle() {
  openSessionBundle('p1', 's1');
  await claimOpenBundle('p1', 's1');
}

const historyReads = (requests: string[]) =>
  requests.filter((url) => url.includes('/transcript?shape=sync') && url.includes('history=true'));

test('a snapshot that already answered serves the history read: the saved window is downloaded once', async () => {
  const requests = serve(async () => Response.json(snapshot()));
  await openAndSettle();
  const hook = await mount(true);
  expect(hook.value().rootSessionId).toBe('ses_history');
  expect(hook.value().envelope?.messages[0].info.id).toBe('msg_history');
  expect(hook.value().isLoading).toBe(false);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain('/sessions/s1/snapshot');
});

test('a snapshot that answered "no copy is saved" serves the history read too', async () => {
  const requests = serve(async () =>
    Response.json(
      snapshot({
        transcript: { known: true, requested: true, ...transcript(), available: false, source: 'none', messages: [] },
      }),
    ),
  );
  await openAndSettle();
  const hook = await mount(true);
  expect(hook.value()).toEqual({ envelope: null, rootSessionId: null, emptyRootSessionId: null, isLoading: false });
  expect(requests).toHaveLength(1);
});

test('a snapshot still in flight is never waited for: the history route answers', async () => {
  const requests = serve(() => new Promise<Response>(() => {}));
  openSessionBundle('p1', 's1');
  const hook = await mount(true);
  expect(hook.value().isLoading).toBe(false);
  expect(hook.value().rootSessionId).toBe('ses_history');
  expect(historyReads(requests)).toHaveLength(1);
});

test('a snapshot that cannot prove the current root leaves the answer to the history route', async () => {
  const unproven = [
    // The saved copy is from another root: the route answers "not available".
    snapshot({ session: { session_id: 's1', runtime_session_id: 'ses_other', opencode_session_id: 'ses_other' } }),
    // The session has no root yet.
    snapshot({ session: { session_id: 's1', runtime_session_id: null, opencode_session_id: null } }),
    // The leg could not answer, or only the pointer was asked for.
    snapshot({ transcript: { known: false, reason: 'test' } }),
    snapshot({ transcript: { known: true, requested: false } }),
  ];
  for (const body of unproven) {
    const requests = serve(async () => Response.json(body));
    await openAndSettle();
    await mount(true);
    expect(historyReads(requests)).toHaveLength(1);
    if (root) await act(async () => root?.unmount());
    root = undefined;
    client.clear();
    resetSessionOpenBundles();
  }
});

test('a failed snapshot leaves the answer to the history route', async () => {
  const requests = serve(async () => Response.json({ error: 'Not found' }, { status: 404 }));
  await openAndSettle();
  const hook = await mount(true);
  expect(hook.value().rootSessionId).toBe('ses_history');
  expect(historyReads(requests)).toHaveLength(1);
});

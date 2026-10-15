import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '@kortix/sdk';
import { resetIdentityState, useSessionSync } from '@kortix/sdk/react';
import { SessionRuntimeProvider, type BoundSession } from '@/components/session/SessionRuntime';
import { useSavedCopy, type SavedCopyTarget } from './useSavedCopy';

/**
 * The connecting view shows a session's saved copy while its computer wakes
 * (up to minutes). The copy is read by `@kortix/sdk` with the web's one
 * saved-history read (KRTX-189); these tests pin what this app paints from it
 * and the requests it costs.
 */

const ROOT = 'ses_mobile_root';
const CHILD = 'ses_mobile_child';
const originalFetch = globalThis.fetch;

let urls: string[] = [];
function serve(route: (url: string) => unknown) {
  urls = [];
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    return Response.json(route(url));
  }) as unknown as typeof fetch;
}

function copy(rootId: string, count: number, fields: Record<string, unknown> = {}) {
  return {
    available: true,
    reason: null,
    source: 'mirror',
    complete: true,
    captured_at: '2026-09-26T10:00:00Z',
    opencode_session_id: rootId,
    message_count: count,
    messages: Array.from({ length: count }, (_, i) => ({
      info: { id: `msg_${rootId}_${i + 1}`, sessionID: rootId, role: 'assistant', time: { created: i + 1, completed: i + 2 } },
      parts: [{ id: `prt_${rootId}_${i + 1}`, type: 'text', text: `message ${i + 1}` }],
    })),
    ...fields,
  };
}

const target = (fields: Partial<SavedCopyTarget> = {}): SavedCopyTarget => ({
  projectId: 'p1',
  sessionId: 's1',
  rootId: ROOT,
  child: false,
  ...fields,
});

let tree: any;
let latest: ReturnType<typeof useSavedCopy> | null = null;
function Probe(props: { target: SavedCopyTarget | null }) {
  latest = useSavedCopy(props.target);
  return null;
}

async function mount(value: SavedCopyTarget | null) {
  await act(async () => {
    tree = create(React.createElement(Probe, { target: value }));
  });
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  return latest!;
}

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
});

afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  tree = undefined;
  latest = null;
  globalThis.fetch = originalFetch;
  resetIdentityState();
});

describe('useSavedCopy', () => {
  test('the root paints the server copy from one saved-history read', async () => {
    serve(() => copy(ROOT, 2));
    const view = await mount(target());
    expect(view.thread?.messages.map((message) => message.message_id)).toEqual([`msg_${ROOT}_1`, `msg_${ROOT}_2`]);
    expect(view.empty).toBe(false);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/projects/p1/sessions/s1/transcript?shape=sync');
    expect(urls[0]).toContain('history=true');
  });

  test('a sub-agent paints its own window, read by `child`, and never claims emptiness', async () => {
    serve(() => copy(CHILD, 1));
    const view = await mount(target({ rootId: CHILD, child: true }));
    expect(view.thread?.messages.map((message) => message.thread_id)).toEqual([CHILD]);
    expect(view.empty).toBe(false);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`child=${CHILD}`);
  });

  test('a copy that proves the root empty, with no turn on record, opens on the composer', async () => {
    serve((url) => (url.includes('/turn') ? { turns: [] } : copy(ROOT, 0, { total: 0 })));
    const view = await mount(target());
    expect(view.empty).toBe(true);
    expect(view.thread).toBeUndefined();
  });

  test('a failed read paints nothing and claims nothing', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    const view = await mount(target());
    expect(view).toEqual({ thread: undefined, empty: false });
  });

  test('no target reads nothing', async () => {
    serve(() => copy(ROOT, 2));
    const view = await mount(null);
    expect(view).toEqual({ thread: undefined, empty: false });
    expect(urls).toHaveLength(0);
  });
});

describe('connect → thread: the window is downloaded once per open (KRTX-189)', () => {
  // The connecting view reads the saved window while the computer wakes. At
  // the bind, `SessionRuntimeProvider`'s `useSession` starts the session-open
  // snapshot and `SessionPage` paints from the SDK's saved-history read (no
  // `mirror`). Neither may download the window again. The thread can commit
  // before the bind or with it (`lib/session/project-connect.ts`).
  const OPEN_ROOT = 'ses_mobile_open_root';
  let thread: ReturnType<typeof useSessionSync> | null = null;

  function Thread(props: { sessionId: string }) {
    thread = useSessionSync(OPEN_ROOT, {
      kortixSessionScope: `p1/${props.sessionId}`,
      networkEnabled: false,
    });
    return null;
  }

  function Opened(props: { client: QueryClient; session: BoundSession | null; sessionId: string }) {
    return (
      <QueryClientProvider client={props.client}>
        <SessionRuntimeProvider session={props.session}>
          <Thread sessionId={props.sessionId} />
        </SessionRuntimeProvider>
      </QueryClientProvider>
    );
  }

  /** The server: `/start` still waking, the snapshot honouring `?transcript=`. */
  function serveOpen(sessionId: string) {
    serve((url) => {
      if (url.includes('/snapshot')) {
        return {
          observed_at: '2026-09-26T10:00:01Z',
          session: { session_id: sessionId, runtime_session_id: OPEN_ROOT, opencode_session_id: OPEN_ROOT },
          turn: { known: false, reason: 'test' },
          queue: { known: false, reason: 'test' },
          transcript: url.includes('transcript=0')
            ? { known: true, requested: false }
            : { known: true, requested: true, ...copy(OPEN_ROOT, 2) },
          config: { known: true, base_ref: null, agent_name: null, llm_gateway_enabled: false },
          models: { known: false, reason: 'test' },
        };
      }
      if (url.includes('/transcript?')) return copy(OPEN_ROOT, 2);
      return { stage: 'starting', retriable: true, sandbox: null };
    });
  }

  async function settle() {
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  for (const order of ['bound with the thread', 'thread before the bind'] as const) {
    test(`${order}: one window read, and the snapshot asks for the pointer only`, async () => {
      const sessionId = order === 'bound with the thread' ? '11111111-1111-4111-8111-111111111189' : '22222222-2222-4222-8222-222222222189';
      serveOpen(sessionId);
      const connecting = await mount(target({ sessionId, rootId: OPEN_ROOT }));
      expect(connecting.thread?.messages).toHaveLength(2);
      await act(async () => tree.unmount());

      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const bound = { projectId: 'p1', sessionId };
      await act(async () => {
        tree = create(React.createElement(Opened, { client, session: order === 'bound with the thread' ? bound : null, sessionId }));
      });
      await settle();
      if (order === 'thread before the bind') {
        await act(async () => tree.update(React.createElement(Opened, { client, session: bound, sessionId })));
        await settle();
      }

      expect(thread?.messages.map((message) => message.info.id)).toEqual([`msg_${OPEN_ROOT}_1`, `msg_${OPEN_ROOT}_2`]);
      // This session's reads only: a retry of an earlier test can land late.
      const windows = urls.filter((url) => url.includes(`/sessions/${sessionId}/transcript?`));
      const snapshots = urls.filter((url) => url.includes(`/sessions/${sessionId}/snapshot`));
      expect(windows).toHaveLength(1);
      expect(snapshots.length).toBeGreaterThan(0);
      for (const url of snapshots) expect(url).toContain('transcript=0');
      client.clear();
    });
  }
});

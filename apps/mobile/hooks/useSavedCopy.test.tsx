import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureKortix, sessionLogOfV1Rows } from '@kortix/sdk';
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
/** The project flag `session_log` the project detail answers. */
let sessionLogOn = false;
function serve(route: (url: string) => unknown) {
  urls = [];
  globalThis.fetch = mock(async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    if (url.endsWith('/projects/p1/detail')) return Response.json({ project: { project_id: 'p1', experimental: { session_log: sessionLogOn } }, config: {} });
    const answer = route(url);
    return answer instanceof Response ? answer : Response.json(answer);
  }) as unknown as typeof fetch;
}
/** Every read but the project detail (the flag). */
const reads = () => urls.filter((url) => !url.endsWith('/detail'));

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

async function mount(value: SavedCopyTarget | null, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  await act(async () => {
    tree = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe, { target: value })));
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
  sessionLogOn = false;
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
    expect(reads()).toHaveLength(1);
    expect(reads()[0]).toContain('/projects/p1/sessions/s1/transcript?shape=sync');
    expect(reads()[0]).toContain('history=true');
    // The flag is read first: the project detail, once.
    expect(urls.filter((url) => url.endsWith('/projects/p1/detail'))).toHaveLength(1);
  });

  test('a sub-agent paints its own window, read by `child`, and never claims emptiness', async () => {
    serve(() => copy(CHILD, 1));
    const view = await mount(target({ rootId: CHILD, child: true }));
    expect(view.thread?.messages.map((message) => message.thread_id)).toEqual([CHILD]);
    expect(view.empty).toBe(false);
    expect(reads()).toHaveLength(1);
    expect(reads()[0]).toContain(`child=${CHILD}`);
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

describe('useSavedCopy with the session log (`session_log` on, P8)', () => {
  // With the flag on the session log is the saved copy: the connecting view paints its
  // newest page and never reads the v1 window (`GET …/transcript`).
  const golden = JSON.parse(
    readFileSync(join(import.meta.dir, '../../../packages/api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'),
  );
  const [root, child] = golden.threads as Array<{ thread_id: string; messages: Array<{ message_id: string }> }>;
  /** `GET …/log`: the root page, or the thread `?thread=` names. */
  function serveLog(url: string) {
    const { threads, ...session } = structuredClone(golden);
    const thread = new URL(url).searchParams.get('thread') ?? root!.thread_id;
    const messages = threads.find((t: { thread_id: string }) => t.thread_id === thread).messages;
    return { session, generation: 1, threads: threads.map(({ messages: _m, ...head }: { messages: unknown }) => head), thread_id: thread, messages, has_more: false };
  }

  beforeEach(() => {
    sessionLogOn = true;
  });

  test('the root paints the log page: one /log read, no /transcript', async () => {
    serve((url) => (url.includes('/log') ? serveLog(url) : copy(ROOT, 2)));
    const view = await mount(target({ sessionId: 's-log-root', rootId: root!.thread_id }));
    expect(view.thread?.messages.map((message) => message.message_id)).toEqual(root!.messages.map((message) => message.message_id));
    expect(view.empty).toBe(false);
    expect(reads()).toEqual(['http://test.local/v1/projects/p1/sessions/s-log-root/log?limit=40']);
  });

  test("a sub-agent paints its thread from the log: the root page, then the thread's page, no /transcript", async () => {
    serve((url) => (url.includes('/log') ? serveLog(url) : copy(CHILD, 1)));
    const view = await mount(target({ sessionId: 's-log-child', rootId: child!.thread_id, child: true }));
    expect(view.thread?.messages.map((message) => message.message_id)).toEqual(child!.messages.map((message) => message.message_id));
    expect(view.empty).toBe(false);
    expect(reads()).toEqual([
      'http://test.local/v1/projects/p1/sessions/s-log-child/log?limit=40',
      `http://test.local/v1/projects/p1/sessions/s-log-child/log?thread=${child!.thread_id}&limit=40`,
    ]);
  });

  test('a page that proves the root empty, with no turn on record, opens on the composer', async () => {
    serve((url) => (url.includes('/turn') ? { turns: [] } : url.includes('/log') ? { ...serveLog(url), messages: [] } : copy(ROOT, 2)));
    const view = await mount(target({ sessionId: 's-log-empty', rootId: root!.thread_id }));
    expect(view.empty).toBe(true);
    expect(view.thread).toBeUndefined();
    expect(reads().some((url) => url.includes('/transcript'))).toBe(false);
  });

  test('no stored log (404): no copy, and still no /transcript', async () => {
    serve((url) => (url.includes('/log') ? Response.json({ error: 'No session log for this session' }, { status: 404 }) : copy(ROOT, 2)));
    const view = await mount(target({ sessionId: 's-log-none', rootId: root!.thread_id }));
    expect(view).toEqual({ thread: undefined, empty: false });
    expect(reads()).toEqual(['http://test.local/v1/projects/p1/sessions/s-log-none/log?limit=40']);
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

  function Thread(props: { sessionId: string; sessionLog?: boolean }) {
    thread = useSessionSync(OPEN_ROOT, {
      kortixSessionScope: `p1/${props.sessionId}`,
      networkEnabled: false,
      sessionLog: props.sessionLog,
    });
    return null;
  }

  function Opened(props: { client: QueryClient; session: BoundSession | null; sessionId: string; sessionLog?: boolean }) {
    return (
      <QueryClientProvider client={props.client}>
        <SessionRuntimeProvider session={props.session}>
          <Thread sessionId={props.sessionId} sessionLog={props.sessionLog} />
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
      if (url.includes('/log?')) return logPage(sessionId);
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

  /** The session log's newest page: the two messages of `copy(OPEN_ROOT, 2)`, converted. */
  function logPage(sessionId: string) {
    const log = sessionLogOfV1Rows(sessionId, OPEN_ROOT, copy(OPEN_ROOT, 2).messages as never);
    const { threads, ...session } = log;
    return { session, generation: 1, threads: threads.map(({ messages: _m, ...head }) => head), thread_id: threads[0]!.thread_id, messages: threads[0]!.messages, has_more: false };
  }

  test('session_log on: the connecting view and the bound thread read the log, no /transcript, and the snapshot asks no window', async () => {
    sessionLogOn = true;
    const sessionId = '33333333-3333-4333-8333-333333333189';
    serveOpen(sessionId);
    // One app-wide query client, as in the app: the flag the connecting view read is known at the bind.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const connecting = await mount(target({ sessionId, rootId: OPEN_ROOT }), client);
    expect(connecting.thread?.messages.map((message) => message.message_id)).toEqual([`msg_${OPEN_ROOT}_1`, `msg_${OPEN_ROOT}_2`]);
    await act(async () => tree.unmount());

    await act(async () => {
      tree = create(React.createElement(Opened, { client, session: { projectId: 'p1', sessionId }, sessionId, sessionLog: true }));
    });
    await settle();

    const mine = urls.filter((url) => url.includes(`/sessions/${sessionId}/`));
    expect(mine.filter((url) => url.includes('/transcript'))).toEqual([]);
    expect(mine.filter((url) => url.includes('/log?')).length).toBeGreaterThan(0);
    const snapshots = mine.filter((url) => url.includes('/snapshot'));
    expect(snapshots.length).toBeGreaterThan(0);
    for (const url of snapshots) expect(url).toContain('transcript=0');
    // The project detail (the flag) is read once for both views.
    expect(urls.filter((url) => url.endsWith('/projects/p1/detail'))).toHaveLength(1);
    client.clear();
  });

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

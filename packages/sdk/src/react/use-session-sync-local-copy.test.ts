import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';
import { useSyncStore } from '../browser/stores/sync-store';
import type { KeyValueStorage } from '../core/cache/persisted-query-cache';
import { configureKortix } from '../core/http/config';
import type { SessionTranscriptSyncEnvelope } from '../core/rest/projects-client/sessions';
import { SAVED_COPY_REFRESH_DELAY_MS } from '../browser/session-sync/server-transcript-mirror';
import { openSessionBundle, resetSessionOpenBundles } from '../core/session/open-bundle';
import {
  type SavedCopyStore,
  createSavedCopyStore,
  setSavedCopyStore,
} from '../core/session-sync/saved-copy-store';

// A browser has a `window`; the hook picks its effect kinds at load. Loaded
// after this line, so the commit-phase test below sees what a browser runs.
const hadWindow = 'window' in globalThis;
if (!hadWindow) (globalThis as { window?: unknown }).window = globalThis;
const { useSessionSync } = await import('./use-session-sync');

/**
 * The saved copy the server sent at the LAST open is kept on the device, so
 * the next open paints it in the first frame instead of skeleton rows. The
 * copy from the network then reconciles into it by message id, for as long as
 * no runtime read has landed. These tests pin that order and its guards.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let root: ReactTestRenderer | undefined;
const touched: string[] = [];

afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  globalThis.fetch = originalFetch;
  resetSessionOpenBundles();
  setSavedCopyStore(null);
  for (const id of touched.splice(0)) useSyncStore.getState().clearSession(id);
});

const PROJECT = 'p1';
const SESSION = '2f6c0a52-7d0e-4b8e-9f51-3c5b8d7e0a11';
const SCOPE = `${PROJECT}/${SESSION}`;

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function message(rootId: string, n: number) {
  return {
    info: { id: `msg_${rootId}_${n}`, sessionID: rootId, role: 'assistant', time: { created: n, completed: n + 1 } },
    parts: [{ id: `prt_${rootId}_${n}`, type: 'text', text: `Reply ${n}` }],
  };
}

function envelope(rootId: string, count: number, capturedAt = '2026-09-25T00:00:00Z'): SessionTranscriptSyncEnvelope {
  return {
    available: true,
    reason: null,
    source: 'mirror',
    complete: true,
    captured_at: capturedAt,
    opencode_session_id: rootId,
    message_count: count,
    messages: Array.from({ length: count }, (_, i) => message(rootId, i + 1)),
  } as unknown as SessionTranscriptSyncEnvelope;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

type Options = NonNullable<Parameters<typeof useSessionSync>[1]>;

/**
 * The v1 tests model a server older than the session log: `mount` answers `GET …/log` 404
 * before the test's own fetch sees it, so the test counts only the v1 requests. The log tests
 * at the end serve the log through their own fetch (`logServed`).
 */
let logServed = false;
afterEach(() => {
  logServed = false;
});

async function mount(sessionId: string, options: Options) {
  touched.push(sessionId);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    !logServed && String(input instanceof Request ? input.url : input).includes('/log?')
      ? Response.json({ error: 'Not found' }, { status: 404 })
      : inner(input, init)) as typeof fetch;
  let value!: ReturnType<typeof useSessionSync>;
  function Probe() {
    value = useSessionSync(sessionId, options);
    return null;
  }
  await act(async () => {
    root = create(React.createElement(Probe));
  });
  return { value: () => value };
}

const offline: Options = { kortixSessionScope: SCOPE, networkEnabled: false };

function heldFetch() {
  let answer!: (response: Response) => void;
  globalThis.fetch = mock(
    async () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  ) as unknown as typeof fetch;
  return (response: Response) => answer(response);
}

async function seeded(rootId: string, count: number): Promise<SavedCopyStore & { storage: ReturnType<typeof memoryStorage> }> {
  const storage = memoryStorage();
  const store = createSavedCopyStore({ storage, userId: 'user-a' });
  await store.write(PROJECT, SESSION, envelope(rootId, count));
  setSavedCopyStore(store);
  return Object.assign(store, { storage });
}

test('the local copy paints before the server answers', async () => {
  // The web keeps saved copies in IndexedDB, so the read is asynchronous: the
  // copy paints one task after the first frame, not inside it.
  const store = await seeded('ses_local_first', 2);
  const { storage } = store;
  const sync = { ...storage };
  storage.getItem = async (key) => sync.getItem(key);
  heldFetch();

  const hook = await mount('ses_local_first', offline);
  await settle();

  expect(hook.value().messages).toHaveLength(2);
  expect(hook.value().mirrorState).toBe('painted');
});

test('the saved copy is never read during the commit, so no parse delays the first frame', async () => {
  const store = await seeded('ses_local_commit', 2);
  const { storage } = store;
  const read = storage.getItem;
  let reads = 0;
  storage.getItem = (key) => {
    reads += 1;
    return read(key);
  };
  heldFetch();
  touched.push('ses_local_commit');
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  let readsInCommit = -1;
  let value!: ReturnType<typeof useSessionSync>;
  function Probe() {
    value = useSessionSync('ses_local_commit', offline);
    return null;
  }
  // A parent's layout effect runs after every child's: it sees what the
  // child's layout effects did in this commit.
  function Parent() {
    React.useLayoutEffect(() => {
      readsInCommit = reads;
    }, []);
    return React.createElement(Probe);
  }
  await act(async () => {
    root = create(React.createElement(Parent));
  });
  await settle();

  expect(readsInCommit).toBe(0);
  expect(reads).toBeGreaterThan(0);
  expect(value.messages).toHaveLength(2);
});

test("the server's newer copy reconciles into the local one and is kept for the next open", async () => {
  const store = await seeded('ses_local_merge', 2);
  const answer = heldFetch();
  const hook = await mount('ses_local_merge', offline);
  expect(hook.value().messages).toHaveLength(2);

  await act(async () => {
    answer(Response.json(envelope('ses_local_merge', 3, '2026-09-26T00:00:00Z')));
  });
  await settle();

  expect(hook.value().messages).toHaveLength(3);
  const kept = store.read(PROJECT, SESSION) as SessionTranscriptSyncEnvelope;
  expect(kept.messages).toHaveLength(3);
});

/** Mount with a host-supplied `mirror` that the test can change between renders. */
async function mountWithHostCopy(sessionId: string) {
  touched.push(sessionId);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  let mirror: SessionTranscriptSyncEnvelope | null = null;
  let value!: ReturnType<typeof useSessionSync>;
  function Probe() {
    value = useSessionSync(sessionId, { ...offline, mirror });
    return null;
  }
  await act(async () => {
    root = create(React.createElement(Probe));
  });
  return {
    value: () => value,
    answer: async (envelope: SessionTranscriptSyncEnvelope) => {
      mirror = envelope;
      await act(async () => {
        root?.update(React.createElement(Probe));
      });
      await settle();
    },
  };
}

test("the host's saved copy reconciles into the local one when it arrives after the first paint", async () => {
  // `useSession` reads saved history itself and hands the answer in as
  // `mirror`: null while that read is in flight, then the envelope. A hard
  // reload painted the device's older copy first and then kept it on screen
  // until the computer woke, although the newer copy had arrived.
  const store = await seeded('ses_host_copy', 2);
  heldFetch();
  const hook = await mountWithHostCopy('ses_host_copy');
  expect(hook.value().messages).toHaveLength(2);

  await hook.answer(envelope('ses_host_copy', 3, '2026-09-26T00:00:00Z'));

  expect(hook.value().messages).toHaveLength(3);
  const kept = store.read(PROJECT, SESSION) as SessionTranscriptSyncEnvelope;
  expect(kept.messages).toHaveLength(3);
});

test('a host that hands in its saved copy, or null while that read runs, makes no transcript read here', async () => {
  // `useSession` reads saved history once and passes the answer in. A second
  // read beside it downloaded the same window again (KRTX-189).
  const store = await seeded('ses_host_no_read', 2);
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
  const hook = await mountWithHostCopy('ses_host_no_read');
  await settle();
  expect(hook.value().messages).toHaveLength(2);

  await hook.answer(envelope('ses_host_no_read', 3, '2026-09-26T00:00:00Z'));

  expect(hook.value().messages).toHaveLength(3);
  expect(requests).toEqual([]);
  expect((store.read(PROJECT, SESSION) as SessionTranscriptSyncEnvelope).messages).toHaveLength(3);
});

test('a host that hands in no saved copy gets the one saved-history read', async () => {
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return Response.json(envelope('ses_no_host_copy', 2));
  }) as unknown as typeof fetch;

  const hook = await mount('ses_no_host_copy', offline);
  await settle();

  expect(hook.value().messages).toHaveLength(2);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain(`/sessions/${SESSION}/transcript?shape=sync`);
  expect(requests[0]).toContain('history=true');
});

test('a host that hands in no saved copy rides the session-open snapshot in flight: no transcript request', async () => {
  // apps/mobile's thread: `useSession` (chatEngine off) starts the snapshot
  // in the commit the thread mounts in, and the thread's sync claims it.
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return Response.json({
      observed_at: '2026-09-26T00:00:01Z',
      session: { session_id: SESSION, runtime_session_id: 'ses_rides_snapshot' },
      turn: { known: false, reason: 'test' },
      queue: { known: false, reason: 'test' },
      transcript: { known: true, requested: true, ...envelope('ses_rides_snapshot', 2) },
      config: { known: true },
      models: { known: false, reason: 'test' },
    });
  }) as unknown as typeof fetch;
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  openSessionBundle(PROJECT, SESSION);

  const hook = await mount('ses_rides_snapshot', offline);
  await settle();

  expect(hook.value().messages).toHaveLength(2);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain(`/sessions/${SESSION}/snapshot`);
});

test("the host's saved copy never replaces a runtime read", async () => {
  await seeded('ses_host_after_runtime', 2);
  heldFetch();
  const hook = await mountWithHostCopy('ses_host_after_runtime');
  const live = envelope('ses_host_after_runtime', 4).messages;
  await act(async () => {
    useSyncStore.getState().hydrate('ses_host_after_runtime', live as never);
  });
  expect(hook.value().messages).toHaveLength(4);

  await hook.answer(envelope('ses_host_after_runtime', 3, '2026-09-26T00:00:00Z'));

  expect(hook.value().messages).toHaveLength(4);
});

test('a local copy captured from another root is refused', async () => {
  await seeded('ses_old_root', 2);
  heldFetch();

  const hook = await mount('ses_new_root', offline);

  expect(hook.value().messages).toHaveLength(0);
  expect(hook.value().mirrorState).toBe('loading');
});

test('a failed read keeps the local copy for the next open', async () => {
  const store = await seeded('ses_local_offline', 2);
  globalThis.fetch = mock(async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;

  const hook = await mount('ses_local_offline', offline);
  await settle();

  expect(hook.value().messages).toHaveLength(2);
  expect(store.read(PROJECT, SESSION)).not.toBeNull();
});

test('a server that no longer holds a copy removes the local one', async () => {
  const store = await seeded('ses_local_gone', 2);
  const answer = heldFetch();
  await mount('ses_local_gone', offline);

  await act(async () => {
    answer(
      Response.json({
        ...envelope('ses_local_gone', 0),
        available: false,
        source: 'none',
      }),
    );
  });
  await settle();

  expect(store.read(PROJECT, SESSION)).toBeNull();
});

test('without a configured store nothing is read or written locally', async () => {
  const answer = heldFetch();
  const hook = await mount('ses_no_store', offline);
  expect(hook.value().mirrorState).toBe('loading');

  await act(async () => {
    answer(Response.json(envelope('ses_no_store', 1)));
  });
  await settle();

  expect(hook.value().messages).toHaveLength(1);
});

test('when a turn ends, the kept copy is re-read from the server', async () => {
  const store = await seeded('ses_turn_end', 1);
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return Response.json(envelope('ses_turn_end', 4, '2026-09-26T01:00:00Z'));
  }) as unknown as typeof fetch;
  const scheduled: Array<() => void> = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    if (ms === SAVED_COPY_REFRESH_DELAY_MS) {
      scheduled.push(callback);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(callback, ms);
  }) as typeof setTimeout;
  try {
    let working = true;
    touched.push('ses_turn_end');
    configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
    function Probe() {
      useSessionSync('ses_turn_end', { ...offline, working });
      return null;
    }
    await act(async () => {
      root = create(React.createElement(Probe));
    });
    await settle();
    const before = requests.length;
    expect(scheduled).toHaveLength(0);

    working = false;
    await act(async () => {
      root?.update(React.createElement(Probe));
    });
    expect(scheduled).toHaveLength(1);

    await act(async () => {
      scheduled[0]();
      await new Promise((resolve) => realSetTimeout(resolve, 20));
    });
    expect(requests.length).toBe(before + 1);
    expect(requests.at(-1)).toContain('/transcript?shape=sync');
    expect((store.read(PROJECT, SESSION) as SessionTranscriptSyncEnvelope).messages).toHaveLength(4);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("a sub-agent reads its own saved window by `child`, and never touches the parent's kept copy", async () => {
  // A sub-agent is its own OpenCode session inside the parent's Kortix
  // session: same scope, different transcript. Read as the root, it would get
  // the parent's window; kept like the root, it would overwrite the parent's
  // copy on this device.
  const store = await seeded('ses_parent_root', 2);
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return Response.json({ ...envelope('ses_subagent_one', 3), next_cursor: 'msg_ses_subagent_one_1' });
  }) as unknown as typeof fetch;

  const hook = await mount('ses_subagent_one', { ...offline, savedChild: true });
  await settle();

  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain('child=ses_subagent_one');
  expect(hook.value().messages.map((row) => row.info.sessionID)).toEqual([
    'ses_subagent_one',
    'ses_subagent_one',
    'ses_subagent_one',
  ]);
  const kept = store.read(PROJECT, SESSION) as SessionTranscriptSyncEnvelope;
  expect(kept.opencode_session_id).toBe('ses_parent_root');
  expect(kept.messages).toHaveLength(2);

  // Older windows come from the same sub-agent.
  expect(hook.value().hasOlder).toBe(true);
  await act(async () => {
    await hook.value().loadOlder();
  });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain('child=ses_subagent_one');
  expect(requests[1]).toContain('before=msg_ses_subagent_one_1');
});

test('a runtime read that holds the saved cursor and leaves no runtime cursor ends the saved paging: hasOlder is false', async () => {
  // The saved copy is the newest window (2..4, cursor msg_…_2). The runtime then answers its
  // whole history (1..4, no cursor). Every older saved message is in the runtime too: offering
  // "earlier messages" would page a window the store already holds (mobile showed the control
  // after the whole history had loaded).
  const ROOT = 'ses_whole_history';
  const requests: string[] = [];
  const window = envelope(ROOT, 4);
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return Response.json({ ...window, messages: window.messages.slice(1), next_cursor: `msg_${ROOT}_2` });
  }) as unknown as typeof fetch;

  const hook = await mount(ROOT, offline);
  await settle();
  expect(hook.value().messages).toHaveLength(3);
  expect(hook.value().hasOlder).toBe(true);

  await act(async () => {
    useSyncStore.getState().hydrate(ROOT, window.messages as never);
  });
  expect(hook.value().messages).toHaveLength(4);
  expect(hook.value().hasOlder).toBe(false);
  await act(async () => {
    await hook.value().loadOlder();
  });
  expect(requests).toHaveLength(1);
});

test('a runtime read that lacks the saved cursor (the box lost its state) keeps the saved paging', async () => {
  const ROOT = 'ses_lost_box';
  const window = envelope(ROOT, 4);
  globalThis.fetch = mock(async () =>
    Response.json({ ...window, messages: window.messages.slice(1), next_cursor: `msg_${ROOT}_2` }),
  ) as unknown as typeof fetch;

  const hook = await mount(ROOT, offline);
  await settle();
  await act(async () => {
    useSyncStore.getState().hydrate(ROOT, [message(ROOT, 9)] as never);
  });
  expect(hook.value().hasOlder).toBe(true);
});

test('a session the session log owns (v2) reads no saved copy: no transcript request, no device v1 copy, no refresh after a turn', async () => {
  const store = await seeded('ses_log_owned', 2);
  const { storage } = store;
  const read = storage.getItem;
  let reads = 0;
  storage.getItem = (key) => {
    reads += 1;
    return read(key);
  };
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return Response.json(envelope('ses_log_owned', 3));
  }) as unknown as typeof fetch;
  touched.push('ses_log_owned');
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  let working = true;
  let value!: ReturnType<typeof useSessionSync>;
  function Probe() {
    value = useSessionSync('ses_log_owned', { ...offline, sessionLog: true, working });
    return null;
  }
  await act(async () => {
    root = create(React.createElement(Probe));
  });
  await settle();
  working = false;
  await act(async () => {
    root?.update(React.createElement(Probe));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SAVED_COPY_REFRESH_DELAY_MS + 50));
  });

  expect(requests).toEqual([]);
  expect(reads).toBe(0);
  expect(value.messages).toHaveLength(0);
  expect(value.hasOlder).toBe(false);
});

// The session log first (P8): a host that hands in no saved copy, and a sub-agent's view, read
// `GET …/log` before any v1 window. A page goes in the session store, so the host renders the
// log's thread; only a 404 (a server older than the log) or an invalid page reads the v1 copy.
const golden = JSON.parse(
  (await import('node:fs')).readFileSync(
    (await import('node:path')).join(import.meta.dir, '../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'),
    'utf8',
  ),
) as { threads: Array<{ thread_id: string; messages: unknown[] } & Record<string, unknown>> } & Record<string, unknown>;
const logPage = () => {
  const { threads, ...session } = structuredClone(golden);
  return { session, generation: 1, threads: threads.map(({ messages: _m, ...head }) => head), thread_id: threads[0]!.thread_id, messages: threads[0]!.messages, has_more: false };
};

for (const savedChild of [false, true]) {
  test(`${savedChild ? 'a sub-agent' : 'a host that hands in no saved copy'}: the log page goes in the store, and no /transcript is read`, async () => {
    logServed = true;
    const requests: string[] = [];
    globalThis.fetch = mock(async (url: unknown) => {
      requests.push(String(url));
      if (String(url).includes('/log?')) return Response.json(logPage());
      return Response.json(envelope('ses_log_first', 2));
    }) as unknown as typeof fetch;
    try {
      const hook = await mount('ses_log_first', { ...offline, savedChild });
      await settle();
      expect(requests).toEqual([`http://test.local/v1/projects/${PROJECT}/sessions/${SESSION}/log?limit=40`]);
      expect(useSyncStore.getState().sessionLogs[SESSION]?.messages[golden.threads[0]!.thread_id]).toHaveLength(golden.threads[0]!.messages.length);
      expect(hook.value().messages).toHaveLength(0);
      expect(hook.value().mirrorState).not.toBe('absent');
    } finally {
      useSyncStore.getState().dropSessionLog(SESSION);
    }
  });
}

test("a session whose log the store already holds (the route's useSession read it) reads no saved copy, whatever `sessionLog` says", async () => {
  logServed = true;
  useSyncStore.getState().applySessionLogPage(SESSION, logPage() as never);
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    return Response.json(envelope('ses_log_held', 2));
  }) as unknown as typeof fetch;
  try {
    await mount('ses_log_held', { ...offline, savedChild: true });
    await settle();
    expect(requests).toEqual([]);
  } finally {
    useSyncStore.getState().dropSessionLog(SESSION);
  }
});

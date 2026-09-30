import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// `@/api/config` pulls in the Supabase client, which cannot load under bun.
// bun's mock.module is process-wide, so the stub carries every export of
// api/config.ts: a later test file that imports any of them still resolves.
mock.module('@/api/config', () => ({
  getServerUrl: () => 'http://localhost:8008/v1',
  API_URL: 'http://localhost:8008/v1',
  getAuthToken: async () => null,
  getAuthHeaders: async () => ({ 'Content-Type': 'application/json' }),
}));

const {
  DETACHED_SESSION_LIMIT,
  EMPTY_SNAPSHOT,
  getEmptySnapshot,
  hydrateLiveStatuses,
  loadFullHistory,
  noopSubscribe,
  reconcileLiveSession,
  reconcileLiveSessions,
  registerLiveSession,
  resetLiveSessionsForTest,
} = await import('./session-sync');
const { useSyncStore } = await import('./sync-store');

function fakeController() {
  const calls: string[] = [];
  let resolve: () => void = () => {};
  return {
    calls,
    finish: () => resolve(),
    reconcile(reason?: string) {
      calls.push(reason ?? 'manual');
      return new Promise<void>((done) => {
        resolve = done;
      });
    },
  };
}

function load(sessionId: string) {
  useSyncStore.getState().hydrate(sessionId, [
    { info: { id: `${sessionId}-m`, role: 'assistant', sessionID: sessionId, time: { created: 1 } }, parts: [] },
  ]);
}

describe('empty snapshot', () => {
  test('the getter returns one stable object', () => {
    expect(getEmptySnapshot()).toBe(getEmptySnapshot());
    expect(getEmptySnapshot()).toBe(EMPTY_SNAPSHOT);
    expect(EMPTY_SNAPSHOT).toEqual({ freshness: 'idle', hasOlder: false, isLoadingOlder: false });
  });

  test('the no-op subscribe returns a callable unsubscribe', () => {
    expect(typeof noopSubscribe(() => {})).toBe('function');
  });
});

describe('live session registry', () => {
  beforeEach(() => {
    resetLiveSessionsForTest();
    useSyncStore.getState().reset();
  });

  test('reconcileLiveSessions reconciles every live controller of the sandbox once', async () => {
    const a = fakeController();
    const b = fakeController();
    const other = fakeController();
    registerLiveSession({ sessionId: 's-a', sandboxUrl: 'https://box-1', controller: a });
    registerLiveSession({ sessionId: 's-b', sandboxUrl: 'https://box-1', controller: b });
    registerLiveSession({ sessionId: 's-c', sandboxUrl: 'https://box-2', controller: other });

    const pending = reconcileLiveSessions('sse-gap', 'https://box-1');
    expect(a.calls).toEqual(['sse-gap']);
    expect(b.calls).toEqual(['sse-gap']);
    expect(other.calls).toEqual([]);
    a.finish();
    b.finish();
    await pending;
  });

  test('overlapping gaps do not stack requests', async () => {
    const a = fakeController();
    registerLiveSession({ sessionId: 's-a', sandboxUrl: 'https://box-1', controller: a });

    const first = reconcileLiveSessions('sse-gap');
    const second = reconcileLiveSessions('sse-gap');
    expect(a.calls).toEqual(['sse-gap']);
    a.finish();
    await Promise.all([first, second]);

    const third = reconcileLiveSessions('sse-gap');
    expect(a.calls).toEqual(['sse-gap', 'sse-gap']);
    a.finish();
    await third;
  });

  test('a different reason during an in-flight reconcile chains one follow-up', async () => {
    const a = fakeController();
    registerLiveSession({ sessionId: 's-a', sandboxUrl: 'https://box-1', controller: a });

    const gap = reconcileLiveSessions('sse-gap');
    const compaction = reconcileLiveSession('s-a', 'compaction');
    const again = reconcileLiveSession('s-a', 'compaction');
    expect(a.calls).toEqual(['sse-gap']);

    a.finish();
    await gap;
    // Let the follow-up start after the first read settles.
    await Promise.resolve();
    await Promise.resolve();
    expect(a.calls).toEqual(['sse-gap', 'compaction']);
    a.finish();
    await Promise.all([compaction, again]);
    expect(a.calls).toEqual(['sse-gap', 'compaction']);
  });

  test('reconcileLiveSession targets one session', async () => {
    const a = fakeController();
    const b = fakeController();
    registerLiveSession({ sessionId: 's-a', sandboxUrl: 'https://box-1', controller: a });
    registerLiveSession({ sessionId: 's-b', sandboxUrl: 'https://box-1', controller: b });

    const pending = reconcileLiveSession('s-b', 'compaction');
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual(['compaction']);
    b.finish();
    await pending;
  });

  test('an unregistered controller is no longer reconciled', async () => {
    const a = fakeController();
    const unregister = registerLiveSession({ sessionId: 's-a', sandboxUrl: 'https://box-1', controller: a });
    unregister();
    await reconcileLiveSessions('sse-gap');
    expect(a.calls).toEqual([]);
  });

  test('detaching keeps the 3 most recently detached transcripts and evicts older ones', () => {
    expect(DETACHED_SESSION_LIMIT).toBe(3);
    const ids = ['s1', 's2', 's3', 's4', 's5'];
    const unregister = new Map<string, () => void>();
    for (const id of ids) {
      load(id);
      unregister.set(id, registerLiveSession({ sessionId: id, sandboxUrl: 'https://box', controller: fakeController() }));
    }
    load('never-attached');

    unregister.get('s1')!();
    unregister.get('s2')!();
    unregister.get('s3')!();
    // Live: s4, s5. Detached (newest first): s3, s2, s1. Unattached stubs go.
    expect(Object.keys(useSyncStore.getState().messages).sort()).toEqual(['s1', 's2', 's3', 's4', 's5']);

    unregister.get('s4')!();
    // Detached: s4, s3, s2 — s1 falls off.
    expect(Object.keys(useSyncStore.getState().messages).sort()).toEqual(['s2', 's3', 's4', 's5']);
  });

  test('re-attaching a detached session moves it out of the detached list', () => {
    const attach = (id: string) => {
      load(id);
      return registerLiveSession({ sessionId: id, sandboxUrl: 'https://box', controller: fakeController() });
    };
    attach('s1')();
    attach('s2')();
    attach('s3')();
    // s1 is re-attached, then s4 detaches: the detached list is s4, s3, s2.
    registerLiveSession({ sessionId: 's1', sandboxUrl: 'https://box', controller: fakeController() });
    attach('s4')();
    expect(Object.keys(useSyncStore.getState().messages).sort()).toEqual(['s1', 's2', 's3', 's4']);
  });

  test('a session with two mounted controllers stays live until both detach', () => {
    load('s1');
    const one = registerLiveSession({ sessionId: 's1', sandboxUrl: 'https://box', controller: fakeController() });
    const two = registerLiveSession({ sessionId: 's1', sandboxUrl: 'https://box', controller: fakeController() });
    for (const id of ['s2', 's3', 's4']) {
      load(id);
      registerLiveSession({ sessionId: id, sandboxUrl: 'https://box', controller: fakeController() })();
    }
    one();
    expect('s1' in useSyncStore.getState().messages).toBe(true);
    two();
    // s1 is now the newest detached session; s2 falls off.
    expect(Object.keys(useSyncStore.getState().messages).sort()).toEqual(['s1', 's3', 's4']);
  });
});

describe('loadFullHistory', () => {
  beforeEach(() => resetLiveSessionsForTest());

  /** A controller with `pages` older pages left; `failAt` rejects that call (1-based). */
  function pagedController(pages: number, failAt?: number) {
    let left = pages;
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      reconcile: () => Promise.resolve(),
      getSnapshot: () => ({ freshness: 'fresh' as const, hasOlder: left > 0, isLoadingOlder: false }),
      loadOlder: () => {
        calls += 1;
        if (calls === failAt) return Promise.reject(new Error('offline'));
        left -= 1;
        return Promise.resolve();
      },
    };
  }

  test('loads every older page, then reports complete', async () => {
    const c = pagedController(3);
    registerLiveSession({ sessionId: 's', sandboxUrl: 'https://box', controller: c });
    expect(await loadFullHistory('s')).toEqual({ complete: true });
    expect(c.calls).toBe(3);
  });

  test('no older history: complete without a request', async () => {
    const c = pagedController(0);
    registerLiveSession({ sessionId: 's', sandboxUrl: 'https://box', controller: c });
    expect(await loadFullHistory('s')).toEqual({ complete: true });
    expect(c.calls).toBe(0);
  });

  test('stops at the page bound and reports incomplete', async () => {
    const c = pagedController(5);
    registerLiveSession({ sessionId: 's', sandboxUrl: 'https://box', controller: c });
    expect(await loadFullHistory('s', 2)).toEqual({ complete: false });
    expect(c.calls).toBe(2);
  });

  test('a failed page reports incomplete', async () => {
    const c = pagedController(3, 2);
    registerLiveSession({ sessionId: 's', sandboxUrl: 'https://box', controller: c });
    expect(await loadFullHistory('s')).toEqual({ complete: false });
  });

  test('a snapshot that throws after the last page: incomplete, never a rejection', async () => {
    let reads = 0;
    registerLiveSession({
      sessionId: 's',
      sandboxUrl: 'https://box',
      controller: {
        reconcile: () => Promise.resolve(),
        loadOlder: () => Promise.resolve(),
        // hasOlder until the page bound, then the final read throws.
        getSnapshot: () => {
          reads += 1;
          if (reads > 2) throw new Error('destroyed');
          return { freshness: 'fresh' as const, hasOlder: true, isLoadingOlder: false };
        },
      },
    });
    expect(await loadFullHistory('s', 2)).toEqual({ complete: false });
  });

  test('no mounted controller: unknown, reported incomplete', async () => {
    expect(await loadFullHistory('nobody')).toEqual({ complete: false });
  });
});

describe('hydrateLiveStatuses', () => {
  const url = 'http://box.test';
  const realFetch = globalThis.fetch;
  const statusBody = (body: unknown) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  };
  const user = { info: { id: 'm1', role: 'user', sessionID: 's1', time: { created: 1 } }, parts: [] };
  const reply = (completed?: number) => ({
    info: { id: 'm2', role: 'assistant', sessionID: 's1', time: { created: 2, ...(completed ? { completed } : {}) } },
    parts: [],
  });
  /** A controller whose tail read lands `messages` in the store. */
  const controllerLanding = (messages: unknown[]) => ({
    calls: [] as string[],
    async reconcile(this: { calls: string[] }, reason?: string) {
      this.calls.push(reason ?? 'manual');
      useSyncStore.getState().hydrate('s1', messages as never);
    },
  });

  beforeEach(() => {
    resetLiveSessionsForTest();
    useSyncStore.getState().reset();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('a busy slot the runtime no longer lists goes idle once the re-read transcript ends finished', async () => {
    const controller = controllerLanding([user, reply(3)]);
    registerLiveSession({ sessionId: 's1', sandboxUrl: url, controller });
    useSyncStore.getState().hydrate('s1', [user, reply()] as never);
    useSyncStore.getState().setStatus('s1', { type: 'busy' });
    statusBody({});

    await hydrateLiveStatuses(url, () => false);

    expect(controller.calls).toEqual(['sse-gap']);
    expect(useSyncStore.getState().sessionStatus.s1).toEqual({ type: 'idle' });
  });

  test('it stays busy while the re-read transcript is still open', async () => {
    registerLiveSession({ sessionId: 's1', sandboxUrl: url, controller: controllerLanding([user, reply()]) });
    useSyncStore.getState().setStatus('s1', { type: 'busy' });
    statusBody({});

    await hydrateLiveStatuses(url, () => false);

    expect(useSyncStore.getState().sessionStatus.s1).toEqual({ type: 'busy' });
  });

  test('it stays busy for a prompt the runtime has not answered yet', async () => {
    registerLiveSession({ sessionId: 's1', sandboxUrl: url, controller: controllerLanding([user]) });
    useSyncStore.getState().setStatus('s1', { type: 'busy' });
    statusBody({});

    await hydrateLiveStatuses(url, () => false);

    expect(useSyncStore.getState().sessionStatus.s1).toEqual({ type: 'busy' });
  });

  test('a status frame that lands during the re-read wins', async () => {
    const frame = { type: 'busy' as const };
    registerLiveSession({
      sessionId: 's1',
      sandboxUrl: url,
      controller: {
        async reconcile() {
          useSyncStore.getState().hydrate('s1', [user, reply(3)] as never);
          useSyncStore.getState().setStatus('s1', frame);
        },
      },
    });
    useSyncStore.getState().setStatus('s1', { type: 'busy' });
    statusBody({});

    await hydrateLiveStatuses(url, () => false);

    expect(useSyncStore.getState().sessionStatus.s1).toBe(frame);
  });

  test('a session that is not mounted is left alone', async () => {
    useSyncStore.getState().hydrate('s1', [user, reply(3)] as never);
    useSyncStore.getState().setStatus('s1', { type: 'busy' });
    statusBody({});

    await hydrateLiveStatuses(url, () => false);

    expect(useSyncStore.getState().sessionStatus.s1).toEqual({ type: 'busy' });
  });

  test('a stale read writes nothing', async () => {
    registerLiveSession({ sessionId: 's1', sandboxUrl: url, controller: controllerLanding([user, reply(3)]) });
    useSyncStore.getState().setStatus('s1', { type: 'busy' });
    statusBody({});

    await hydrateLiveStatuses(url, () => true);

    expect(useSyncStore.getState().sessionStatus.s1).toEqual({ type: 'busy' });
  });

  test('a listed working session still fills a slot with no status', async () => {
    registerLiveSession({ sessionId: 's1', sandboxUrl: url, controller: controllerLanding([user, reply()]) });
    statusBody({ s1: { type: 'busy' } });

    await hydrateLiveStatuses(url, () => false);

    expect(useSyncStore.getState().sessionStatus.s1).toEqual({ type: 'busy' });
  });

  test('with reread off it judges the transcript already in the store', async () => {
    const controller = controllerLanding([user, reply()]);
    registerLiveSession({ sessionId: 's1', sandboxUrl: url, controller });
    useSyncStore.getState().hydrate('s1', [user, reply(3)] as never);
    useSyncStore.getState().setStatus('s1', { type: 'busy' });
    statusBody({});

    await hydrateLiveStatuses(url, () => false, { reread: false });

    expect(controller.calls).toEqual([]);
    expect(useSyncStore.getState().sessionStatus.s1).toEqual({ type: 'idle' });
  });
});

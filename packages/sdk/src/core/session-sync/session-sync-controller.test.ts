import { describe, expect, test } from 'bun:test';
import type { Message, Part, SessionStatus } from '@opencode-ai/sdk/v2/client';
import {
  SESSION_SYNC_PAGE_SIZE,
  SESSION_SYNC_TAIL_PAGE_SIZE,
  SessionSyncController,
  createHttpSessionSyncController,
  loadCompleteSessionHistory,
  type SessionSyncControllerOptions,
  type SessionSyncPage,
  type SessionSyncReason,
  MAX_TURN_BACKFILL_PAGES,
  type SessionSyncScheduler,
} from './session-sync-controller';

type MessageWithParts = { info: Message; parts: Part[] };

function page(ids: string[], nextCursor?: string): SessionSyncPage {
  return {
    messages: ids.map((id) => ({
      info: { id, sessionID: 'session-1', role: 'user' } as Message,
      parts: [],
    })),
    nextCursor,
  };
}

function messagePage(
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    parentID?: string;
  }>,
  nextCursor?: string,
): SessionSyncPage {
  return {
    messages: messages.map(({ id, role, parentID }) => ({
      info: {
        id,
        sessionID: 'session-1',
        role,
        ...(parentID ? { parentID } : {}),
      } as Message,
      parts: [],
    })),
    nextCursor,
  };
}

function createScheduler() {
  let now = 0;
  let callback: (() => void) | undefined;
  // Timeouts too, so the retry backoff is driven by the fake clock rather than
  // falling through to the real one.
  let nextTimeoutId = 2;
  const timeouts = new Map<number, { dueAt: number; run: () => void }>();
  const scheduler: SessionSyncScheduler = {
    now: () => now,
    setInterval: (next) => {
      callback = next;
      return 1;
    },
    clearInterval: () => {
      callback = undefined;
    },
    setTimeout: (next, ms) => {
      const id = nextTimeoutId++;
      timeouts.set(id, { dueAt: now + ms, run: next });
      return id;
    },
    clearTimeout: (handle) => {
      timeouts.delete(handle as number);
    },
  };
  return {
    scheduler,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timeouts]) {
        if (timer.dueAt > now) continue;
        timeouts.delete(id);
        timer.run();
      }
      callback?.();
    },
  };
}

describe('SessionSyncController', () => {
  test('creates an authenticated framework-free HTTP controller for React Native', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const hydrated: MessageWithParts[][] = [];
    const controller = createHttpSessionSyncController({
      baseUrl: 'https://runtime.example.test',
      sessionId: 'session/1',
      getToken: async () => 'token-1',
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(input),
          authorization: headers.get('authorization'),
        });
        return new Response(JSON.stringify(page(['message-1']).messages), {
          status: 200,
          headers: { 'X-Next-Cursor': 'cursor-1' },
        });
      },
      hydrate: (messages) => hydrated.push(messages),
      markLoaded: () => {},
    });

    await controller.start();
    expect(requests).toEqual([
      {
        url: `https://runtime.example.test/session/session%2F1/message?limit=${SESSION_SYNC_TAIL_PAGE_SIZE}`,
        authorization: 'Bearer token-1',
      },
    ]);
    expect(hydrated[0]?.[0]?.info.id).toBe('message-1');
    expect(controller.getSnapshot().hasOlder).toBe(true);
  });

  test('loads complete history only through explicit older-page pagination', async () => {
    const requests: Array<{ limit: number; before?: string }> = [];
    const messages = await loadCompleteSessionHistory(async (request) => {
      requests.push(request);
      if (!request.before) return page(['message-3'], 'cursor-2');
      if (request.before === 'cursor-2') {
        return page(['message-2'], 'cursor-1');
      }
      return page(['message-1']);
    });

    // `loadCompleteSessionHistory` is a full-history helper, not a first
    // paint: nobody is watching a spinner, so it keeps the larger page.
    expect(requests).toEqual([
      { limit: SESSION_SYNC_PAGE_SIZE },
      { limit: SESSION_SYNC_PAGE_SIZE, before: 'cursor-2' },
      { limit: SESSION_SYNC_PAGE_SIZE, before: 'cursor-1' },
    ]);
    expect(messages.map((message) => message.info.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
    ]);
  });

  // `MessageV2.page()` orders by `time_created` on the server, and it always
  // did. Ids do NOT ascend with time any more (OpenCode 1.18.15 retired that
  // invariant), so re-sorting the pages by id — `localeCompare`, no less,
  // which is not even byte order — invented an order the server never sent.
  // The transcript is the pages, oldest page first, each page untouched.
  test('reassembles pages in page order, never by id — the server page IS the order', async () => {
    const messages = await loadCompleteSessionHistory(async (request) => {
      // Page 1 is the NEWEST tail; `before` walks backwards into history.
      if (!request.before) return page(['msg_aa', 'msg_ab'], 'cursor-older');
      return page(['msg_zy', 'msg_zz']);
    });

    expect(messages.map((message) => message.info.id)).toEqual([
      'msg_zy',
      'msg_zz',
      'msg_aa',
      'msg_ab',
    ]);
  });

  test('an id repeated across overlapping pages appears exactly once, at its oldest position', async () => {
    const messages = await loadCompleteSessionHistory(async (request) => {
      if (!request.before) return page(['msg_b', 'msg_a'], 'cursor-older');
      return page(['msg_c', 'msg_b']);
    });

    expect(messages.map((message) => message.info.id)).toEqual(['msg_c', 'msg_b', 'msg_a']);
  });

  test('loads only the newest page and exposes older pagination', async () => {
    const requests: Array<{ limit: number; before?: string }> = [];
    const hydrated: MessageWithParts[][] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) => {
        requests.push(request);
        return request.before
          ? page(['message-older'], undefined)
          : page(['message-newest'], 'cursor-older');
      },
      hydrate: (messages) => hydrated.push(messages),
      markLoaded: () => {},
    });

    await controller.start();
    expect(requests).toEqual([{ limit: SESSION_SYNC_TAIL_PAGE_SIZE }]);
    expect(controller.getSnapshot()).toMatchObject({
      freshness: 'fresh',
      hasOlder: true,
      isLoadingOlder: false,
    });

    await controller.loadOlder();
    expect(requests).toEqual([
      { limit: SESSION_SYNC_TAIL_PAGE_SIZE },
      { limit: SESSION_SYNC_PAGE_SIZE, before: 'cursor-older' },
    ]);
    expect(hydrated.flat().map((entry) => entry.info.id)).toEqual([
      'message-newest',
      'message-older',
    ]);
    expect(controller.getSnapshot().hasOlder).toBe(false);
  });

  test('loads the complete newest turn before exposing older pagination', async () => {
    const requests: Array<{ limit: number; before?: string }> = [];
    const hydrated: string[][] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) => {
        requests.push(request);
        if (!request.before) {
          return messagePage(
            [
              {
                id: 'assistant-new-3',
                role: 'assistant',
                parentID: 'user-only',
              },
              {
                id: 'assistant-new-4',
                role: 'assistant',
                parentID: 'user-only',
              },
            ],
            'cursor-1',
          );
        }
        if (request.before === 'cursor-1') {
          return messagePage(
            [
              {
                id: 'assistant-new-1',
                role: 'assistant',
                parentID: 'user-only',
              },
              {
                id: 'assistant-new-2',
                role: 'assistant',
                parentID: 'user-only',
              },
            ],
            'cursor-2',
          );
        }
        return messagePage(
          [
            { id: 'user-only', role: 'user' },
            { id: 'assistant-new-0', role: 'assistant', parentID: 'user-only' },
          ],
          undefined,
        );
      },
      hydrate: (messages) => hydrated.push(messages.map((message) => message.info.id)),
      markLoaded: () => {},
    });

    // The TAIL is one page — see `loadTail`. Completing the turn is what the
    // user drives by scrolling up, and that is where the walk lives now.
    await controller.start();
    expect(requests).toEqual([{ limit: SESSION_SYNC_TAIL_PAGE_SIZE }]);

    await controller.loadOlder();

    expect(requests).toEqual([
      { limit: SESSION_SYNC_TAIL_PAGE_SIZE },
      { limit: SESSION_SYNC_PAGE_SIZE, before: 'cursor-1' },
      { limit: SESSION_SYNC_PAGE_SIZE, before: 'cursor-2' },
    ]);
    // The tail paints first, then the older walk hydrates what it completed —
    // the store merges the two, so the union is the whole turn.
    expect(hydrated[0]).toEqual(['assistant-new-3', 'assistant-new-4']);
    expect(new Set(hydrated.flat())).toEqual(
      new Set([
        'user-only',
        'assistant-new-0',
        'assistant-new-1',
        'assistant-new-2',
        'assistant-new-3',
        'assistant-new-4',
      ]),
    );
    expect(controller.getSnapshot()).toMatchObject({
      freshness: 'fresh',
      hasOlder: false,
    });
  });

  test('loads through assistant-only pages until the parent user turn is complete', async () => {
    const requests: Array<{ limit: number; before?: string }> = [];
    const hydrated: string[][] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) => {
        requests.push(request);
        if (!request.before) {
          return messagePage(
            [
              { id: 'user-new', role: 'user' },
              { id: 'assistant-new', role: 'assistant', parentID: 'user-new' },
            ],
            'cursor-1',
          );
        }
        if (request.before === 'cursor-1') {
          return messagePage(
            [
              {
                id: 'assistant-old-3',
                role: 'assistant',
                parentID: 'user-old',
              },
              {
                id: 'assistant-old-4',
                role: 'assistant',
                parentID: 'user-old',
              },
            ],
            'cursor-2',
          );
        }
        if (request.before === 'cursor-2') {
          return messagePage(
            [
              {
                id: 'assistant-old-1',
                role: 'assistant',
                parentID: 'user-old',
              },
              {
                id: 'assistant-old-2',
                role: 'assistant',
                parentID: 'user-old',
              },
            ],
            'cursor-3',
          );
        }
        return messagePage(
          [
            { id: 'user-old', role: 'user' },
            { id: 'assistant-old-0', role: 'assistant', parentID: 'user-old' },
          ],
          'cursor-4',
        );
      },
      hydrate: (messages) => hydrated.push(messages.map((message) => message.info.id)),
      markLoaded: () => {},
    });

    await controller.start();
    await controller.loadOlder();

    expect(requests).toEqual([
      { limit: SESSION_SYNC_TAIL_PAGE_SIZE },
      { limit: SESSION_SYNC_PAGE_SIZE, before: 'cursor-1' },
      { limit: SESSION_SYNC_PAGE_SIZE, before: 'cursor-2' },
      { limit: SESSION_SYNC_PAGE_SIZE, before: 'cursor-3' },
    ]);
    expect(hydrated).toEqual([
      ['user-new', 'assistant-new'],
      [
        'user-old',
        'assistant-old-0',
        'assistant-old-1',
        'assistant-old-2',
        'assistant-old-3',
        'assistant-old-4',
      ],
    ]);
    expect(controller.getSnapshot().hasOlder).toBe(true);
  });

  test('rejects a repeated cursor while loading a complete older turn', async () => {
    const requests: Array<{ limit: number; before?: string }> = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) => {
        requests.push(request);
        if (!request.before) return page(['message-newest'], 'cursor-1');
        return messagePage(
          [{ id: 'assistant-old', role: 'assistant', parentID: 'user-old' }],
          'cursor-1',
        );
      },
      hydrate: () => {},
      markLoaded: () => {},
    });

    await controller.start();

    await expect(controller.loadOlder()).rejects.toThrow(
      'Session history cursor repeated: cursor-1',
    );
    expect(requests).toEqual([
      { limit: SESSION_SYNC_TAIL_PAGE_SIZE },
      { limit: SESSION_SYNC_PAGE_SIZE, before: 'cursor-1' },
    ]);
    expect(controller.getSnapshot().isLoadingOlder).toBe(false);
  });

  test('deduplicates initial and reconciliation reads', async () => {
    let resolvePage!: (value: SessionSyncPage) => void;
    let calls = 0;
    const pending = new Promise<SessionSyncPage>((resolve) => {
      resolvePage = resolve;
    });
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: () => {
        calls += 1;
        return pending;
      },
      hydrate: () => {},
      markLoaded: () => {},
    });

    const first = controller.start();
    const second = controller.reconcile('sse-gap');
    expect(calls).toBe(1);
    resolvePage(page([]));
    await Promise.all([first, second]);
  });

  test('does not reload an already synchronized tail on remount', async () => {
    let calls = 0;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => {
        calls += 1;
        return page([]);
      },
      hydrate: () => {},
      markLoaded: () => {},
    });

    await controller.start();
    await controller.start();
    expect(calls).toBe(1);
  });

  test('revalidates one bounded tail for each explicit reconciliation', async () => {
    const requests: Array<{ limit: number; before?: string }> = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) => {
        requests.push(request);
        return page([]);
      },
      hydrate: () => {},
      markLoaded: () => {},
    });

    await controller.reconcile('manual');
    await controller.reconcile('manual');

    expect(requests).toEqual([
      { limit: SESSION_SYNC_TAIL_PAGE_SIZE },
      { limit: SESSION_SYNC_TAIL_PAGE_SIZE },
    ]);
  });

  test('uses event activity instead of part count for busy liveness', async () => {
    const clock = createScheduler();
    const requests: Array<{ limit: number; before?: string }> = [];
    const statuses: SessionStatus[] = [];
    let statusReads = 0;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) => {
        requests.push(request);
        return page([]);
      },
      loadStatus: async () => {
        statusReads += 1;
        return { type: 'idle' } as SessionStatus;
      },
      hydrate: () => {},
      markLoaded: () => {},
      setStatus: (status) => statuses.push(status),
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    await controller.start();
    controller.setBusy(true);
    clock.advance(9_000);
    controller.noteActivity();
    clock.advance(10_000);
    await Promise.resolve();
    expect(requests).toHaveLength(1);

    clock.advance(10_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(2);
    // The poll reconciles the TAIL and nothing else. Its status half read the
    // runtime over REST and wrote the answer into the slot SSE frames land in,
    // which made a REST poll indistinguishable from the runtime's own voice —
    // and re-stamped the stream observation on every tick, so the bound that
    // stops a dead stream from deciding was never reached. `GET .../turn` is
    // the status authority now, and the controller's own `setBusy` is already
    // driven FROM that projection, so a fourth stamped input could only
    // confirm or latch, never correct.
    expect(statuses).toEqual([]);
    expect(statusReads).toBe(0);
  });

  test('the caller\'s working signal, and only it, starts transcript liveness reconciliation', async () => {
    const clock = createScheduler();
    const requests: Array<{ limit: number; before?: string }> = [];
    const hydrated: string[][] = [];
    const statuses: SessionStatus[] = [];
    let statusReads = 0;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) => {
        requests.push(request);
        return messagePage([
          { id: 'user-new', role: 'user' },
          { id: 'assistant-new', role: 'assistant', parentID: 'user-new' },
        ]);
      },
      loadStatus: async () => {
        statusReads += 1;
        return { type: 'idle' } as SessionStatus;
      },
      hydrate: (messages) => hydrated.push(messages.map((message) => message.info.id)),
      markLoaded: () => {},
      setStatus: (status) => statuses.push(status),
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    // Nothing polls until someone says the session is working. The controller
    // does not decide that any more — `projectWorking` does, from the server's
    // turn authority — so an unattended controller is silent.
    clock.advance(10_001);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(0);

    controller.setBusy(true);
    clock.advance(10_001);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toHaveLength(1);
    expect(hydrated).toEqual([['user-new', 'assistant-new']]);
    // The tail is repaired; no status is claimed or even read. `loadStatus` /
    // `setStatus` remain on the options type only because 0.12.8 published
    // them — see their `@deprecated` banners.
    expect(statuses).toEqual([]);
    expect(statusReads).toBe(0);
  });

  /**
   * The postponement hole (prod, 2026-08-26): `noteActivity` renews the poll's
   * quiet timer on EVERY transcript frame, so a degraded stream that still
   * delivers a trickle — events lost at the source or the edge, connection
   * alive — postponed the tail read indefinitely while the transcript diverged
   * arbitrarily far from the runtime. The repair built for a lossy stream was
   * switched off by the surviving frames of that same lossy stream.
   *
   * While the session is busy, a bounded verification read runs at
   * `verifyIntervalMs` no matter how much activity arrives. A healthy stream
   * pays one tail page per interval and the hydrate is a no-op.
   */
  test('continuous stream activity cannot postpone tail verification forever', async () => {
    const clock = createScheduler();
    const requests: Array<{ limit: number; before?: string }> = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) => {
        requests.push(request);
        return page([]);
      },
      hydrate: () => {},
      markLoaded: () => {},
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
      verifyIntervalMs: 30_000,
    });

    controller.setBusy(true);
    // A busy runtime: activity lands between every poll tick, forever.
    for (let tick = 0; tick < 5; tick++) {
      clock.advance(5_000);
      controller.noteActivity();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // 25s of constant activity: the quiet-based poll never fired.
    expect(requests).toHaveLength(0);

    clock.advance(5_000);
    controller.noteActivity();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 30s since the last tail read (there has never been one): verification
    // runs even though activity is fresh.
    expect(requests).toHaveLength(1);

    // And the NEXT verification waits a full interval again — one read per
    // `verifyIntervalMs`, not one per tick.
    clock.advance(5_000);
    controller.noteActivity();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
  });

  test('the snapshot holds transcript state only — never a busy opinion', async () => {
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => page([]),
      loadStatus: async () => ({ type: 'busy' }) as SessionStatus,
      hydrate: () => {},
      markLoaded: () => {},
    });

    await controller.start();
    controller.noteActivity();

    // The three transcript fields, and nothing else. `isPromptObservedBusy`
    // lived here and latched: it was inferred from silence, and every signal
    // that could have released it can be lost.
    expect(Object.keys(controller.getSnapshot()).sort()).toEqual([
      'freshness',
      'hasOlder',
      'isLoadingOlder',
    ]);
    expect('isPromptObservedBusy' in controller.getSnapshot()).toBe(false);
  });

  /**
   * REPLACES "marks an empty or failed initial read as loaded", which encoded
   * the bug: a failed read told the store the session was loaded, and the
   * store's implementation of that plants an empty message list. Loading is a
   * claim about the SESSION; a read that never landed supports no claim at all.
   */
  test('a start that never reaches the runtime resolves without claiming the session is empty', async () => {
    let loaded = 0;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => {
        throw new Error('offline');
      },
      hydrate: () => {},
      markLoaded: () => {
        loaded += 1;
      },
    });

    await expect(controller.start()).resolves.toBeUndefined();
    expect(loaded).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({
      freshness: 'error',
      hasOlder: false,
    });
    controller.destroy();
  });

  test('retains the older-page cursor after a transient tail failure', async () => {
    const requests: Array<{ limit: number; before?: string }> = [];
    let failTail = false;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) => {
        requests.push(request);
        if (failTail && !request.before) throw new Error('offline');
        return request.before ? page(['message-older']) : page(['message-newest'], 'cursor-older');
      },
      hydrate: () => {},
      markLoaded: () => {},
    });

    await controller.start();
    failTail = true;
    await controller.reconcile('poll');

    expect(controller.getSnapshot()).toMatchObject({
      freshness: 'error',
      hasOlder: true,
    });

    await controller.loadOlder();
    expect(requests.at(-1)).toEqual({
      limit: SESSION_SYNC_PAGE_SIZE,
      before: 'cursor-older',
    });
  });

  test('does not reset an advanced older-page cursor during tail reconciliation', async () => {
    const requests: Array<{ limit: number; before?: string }> = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) => {
        requests.push(request);
        if (!request.before) return page(['message-newest'], 'cursor-1');
        if (request.before === 'cursor-1') return page(['message-older-1'], 'cursor-2');
        return page(['message-older-2']);
      },
      hydrate: () => {},
      markLoaded: () => {},
    });

    await controller.start();
    await controller.loadOlder();
    await controller.reconcile('poll');
    await controller.loadOlder();

    expect(requests).toEqual([
      { limit: SESSION_SYNC_TAIL_PAGE_SIZE },
      { limit: SESSION_SYNC_PAGE_SIZE, before: 'cursor-1' },
      { limit: SESSION_SYNC_TAIL_PAGE_SIZE },
      { limit: SESSION_SYNC_PAGE_SIZE, before: 'cursor-2' },
    ]);
  });

  test('does not hydrate an older page after destruction', async () => {
    let resolveOlder!: (value: SessionSyncPage) => void;
    const older = new Promise<SessionSyncPage>((resolve) => {
      resolveOlder = resolve;
    });
    const hydrated: string[][] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) =>
        request.before ? older : page(['message-newest'], 'cursor-older'),
      hydrate: (messages) => hydrated.push(messages.map((message) => message.info.id)),
      markLoaded: () => {},
    });

    await controller.start();
    const pending = controller.loadOlder();
    controller.destroy();
    resolveOlder(page(['message-older']));
    await pending;

    expect(hydrated).toEqual([['message-newest']]);
  });
  /**
   * The screenshot that started this: the runtime finished an 8-minute turn
   * and its terminal showed the whole answer; the browser's transcript stopped
   * mid-turn with a spinner. The turn ENDED — and turn end was exactly the
   * moment the repair switched itself off.
   */
  test('the last thing a busy session does is read its own tail', async () => {
    const clock = createScheduler();
    const reasons: SessionSyncReason[] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => page([]),
      hydrate: () => {},
      markLoaded: () => {},
      onTelemetry: (event) => reasons.push(event.reason),
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    await controller.start();
    reasons.length = 0;
    controller.setBusy(true);
    controller.setBusy(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reasons).toEqual(['turn-end']);
  });

  test('a session that was never busy does not read a tail when it stays idle', async () => {
    const clock = createScheduler();
    const reasons: SessionSyncReason[] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => page([]),
      hydrate: () => {},
      markLoaded: () => {},
      onTelemetry: (event) => reasons.push(event.reason),
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    await controller.start();
    reasons.length = 0;
    controller.setBusy(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reasons).toEqual([]);
  });

  test('destruction does not fire a turn-end read', async () => {
    const clock = createScheduler();
    const reasons: SessionSyncReason[] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => page([]),
      hydrate: () => {},
      markLoaded: () => {},
      onTelemetry: (event) => reasons.push(event.reason),
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    await controller.start();
    controller.setBusy(true);
    reasons.length = 0;
    controller.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reasons).toEqual([]);
  });

  /**
   * The blank transcript, and it was eight lines away from the spinner that
   * never ends.
   *
   * `markLoaded` ran in a `finally`, so a tail read that FAILED still told the
   * store "this session is loaded" — and the registry's implementation of that
   * plants an empty message list. A first read that lost to a waking box, a
   * 503 from the proxy, or a flapping probe therefore RECORDED the session as
   * having no messages. The UI then painted an empty conversation, and nothing
   * came back for it: the mount already ran, and the liveness poll only turns
   * on while a session is working.
   */
  test('a failed tail read is never recorded as an empty transcript', async () => {
    const clock = createScheduler();
    let loaded = 0;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => {
        throw new Error('sandbox waking');
      },
      hydrate: () => {},
      markLoaded: () => {
        loaded += 1;
      },
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    await controller.reconcile('initial');

    expect(loaded).toBe(0);
    expect(controller.getSnapshot().freshness).toBe('error');
  });

  test('a successful read with no messages IS a loaded, empty session', async () => {
    const clock = createScheduler();
    let loaded = 0;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => page([]),
      hydrate: () => {},
      markLoaded: () => {
        loaded += 1;
      },
      scheduler: clock.scheduler,
    });

    await controller.reconcile('initial');

    expect(loaded).toBe(1);
    expect(controller.getSnapshot().freshness).toBe('fresh');
  });

  /**
   * And the second half: one shot was all a session ever got. The read that
   * loses to a waking sandbox has to come back on its own, or the page waits
   * for a health probe it does not control.
   */
  test('a failed read retries on its own until it lands', async () => {
    const clock = createScheduler();
    let attempts = 0;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('sandbox waking');
        return messagePage([{ id: 'user-1', role: 'user' }]);
      },
      hydrate: () => {},
      markLoaded: () => {},
      scheduler: clock.scheduler,
    });

    await controller.reconcile('initial');
    expect(attempts).toBe(1);

    for (let i = 0; i < 6 && attempts < 3; i++) {
      clock.advance(30_000);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(attempts).toBe(3);
    expect(controller.getSnapshot().freshness).toBe('fresh');
  });

  test('a destroyed controller stops retrying', async () => {
    const clock = createScheduler();
    let attempts = 0;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => {
        attempts += 1;
        throw new Error('gone');
      },
      hydrate: () => {},
      markLoaded: () => {},
      scheduler: clock.scheduler,
    });

    await controller.reconcile('initial');
    controller.destroy();
    clock.advance(120_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(attempts).toBe(1);
  });
  /**
   * The blank thread on a HUGE session, and every read returned 200.
   *
   * Measured on essentia (2026-08-24), a run with hundreds of image reads:
   *
   *   message?limit=50            200   8,228 kB   30.39 s
   *   message?limit=50            200  24,460 kB   48.76 s
   *   message?limit=50&before=..  200  20,284 kB   35.74 s
   *   message?limit=50&before=..  200  25,125 kB   29.23 s
   *   -> 78,097 kB transferred, finish 3.8 min, nothing on screen
   *
   * Fifty messages weigh megabytes because the parts carry image bytes, and the
   * tail read used to keep walking backwards until every assistant message had
   * its parent prompt — hydrating only when that walk ENDED.
   *
   * One page. Render it. However long the turn is.
   */
  test('the tail is exactly one request, however long the turn', async () => {
    const hydrated: string[][] = [];
    let pages = 0;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => {
        pages += 1;
        // An orphan assistant: the old walk would have chased its prompt
        // through the whole session before painting anything.
        return {
          messages: [
            {
              info: { id: `assistant-${pages}`, role: 'assistant', parentID: 'user-far-back' },
              parts: [],
            },
          ],
          nextCursor: `cursor-${pages}`,
        } as unknown as SessionSyncPage;
      },
      hydrate: (messages) => hydrated.push(messages.map((message) => message.info.id)),
      markLoaded: () => {},
    });

    await controller.reconcile('initial');

    expect(pages).toBe(1);
    expect(hydrated).toEqual([['assistant-1']]);
    // The rest stays reachable — the cursor survives for "load older".
    expect(controller.getSnapshot().hasOlder).toBe(true);
    controller.destroy();
  });

  test('the walk the user drives is still bounded', async () => {
    let pages = 0;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => {
        pages += 1;
        return {
          messages: [
            {
              info: { id: `assistant-${pages}`, role: 'assistant', parentID: 'user-far-back' },
              parts: [],
            },
          ],
          nextCursor: `cursor-${pages}`,
        } as unknown as SessionSyncPage;
      },
      hydrate: () => {},
      markLoaded: () => {},
    });

    await controller.start();
    await controller.loadOlder();

    // 1 tail page + at most MAX_TURN_BACKFILL_PAGES of turn completion.
    expect(pages).toBeLessThanOrEqual(MAX_TURN_BACKFILL_PAGES + 2);
    expect(controller.getSnapshot().hasOlder).toBe(true);
    controller.destroy();
  });

  test('a turn that completes early stops paging', async () => {
    let pages = 0;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => {
        pages += 1;
        return pages === 1
          ? ({
              messages: [
                { info: { id: 'assistant-1', role: 'assistant', parentID: 'user-1' }, parts: [] },
              ],
              nextCursor: 'cursor-1',
            } as unknown as SessionSyncPage)
          : ({
              messages: [{ info: { id: 'user-1', role: 'user' }, parts: [] }],
              nextCursor: undefined,
            } as unknown as SessionSyncPage);
      },
      hydrate: () => {},
      markLoaded: () => {},
    });

    await controller.start();
    await controller.loadOlder();

    expect(pages).toBe(2);
    controller.destroy();
  });
  /**
   * Time to FIRST PAINT is bytes, not messages.
   *
   * Measured on a heavy session (essentia, 2026-08-24 — hundreds of image reads,
   * parts carrying base64): 50 messages weighed 8,228 kB / 24,460 kB / 20,284 kB
   * / 25,125 kB across four reads. That is roughly 165-500 kB PER MESSAGE, so the
   * first screen cost 8-25 MB and 30-49 s.
   *
   * The first page only has to fill a screen. Twenty messages is a full view plus
   * buffer, and on that session it is ~3-10 MB instead of ~8-25 MB.
   *
   * Older pages keep the larger size: by then the user is scrolling deliberately,
   * a spinner is honest, and fewer round trips is the better trade (each page
   * costs a CORS preflight — one measured at 3.34 s).
   */
  test('the first page is smaller than an older page', async () => {
    const requests: Array<{ limit: number; before?: string }> = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) => {
        requests.push(request);
        return request.before ? page(['older']) : page(['newest'], 'cursor-older');
      },
      hydrate: () => {},
      markLoaded: () => {},
    });

    await controller.start();
    expect(requests).toEqual([{ limit: SESSION_SYNC_TAIL_PAGE_SIZE }]);

    await controller.loadOlder();
    expect(requests.at(-1)).toEqual({
      limit: SESSION_SYNC_PAGE_SIZE,
      before: 'cursor-older',
    });

    expect(SESSION_SYNC_TAIL_PAGE_SIZE).toBeLessThan(SESSION_SYNC_PAGE_SIZE);
    controller.destroy();
  });

  test('every reconcile reason reads the small first page, not just the initial one', async () => {
    const requests: Array<{ limit: number; before?: string }> = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) => {
        requests.push(request);
        return page(['m1']);
      },
      hydrate: () => {},
      markLoaded: () => {},
    });

    for (const reason of ['initial', 'poll', 'visible', 'turn-end', 'eviction'] as const) {
      await controller.reconcile(reason);
    }

    expect(requests.every((request) => request.limit === SESSION_SYNC_TAIL_PAGE_SIZE)).toBe(true);
    controller.destroy();
  });
});

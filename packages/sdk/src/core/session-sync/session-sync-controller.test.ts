import { describe, expect, mock, test } from 'bun:test';
import type { Message, Part, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { SandboxNotReadyError } from '../http/opencode-errors';
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
  for (const status of [404, 410]) {
    test(`does not automatically retry a missing conversation (${status}) but permits explicit recovery`, async () => {
      const clock = createScheduler();
      let attempts = 0;
      let available = false;
      const controller = createHttpSessionSyncController({
        baseUrl: 'https://runtime.example.test',
        sessionId: 'missing-session',
        fetch: async () => {
          attempts += 1;
          return available ? Response.json([]) : Response.json({ error: 'Not found' }, { status });
        },
        hydrate: () => {},
        markLoaded: () => {},
        scheduler: clock.scheduler,
      });
      try {
        controller.setBusy(true);
        await controller.reconcile('initial');
        expect(controller.getSnapshot().freshness).toBe('error');
        clock.advance(60_000);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(attempts).toBe(1);
        available = true;
        await controller.reconcile('manual');
        expect(attempts).toBe(2);
        expect(controller.getSnapshot().freshness).toBe('fresh');
      } finally {
        controller.destroy();
      }
    });
  }

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
    // S2 (Task 4): each page of the older-history walk now hydrates as it
    // lands (`onPage`), on top of the pre-existing final commit — so the tail
    // read is followed by one hydrate per walked page, then the final,
    // already-complete commit. Redundant, not incorrect: `hydrate` is
    // idempotent by message id in the real store; this mock just records
    // every call verbatim.
    expect(hydrated).toEqual([
      ['user-new', 'assistant-new'],
      ['assistant-old-1', 'assistant-old-2', 'assistant-old-3', 'assistant-old-4'],
      [
        'user-old',
        'assistant-old-0',
        'assistant-old-1',
        'assistant-old-2',
        'assistant-old-3',
        'assistant-old-4',
      ],
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

/**
 * The sandbox-not-ready path (FINDINGS-B fix #2). A read that fails because the
 * box is still waking is a RETRYABLE, "loading" state — never an error, never
 * an empty-`fresh`. The controller keeps polling with backoff until the box
 * comes up, then lands `fresh` with the real transcript.
 */
describe('SessionSyncController — sandbox-not-ready classification', () => {
  test('a not-ready read stays loading and retries, then lands fresh with messages', async () => {
    const clock = createScheduler();
    let attempts = 0;
    let loaded = 0;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => {
        attempts += 1;
        if (attempts < 3) throw new SandboxNotReadyError('sandbox not ready (status: starting)');
        return messagePage([{ id: 'user-1', role: 'user' }]);
      },
      hydrate: () => {},
      markLoaded: () => {
        loaded += 1;
      },
      scheduler: clock.scheduler,
    });
    const seen: string[] = [];
    controller.subscribe(() => seen.push(controller.getSnapshot().freshness));

    await controller.reconcile('initial');
    // Waking, not failed: loading, and the session was NOT recorded as loaded.
    expect(attempts).toBe(1);
    expect(controller.getSnapshot().freshness).toBe('loading');
    expect(loaded).toBe(0);

    for (let i = 0; i < 6 && attempts < 3; i += 1) {
      clock.advance(30_000);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(attempts).toBe(3);
    expect(controller.getSnapshot().freshness).toBe('fresh');
    expect(loaded).toBe(1);
    // It never flashed an error and never claimed a fresh-but-empty transcript
    // while the box was waking.
    expect(seen).not.toContain('error');
  });

  test('a real error is marked error, not loading', async () => {
    const clock = createScheduler();
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => {
        throw new Error('internal server error');
      },
      hydrate: () => {},
      markLoaded: () => {},
      scheduler: clock.scheduler,
    });

    await controller.reconcile('initial');
    expect(controller.getSnapshot().freshness).toBe('error');
    controller.destroy();
  });
});

/**
 * Cancellation (FINDINGS-B fix #4). `destroy()` — reached by a scope reset or
 * unmount — aborts the controller's signal, so the in-flight read cancels and
 * a late-resolving, superseded read can never hydrate a torn-down controller.
 */
describe('SessionSyncController — abort on destroy', () => {
  test('destroy aborts the in-flight read and never hydrates after it resolves', async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolvePage!: (value: SessionSyncPage) => void;
    const pending = new Promise<SessionSyncPage>((resolve) => {
      resolvePage = resolve;
    });
    const hydrated: string[][] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: (_request, signal) => {
        capturedSignal = signal;
        return pending;
      },
      hydrate: (messages) => hydrated.push(messages.map((message) => message.info.id)),
      markLoaded: () => {},
    });

    const request = controller.reconcile('initial');
    controller.destroy();
    expect(capturedSignal?.aborted).toBe(true);

    resolvePage(messagePage([{ id: 'user-1', role: 'user' }]));
    await request;

    expect(hydrated).toEqual([]);
  });
});

/**
 * The turn-completion walk is bounded (FINDINGS-B fix #5). An assistant whose
 * parent user message never appears — a compacted or removed prompt — used to
 * drive the walk through the entire session. It now stops at the page cap and
 * keeps older history reachable (`hasOlder`) instead of draining it.
 */
describe('SessionSyncController — bounded turn walk', () => {
  test('an unresolvable parent stops at the page cap and keeps older reachable', async () => {
    const requests: Array<{ limit: number; before?: string }> = [];
    let olderCursor = 0;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) => {
        requests.push(request);
        if (!request.before) return page(['tail'], 'cursor-0');
        olderCursor += 1;
        return messagePage(
          [{ id: `assistant-${olderCursor}`, role: 'assistant', parentID: 'user-never' }],
          `cursor-${olderCursor}`,
        );
      },
      hydrate: () => {},
      markLoaded: () => {},
    });

    await controller.start();
    await controller.loadOlder();

    const olderReads = requests.filter((request) => request.before).length;
    // The first older page plus at most MAX_TURN_BACKFILL_PAGES walked pages —
    // bounded, not the whole session.
    expect(olderReads).toBeLessThanOrEqual(MAX_TURN_BACKFILL_PAGES + 1);
    expect(olderReads).toBe(MAX_TURN_BACKFILL_PAGES + 1);
    // The cursor survives, so the rest of history is reachable rather than
    // drained on this one pull.
    expect(controller.getSnapshot().hasOlder).toBe(true);
  });
});

/**
 * Partial commit of a failed older-history walk (S2 / Task 4). `loadOlder`
 * walks up to MAX_TURN_BACKFILL_PAGES + 1 = 11 pages and used to commit them
 * all in one atomic `.then`, so a rejection on a later page discarded every
 * successful read AND left `nextCursor` unmoved — the only recovery was to
 * replay the identical walk. That is the "continuously tries to fetch more &
 * more, but no messages render" report.
 */
describe('SessionSyncController — partial commit of a failed history walk', () => {
  /**
   * Builds a controller wired to a paged, mockable `loadPage`, already past
   * its initial tail read (so `nextCursor` is set and `loadOlder` can walk).
   * Every older page carries an assistant message whose parent is never
   * resolved, so the turn-completion walk keeps going instead of stopping
   * after one page — mirrors the "bounded turn walk" setup above. The Nth
   * older-history read (1-indexed; the first page — `firstPage` itself —
   * counts as read 1) rejects when it matches `rejectAtPage`.
   */
  async function makeControllerWithPagedHistory(options: { rejectAtPage?: number }) {
    const { rejectAtPage } = options;
    const hydrated: MessageWithParts[] = [];
    const olderBefore: string[] = [];
    let olderReads = 0;
    const servePage = mock(async (request: { limit: number; before?: string }) => {
      if (!request.before) {
        // The initial tail page — seeds the cursor `loadOlder` walks back from.
        return page(['tail'], 'cursor-0');
      }
      olderBefore.push(request.before);
      olderReads += 1;
      if (rejectAtPage && olderReads === rejectAtPage) {
        throw new Error(`page ${olderReads} failed`);
      }
      return messagePage(
        [{ id: `assistant-${olderReads}`, role: 'assistant', parentID: 'user-never' }],
        `cursor-${olderReads}`,
      );
    });
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: servePage,
      hydrate: (messages) => hydrated.push(...messages),
      markLoaded: () => {},
    });
    await controller.start();
    return { controller, hydrated, olderBefore, servePage };
  }

  // S2: an older-history pull walks up to 11 pages. Committing them in one
  // atomic `.then` meant a rejection on page 6 discarded five successful reads
  // — including `firstPage`, read 1, whose content only ever reached the
  // store as part of that atomic commit — AND left the cursor unmoved, so the
  // only recovery was to replay the identical walk — the "continously tries
  // to fetch more & more" report.
  test('a history walk that fails midway keeps the pages it already read', async () => {
    const { controller, hydrated } = await makeControllerWithPagedHistory({
      rejectAtPage: 6,
    });

    await controller.loadOlder().catch(() => undefined);

    // The distinct hydrated ids from the older-history walk pin two things at
    // once: five pages were committed (not zero, not fewer), AND `firstPage`
    // itself (assistant-1) reached the store even though ITS read never
    // failed — only the 6th read did.
    const olderIds = new Set(
      hydrated.map((message) => message.info.id).filter((id) => id.startsWith('assistant-')),
    );
    expect([...olderIds].sort()).toEqual([
      'assistant-1',
      'assistant-2',
      'assistant-3',
      'assistant-4',
      'assistant-5',
    ]);
  });

  // Important 1 (fix round 1): a rejection on ANY page must commit what is
  // already accumulated, including the loop's very FIRST read — the one case
  // where `firstPage`'s content had never yet been carried along by a prior
  // successful `onPage` call. `rejectAtPage: 6` above does not exercise this:
  // by page 6, four earlier successful reads had already swept `firstPage`
  // into the store incidentally. This test isolates the loop's first read.
  test('a rejection on the loop\'s very first read still commits firstPage', async () => {
    const { controller, hydrated } = await makeControllerWithPagedHistory({
      rejectAtPage: 2,
    });

    await controller.loadOlder().catch(() => undefined);

    const olderIds = new Set(
      hydrated.map((message) => message.info.id).filter((id) => id.startsWith('assistant-')),
    );
    // firstPage (assistant-1) reached the store even though its own read
    // never failed — only the very next read did, before any onPage call
    // had ever fired.
    expect([...olderIds]).toEqual(['assistant-1']);
  });

  test('a retry resumes at the failed-page boundary instead of replaying committed pages', async () => {
    const { controller, olderBefore } = await makeControllerWithPagedHistory({
      rejectAtPage: 6,
    });

    await controller.loadOlder().catch(() => undefined);
    const readsAfterFailure = olderBefore.length;
    await controller.loadOlder();

    expect(olderBefore[readsAfterFailure]).toBe('cursor-5');
  });
});

/**
 * A turn-end read must reflect the finished turn.
 *
 * `reconcile` used to hand every caller the read already in flight. A turn-end
 * reconcile therefore joined a poll read issued BEFORE the runtime completed
 * the turn, hydrated that stale page, and the poll switched off behind it: the
 * transcript kept a truncated answer until a reload. A read can also park for
 * the full fetch ceiling (120 s), so every reason joined one stale read for
 * that long, and it held one of the six HTTP/1.1 connections of the origin.
 */
describe('SessionSyncController — a turn-end read reflects the finished turn', () => {
  const PARTIAL = '1. alpha\n2. be';
  const FULL = '1. alpha\n2. beta\n3. gamma\n';

  function turnPage(text: string, completed?: number): SessionSyncPage {
    return {
      messages: [
        {
          info: {
            id: 'user-1',
            sessionID: 'session-1',
            role: 'user',
            time: { created: 1 },
          } as Message,
          parts: [],
        },
        {
          info: {
            id: 'assistant-1',
            sessionID: 'session-1',
            role: 'assistant',
            parentID: 'user-1',
            time: { created: 2, ...(completed ? { completed } : {}) },
          } as Message,
          parts: [
            {
              id: 'part-1',
              sessionID: 'session-1',
              messageID: 'assistant-1',
              type: 'text',
              text,
            } as Part,
          ],
        },
      ],
    };
  }

  function tailOf(messages: MessageWithParts[]) {
    const tail = messages.at(-1);
    return {
      text: (tail?.parts[0] as { text?: string } | undefined)?.text,
      completed: (tail?.info.time as { completed?: number } | undefined)?.completed,
    };
  }

  interface PendingRead {
    signal: AbortSignal | undefined;
    snapshot: SessionSyncPage;
    resolve: (page: SessionSyncPage) => void;
    reject: (error: unknown) => void;
  }

  /** A runtime whose reads stay open until the test settles them. Each read
   *  captures the runtime's transcript at the moment it was issued. */
  function deferredRuntime(initial: SessionSyncPage) {
    let runtime = initial;
    const reads: PendingRead[] = [];
    const loadPage: SessionSyncControllerOptions['loadPage'] = (_request, signal) => {
      const snapshot = runtime;
      return new Promise<SessionSyncPage>((resolve, reject) => {
        reads.push({ signal, snapshot, resolve, reject });
      });
    };
    return {
      reads,
      loadPage,
      complete(page: SessionSyncPage) {
        runtime = page;
      },
    };
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('a turn-end read issued while a poll read is in flight reads again and hydrates the finished turn', async () => {
    const clock = createScheduler();
    const runtime = deferredRuntime(turnPage(PARTIAL));
    const hydrated: MessageWithParts[][] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: runtime.loadPage,
      hydrate: (messages) => hydrated.push(messages),
      markLoaded: () => {},
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.setBusy(true);
    clock.advance(10_001);
    expect(runtime.reads).toHaveLength(1);

    // The runtime finishes the turn while the poll read is still on the wire.
    runtime.complete(turnPage(FULL, 99));
    controller.setBusy(false);
    runtime.reads[0].resolve(runtime.reads[0].snapshot);
    await flush();
    expect(runtime.reads).toHaveLength(2);

    runtime.reads[1].resolve(runtime.reads[1].snapshot);
    await flush();
    expect(runtime.reads).toHaveLength(2);
    expect(tailOf(hydrated.at(-1)!)).toEqual({ text: FULL, completed: 99 });

    // A closed tail ends the turn-end reads.
    for (let step = 0; step < 60; step++) {
      clock.advance(1_000);
      await flush();
    }
    expect(runtime.reads).toHaveLength(2);
    controller.destroy();
  });

  test('a poll read that never resolves does not block a turn-end read', async () => {
    const clock = createScheduler();
    const runtime = deferredRuntime(turnPage(PARTIAL));
    const hydrated: MessageWithParts[][] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: runtime.loadPage,
      hydrate: (messages) => hydrated.push(messages),
      markLoaded: () => {},
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.setBusy(true);
    clock.advance(10_001);
    expect(runtime.reads).toHaveLength(1);

    runtime.complete(turnPage(FULL, 99));
    controller.setBusy(false);
    // Issued at once, not behind the parked read — and the parked read is
    // cancelled so it frees its connection.
    expect(runtime.reads).toHaveLength(2);
    expect(runtime.reads[0].signal?.aborted).toBe(true);
    expect(runtime.reads[1].signal?.aborted).toBe(false);

    runtime.reads[1].resolve(runtime.reads[1].snapshot);
    await flush();
    expect(tailOf(hydrated.at(-1)!)).toEqual({ text: FULL, completed: 99 });
    expect(controller.getSnapshot().freshness).toBe('fresh');

    // The cancelled read settles late. It never hydrates, never paints an
    // error, and never schedules a retry.
    runtime.reads[0].resolve(runtime.reads[0].snapshot);
    await flush();
    runtime.reads[0].reject(new Error('socket closed'));
    await flush();
    expect(hydrated).toHaveLength(1);
    expect(controller.getSnapshot().freshness).toBe('fresh');
    for (let step = 0; step < 60; step++) {
      clock.advance(1_000);
      await flush();
    }
    expect(runtime.reads).toHaveLength(2);
    controller.destroy();
  });

  test('a poll read older than the poll read deadline is aborted', async () => {
    const clock = createScheduler();
    const runtime = deferredRuntime(turnPage(PARTIAL));
    const hydrated: MessageWithParts[][] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: runtime.loadPage,
      hydrate: (messages) => hydrated.push(messages),
      markLoaded: () => {},
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.setBusy(true);
    clock.advance(10_001);
    expect(runtime.reads).toHaveLength(1);

    // Deadline = 3 liveness intervals = 30 s after the read was issued.
    clock.advance(29_999);
    await flush();
    expect(runtime.reads[0].signal?.aborted).toBe(false);

    clock.advance(1);
    await flush();
    expect(runtime.reads[0].signal?.aborted).toBe(true);

    // The abort released the slot even though the parked read has not settled
    // (a loader can ignore its signal): the poll reads again instead of
    // joining it.
    clock.advance(10_000);
    await flush();
    expect(runtime.reads).toHaveLength(2);
    expect(runtime.reads[1].signal?.aborted).toBe(false);

    // The aborted read is not a failure and never hydrates.
    runtime.reads[0].reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    await flush();
    expect(hydrated).toEqual([]);
    expect(controller.getSnapshot().freshness).not.toBe('error');
    controller.destroy();
  });

  test('a turn-end that joins a pending follow-up makes the shared read a repair read', async () => {
    const runtime = deferredRuntime(page(['message-1']));
    const reasons: SessionSyncReason[] = [];
    const hydrateOptions: Array<{ stampActivity?: boolean } | undefined> = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: runtime.loadPage,
      hydrate: (_messages, options) => hydrateOptions.push(options),
      markLoaded: () => {},
      onTelemetry: (event) => reasons.push(event.reason),
    });

    void controller.reconcile('initial');
    void controller.reconcile('visible');
    void controller.reconcile('turn-end');
    runtime.reads[0].resolve(runtime.reads[0].snapshot);
    await flush();
    expect(runtime.reads).toHaveLength(2);
    runtime.reads[1].resolve(runtime.reads[1].snapshot);
    await flush();

    expect(reasons).toEqual(['initial', 'turn-end']);
    expect(hydrateOptions).toEqual([undefined, { stampActivity: false }]);
    controller.destroy();
  });

  test('a caller that joined a superseded poll read waits for its successor', async () => {
    const runtime = deferredRuntime(page(['message-1']));
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: runtime.loadPage,
      hydrate: () => {},
      markLoaded: () => {},
    });

    let pollSettled = false;
    void controller.reconcile('poll').then(() => {
      pollSettled = true;
    });
    void controller.reconcile('sse-gap');
    expect(runtime.reads).toHaveLength(2);

    runtime.reads[0].resolve(runtime.reads[0].snapshot);
    await flush();
    expect(pollSettled).toBe(false);

    runtime.reads[1].resolve(runtime.reads[1].snapshot);
    await flush();
    expect(pollSettled).toBe(true);
    controller.destroy();
  });

  test('destroy settles every caller still waiting, the follow-up included', async () => {
    const runtime = deferredRuntime(page(['message-1']));
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: runtime.loadPage,
      hydrate: () => {},
      markLoaded: () => {},
    });

    const waiting = Promise.all([
      controller.reconcile('initial'),
      controller.reconcile('turn-end'),
    ]).then(() => 'settled');
    controller.destroy();
    const outcome = await Promise.race([
      waiting,
      new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);

    expect(outcome).toBe('settled');
    expect(runtime.reads).toHaveLength(1);
    expect(runtime.reads[0].signal?.aborted).toBe(true);
  });

  test('a freshness reconcile during a non-poll read issues exactly one follow-up read when it settles', async () => {
    const runtime = deferredRuntime(page(['message-1']));
    const reasons: SessionSyncReason[] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: runtime.loadPage,
      hydrate: () => {},
      markLoaded: () => {},
      onTelemetry: (event) => reasons.push(event.reason),
    });

    const initial = controller.reconcile('initial');
    const turnEnd = controller.reconcile('turn-end');
    const visible = controller.reconcile('visible');
    const gap = controller.reconcile('sse-gap');
    expect(runtime.reads).toHaveLength(1);
    // Only a poll read is superseded. Any other read runs to completion.
    expect(runtime.reads[0].signal?.aborted).toBe(false);

    runtime.reads[0].resolve(runtime.reads[0].snapshot);
    await flush();
    // One pending slot: three freshness calls share one follow-up read.
    expect(runtime.reads).toHaveLength(2);

    runtime.reads[1].resolve(runtime.reads[1].snapshot);
    await Promise.all([initial, turnEnd, visible, gap]);
    await flush();
    expect(runtime.reads).toHaveLength(2);
    // The shared follow-up is a turn-end read once a turn-end joined it.
    expect(reasons).toEqual(['initial', 'turn-end']);
    controller.destroy();
  });

  test('poll, initial and manual reconciles join the read already in flight (guard)', async () => {
    const runtime = deferredRuntime(page(['message-1']));
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: runtime.loadPage,
      hydrate: () => {},
      markLoaded: () => {},
    });

    const first = controller.reconcile('initial');
    const polled = controller.reconcile('poll');
    const manual = controller.reconcile('manual');
    const again = controller.reconcile('initial');
    expect(runtime.reads).toHaveLength(1);

    runtime.reads[0].resolve(runtime.reads[0].snapshot);
    await Promise.all([first, polled, manual, again]);
    await flush();
    expect(runtime.reads).toHaveLength(1);
    controller.destroy();
  });
});

/**
 * OpenCode persists `time.completed` after the idle frame (measured 1.765 s),
 * so the first turn-end read can still see an OPEN assistant tail. One read
 * then left the turn looking unfinished. The controller re-reads with backoff
 * until the tail closes, a bounded number of times.
 */
describe('SessionSyncController — turn-end settle', () => {
  function openOrClosedPage(completed?: number): SessionSyncPage {
    return {
      messages: [
        {
          info: { id: 'user-1', sessionID: 'session-1', role: 'user', time: { created: 1 } } as Message,
          parts: [],
        },
        {
          info: {
            id: 'assistant-1',
            sessionID: 'session-1',
            role: 'assistant',
            parentID: 'user-1',
            time: { created: 2, ...(completed ? { completed } : {}) },
          } as Message,
          parts: [],
        },
      ],
    };
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  function scriptedRuntime(clock: ReturnType<typeof createScheduler>, script: SessionSyncPage[]) {
    const issuedAt: number[] = [];
    const loadPage: SessionSyncControllerOptions['loadPage'] = async () => {
      issuedAt.push(clock.scheduler.now());
      return script[Math.min(issuedAt.length - 1, script.length - 1)];
    };
    return { issuedAt, loadPage };
  }

  async function advanceBy(clock: ReturnType<typeof createScheduler>, totalMs: number) {
    for (let elapsed = 0; elapsed < totalMs; elapsed += 1_000) {
      clock.advance(1_000);
      await flush();
    }
  }

  test('turn end with an open tail re-reads with backoff until the tail closes', async () => {
    const clock = createScheduler();
    const runtime = scriptedRuntime(clock, [
      openOrClosedPage(),
      openOrClosedPage(),
      openOrClosedPage(99),
    ]);
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: runtime.loadPage,
      hydrate: () => {},
      markLoaded: () => {},
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.setBusy(true);
    controller.setBusy(false);
    await flush();
    expect(runtime.issuedAt).toEqual([0]);

    clock.advance(999);
    await flush();
    expect(runtime.issuedAt).toEqual([0]);
    clock.advance(1);
    await flush();
    expect(runtime.issuedAt).toEqual([0, 1_000]);

    clock.advance(1_999);
    await flush();
    expect(runtime.issuedAt).toEqual([0, 1_000]);
    clock.advance(1);
    await flush();
    expect(runtime.issuedAt).toEqual([0, 1_000, 3_000]);

    await advanceBy(clock, 60_000);
    expect(runtime.issuedAt).toEqual([0, 1_000, 3_000]);
    controller.destroy();
  });

  test('a tail that never closes stops after five turn-end reads', async () => {
    const clock = createScheduler();
    const runtime = scriptedRuntime(clock, [openOrClosedPage()]);
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: runtime.loadPage,
      hydrate: () => {},
      markLoaded: () => {},
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.setBusy(true);
    controller.setBusy(false);
    await flush();
    await advanceBy(clock, 120_000);

    expect(runtime.issuedAt).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
    controller.destroy();
  });

  test('settle stops when the session turns busy between reads', async () => {
    const clock = createScheduler();
    const runtime = scriptedRuntime(clock, [openOrClosedPage()]);
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: runtime.loadPage,
      hydrate: () => {},
      markLoaded: () => {},
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.setBusy(true);
    controller.setBusy(false);
    await flush();
    await advanceBy(clock, 1_000);
    expect(runtime.issuedAt).toEqual([0, 1_000]);

    // A new turn starts before the next settle read (due at 3_000).
    await advanceBy(clock, 1_000);
    controller.setBusy(true);
    // Settle reads would land at 3_000 and 7_000. The liveness poll's first
    // quiet read is due only after 12_000.
    await advanceBy(clock, 9_000);
    expect(runtime.issuedAt).toEqual([0, 1_000]);
    controller.destroy();
  });

  test('a failed turn-end read retries inside its settle cycle and spends the same read budget', async () => {
    const clock = createScheduler();
    const issuedAt: number[] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => {
        issuedAt.push(clock.scheduler.now());
        if (issuedAt.length === 1) throw new Error('proxy reset');
        return openOrClosedPage();
      },
      hydrate: () => {},
      markLoaded: () => {},
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.setBusy(true);
    controller.setBusy(false);
    await flush();
    await advanceBy(clock, 120_000);

    // Failed read at 0, its retry at 1_000, settle reads after that.
    expect(issuedAt).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
    controller.destroy();
  });

  test('a turn-end read that fails while an earlier read waits to retry takes over that retry and keeps settling', async () => {
    const clock = createScheduler();
    const reads: Array<{ at: number; reason: SessionSyncReason; succeeded: boolean }> = [];
    const hydrateOptions: Array<{ stampActivity?: boolean } | undefined> = [];
    let failures = 2;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('proxy reset');
        }
        return openOrClosedPage();
      },
      hydrate: (_messages, options?: { stampActivity?: boolean }) => hydrateOptions.push(options),
      markLoaded: () => {},
      onTelemetry: (event) =>
        reads.push({ at: clock.scheduler.now(), reason: event.reason, succeeded: event.succeeded }),
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.setBusy(true);
    clock.advance(10_001);
    await flush();
    // The poll read failed. Its retry is due at 11_001.
    controller.setBusy(false);
    await flush();
    await advanceBy(clock, 120_000);

    // The retry re-issues the turn-end read, not the poll read, and the settle
    // cycle continues from it: 5 cycle reads, the failed one included.
    expect(reads).toEqual([
      { at: 10_001, reason: 'poll', succeeded: false },
      { at: 10_001, reason: 'turn-end', succeeded: false },
      { at: 11_001, reason: 'turn-end', succeeded: true },
      { at: 13_001, reason: 'turn-end', succeeded: true },
      { at: 17_001, reason: 'turn-end', succeeded: true },
      { at: 25_001, reason: 'turn-end', succeeded: true },
    ]);
    expect(hydrateOptions).toEqual([
      { stampActivity: false },
      { stampActivity: false },
      { stampActivity: false },
      { stampActivity: false },
    ]);
    controller.destroy();
  });

  test('the read budget caps reads that land; a failed read past it retries until one lands (guard)', async () => {
    const clock = createScheduler();
    const issuedAt: number[] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => {
        issuedAt.push(clock.scheduler.now());
        // Reads 1-4 land with an open tail, reads 5-7 fail, read 8 lands open.
        if (issuedAt.length >= 5 && issuedAt.length <= 7) throw new Error('proxy reset');
        return openOrClosedPage();
      },
      hydrate: () => {},
      markLoaded: () => {},
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.setBusy(true);
    controller.setBusy(false);
    await flush();
    await advanceBy(clock, 120_000);

    // Failures retry on the tail retry backoff (1, 2, 4 s). The first read to
    // land past the budget ends the cycle, although its tail is still open.
    expect(issuedAt).toEqual([0, 1_000, 3_000, 7_000, 15_000, 16_000, 18_000, 22_000]);
    controller.destroy();
  });

  /** Turn A's reply, then queued turn B's prompt and its still-open reply. */
  function queuedTurnPage(endedTurnCompleted?: number): SessionSyncPage {
    const turnA = openOrClosedPage(endedTurnCompleted).messages;
    return {
      messages: [
        ...turnA,
        {
          info: { id: 'user-2', sessionID: 'session-1', role: 'user', time: { created: 3 } } as Message,
          parts: [],
        },
        {
          info: {
            id: 'assistant-2',
            sessionID: 'session-1',
            role: 'assistant',
            parentID: 'user-2',
            time: { created: 4 },
          } as Message,
          parts: [],
        },
      ],
    };
  }

  function turnEndReadTimes(clock: ReturnType<typeof createScheduler>) {
    const times: number[] = [];
    return {
      times,
      onTelemetry: (event: { reason: SessionSyncReason }) => {
        if (event.reason === 'turn-end') times.push(clock.scheduler.now());
      },
    };
  }

  test('a turn-end read while the session stays busy settles the turn that ended; a repeated busy signal does not stop it', async () => {
    const clock = createScheduler();
    const runtime = scriptedRuntime(clock, [queuedTurnPage(), queuedTurnPage(99)]);
    const turnEndReads = turnEndReadTimes(clock);
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: runtime.loadPage,
      hydrate: () => {},
      markLoaded: () => {},
      onTelemetry: turnEndReads.onTelemetry,
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.setBusy(true);
    void controller.reconcile('turn-end');
    await flush();
    // A repeated busy signal is not a new turn.
    controller.setBusy(true);
    await advanceBy(clock, 60_000);
    // Read 1: turn A's reply is still open. Read 2: it closed, so the cycle
    // ends while turn B's reply stays open.
    expect(turnEndReads.times).toEqual([0, 1_000]);
    controller.destroy();
  });

  test('while busy, a turn-end read whose ended turn is closed issues no settle read, although the running turn is open', async () => {
    const clock = createScheduler();
    // An older turn left a husk: a reply nothing ever closed. It is not the
    // turn that ended and must not keep the cycle going.
    const husk: SessionSyncPage['messages'] = [
      {
        info: { id: 'user-0', sessionID: 'session-1', role: 'user', time: { created: 0 } } as Message,
        parts: [],
      },
      {
        info: {
          id: 'assistant-0',
          sessionID: 'session-1',
          role: 'assistant',
          parentID: 'user-0',
          time: { created: 0 },
        } as Message,
        parts: [],
      },
    ];
    const runtime = scriptedRuntime(clock, [
      { messages: [...husk, ...queuedTurnPage(99).messages] },
    ]);
    const turnEndReads = turnEndReadTimes(clock);
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: runtime.loadPage,
      hydrate: () => {},
      markLoaded: () => {},
      onTelemetry: turnEndReads.onTelemetry,
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.setBusy(true);
    void controller.reconcile('turn-end');
    await flush();
    await advanceBy(clock, 60_000);
    expect(turnEndReads.times).toEqual([0]);
    controller.destroy();
  });

  test('settle stops on destroy', async () => {
    const clock = createScheduler();
    const runtime = scriptedRuntime(clock, [openOrClosedPage()]);
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: runtime.loadPage,
      hydrate: () => {},
      markLoaded: () => {},
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.setBusy(true);
    controller.setBusy(false);
    await flush();
    await advanceBy(clock, 1_000);
    expect(runtime.issuedAt).toEqual([0, 1_000]);

    controller.destroy();
    await advanceBy(clock, 60_000);
    expect(runtime.issuedAt).toEqual([0, 1_000]);
  });

  /**
   * An early turn-end read sees an open tail with more text than the tab
   * holds. The sync store stamps runtime activity for exactly that, and the
   * working projection then answers 'working' for up to 45 s: Stop came back
   * on a finished turn. Repair reads must not stamp.
   */
  test('turn-end and settle reads hydrate without stamping runtime activity; other reasons keep stamping', async () => {
    const clock = createScheduler();
    const runtime = scriptedRuntime(clock, [openOrClosedPage()]);
    const calls: Array<{ options: { stampActivity?: boolean } | undefined }> = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: runtime.loadPage,
      hydrate: (_messages, options?: { stampActivity?: boolean }) => calls.push({ options }),
      markLoaded: () => {},
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    await controller.reconcile('initial');
    controller.setBusy(true);
    clock.advance(10_001);
    await flush();
    await controller.reconcile('visible');
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.options?.stampActivity !== false)).toBe(true);

    controller.setBusy(false);
    await flush();
    expect(calls).toHaveLength(4);
    expect(calls[3]).toEqual({ options: { stampActivity: false } });

    // The settle read after it is a repair read too.
    await advanceBy(clock, 1_000);
    expect(calls).toHaveLength(5);
    expect(calls[4]).toEqual({ options: { stampActivity: false } });
    controller.destroy();
  });
});

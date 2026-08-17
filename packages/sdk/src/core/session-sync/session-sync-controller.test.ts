import { describe, expect, test } from 'bun:test';
import type { Message, Part, SessionStatus } from '@opencode-ai/sdk/v2/client';
import {
  PROMPT_OBSERVATION_STALL_MS,
  PROMPT_STALL_MAX_ATTEMPTS,
  SESSION_SYNC_PAGE_SIZE,
  SessionSyncController,
  createHttpSessionSyncController,
  loadCompleteSessionHistory,
  type SessionSyncControllerOptions,
  type SessionSyncPage,
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
  const scheduler: SessionSyncScheduler = {
    now: () => now,
    setInterval: (next) => {
      callback = next;
      return 1;
    },
    clearInterval: () => {
      callback = undefined;
    },
  };
  return {
    scheduler,
    advance(ms: number) {
      now += ms;
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
        url: `https://runtime.example.test/session/session%2F1/message?limit=${SESSION_SYNC_PAGE_SIZE}`,
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
    expect(requests).toEqual([{ limit: SESSION_SYNC_PAGE_SIZE }]);
    expect(controller.getSnapshot()).toMatchObject({
      freshness: 'fresh',
      hasOlder: true,
      isLoadingOlder: false,
    });

    await controller.loadOlder();
    expect(requests).toEqual([
      { limit: SESSION_SYNC_PAGE_SIZE },
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

    await controller.start();

    expect(requests).toEqual([
      { limit: SESSION_SYNC_PAGE_SIZE },
      { limit: SESSION_SYNC_PAGE_SIZE, before: 'cursor-1' },
      { limit: SESSION_SYNC_PAGE_SIZE, before: 'cursor-2' },
    ]);
    expect(hydrated).toEqual([
      [
        'user-only',
        'assistant-new-0',
        'assistant-new-1',
        'assistant-new-2',
        'assistant-new-3',
        'assistant-new-4',
      ],
    ]);
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
      { limit: SESSION_SYNC_PAGE_SIZE },
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
      { limit: SESSION_SYNC_PAGE_SIZE },
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
      { limit: SESSION_SYNC_PAGE_SIZE },
      { limit: SESSION_SYNC_PAGE_SIZE },
    ]);
  });

  test('uses event activity instead of part count for busy liveness', async () => {
    const clock = createScheduler();
    const requests: Array<{ limit: number; before?: string }> = [];
    const statuses: SessionStatus[] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) => {
        requests.push(request);
        return page([]);
      },
      loadStatus: async () => ({ type: 'idle' }) as SessionStatus,
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
    expect(statuses).toEqual([{ type: 'idle' }]);
  });

  test('starts transcript liveness reconciliation when a REST prompt is accepted', async () => {
    const clock = createScheduler();
    const requests: Array<{ limit: number; before?: string }> = [];
    const hydrated: string[][] = [];
    const statuses: SessionStatus[] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async (request) => {
        requests.push(request);
        return messagePage([
          { id: 'user-new', role: 'user' },
          { id: 'assistant-new', role: 'assistant', parentID: 'user-new' },
        ]);
      },
      loadStatus: async () => ({ type: 'idle' }) as SessionStatus,
      hydrate: (messages) => hydrated.push(messages.map((message) => message.info.id)),
      markLoaded: () => {},
      setStatus: (status) => statuses.push(status),
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.beginPromptObservation();
    clock.advance(10_001);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toHaveLength(1);
    expect(hydrated).toEqual([['user-new', 'assistant-new']]);
    expect(statuses).toEqual([{ type: 'idle' }]);
  });

  test('keeps REST prompt completion busy until runtime idle is stable after real work starts', () => {
    let now = 0;
    let timeout:
      | {
          handler: () => void;
          dueAt: number;
        }
      | undefined;
    const scheduler = {
      now: () => now,
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: (handler: () => void, delayMs: number) => {
        timeout = { handler, dueAt: now + delayMs };
        return 2;
      },
      clearTimeout: () => {
        timeout = undefined;
      },
    };
    const advance = (ms: number) => {
      now += ms;
      if (timeout && timeout.dueAt <= now) {
        const handler = timeout.handler;
        timeout = undefined;
        handler();
      }
    };
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => page([]),
      hydrate: () => {},
      markLoaded: () => {},
      scheduler,
    });

    controller.beginPromptObservation();
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);

    controller.observePromptStatus({ type: 'idle' });
    advance(1_000);
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);

    controller.observePromptStatus({ type: 'busy' });
    controller.observePromptStatus({ type: 'idle' });
    advance(400);
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);

    controller.observePromptStatus({ type: 'busy' });
    advance(1_000);
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);

    controller.observePromptStatus({ type: 'idle' });
    advance(499);
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);
    advance(1);
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(false);
  });

  test('marks an empty or failed initial read as loaded', async () => {
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
    expect(loaded).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({
      freshness: 'error',
      hasOlder: false,
    });
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
      { limit: SESSION_SYNC_PAGE_SIZE },
      { limit: SESSION_SYNC_PAGE_SIZE, before: 'cursor-1' },
      { limit: SESSION_SYNC_PAGE_SIZE },
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
});

/**
 * A scheduler whose interval AND timeouts are both driven by `advance`, so a
 * test can move the prompt-observation state machine through real time.
 */
function createClock() {
  let now = 0;
  let interval: { handler: () => void; everyMs: number; nextAt: number } | undefined;
  const timeouts = new Map<number, { handler: () => void; dueAt: number }>();
  let nextTimeoutId = 1;
  const scheduler: SessionSyncScheduler = {
    now: () => now,
    setInterval: (handler, everyMs) => {
      interval = { handler, everyMs, nextAt: now + everyMs };
      return 1;
    },
    clearInterval: () => {
      interval = undefined;
    },
    setTimeout: (handler, delayMs) => {
      const id = nextTimeoutId++;
      timeouts.set(id, { handler, dueAt: now + delayMs });
      return id;
    },
    clearTimeout: (handle) => {
      timeouts.delete(handle as number);
    },
  };
  return {
    scheduler,
    /** Move time forward, firing every timer that comes due, in due order. */
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const dueTimeout = [...timeouts.entries()]
          .filter(([, timeout]) => timeout.dueAt <= target)
          .sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
        const dueInterval = interval && interval.nextAt <= target ? interval : undefined;
        if (!dueTimeout && !dueInterval) break;
        const timeoutAt = dueTimeout?.[1].dueAt ?? Number.POSITIVE_INFINITY;
        const intervalAt = dueInterval?.nextAt ?? Number.POSITIVE_INFINITY;
        if (timeoutAt <= intervalAt) {
          now = timeoutAt;
          timeouts.delete(dueTimeout![0]);
          dueTimeout![1].handler();
        } else {
          now = intervalAt;
          dueInterval!.nextAt = now + dueInterval!.everyMs;
          dueInterval!.handler();
        }
      }
      now = target;
    },
  };
}

describe('SessionSyncController prompt observation', () => {
  function createObservedController(
    overrides: Partial<SessionSyncControllerOptions> = {},
  ): { controller: SessionSyncController; clock: ReturnType<typeof createClock> } {
    const clock = createClock();
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => page([]),
      loadStatus: async () => ({ type: 'idle' }) as SessionStatus,
      hydrate: () => {},
      markLoaded: () => {},
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
      ...overrides,
    });
    return { controller, clock };
  }

  test('releases the busy override when the accepted prompt never starts work', async () => {
    const { controller, clock } = createObservedController();

    controller.beginPromptObservation();
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);

    // The runtime is idle and stays idle: the prompt never became a turn.
    // Every idle observation lands while the phase is still "awaiting-work",
    // which is exactly the state that used to ignore idle forever. Release
    // happens after the expiry's own authoritative status poll (idle here)
    // resolves — hence the microtask flush.
    for (let elapsed = 0; elapsed < PROMPT_OBSERVATION_STALL_MS; elapsed += 1_000) {
      controller.observePromptStatus({ type: 'idle' } as SessionStatus);
      clock.advance(1_000);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.getSnapshot().isPromptObservedBusy).toBe(false);
  });

  test('releases the busy override when the runtime goes quiet without an idle event', async () => {
    const { controller, clock } = createObservedController();

    controller.beginPromptObservation();
    controller.observePromptActivity();
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);

    // Work started, then every completion signal is lost — no session.idle,
    // no status poll, no further events. The expiry's authoritative status
    // poll (idle in this harness) settles the release; running phase routes
    // through the 500ms settlement window first.
    clock.advance(PROMPT_OBSERVATION_STALL_MS);
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.advance(600);

    expect(controller.getSnapshot().isPromptObservedBusy).toBe(false);
  });

  test('holds the busy override while the stream keeps proving the turn is alive', () => {
    const { controller, clock } = createObservedController();

    controller.beginPromptObservation();
    for (let tick = 0; tick < 6; tick++) {
      clock.advance(PROMPT_OBSERVATION_STALL_MS - 1_000);
      controller.noteActivity();
    }

    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);

    controller.observePromptStatus({ type: 'busy' } as SessionStatus);
    controller.observePromptStatus({ type: 'idle' } as SessionStatus);
    clock.advance(499);
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);
    clock.advance(1);
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(false);
  });

  test('reconciles runtime status even when the transcript read never resolves', async () => {
    const statuses: SessionStatus[] = [];
    const { controller, clock } = createObservedController({
      // The sandbox proxy can park a read forever — this promise models that.
      loadPage: () => new Promise<SessionSyncPage>(() => {}),
      setStatus: (status) => statuses.push(status),
    });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    controller.setBusy(true);
    clock.advance(10_001);
    await flush();
    clock.advance(10_001);
    await flush();
    // The tail read is parked. Status must not be parked behind it.
    expect(statuses).toEqual([]);

    clock.advance(10_001);
    await flush();

    expect(statuses).toEqual([{ type: 'idle' } as SessionStatus]);
    controller.destroy();
  });
});

describe('SessionSyncController stall expiry is authoritative, not blind', () => {
  function observedController(statusAnswer: () => Promise<SessionStatus>) {
    const clock = createClock();
    const statuses: SessionStatus[] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => page([]),
      loadStatus: statusAnswer,
      hydrate: () => {},
      markLoaded: () => {},
      setStatus: (status) => statuses.push(status),
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });
    return { controller, clock, statuses };
  }

  test('expiry with the runtime answering busy KEEPS the override — a live turn is never unmasked', async () => {
    const { controller, clock, statuses } = observedController(
      async () => ({ type: 'busy' }) as SessionStatus,
    );
    controller.beginPromptObservation();
    // No SSE frames at all — a reasoning model before its first token.
    clock.advance(PROMPT_OBSERVATION_STALL_MS + 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);
    // The authoritative busy answer must also be pushed into the store.
    expect(statuses).toContainEqual({ type: 'busy' } as SessionStatus);
    controller.destroy();
  });

  test('expiry with the runtime answering idle releases the override', async () => {
    const { controller, clock } = observedController(
      async () => ({ type: 'idle' }) as SessionStatus,
    );
    controller.beginPromptObservation();
    clock.advance(PROMPT_OBSERVATION_STALL_MS + 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.getSnapshot().isPromptObservedBusy).toBe(false);
    controller.destroy();
  });

  test('expiry with the status read failing releases after the bounded retry budget (never latches on an unreachable runtime)', async () => {
    const { controller, clock } = observedController(async () => {
      throw new Error('proxy down');
    });
    controller.beginPromptObservation();
    // One failure alone must NOT release — a transient 502 at the 10s mark
    // could unmask a live turn. Every window retries, and only exhausting
    // the budget releases.
    for (let attempt = 0; attempt < PROMPT_STALL_MAX_ATTEMPTS; attempt++) {
      expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);
      clock.advance(PROMPT_OBSERVATION_STALL_MS + 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(controller.getSnapshot().isPromptObservedBusy).toBe(false);
    controller.destroy();
  });
});

describe('SessionSyncController stall resolve is epoched, deadlined, and retried', () => {
  test('a late status answer from a PREVIOUS observation never touches the current one', async () => {
    const clock = createClock();
    let resolveStatus!: (status: SessionStatus) => void;
    const statuses: SessionStatus[] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => page([]),
      loadStatus: () => new Promise<SessionStatus>((resolve) => (resolveStatus = resolve)),
      hydrate: () => {},
      markLoaded: () => {},
      setStatus: (status) => statuses.push(status),
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    // Turn A: observation runs its stall out; the status read parks.
    controller.beginPromptObservation();
    controller.observePromptActivity();
    clock.advance(PROMPT_OBSERVATION_STALL_MS + 1);
    const resolveTurnA = resolveStatus;

    // Turn A ends normally; turn B begins a NEW observation.
    controller.endPromptObservation();
    controller.beginPromptObservation();
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);

    // Turn A's parked read finally answers idle — 700ms stale. It must be
    // discarded: not written to the store, not allowed to clear B's override.
    resolveTurnA({ type: 'idle' } as SessionStatus);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);
    expect(statuses).toEqual([]);
    controller.destroy();
  });

  test('a parked stall status read re-arms the deadline instead of latching busy forever', async () => {
    const clock = createClock();
    let statusCalls = 0;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => page([]),
      loadStatus: () => {
        statusCalls += 1;
        return new Promise<SessionStatus>(() => {}); // parks forever
      },
      hydrate: () => {},
      markLoaded: () => {},
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.beginPromptObservation();
    controller.observePromptActivity();

    // Each stall window issues one deadlined read; after the bounded retry
    // budget the override releases rather than painting busy forever.
    for (let attempt = 0; attempt < PROMPT_STALL_MAX_ATTEMPTS; attempt++) {
      clock.advance(PROMPT_OBSERVATION_STALL_MS + 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock.advance(10_000 + 1); // the read's own deadline
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    clock.advance(1_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(statusCalls).toBe(PROMPT_STALL_MAX_ATTEMPTS);
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(false);
    controller.destroy();
  });

  test('a single transient status failure retries instead of releasing over a possibly-live turn', async () => {
    const clock = createClock();
    let statusCalls = 0;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => page([]),
      loadStatus: async () => {
        statusCalls += 1;
        if (statusCalls === 1) throw new Error('transient 502');
        return { type: 'busy' } as SessionStatus;
      },
      hydrate: () => {},
      markLoaded: () => {},
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.beginPromptObservation();
    controller.observePromptActivity();
    clock.advance(PROMPT_OBSERVATION_STALL_MS + 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // First read failed — still busy, retry armed.
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);

    clock.advance(PROMPT_OBSERVATION_STALL_MS + 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Second read answered busy — override stays, turn was live all along.
    expect(statusCalls).toBe(2);
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);
    controller.destroy();
  });
});

describe('SessionSyncController stall answers stale WITHIN one observation are discarded', () => {
  test('an idle answer that was overtaken by proof-of-life mid-flight never releases the override', async () => {
    const clock = createClock();
    let resolveStatus!: (status: SessionStatus) => void;
    const statuses: SessionStatus[] = [];
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => page([]),
      loadStatus: () => new Promise<SessionStatus>((resolve) => (resolveStatus = resolve)),
      hydrate: () => {},
      markLoaded: () => {},
      setStatus: (status) => statuses.push(status),
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    // Prompt accepted; the turn has not started yet (queued behind a restart).
    controller.beginPromptObservation();
    clock.advance(PROMPT_OBSERVATION_STALL_MS + 1);
    // The stall's status read goes out — honestly idle AT ISSUE TIME.
    const answer = resolveStatus;

    // The turn starts while the read is in flight: assistant output arrives.
    controller.observePromptActivity();
    clock.advance(1_000);
    controller.noteActivity();

    // The 3s-late idle answer lands. It was overtaken — discard it entirely:
    // no store write, no release.
    answer({ type: 'idle' } as SessionStatus);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);
    expect(statuses).toEqual([]);
    controller.destroy();
  });

  test('a genuinely idle answer with a re-entrant setStatus wrapper still gets the settlement window', async () => {
    const clock = createClock();
    let resolveStatus!: (status: SessionStatus) => void;
    const controller = new SessionSyncController({
      sessionId: 'session-1',
      loadPage: async () => page([]),
      loadStatus: () => new Promise<SessionStatus>((resolve) => (resolveStatus = resolve)),
      hydrate: () => {},
      markLoaded: () => {},
      // The real registry wrapper re-enters observePromptStatus synchronously.
      setStatus: (status) => controller.observePromptStatus(status),
      scheduler: clock.scheduler,
      livenessIntervalMs: 10_000,
    });

    controller.beginPromptObservation();
    controller.observePromptActivity(); // running
    clock.advance(PROMPT_OBSERVATION_STALL_MS + 1);
    resolveStatus({ type: 'idle' } as SessionStatus);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Still inside the settlement window — released only after it elapses.
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);
    clock.advance(600);
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(false);
    controller.destroy();
  });
});

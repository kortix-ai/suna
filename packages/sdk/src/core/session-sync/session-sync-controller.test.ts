import { describe, expect, test } from 'bun:test';
import type { Message, Part, SessionStatus } from '@opencode-ai/sdk/v2/client';
import {
  SESSION_SYNC_PAGE_SIZE,
  SessionSyncController,
  createHttpSessionSyncController,
  loadCompleteSessionHistory,
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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';
import { SandboxNotReadyError } from '../../core/http/opencode-errors';
import { useSyncStore } from '../stores/sync-store';
import { setCurrentRuntime } from '../../core/session/current-runtime';
import { configureKortix } from '../../core/http/config';
import {
  loadSessionRuntimeStatus,
  ACTIVE_SESSION_PREFETCH_SOURCE,
  clearActiveSessionPrefetches,
  getSessionSyncController,
  noteSessionSyncEvent,
  prefetchSessionSyncOnce,
  readSessionMessagePage,
  resetSessionSyncControllers,
  resetSessionSyncControllersForSession,
  retainSessionSyncController,
} from './session-sync-registry';

beforeEach(() => {
  resetSessionSyncControllers();
  useSyncStore.getState().reset();
  setCurrentRuntime(null);
});

/**
 * OpenCode's OWN v1 page handling, taken over.
 *
 * `packages/app/src/context/server-session.ts:566-583` is their v1 branch — the
 * same `client.session.messages({sessionID, limit, before})` call we make, the
 * same `x-next-cursor` header — and it does three things to the response that
 * we did not:
 *
 *   const items = (response.data ?? []).filter((item) => !!item?.info?.id)
 *   session: items.map((item) => cleanMessage(item.info)).sort(compareMessages)
 *   part:    items.map((item) => ({ id: item.info.id,
 *              part: item.parts.filter((part) => !!part?.id).sort((a,b) => cmp(a.id,b.id)) }))
 *
 * with `compareMessages` ordering on `time.created + id`
 * (`packages/app/src/utils/session-message.ts:15-21`).
 *
 * We passed `result.data ?? []` straight through: no filter, no sort. A single
 * malformed row reached the renderer, which is the shape behind
 * "TypeError: t is not iterable", and message order was whatever the wire said.
 */
describe('readSessionMessagePage — daemon transcript normalization', () => {
  const RUNTIME_URL = 'https://runtime.test/p/box/8000';
  let restoreFetch: typeof globalThis.fetch;
  beforeEach(() => {
    restoreFetch = globalThis.fetch;
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'kortix_pat_test' });
  });
  afterEach(() => {
    globalThis.fetch = restoreFetch;
  });

  function entry(id: string, created: number, parts: unknown[] = []) {
    return { info: { id, sessionID: 'session-1', role: 'user', time: { created } }, parts };
  }

  // Mock the daemon `/kortix/opencode/messages` page the read now goes to, and
  // return the runtime url the test passes as the first arg. The normalization
  // rules (drop id-less rows/parts, order by time+id) are unchanged from the
  // old client path — they now run over the daemon body's `messages`.
  function clientReturning(data: unknown[]): string {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ messages: data }), { status: 200 })) as unknown as typeof fetch;
    return RUNTIME_URL;
  }

  test('drops a row with no message id instead of handing it to the renderer', async () => {
    const client = clientReturning([
      entry('m1', 1),
      { parts: [] },
      { info: {}, parts: [] },
      null,
      entry('m2', 2),
    ]);

    const result = await readSessionMessagePage(client, 'session-1', { limit: 50 });

    expect(result.messages.map((m) => m.info.id)).toEqual(['m1', 'm2']);
  });

  test('drops a part with no id', async () => {
    const client = clientReturning([
      entry('m1', 1, [{ id: 'p2' }, { id: null }, {}, { id: 'p1' }]),
    ]);

    const result = await readSessionMessagePage(client, 'session-1', { limit: 50 });

    expect(result.messages[0]!.parts.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  test('orders messages by creation time then id, not by wire order', async () => {
    const client = clientReturning([entry('m9', 200), entry('m1', 100), entry('m5', 150)]);

    const result = await readSessionMessagePage(client, 'session-1', { limit: 50 });

    expect(result.messages.map((m) => m.info.id)).toEqual(['m1', 'm5', 'm9']);
  });

  test('id breaks a tie when two messages share a creation time', async () => {
    const client = clientReturning([entry('m_b', 100), entry('m_a', 100)]);

    const result = await readSessionMessagePage(client, 'session-1', { limit: 50 });

    expect(result.messages.map((m) => m.info.id)).toEqual(['m_a', 'm_b']);
  });

  test('a message with no parts array survives as an empty one', async () => {
    const client = clientReturning([{ info: { id: 'm1', time: { created: 1 } } }]);

    const result = await readSessionMessagePage(client, 'session-1', { limit: 50 });

    expect(result.messages[0]!.parts).toEqual([]);
  });

  test('a message with no time still sorts deterministically by id', async () => {
    const client = clientReturning([
      { info: { id: 'm2' }, parts: [] },
      { info: { id: 'm1' }, parts: [] },
    ]);

    const result = await readSessionMessagePage(client, 'session-1', { limit: 50 });

    expect(result.messages.map((m) => m.info.id)).toEqual(['m1', 'm2']);
  });
});

describe('readSessionMessagePage', () => {
  let restoreFetch: typeof globalThis.fetch;
  beforeEach(() => {
    restoreFetch = globalThis.fetch;
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'kortix_pat_test' });
  });
  afterEach(() => {
    globalThis.fetch = restoreFetch;
  });

  test('reads the daemon transcript page and its older-page cursor', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          messages: [
            { info: { id: 'message-1', sessionID: 'session-1', role: 'user' }, parts: [] },
          ],
          has_more: true,
          first_message_id: 'message-older',
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await readSessionMessagePage('https://runtime.test/p/box/8000', 'session-1', {
      limit: 10,
      before: 'message-newer',
    });

    // The daemon transcript endpoint, NOT the raw `/session/:id/message` proxy.
    expect(urls[0]).toBe(
      'https://runtime.test/p/box/8000/kortix/opencode/messages/session-1?limit=10&before=message-newer',
    );
    expect(result.messages[0]?.info.id).toBe('message-1');
    expect(result.nextCursor).toBe('message-older');
  });
});

describe('prefetchSessionSyncOnce', () => {
  test('keeps controllers distinct when two sandboxes contain the same OpenCode id', () => {
    const sharedId = 'session-from-snapshot';
    const runtimeA = getSessionSyncController(sharedId, undefined, 'runtime-a');
    const runtimeB = getSessionSyncController(sharedId, undefined, 'runtime-b');

    expect(runtimeA).not.toBe(runtimeB);
    expect(getSessionSyncController(sharedId, undefined, 'runtime-a')).toBe(runtimeA);
    expect(getSessionSyncController(sharedId, undefined, 'runtime-b')).toBe(runtimeB);
  });

  test('retires old-sandbox controllers without deleting the current sandbox controller', () => {
    const sharedId = 'session-from-snapshot';
    const runtimeA = getSessionSyncController(sharedId, undefined, 'runtime-a');
    const runtimeB = getSessionSyncController(sharedId, undefined, 'runtime-b');

    resetSessionSyncControllersForSession(sharedId, 'runtime-b');

    expect(getSessionSyncController(sharedId, undefined, 'runtime-a')).not.toBe(runtimeA);
    expect(getSessionSyncController(sharedId, undefined, 'runtime-b')).toBe(runtimeB);
  });

  test('deduplicates one runtime source and revalidates after the runtime changes', async () => {
    const restoreFetch = globalThis.fetch;
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'kortix_pat_test' });
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      // The transcript read now goes to the SESSION runtime url (bound when the
      // current sandbox matches the controller scope), not a passed client.
      setCurrentRuntime('https://runtime-a.test/p/box/8000', 'runtime-a');
      await prefetchSessionSyncOnce('session-1', 'runtime-a', undefined);
      await prefetchSessionSyncOnce('session-1', 'runtime-a', undefined);
      setCurrentRuntime('https://runtime-b.test/p/box/8000', 'runtime-b');
      await prefetchSessionSyncOnce('session-1', 'runtime-b', undefined);
      // One read per distinct runtime source: the second runtime-a call dedups.
      expect(urls.length).toBe(2);
      expect(urls[0]).toContain('runtime-a.test');
      expect(urls[1]).toContain('runtime-b.test');
    } finally {
      globalThis.fetch = restoreFetch;
    }
  });

  test('clears active-runtime markers without clearing explicit runtime markers', async () => {
    const restoreFetch = globalThis.fetch;
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'kortix_pat_test' });
    let activeRequests = 0;
    let backgroundRequests = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('active.test')) activeRequests += 1;
      if (String(input).includes('background.test')) backgroundRequests += 1;
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      // The active-runtime source binds to whatever the current runtime is.
      setCurrentRuntime('https://active.test/p/box/8000', 'active-box');
      await prefetchSessionSyncOnce('active-session', ACTIVE_SESSION_PREFETCH_SOURCE, undefined);
      setCurrentRuntime('https://background.test/p/box/8000', 'runtime-a');
      await prefetchSessionSyncOnce('background-session', 'runtime-a', undefined);
      clearActiveSessionPrefetches();
      // The active marker was cleared -> it revalidates; the explicit one holds.
      setCurrentRuntime('https://active.test/p/box/8000', 'active-box');
      await prefetchSessionSyncOnce('active-session', ACTIVE_SESSION_PREFETCH_SOURCE, undefined);
      setCurrentRuntime('https://background.test/p/box/8000', 'runtime-a');
      await prefetchSessionSyncOnce('background-session', 'runtime-a', undefined);

      expect(activeRequests).toBe(2);
      expect(backgroundRequests).toBe(1);
    } finally {
      globalThis.fetch = restoreFetch;
    }
  });
});

describe('session sync controller eviction', () => {
  test('keeps every retained controller and evicts released overflow', () => {
    const retained: Array<{
      controller: ReturnType<typeof getSessionSyncController>;
      release: () => void;
    }> = [];

    for (let index = 0; index < 21; index += 1) {
      const sessionId = `session-${index}`;
      const controller = getSessionSyncController(sessionId);
      retained.push({
        controller,
        release: retainSessionSyncController(sessionId),
      });
      expect(getSessionSyncController(sessionId)).toBe(controller);
    }

    retained[0]?.release();
    expect(getSessionSyncController('session-0')).not.toBe(retained[0]?.controller);
    for (const entry of retained.slice(1)) entry.release();
  });
});

/**
 * What is left of the event hook: a frame is proof this session's transcript
 * moved. It used to also drive a prompt-observation phase machine that decided
 * "working" from WHICH frame arrived when — an inference that latched, and is
 * now the server's answer via `projectWorking`.
 */
describe('session sync events', () => {
  test('renews the sole scoped controller while the current runtime is temporarily unbound', () => {
    const sessionId = 'session-rest-prompt';
    const controller = getSessionSyncController(sessionId, undefined, 'runtime-a');
    expect(controller.getSnapshot().freshness).toBe('idle');

    noteSessionSyncEvent({
      type: 'message.updated',
      properties: { info: { id: 'assistant-1', sessionID: sessionId, role: 'assistant' } },
    });

    expect(controller.getSnapshot().freshness).toBe('fresh');
  });

  /**
   * The starvation bug. `checkLiveness` skips whenever the last activity is
   * newer than the poll interval, so ANY frame carrying this session's id used
   * to postpone the repair — including frames that carry no transcript at all.
   * A stream that keeps emitting status while dropping message parts could
   * therefore keep the browser's transcript arbitrarily stale, forever, and
   * the poll built to catch exactly that never ran.
   *
   * Only a frame that MOVES the transcript is evidence the transcript moved.
   */
  test('a status frame is not evidence that the transcript moved', () => {
    const sessionId = 'session-status-only';
    const controller = getSessionSyncController(sessionId, undefined, 'runtime-a');

    for (const type of ['session.status', 'session.idle', 'permission.updated']) {
      noteSessionSyncEvent({ type, properties: { sessionID: sessionId } });
      expect(controller.getSnapshot().freshness).toBe('idle');
    }
  });

  test('every frame that carries transcript content renews freshness', () => {
    const sessionId = 'session-content';
    for (const event of [
      { type: 'message.updated', properties: { info: { id: 'm1', sessionID: sessionId } } },
      { type: 'message.part.updated', properties: { part: { sessionID: sessionId } } },
      { type: 'message.removed', properties: { sessionID: sessionId, messageID: 'm1' } },
    ]) {
      resetSessionSyncControllers();
      const controller = getSessionSyncController(sessionId, undefined, 'runtime-a');
      noteSessionSyncEvent(event);
      expect(controller.getSnapshot().freshness).toBe('fresh');
    }
  });

  test('a frame for another session never touches this one', () => {
    const controller = getSessionSyncController('session-a', undefined, 'runtime-a');

    noteSessionSyncEvent({
      type: 'session.idle',
      properties: { sessionID: 'session-b' },
    });

    expect(controller.getSnapshot().freshness).toBe('idle');
  });

  test('ignores global events that do not contain session properties', () => {
    expect(() =>
      noteSessionSyncEvent({
        type: 'server.connected',
        properties: undefined,
      }),
    ).not.toThrow();
  });

  test('ignores an event with no properties instead of throwing', () => {
    expect(() =>
      noteSessionSyncEvent({ type: 'sync' } as unknown as { type?: string; properties: unknown }),
    ).not.toThrow();
  });
});

describe('loadSessionRuntimeStatus', () => {
  test('returns the authoritative runtime status for one session', async () => {
    const client = {
      session: {
        messages: async () => ({ data: [] }),
        status: async () => ({ data: { 'ses-1': { type: 'busy' } } }),
      },
    } as never;
    expect(await loadSessionRuntimeStatus('ses-1', client)).toEqual({ type: 'busy' });
  });

  test('a session absent from the snapshot is authoritatively idle', async () => {
    const client = {
      session: {
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      },
    } as never;
    expect(await loadSessionRuntimeStatus('ses-1', client)).toEqual({ type: 'idle' });
  });

  test('a runtime without a status endpoint returns null (caller decides)', async () => {
    const client = { session: { messages: async () => ({ data: [] }) } } as never;
    expect(await loadSessionRuntimeStatus('ses-1', client)).toBeNull();
  });
});

describe('loadSessionRuntimeStatus binds the client method', () => {
  test('a client whose status() reads `this` (like the real SDK) works', async () => {
    // The real @opencode-ai/sdk SessionClient.status() dereferences
    // `this.client`. Detaching the method (`const f = s.status; await f()`)
    // makes `this` undefined and throws before any request goes out — which
    // silently disabled every status reconciliation against a real client
    // while all the plain-object test fakes kept passing.
    class RealisticSession {
      private answer = { data: { 'ses-1': { type: 'busy' } } };
      async messages() {
        return { data: [] };
      }
      async status() {
        // Throws exactly like the SDK if called detached.
        return (this as RealisticSession).answer;
      }
    }
    const client = { session: new RealisticSession() } as never;
    expect(await loadSessionRuntimeStatus('ses-1', client)).toEqual({ type: 'busy' });
  });
});

describe('loadSessionRuntimeStatus refuses to launder failures into idle', () => {
  test('an SDK-style resolved error response throws instead of reporting idle', async () => {
    // The generated client RESOLVES with { error } on HTTP failure. Mapping
    // that to "idle" told every caller a failing runtime was authoritatively
    // done — which defeats retry budgets built on thrown errors.
    const client = {
      session: {
        messages: async () => ({ data: [] }),
        status: async () => ({ error: { message: 'ECONNREFUSED' } }),
      },
    } as never;
    await expect(loadSessionRuntimeStatus('ses-1', client)).rejects.toThrow();
  });
});

/**
 * The 503-swallowed-to-empty-page bug (FINDINGS-B root cause #1).
 *
 * The generated OpenCode client RESOLVES with `{ data: undefined, error,
 * response.status }` on a non-2xx response — it does not throw. Reading
 * `result.data ?? []` therefore turned a cold-boot 503 into a success-looking
 * empty page: the transcript rendered blank and "complete", with no retry and
 * no error. `readSessionMessagePage` must CLASSIFY the result instead.
 */
describe('readSessionMessagePage — error classification', () => {
  const RUNTIME_URL = 'https://runtime.test/p/box/8000';
  let restoreFetch: typeof globalThis.fetch;
  beforeEach(() => {
    restoreFetch = globalThis.fetch;
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'kortix_pat_test' });
  });
  afterEach(() => {
    globalThis.fetch = restoreFetch;
  });

  function daemonRespond(body: BodyInit | null, status: number): void {
    globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
  }

  test('a 503 throws a retryable SandboxNotReadyError, never an empty page', async () => {
    daemonRespond('sandbox not ready (status: starting)', 503);
    const promise = readSessionMessagePage(RUNTIME_URL, 'session-1', { limit: 50 });
    await expect(promise).rejects.toBeInstanceOf(SandboxNotReadyError);
    await expect(promise).rejects.toThrow(/sandbox not ready/i);
  });

  test('a not-ready body classifies as SandboxNotReadyError even without a 503 status', async () => {
    daemonRespond('opencode session is not ready', 500);
    await expect(
      readSessionMessagePage(RUNTIME_URL, 'session-1', { limit: 50 }),
    ).rejects.toBeInstanceOf(SandboxNotReadyError);
  });

  test('a 500 throws a real error, not a not-ready error', async () => {
    daemonRespond('internal error', 500);
    const promise = readSessionMessagePage(RUNTIME_URL, 'session-1', { limit: 50 });
    await expect(promise).rejects.toThrow('internal error');
    await expect(promise).rejects.not.toBeInstanceOf(SandboxNotReadyError);
  });

  test('a 2xx payload is still normalized and returned', async () => {
    daemonRespond(
      JSON.stringify({ messages: [{ info: { id: 'm1', time: { created: 1 } }, parts: [] }] }),
      200,
    );
    const result = await readSessionMessagePage(RUNTIME_URL, 'session-1', { limit: 50 });
    expect(result.messages.map((m) => m.info.id)).toEqual(['m1']);
  });

  test('threads the AbortSignal into the transcript fetch', async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }) as typeof fetch;
    const controller = new AbortController();
    await readSessionMessagePage(RUNTIME_URL, 'session-1', { limit: 50 }, controller.signal);
    // authenticatedFetch COMPOSES the caller's signal with its own timeout, so
    // the fetch sees a derived signal, not the identical object — assert that
    // aborting the caller's controller propagates to it.
    expect(seen).toBeDefined();
    controller.abort();
    expect(seen?.aborted).toBe(true);
  });
});

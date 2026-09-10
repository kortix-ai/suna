import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { configureKortix } from '../../core/http/config';
import type { Message } from '@opencode-ai/sdk/v2/client';
import { SandboxNotReadyError } from '../../core/http/opencode-errors';
import * as errors from '../../core/http/opencode-errors';
import * as registry from './session-sync-registry';
import { useSyncStore } from '../stores/sync-store';
import { setCurrentRuntime } from '../../core/session/current-runtime';
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
  setCurrentRuntime('https://runtime-a.test', 'runtime-a');
});

afterEach(() => resetSessionSyncControllers());

test('refuses controller creation without a runtime URL or explicit client', () => {
  setCurrentRuntime(null);
  expect(() => getSessionSyncController('unowned')).toThrow('not ready');
});

test('retaining a prefetched entry preserves its explicit client', async () => {
  const reads: string[] = [];
  const client = { session: { messages: async () => { reads.push('a'); return { data: [] }; } } };
  await prefetchSessionSyncOnce('ses-prefetched', 'runtime-a', client);
  const release = retainSessionSyncController('ses-prefetched', 'runtime-a');
  await getSessionSyncController('ses-prefetched', undefined, 'runtime-a').reconcile();
  release();
  expect(reads).toEqual(['a', 'a']);
});

test('runtime switch destroys detached controllers and preserves retained controllers', async () => {
  const signals: AbortSignal[] = [];
  const client = { session: { messages: async (_: unknown, opts?: { signal?: AbortSignal }) => {
    signals.push(opts!.signal!);
    return { data: [] };
  } } };
  const old = getSessionSyncController('old', client, 'runtime-a');
  const held = getSessionSyncController('held', client, 'runtime-a');
  const release = retainSessionSyncController('held', 'runtime-a');
  await old.reconcile();
  await held.reconcile();
  registry.resetSessionSyncControllersForRuntime('runtime-b');
  expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
  await old.reconcile();
  expect(signals).toHaveLength(2);
  release();
});

test('noteSessionSyncEvent updates only the explicit stream scope', () => {
  const client = { session: { messages: async () => ({ data: [] }) } };
  const a = getSessionSyncController('shared', client, 'runtime-a');
  const b = getSessionSyncController('shared', client, 'runtime-b');
  noteSessionSyncEvent({ type: 'message.updated', properties: { info: { sessionID: 'shared' } } }, 'runtime-a');
  expect(a.getSnapshot().freshness).toBe('fresh');
  expect(b.getSnapshot().freshness).toBe('idle');
});

test('only an OpenCode JSON NotFoundError 404 is tuple-terminal', async () => {
  const client = (error: unknown, status = 404) => ({ session: { messages: async () => ({
    error, response: new Response(null, { status }),
  }) } });
  await expect(readSessionMessagePage(client({ name: 'NotFoundError', data: { message: 'Session not found' } }), 'missing', { limit: 50 }))
    .rejects.toBeInstanceOf(errors.SessionNotFoundOnRuntimeError);
  for (const body of ['<html>Not found</html>', 'Sandbox is not running']) {
    await expect(readSessionMessagePage(client(body), 'missing', { limit: 50 }))
      .rejects.toBeInstanceOf(SandboxNotReadyError);
  }
});

test('a re-provisioned session gets a new tuple while the old controller cannot write', async () => {
  let resolveOld!: (value: { data: Array<{ info: Message; parts: [] }> }) => void;
  const old = getSessionSyncController('reprovisioned', {
    session: { messages: async () => new Promise((resolve) => { resolveOld = resolve; }) },
  }, 'runtime-a');
  const oldRead = old.reconcile();
  const next = getSessionSyncController('reprovisioned', {
    session: { messages: async () => ({ data: [] }) },
  }, 'runtime-b', 'https://runtime-b.test');
  resetSessionSyncControllersForSession('reprovisioned', 'runtime-b');
  await next.reconcile();
  resolveOld({ data: [{ info: { id: 'stale', sessionID: 'reprovisioned', role: 'user' } as Message, parts: [] }] });
  await oldRead;
  expect(useSyncStore.getState().messages.reprovisioned).toEqual([]);
  expect(useSyncStore.getState().sessionRuntime.reprovisioned).toBe('runtime-b');
  expect(next).not.toBe(old);
});

test('session.deleted aborts its scoped controller before an in-flight read can refill the store', async () => {
  let signal: AbortSignal | undefined;
  let resolveRead!: (value: { data: Array<{ info: Message; parts: [] }> }) => void;
  const controller = getSessionSyncController('deleted', { session: {
    messages: async (_: unknown, opts?: { signal?: AbortSignal }) => {
      signal = opts?.signal;
      return new Promise((resolve) => { resolveRead = resolve; });
    },
  } }, 'runtime-a');
  const read = controller.reconcile();
  noteSessionSyncEvent({ type: 'session.deleted', properties: { info: { id: 'deleted' } } }, 'runtime-a');
  expect(signal?.aborted).toBe(true);
  resolveRead({ data: [{ info: { id: 'stale', sessionID: 'deleted', role: 'user' } as Message, parts: [] }] });
  await read;
  expect('deleted' in useSyncStore.getState().messages).toBe(false);
});

test('full-history export captures its runtime once across page boundaries', async () => {
  const reads: string[] = [];
  configureKortix({ backendUrl: 'https://api.test/v1', getToken: async () => 'test', fetch: async (input) => {
    reads.push(input instanceof Request ? input.url : String(input));
    if (reads.length === 1) {
      setCurrentRuntime('https://export-b.test', 'b');
      return Response.json([], { headers: { 'x-next-cursor': 'older' } });
    }
    return Response.json([]);
  } });
  setCurrentRuntime('https://export-a.test', 'a');
  await registry.loadSessionTranscriptMessages('ses-export');
  expect(reads).toEqual([
    'https://export-a.test/session/ses-export/message?limit=100',
    'https://export-a.test/session/ses-export/message?limit=100&before=older',
  ]);
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('React cleanup order never reads busy session A on runtime B', async () => {
  const reads: string[] = [];
  const cleanupOrder: string[] = [];
  configureKortix({
    backendUrl: 'https://api.test/v1',
    getToken: async () => 'test-token',
    fetch: async (input) => {
      reads.push(input instanceof Request ? input.url : String(input));
      return Response.json([]);
    },
  });
  setCurrentRuntime('https://runtime-a.test', 'runtime-a');
  const controller = getSessionSyncController('ses-a', undefined, 'runtime-a');
  function SessionA() {
    // Same declaration order as useSession: clear runtime before sync release.
    useEffect(() => () => {
      cleanupOrder.push('clear runtime');
      setCurrentRuntime(null);
    }, []);
    useEffect(() => {
      const release = retainSessionSyncController('ses-a', 'runtime-a');
      controller.setBusy(true);
      return () => {
        cleanupOrder.push('release controller');
        release();
      };
    }, []);
    return null;
  }
  let tree: ReactTestRenderer;
  await act(async () => { tree = create(createElement(SessionA)); });
  await controller.reconcile('initial');
  expect(reads).toEqual(['https://runtime-a.test/session/ses-a/message?limit=50']);
  const originalTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map<number, { dueAt: number; run: () => void }>();
  let timerId = 0;
  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    timers.set(++timerId, { dueAt: delay, run: callback });
    return timerId;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => timers.delete(id)) as typeof clearTimeout;
  try {
    await act(async () => { tree!.unmount(); });
    expect(cleanupOrder).toEqual(['clear runtime', 'release controller']);
    setCurrentRuntime('https://runtime-b.test', 'runtime-b');
    // Advance beyond the one-second retry after the turn-end promise settles.
    for (const [id, timer] of [...timers]) {
      if (timer.dueAt > 1_100) continue;
      timers.delete(id);
      timer.run();
    }
    for (let index = 0; index < 25; index++) await Promise.resolve();
    expect(reads.filter((url) => url.includes('runtime-b.test'))).toEqual([]);
    expect(timers.size).toBe(0);
  } finally {
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
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
describe('readSessionMessagePage — OpenCode v1 normalization', () => {
  function entry(id: string, created: number, parts: unknown[] = []) {
    return { info: { id, sessionID: 'session-1', role: 'user', time: { created } }, parts };
  }

  function clientReturning(data: unknown[]) {
    return {
      session: {
        messages: async () => ({ data, response: { headers: { get: () => null } } }),
      },
    } as never;
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
  test('preserves MessageWithParts and reads the legacy older-page cursor', async () => {
    const requests: unknown[] = [];
    const client = {
      session: {
        messages: async (request: unknown) => {
          requests.push(request);
          return {
            data: [
              {
                info: {
                  id: 'message-1',
                  sessionID: 'session-1',
                  role: 'user',
                } as Message,
                parts: [],
              },
            ],
            response: new Response(null, {
              headers: { 'X-Next-Cursor': 'message-older' },
            }),
          };
        },
      },
    };

    const result = await readSessionMessagePage(client, 'session-1', {
      limit: 10,
      before: 'message-newer',
    });

    expect(requests).toEqual([
      {
        sessionID: 'session-1',
        limit: 10,
        before: 'message-newer',
      },
    ]);
    expect(result.messages[0]?.info.id).toBe('message-1');
    expect(result.nextCursor).toBe('message-older');
  });
});

describe('prefetchSessionSyncOnce', () => {
  test('keeps controllers distinct when two sandboxes contain the same OpenCode id', () => {
    const sharedId = 'session-from-snapshot';
    const runtimeA = getSessionSyncController(sharedId, undefined, 'runtime-a');
    const runtimeB = getSessionSyncController(sharedId, undefined, 'runtime-b', 'https://runtime-b.test');

    expect(runtimeA).not.toBe(runtimeB);
    expect(getSessionSyncController(sharedId, undefined, 'runtime-a')).toBe(runtimeA);
    expect(getSessionSyncController(sharedId, undefined, 'runtime-b')).toBe(runtimeB);
  });

  test('retires old-sandbox controllers without deleting the current sandbox controller', () => {
    const sharedId = 'session-from-snapshot';
    const runtimeA = getSessionSyncController(sharedId, undefined, 'runtime-a');
    const runtimeB = getSessionSyncController(sharedId, undefined, 'runtime-b', 'https://runtime-b.test');

    resetSessionSyncControllersForSession(sharedId, 'runtime-b');

    expect(getSessionSyncController(sharedId, undefined, 'runtime-a')).not.toBe(runtimeA);
    expect(getSessionSyncController(sharedId, undefined, 'runtime-b')).toBe(runtimeB);
  });

  test('deduplicates one runtime source and revalidates after the runtime changes', async () => {
    const requests: string[] = [];
    const client = (runtime: string) => ({
      session: {
        messages: async () => {
          requests.push(runtime);
          return { data: [] };
        },
      },
    });

    await prefetchSessionSyncOnce('session-1', 'runtime-a', client('runtime-a'));
    await prefetchSessionSyncOnce('session-1', 'runtime-a', client('runtime-a'));
    await prefetchSessionSyncOnce('session-1', 'runtime-b', client('runtime-b'));

    expect(requests).toEqual(['runtime-a', 'runtime-b']);
  });

  test('clears active-runtime markers without clearing explicit runtime markers', async () => {
    let activeRequests = 0;
    let backgroundRequests = 0;
    const activeClient = {
      session: {
        messages: async () => {
          activeRequests += 1;
          return { data: [] };
        },
      },
    };
    const backgroundClient = {
      session: {
        messages: async () => {
          backgroundRequests += 1;
          return { data: [] };
        },
      },
    };

    await prefetchSessionSyncOnce('active-session', ACTIVE_SESSION_PREFETCH_SOURCE, activeClient);
    await prefetchSessionSyncOnce('background-session', 'runtime-a', backgroundClient);
    clearActiveSessionPrefetches();
    await prefetchSessionSyncOnce('active-session', ACTIVE_SESSION_PREFETCH_SOURCE, activeClient);
    await prefetchSessionSyncOnce('background-session', 'runtime-a', backgroundClient);

    expect(activeRequests).toBe(2);
    expect(backgroundRequests).toBe(1);
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
    setCurrentRuntime(null);

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
  function failingClient(payload: {
    data?: unknown;
    error?: unknown;
    status?: number;
  }) {
    return {
      session: {
        messages: async () => ({
          data: payload.data,
          error: payload.error,
          response: payload.status
            ? new Response(null, { status: payload.status })
            : undefined,
        }),
      },
    } as never;
  }

  test('a 503 throws a retryable SandboxNotReadyError, never an empty page', async () => {
    const client = failingClient({
      error: { data: { message: 'sandbox not ready (status: starting)' } },
      status: 503,
    });
    const promise = readSessionMessagePage(client, 'session-1', { limit: 50 });
    await expect(promise).rejects.toBeInstanceOf(SandboxNotReadyError);
    await expect(promise).rejects.toThrow(/sandbox not ready/i);
  });

  test('a not-ready body classifies as SandboxNotReadyError even without a 503 status', async () => {
    const client = failingClient({ error: { message: 'opencode session is not ready' } });
    await expect(
      readSessionMessagePage(client, 'session-1', { limit: 50 }),
    ).rejects.toBeInstanceOf(SandboxNotReadyError);
  });

  test('a 500 throws a real error, not a not-ready error', async () => {
    const client = failingClient({ error: { message: 'internal error' }, status: 500 });
    const promise = readSessionMessagePage(client, 'session-1', { limit: 50 });
    await expect(promise).rejects.toThrow('internal error');
    await expect(promise).rejects.not.toBeInstanceOf(SandboxNotReadyError);
  });

  test('a 2xx payload is still normalized and returned', async () => {
    const client = {
      session: {
        messages: async () => ({
          data: [{ info: { id: 'm1', time: { created: 1 } }, parts: [] }],
          response: new Response(null, { status: 200 }),
        }),
      },
    } as never;
    const result = await readSessionMessagePage(client, 'session-1', { limit: 50 });
    expect(result.messages.map((m) => m.info.id)).toEqual(['m1']);
  });

  test('threads the AbortSignal into client.session.messages', async () => {
    let seen: AbortSignal | undefined;
    const client = {
      session: {
        messages: async (_request: unknown, options?: { signal?: AbortSignal }) => {
          seen = options?.signal;
          return { data: [], response: new Response(null, { status: 200 }) };
        },
      },
    } as never;
    const controller = new AbortController();
    await readSessionMessagePage(client, 'session-1', { limit: 50 }, controller.signal);
    expect(seen).toBe(controller.signal);
  });
});

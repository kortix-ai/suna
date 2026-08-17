import { beforeEach, describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';
import { useSyncStore } from '../stores/sync-store';
import { setCurrentRuntime } from '../../core/session/current-runtime';
import {
  loadSessionRuntimeStatus,
  ACTIVE_SESSION_PREFETCH_SOURCE,
  beginSessionPromptObservation,
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

describe('REST prompt observation events', () => {
  test('reuses the sole scoped controller while the current runtime is temporarily unbound', () => {
    const sessionId = 'session-rest-prompt';
    const controller = getSessionSyncController(sessionId, undefined, 'runtime-a');

    beginSessionPromptObservation(sessionId);

    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);
    noteSessionSyncEvent({
      type: 'session.error',
      properties: { sessionID: sessionId, error: { name: 'RuntimeError' } },
    });
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(false);
  });

  test('ignores global events that do not contain session properties', () => {
    expect(() =>
      noteSessionSyncEvent({
        type: 'server.connected',
        properties: undefined,
      }),
    ).not.toThrow();
  });

  test('ignores premature idle and ends observation on a terminal runtime error', () => {
    const sessionId = 'session-rest-prompt';
    const controller = getSessionSyncController(sessionId);

    beginSessionPromptObservation(sessionId);
    noteSessionSyncEvent({
      type: 'session.idle',
      properties: { sessionID: sessionId },
    });
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);

    noteSessionSyncEvent({
      type: 'message.updated',
      properties: {
        info: { id: 'assistant-1', sessionID: sessionId, role: 'assistant' },
      },
    });
    noteSessionSyncEvent({
      type: 'session.error',
      properties: { sessionID: sessionId, error: { name: 'RuntimeError' } },
    });
    expect(controller.getSnapshot().isPromptObservedBusy).toBe(false);
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

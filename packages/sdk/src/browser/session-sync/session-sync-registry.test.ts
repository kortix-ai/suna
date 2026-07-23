import { beforeEach, describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';
import { useSyncStore } from '../stores/sync-store';
import {
  ACTIVE_SESSION_PREFETCH_SOURCE,
  clearActiveSessionPrefetches,
  getSessionSyncController,
  prefetchSessionSyncOnce,
  readSessionMessagePage,
  resetSessionSyncControllers,
  retainSessionSyncController,
} from './session-sync-registry';

beforeEach(() => {
  resetSessionSyncControllers();
  useSyncStore.getState().reset();
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

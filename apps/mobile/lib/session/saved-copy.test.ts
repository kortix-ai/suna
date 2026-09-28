import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  configureKortix,
  createSavedCopyStore,
  setSavedCopyStore,
  type KeyValueStorage,
  type SessionTranscriptSyncEnvelope,
} from '@kortix/sdk';

import { useSyncStore } from '@/lib/opencode/sync-store';
import { loadSavedCopy, paintSavedCopy } from './saved-copy';

/**
 * Opening a session on mobile showed a loader for the whole wake of its
 * computer (up to minutes), although the server holds a saved copy of the
 * conversation and the device kept the last one it saw. These tests pin the
 * copy that paints the thread in the meantime: kept copy first, the server's
 * next, only for the session's own OpenCode root, never over a runtime read.
 */

const ROOT = 'ses_root_1';
const originalFetch = globalThis.fetch;

function memoryStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function envelope(count: number, root = ROOT, capturedAt = '2026-09-26T10:00:00Z'): SessionTranscriptSyncEnvelope {
  return {
    available: true,
    reason: null,
    source: 'mirror',
    complete: true,
    captured_at: capturedAt,
    opencode_session_id: root,
    message_count: count,
    messages: Array.from({ length: count }, (_, i) => ({
      info: { id: `msg_${i + 1}`, sessionID: root, role: i % 2 === 0 ? 'user' : 'assistant', time: { created: i + 1 } },
      parts: [{ id: `prt_${i + 1}`, type: 'text', text: `message ${i + 1}` }],
    })),
  } as unknown as SessionTranscriptSyncEnvelope;
}

const ids = () => (useSyncStore.getState().messages[ROOT] ?? []).map((message) => message.info.id);

beforeEach(() => {
  useSyncStore.getState().reset();
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setSavedCopyStore(null);
});

describe('paintSavedCopy', () => {
  test('paints a copy of this root', () => {
    expect(paintSavedCopy(ROOT, envelope(2))).toBe(true);
    expect(ids()).toEqual(['msg_1', 'msg_2']);
  });

  test('refuses a copy captured from another root', () => {
    expect(paintSavedCopy(ROOT, envelope(2, 'ses_other'))).toBe(false);
    expect(ids()).toEqual([]);
  });

  test('never paints over messages the runtime already read', () => {
    useSyncStore.getState().hydrate(ROOT, envelope(1).messages as never);
    expect(paintSavedCopy(ROOT, envelope(3))).toBe(false);
    expect(ids()).toEqual(['msg_1']);
  });

  test('a newer copy reconciles into an earlier copy', () => {
    paintSavedCopy(ROOT, envelope(1));
    expect(paintSavedCopy(ROOT, envelope(3))).toBe(true);
    expect(ids()).toEqual(['msg_1', 'msg_2', 'msg_3']);
  });
});

describe('loadSavedCopy', () => {
  test('paints the kept copy, then the server copy, and keeps the server copy', async () => {
    const store = createSavedCopyStore({ storage: memoryStorage(), userId: 'user-a' });
    await store.write('p1', 's1', envelope(1));
    setSavedCopyStore(store);
    let answer!: (response: Response) => void;
    globalThis.fetch = mock(
      async () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    ) as unknown as typeof fetch;

    const loading = loadSavedCopy({ projectId: 'p1', sessionId: 's1', rootId: ROOT });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ids()).toEqual(['msg_1']);

    answer(Response.json(envelope(3, ROOT, '2026-09-26T11:00:00Z')));
    await loading;
    expect(ids()).toEqual(['msg_1', 'msg_2', 'msg_3']);
    expect(((await store.read('p1', 's1')) as SessionTranscriptSyncEnvelope).message_count).toBe(3);
  });

  test('a failed read keeps what the device showed, and never throws', async () => {
    const store = createSavedCopyStore({ storage: memoryStorage(), userId: 'user-a' });
    await store.write('p1', 's1', envelope(2));
    setSavedCopyStore(store);
    globalThis.fetch = mock(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;

    await loadSavedCopy({ projectId: 'p1', sessionId: 's1', rootId: ROOT });

    expect(ids()).toEqual(['msg_1', 'msg_2']);
    expect(await store.read('p1', 's1')).not.toBeNull();
  });

  test('without a kept copy it paints the server copy', async () => {
    globalThis.fetch = mock(async () => Response.json(envelope(2))) as unknown as typeof fetch;
    await loadSavedCopy({ projectId: 'p1', sessionId: 's1', rootId: ROOT });
    expect(ids()).toEqual(['msg_1', 'msg_2']);
  });
});

describe('a sub-agent thread', () => {
  // A sub-agent runs in its own OpenCode session inside the Kortix session.
  // Its view waited for the computer; the server saves its transcript too.
  const CHILD = 'ses_child_1';

  test('paints its own saved window, and keeps nothing on the device', async () => {
    const store = createSavedCopyStore({ storage: memoryStorage(), userId: 'user-a' });
    setSavedCopyStore(store);
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return Response.json(envelope(2, CHILD));
    }) as unknown as typeof fetch;

    const outcome = await loadSavedCopy({ projectId: 'p1', sessionId: 's1', rootId: CHILD, child: true });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`child=${CHILD}`);
    expect((useSyncStore.getState().messages[CHILD] ?? []).map((m) => m.info.id)).toEqual(['msg_1', 'msg_2']);
    // The device slot is the conversation's copy; a sub-agent never replaces it.
    expect(await store.read('p1', 's1')).toBeNull();
    expect(outcome.empty).toBe(false);
  });
});

describe('an empty conversation', () => {
  // The server's saved copy proves the conversation empty: a complete read of
  // the runtime found no messages. With no turn ever and none open there is
  // nothing to wait for, so the view opens on its composer.
  const provenEmpty = { ...envelope(0), total: 0 };
  const serve = (turn: unknown) => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      return url.includes('/turn') ? Response.json(turn) : Response.json(provenEmpty);
    }) as unknown as typeof fetch;
    return urls;
  };

  test('a copy that proves this root empty, and no turn on record, is empty', async () => {
    serve({ turns: [] });
    expect(await loadSavedCopy({ projectId: 'p1', sessionId: 's1', rootId: ROOT })).toEqual({ empty: true });
  });

  test('a turn that ended since, or one open, outranks the empty copy', async () => {
    serve({ turns: [], last_ended: { turn_token: 't1', end_reason: 'completed', ended_at: '2026-09-28T00:00:00Z' } });
    expect((await loadSavedCopy({ projectId: 'p1', sessionId: 's1', rootId: ROOT })).empty).toBe(false);
    serve({ turns: [{ turn_token: 't2', state: 'running' }] });
    expect((await loadSavedCopy({ projectId: 'p1', sessionId: 's1', rootId: ROOT })).empty).toBe(false);
  });

  test('an unanswered turn record is an unknown, never an empty', async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/turn')) throw new TypeError('Network request failed');
      return Response.json(provenEmpty);
    }) as unknown as typeof fetch;
    expect((await loadSavedCopy({ projectId: 'p1', sessionId: 's1', rootId: ROOT })).empty).toBe(false);
  });

  test('no saved copy is not evidence, and the turn record is not read for it', async () => {
    const urls = serve({ turns: [] });
    globalThis.fetch = mock(async (input: unknown) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return Response.json({ ...envelope(0), available: false, source: 'none' });
    }) as unknown as typeof fetch;
    expect((await loadSavedCopy({ projectId: 'p1', sessionId: 's1', rootId: ROOT })).empty).toBe(false);
    expect(urls.some((url) => url.includes('/turn'))).toBe(false);
  });
});

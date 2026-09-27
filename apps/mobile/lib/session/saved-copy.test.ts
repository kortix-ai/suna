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

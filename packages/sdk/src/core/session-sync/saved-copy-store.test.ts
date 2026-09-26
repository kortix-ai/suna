import { describe, expect, test } from 'bun:test';

import type { KeyValueStorage } from '../cache/persisted-query-cache';
import type { SessionTranscriptSyncEnvelope } from '../rest/projects-client/sessions';
import { createSavedCopyStore, isPaintableSavedCopy } from './saved-copy-store';

/**
 * Opening a session painted nothing until the control plane answered with the
 * saved copy it captured at the last turn end: skeleton rows for 0.3-2.3 s on
 * every cold open, and the whole reload when the backend was slow. This store
 * keeps the last saved copies the SERVER sent, so the next open paints them in
 * the first frame. It never stores the live transcript: only an envelope the
 * server captured because a turn ended, which is why a stopped turn cannot
 * come back as a running one.
 */

const T0 = Date.parse('2026-09-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function asyncStorage(inner = memoryStorage()): KeyValueStorage {
  return {
    getItem: async (key) => inner.getItem(key),
    setItem: async (key, value) => inner.setItem(key, value),
    removeItem: async (key) => inner.removeItem(key),
  };
}

function envelope(overrides: Partial<SessionTranscriptSyncEnvelope> = {}): SessionTranscriptSyncEnvelope {
  return {
    available: true,
    reason: null,
    source: 'mirror',
    complete: false,
    captured_at: '2026-09-26T11:59:00.000Z',
    opencode_session_id: 'ses_root',
    message_count: 1,
    messages: [
      {
        info: { id: 'msg_1', role: 'user', sessionID: 'ses_root', time: { created: T0 } },
        parts: [{ id: 'prt_1', type: 'text', text: 'fix the audit 5xx' }],
      },
    ],
    ...overrides,
  } as unknown as SessionTranscriptSyncEnvelope;
}

function store(storage: KeyValueStorage, overrides: Record<string, unknown> = {}) {
  let now = T0;
  const instance = createSavedCopyStore({ storage, userId: 'user-a', now: () => now, ...overrides });
  return { instance, advance: (ms: number) => (now += ms) };
}

describe('a saved copy paints the next open', () => {
  test('reads back what it wrote, synchronously from synchronous storage', async () => {
    const storage = memoryStorage();
    const { instance } = store(storage);
    await instance.write('p1', 's1', envelope());

    const read = instance.read('p1', 's1');
    expect(read).not.toBeInstanceOf(Promise);
    expect((read as SessionTranscriptSyncEnvelope).messages[0].info.id).toBe('msg_1');
  });

  test('reads back through a promise from asynchronous storage', async () => {
    const { instance } = store(asyncStorage());
    await instance.write('p1', 's1', envelope());

    const read = instance.read('p1', 's1');
    expect(read).toBeInstanceOf(Promise);
    expect((await read)?.opencode_session_id).toBe('ses_root');
  });

  test('an unknown session reads null', () => {
    const { instance } = store(memoryStorage());
    expect(instance.read('p1', 'missing')).toBeNull();
  });
});

describe('only a copy the server vouches for is kept', () => {
  test.each([
    ['unavailable', { available: false }],
    ['not from the mirror', { source: 'none' }],
    ['empty', { messages: [], message_count: 0 }],
    ['without its OpenCode root', { opencode_session_id: null }],
  ])('%s: not kept, and it replaces an older copy', async (_label, overrides) => {
    const storage = memoryStorage();
    const { instance } = store(storage);
    await instance.write('p1', 's1', envelope());
    await instance.write('p1', 's1', envelope(overrides as Partial<SessionTranscriptSyncEnvelope>));

    expect(instance.read('p1', 's1')).toBeNull();
  });

  test('isPaintableSavedCopy accepts a captured window', () => {
    expect(isPaintableSavedCopy(envelope())).toBe(true);
    expect(isPaintableSavedCopy(null)).toBe(false);
  });

  test('an older capture never overwrites a newer one', async () => {
    const storage = memoryStorage();
    const { instance } = store(storage);
    await instance.write('p1', 's1', envelope({ captured_at: '2026-09-26T11:59:00.000Z', message_count: 2 }));
    await instance.write('p1', 's1', envelope({ captured_at: '2026-09-26T11:00:00.000Z', message_count: 1 }));

    expect((instance.read('p1', 's1') as SessionTranscriptSyncEnvelope).message_count).toBe(2);
  });

  test('a copy larger than the per-session bound is not kept', async () => {
    const { instance } = store(memoryStorage(), { maxEnvelopeBytes: 200 });
    await instance.write('p1', 's1', envelope());
    expect(instance.read('p1', 's1')).toBeNull();
  });
});

describe('bounded', () => {
  test('keeps the most recently used sessions when over the session count', async () => {
    const storage = memoryStorage();
    const { instance, advance } = store(storage, { maxSessions: 2 });
    await instance.write('p1', 'a', envelope());
    advance(1_000);
    await instance.write('p1', 'b', envelope());
    advance(1_000);
    instance.read('p1', 'a');
    advance(1_000);
    await instance.write('p1', 'c', envelope());

    expect(instance.read('p1', 'a')).not.toBeNull();
    expect(instance.read('p1', 'b')).toBeNull();
    expect(instance.read('p1', 'c')).not.toBeNull();
  });

  test('keeps the total under the byte bound, evicting the least recent', async () => {
    const storage = memoryStorage();
    const size = JSON.stringify(envelope()).length;
    const { instance, advance } = store(storage, { maxBytes: size * 2 + 400 });
    await instance.write('p1', 'a', envelope());
    advance(1_000);
    await instance.write('p1', 'b', envelope());
    advance(1_000);
    await instance.write('p1', 'c', envelope());

    expect(instance.read('p1', 'a')).toBeNull();
    expect(instance.read('p1', 'c')).not.toBeNull();
  });

  test('a copy older than the maximum age is not painted', async () => {
    const storage = memoryStorage();
    const { instance, advance } = store(storage, { maxAgeMs: 14 * DAY });
    await instance.write('p1', 's1', envelope());
    advance(15 * DAY);

    expect(instance.read('p1', 's1')).toBeNull();
  });

  test('a full storage evicts and retries, and never throws', async () => {
    const inner = memoryStorage();
    let refuse = 1;
    const storage: KeyValueStorage = {
      getItem: inner.getItem,
      removeItem: inner.removeItem,
      setItem: (key, value) => {
        if (key.endsWith('/c') && refuse > 0) {
          refuse -= 1;
          throw new Error('QuotaExceededError');
        }
        inner.setItem(key, value);
      },
    };
    const { instance, advance } = store(storage);
    await instance.write('p1', 'a', envelope());
    advance(1_000);
    await instance.write('p1', 'c', envelope());

    expect(instance.read('p1', 'c')).not.toBeNull();
    expect(instance.read('p1', 'a')).toBeNull();
  });
});

describe('whose copies', () => {
  test('another user never reads them', async () => {
    const storage = memoryStorage();
    await store(storage).instance.write('p1', 's1', envelope());
    const other = createSavedCopyStore({ storage, userId: 'user-b', now: () => T0 });
    expect(other.read('p1', 's1')).toBeNull();
  });

  test('remove() forgets one session', async () => {
    const { instance } = store(memoryStorage());
    await instance.write('p1', 's1', envelope());
    await instance.write('p1', 's2', envelope());
    await instance.remove('p1', 's1');
    expect(instance.read('p1', 's1')).toBeNull();
    expect(instance.read('p1', 's2')).not.toBeNull();
  });

  test('clear() forgets every copy of this user and nothing else', async () => {
    const storage = memoryStorage();
    storage.setItem('unrelated', 'kept');
    const { instance } = store(storage);
    await instance.write('p1', 's1', envelope());
    await instance.write('p2', 's2', envelope());
    await instance.clear();

    expect(instance.read('p1', 's1')).toBeNull();
    expect(instance.read('p2', 's2')).toBeNull();
    expect([...storage.data.keys()]).toEqual(['unrelated']);
  });

  test('a corrupt entry reads null and is removed', () => {
    const storage = memoryStorage();
    const { instance } = store(storage);
    storage.setItem(instance.keyFor('p1', 's1'), '{nope');
    expect(instance.read('p1', 's1')).toBeNull();
    expect(storage.data.has(instance.keyFor('p1', 's1'))).toBe(false);
  });
});

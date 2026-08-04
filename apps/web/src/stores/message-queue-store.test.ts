import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  QUEUE_STORAGE_KEY,
  hadAttachments,
  useMessageQueueStore,
} from './message-queue-store';

const A = 'ses_a';
const B = 'ses_b';

/** An in-memory `localStorage`. Bun has no DOM, so the store never sees one
 *  unless a test installs it — which is also how the "no storage" path is
 *  exercised. */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}

function install(storage: Storage | undefined) {
  (globalThis as { localStorage?: Storage }).localStorage = storage as Storage;
}

beforeEach(() => {
  install(fakeStorage());
  useMessageQueueStore.setState({ queues: {}, hydrated: false });
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('per-session isolation', () => {
  test('a message queued for one session never appears in another', () => {
    const s = useMessageQueueStore.getState();
    s.enqueue(A, { text: 'for a' });
    s.enqueue(B, { text: 'for b' });

    const store = useMessageQueueStore.getState();
    expect(store.getSessionQueue(A).pending.map((m) => m.text)).toEqual(['for a']);
    expect(store.getSessionQueue(B).pending.map((m) => m.text)).toEqual(['for b']);
  });

  test('an unknown session reads as an empty queue, not undefined', () => {
    expect(useMessageQueueStore.getState().getSessionQueue('ses_nope')).toEqual({
      pending: [],
      failed: [],
      inFlightId: null,
    });
  });

  test('clearSession empties one session and leaves the other alone', () => {
    const s = useMessageQueueStore.getState();
    s.enqueue(A, { text: 'for a' });
    s.enqueue(B, { text: 'for b' });
    useMessageQueueStore.getState().clearSession(A);

    const store = useMessageQueueStore.getState();
    expect(store.getSessionQueue(A).pending).toEqual([]);
    expect(store.getSessionQueue(B).pending).toHaveLength(1);
  });
});

describe('persistence', () => {
  test('a queued message survives a reload with its text, config and order', () => {
    const storage = fakeStorage();
    install(storage);

    const s = useMessageQueueStore.getState();
    s.enqueue(A, { text: 'first', agent: 'build', variant: 'thinking' });
    s.enqueue(A, {
      text: 'second',
      model: { providerID: 'anthropic', modelID: 'claude-opus-5' },
    });

    // Reload: same storage, a store that knows nothing.
    useMessageQueueStore.setState({ queues: {}, hydrated: false });
    useMessageQueueStore.getState().hydrate();

    const pending = useMessageQueueStore.getState().getSessionQueue(A).pending;
    expect(pending.map((m) => m.text)).toEqual(['first', 'second']);
    expect(pending[0].agent).toBe('build');
    expect(pending[0].variant).toBe('thinking');
    expect(pending[1].model).toEqual({ providerID: 'anthropic', modelID: 'claude-opus-5' });
  });

  test('a failed message survives a reload', () => {
    const s = useMessageQueueStore.getState();
    s.enqueue(A, { text: 'doomed' });
    useMessageQueueStore.getState().claimNext(A);
    useMessageQueueStore.getState().fail(A, 'network down');

    useMessageQueueStore.setState({ queues: {}, hydrated: false });
    useMessageQueueStore.getState().hydrate();

    const failed = useMessageQueueStore.getState().getSessionQueue(A).failed;
    expect(failed.map((m) => m.text)).toEqual(['doomed']);
    expect(failed[0].lastError).toBe('network down');
  });

  test('an in-flight claim is not persisted — a reload cannot inherit a lock', () => {
    const s = useMessageQueueStore.getState();
    s.enqueue(A, { text: 'mid-flight' });
    useMessageQueueStore.getState().claimNext(A);

    useMessageQueueStore.setState({ queues: {}, hydrated: false });
    useMessageQueueStore.getState().hydrate();

    // The tab that owned the send is gone. Nothing is on the wire, so the
    // queue must be claimable again rather than wedged forever.
    expect(useMessageQueueStore.getState().getSessionQueue(A).inFlightId).toBeNull();
    expect(useMessageQueueStore.getState().claimNext(A)?.text).toBe('mid-flight');
  });

  test('attachments do not survive, and the item says so instead of pretending', () => {
    const file = { kind: 'remote' as const, url: 'u', filename: 'f.png', mime: 'image/png', isImage: true };
    useMessageQueueStore.getState().enqueue(A, { text: 'with a file', files: [file] });

    expect(hadAttachments(useMessageQueueStore.getState().getSessionQueue(A).pending[0])).toBe(0);

    useMessageQueueStore.setState({ queues: {}, hydrated: false });
    useMessageQueueStore.getState().hydrate();

    const restored = useMessageQueueStore.getState().getSessionQueue(A).pending[0];
    expect(hadAttachments(restored)).toBe(1);
    expect(restored.files?.every((f) => f.kind === 'lost')).toBe(true);
  });

  test('a v2 payload under the old key is ignored, not migrated', () => {
    install(
      fakeStorage({
        kortix_message_queue_v2: JSON.stringify([{ id: 'x', sessionId: A, text: 'stale' }]),
      }),
    );
    useMessageQueueStore.getState().hydrate();

    expect(useMessageQueueStore.getState().getSessionQueue(A).pending).toEqual([]);
  });

  test('a corrupt payload hydrates empty instead of throwing', () => {
    install(fakeStorage({ [QUEUE_STORAGE_KEY]: '{not json' }));
    expect(() => useMessageQueueStore.getState().hydrate()).not.toThrow();
    expect(useMessageQueueStore.getState().hydrated).toBe(true);

    install(fakeStorage({ [QUEUE_STORAGE_KEY]: '"a string"' }));
    useMessageQueueStore.setState({ queues: {}, hydrated: false });
    expect(() => useMessageQueueStore.getState().hydrate()).not.toThrow();
    expect(useMessageQueueStore.getState().getSessionQueue(A).pending).toEqual([]);
  });

  test('an entry missing its text is dropped rather than queued blank', () => {
    install(
      fakeStorage({
        [QUEUE_STORAGE_KEY]: JSON.stringify({
          [A]: { pending: [{ id: 'x' }, { id: 'y', clientMessageId: 'c', text: 'kept' }], failed: [] },
        }),
      }),
    );
    useMessageQueueStore.getState().hydrate();

    expect(useMessageQueueStore.getState().getSessionQueue(A).pending.map((m) => m.text)).toEqual([
      'kept',
    ]);
  });

  test('a storage write that throws does not break queueing', () => {
    install({
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage);

    expect(() => useMessageQueueStore.getState().enqueue(A, { text: 'still queues' })).not.toThrow();
    expect(useMessageQueueStore.getState().getSessionQueue(A).pending).toHaveLength(1);
  });

  test('with no storage at all, the queue still works in memory', () => {
    install(undefined);

    expect(() => useMessageQueueStore.getState().enqueue(A, { text: 'in memory' })).not.toThrow();
    expect(useMessageQueueStore.getState().getSessionQueue(A).pending).toHaveLength(1);
    expect(() => useMessageQueueStore.getState().hydrate()).not.toThrow();
  });
});

describe('transitions are delegated to the SDK reducer', () => {
  test('claimNext hands back the head once, then nothing', () => {
    const s = useMessageQueueStore.getState();
    s.enqueue(A, { text: 'one' });
    s.enqueue(A, { text: 'two' });

    expect(useMessageQueueStore.getState().claimNext(A)?.text).toBe('one');
    expect(useMessageQueueStore.getState().claimNext(A)).toBeUndefined();
  });

  test('a failed item does not block the next one', () => {
    const s = useMessageQueueStore.getState();
    s.enqueue(A, { text: 'one' });
    s.enqueue(A, { text: 'two' });
    useMessageQueueStore.getState().claimNext(A);
    useMessageQueueStore.getState().fail(A, 'boom');

    expect(useMessageQueueStore.getState().claimNext(A)?.text).toBe('two');
  });

  test('complete drops the delivered item', () => {
    useMessageQueueStore.getState().enqueue(A, { text: 'one' });
    useMessageQueueStore.getState().claimNext(A);
    useMessageQueueStore.getState().complete(A);

    expect(useMessageQueueStore.getState().getSessionQueue(A).pending).toEqual([]);
  });

  test('retry returns a failed item to the tail', () => {
    const s = useMessageQueueStore.getState();
    s.enqueue(A, { text: 'one' });
    useMessageQueueStore.getState().claimNext(A);
    useMessageQueueStore.getState().fail(A, 'boom');
    useMessageQueueStore.getState().enqueue(A, { text: 'two' });

    const failedId = useMessageQueueStore.getState().getSessionQueue(A).failed[0].id;
    useMessageQueueStore.getState().retry(A, failedId);

    expect(useMessageQueueStore.getState().getSessionQueue(A).pending.map((m) => m.text)).toEqual([
      'two',
      'one',
    ]);
  });

  test('edit, reorder and remove reach the right session', () => {
    const s = useMessageQueueStore.getState();
    s.enqueue(A, { text: 'one' });
    s.enqueue(A, { text: 'two' });
    s.enqueue(A, { text: 'three' });

    const [first, , third] = useMessageQueueStore.getState().getSessionQueue(A).pending;
    useMessageQueueStore.getState().edit(A, first.id, 'edited');
    useMessageQueueStore.getState().reorder(A, third.id, 0);
    useMessageQueueStore.getState().remove(A, third.id);

    expect(useMessageQueueStore.getState().getSessionQueue(A).pending.map((m) => m.text)).toEqual([
      'edited',
      'two',
    ]);
  });

  test('carries files and mentions through untouched while in memory', () => {
    // Inherited from the deleted handoff store's coverage: before a reload,
    // the real `File` payload is still there and must not be mangled.
    const file = { kind: 'local', localUrl: 'blob:mock', file: { name: 'a.txt' } } as never;
    const mention = { kind: 'file', label: 'src/a.txt' } as never;
    useMessageQueueStore.getState().enqueue(A, { text: 'with attachments', files: [file], mentions: [mention] });

    const [queued] = useMessageQueueStore.getState().getSessionQueue(A).pending;
    expect(queued.files).toEqual([file]);
    expect(queued.mentions).toEqual([mention]);
  });

  test('leaves uncaptured agent/model/variant undefined, not null', () => {
    // These are not interchangeable downstream. `handleSend` reads
    // `undefined` as "use whatever is selected now" and `null` as "send
    // nothing at all" — so coercing an uncaptured value to null silently
    // strips the user's model from the send. The instant shell enqueues
    // without any of the three, which is exactly this path.
    useMessageQueueStore.getState().enqueue(A, { text: 'no config captured' });

    const [queued] = useMessageQueueStore.getState().getSessionQueue(A).pending;
    expect(queued.agent).toBeUndefined();
    expect(queued.model).toBeUndefined();
    expect(queued.variant).toBeUndefined();
  });

  test('an explicit null survives as null — "no agent" is a real choice', () => {
    useMessageQueueStore.getState().enqueue(A, { text: 'explicitly none', agent: null });

    expect(useMessageQueueStore.getState().getSessionQueue(A).pending[0].agent).toBeNull();
  });

  test('a reload does not turn undefined config into null', () => {
    useMessageQueueStore.getState().enqueue(A, { text: 'no config captured' });

    useMessageQueueStore.setState({ queues: {}, hydrated: false });
    useMessageQueueStore.getState().hydrate();

    const [restored] = useMessageQueueStore.getState().getSessionQueue(A).pending;
    expect(restored.agent).toBeUndefined();
    expect(restored.model).toBeUndefined();
    expect(restored.variant).toBeUndefined();
  });

  test('every queued message gets a distinct id and idempotency key', () => {
    const s = useMessageQueueStore.getState();
    s.enqueue(A, { text: 'one' });
    s.enqueue(A, { text: 'two' });

    const pending = useMessageQueueStore.getState().getSessionQueue(A).pending;
    expect(pending[0].id).not.toBe(pending[1].id);
    expect(pending[0].clientMessageId).not.toBe(pending[1].clientMessageId);
  });
});

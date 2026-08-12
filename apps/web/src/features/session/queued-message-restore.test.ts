/**
 * Undo must put back what was taken. All of it.
 *
 * The Undo button on "Removed from queue" re-enqueued a hand-written field
 * list, so every field the queue grew after that list was written was dropped
 * on the floor. `command` (added in 27279d2232) and `files` both were: undoing
 * the removal of a queued `/webapp` returned a plain text message — and, when
 * the command had no arguments, an entry whose `text` is `''`, which dispatches
 * an empty prompt.
 *
 * So the guard here is deliberately not "does `command` survive". It is "does
 * EVERY field survive", driven by `Required<EnqueueInput>`: a field added to
 * the queue input makes the fixture below a type error until it is populated,
 * and the round-trip loop then covers it with no further edit.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  QUEUE_STORAGE_KEY,
  hadAttachments,
  useMessageQueueStore,
  type EnqueueInput,
  type WebQueuedMessage,
} from '@/stores/message-queue-store';
import { createQueueUndoAction, restoreQueuedMessage } from './queued-message-restore';

const A = 'ses_a';

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

/**
 * Every field a host can hand the queue, populated.
 *
 * `Required<EnqueueInput>` is the whole point: this object cannot compile while
 * a field is missing, so the next field added to the queue joins the round-trip
 * assertion below automatically instead of being silently untested.
 */
const FULL: Required<EnqueueInput> = {
  text: 'ship the landing page',
  files: [
    { kind: 'remote', url: 'https://f/1.png', filename: '1.png', mime: 'image/png', isImage: true },
    { kind: 'lost' },
  ],
  mentions: [{ kind: 'file', label: 'src/app/page.tsx' }],
  agent: 'build',
  model: { providerID: 'anthropic', modelID: 'claude-opus-5' },
  variant: 'thinking',
  command: { name: 'webapp', split: { before: 'ship the', after: 'landing page' } },
};

/** Enqueue `input`, remove it, and put it back the way the Undo button does. */
function removeAndUndo(input: EnqueueInput): {
  before: WebQueuedMessage;
  after: WebQueuedMessage;
} {
  const store = useMessageQueueStore.getState();
  store.enqueue(A, input);
  const before = useMessageQueueStore.getState().getSessionQueue(A).pending[0];
  useMessageQueueStore.getState().remove(A, before.id);
  useMessageQueueStore.getState().enqueue(A, restoreQueuedMessage(before));
  const after = useMessageQueueStore.getState().getSessionQueue(A).pending[0];
  return { before, after };
}

describe('undo of a removed queued message', () => {
  test('restores every field the queue captured, not a hand-written subset', () => {
    const { before, after } = removeAndUndo(FULL);

    const fields = Object.keys(FULL) as (keyof EnqueueInput)[];
    // A fixture that lost its keys would make every assertion below vacuous.
    expect(fields.length).toBeGreaterThanOrEqual(7);
    for (const field of fields) {
      expect({ [field]: after[field] }).toEqual({
        [field]: before[field],
      });
    }
  });

  test('restores every field across a reload too — the payloads are all that go', () => {
    // The other place a field can be dropped without anyone noticing is
    // `reviveMessage`, which reads each field by name out of localStorage. That
    // allow-list is deliberate — the payload is untrusted, any tab or older
    // build can write it — so this asserts the list is COMPLETE rather than
    // asking for a spread there.
    const store = useMessageQueueStore.getState();
    store.enqueue(A, FULL);
    const before = useMessageQueueStore.getState().getSessionQueue(A).pending[0];

    const stored = (globalThis as { localStorage?: Storage }).localStorage!.getItem(
      QUEUE_STORAGE_KEY,
    );
    install(fakeStorage({ [QUEUE_STORAGE_KEY]: stored! }));
    useMessageQueueStore.setState({ queues: {}, hydrated: false });
    useMessageQueueStore.getState().hydrate();

    const revived = useMessageQueueStore.getState().getSessionQueue(A).pending[0];
    useMessageQueueStore.getState().remove(A, revived.id);
    useMessageQueueStore.getState().enqueue(A, restoreQueuedMessage(revived));
    const after = useMessageQueueStore.getState().getSessionQueue(A).pending[0];

    for (const field of Object.keys(FULL) as (keyof EnqueueInput)[]) {
      // `files` is the one field a reload genuinely cannot preserve: a `File`
      // and a `blob:` URL do not serialize. The COUNT still must.
      if (field === 'files') continue;
      expect({ [field]: after[field] }).toEqual({
        [field]: before[field],
      });
    }
    expect(after.files).toEqual([{ kind: 'lost' }, { kind: 'lost' }]);
  });

  test('a queued `/webapp` comes back as a command, not as its arguments', () => {
    const { after } = removeAndUndo({ text: 'ship the landing page', command: { name: 'webapp' } });

    // Without this the entry dispatches through the prompt path, which sends
    // the literal arguments with no command at all.
    expect(after.command).toEqual({ name: 'webapp' });
  });

  test('an argument-less command does not come back as an empty message', () => {
    // `/webapp` on its own is a complete instruction whose `text` is ''. Drop
    // its `command` and the restored entry sends `handleSend('')` — an empty
    // prompt on the wire.
    const { after } = removeAndUndo({ text: '', command: { name: 'webapp' } });

    expect(after.text).toBe('');
    expect(after.command?.name).toBe('webapp');
  });

  test('attachments come back, including the ones a reload had already lost', () => {
    // `removed.files` is `QueuedAttachment[]`, so it can hold `{kind:'lost'}`
    // placeholders. They are carried rather than filtered: the count is what
    // tells the user "there were two attachments and they will not be sent".
    // Filtering here would restore an entry that quietly claims it never had
    // any — the exact silent loss the store's `lost` marker exists to prevent.
    useMessageQueueStore.getState().enqueue(A, {
      text: 'with two files',
      files: [
        { kind: 'remote', url: 'u1', filename: 'a.png', mime: 'image/png', isImage: true },
        { kind: 'remote', url: 'u2', filename: 'b.png', mime: 'image/png', isImage: true },
      ],
    });

    // Reload: the payloads are gone, the fact of them is not.
    const stored = (globalThis as { localStorage?: Storage }).localStorage!.getItem(
      QUEUE_STORAGE_KEY,
    );
    install(fakeStorage({ [QUEUE_STORAGE_KEY]: stored! }));
    useMessageQueueStore.setState({ queues: {}, hydrated: false });
    useMessageQueueStore.getState().hydrate();

    const removed = useMessageQueueStore.getState().getSessionQueue(A).pending[0];
    expect(hadAttachments(removed)).toBe(2);

    useMessageQueueStore.getState().remove(A, removed.id);
    useMessageQueueStore.getState().enqueue(A, restoreQueuedMessage(removed));

    const restored = useMessageQueueStore.getState().getSessionQueue(A).pending[0];
    expect(hadAttachments(restored)).toBe(2);
  });

  test('live attachments come back as themselves, not as lost markers', () => {
    const file = {
      kind: 'remote' as const,
      url: 'https://f/1.png',
      filename: '1.png',
      mime: 'image/png',
      isImage: true,
    };
    const { after } = removeAndUndo({ text: 'with a file', files: [file] });

    expect(after.files).toEqual([file]);
    expect(hadAttachments(after)).toBe(0);
  });

  test('queue bookkeeping is minted fresh, never carried back', () => {
    // `id`, `clientMessageId`, `createdAt`, `attempts` and `lastError` belong
    // to the queue, not to the message. A restored entry is a new entry: it has
    // not been attempted, and it is not carrying the error of the send that
    // never happened.
    useMessageQueueStore.getState().enqueue(A, { text: 'doomed' });
    useMessageQueueStore.getState().claimNext(A);
    useMessageQueueStore.getState().fail(A, 'network down');

    const failed = useMessageQueueStore.getState().getSessionQueue(A).failed[0];
    useMessageQueueStore.getState().remove(A, failed.id);
    useMessageQueueStore.getState().enqueue(A, restoreQueuedMessage(failed));

    const restored = useMessageQueueStore.getState().getSessionQueue(A).pending[0];
    expect(restored.id).not.toBe(failed.id);
    expect(restored.clientMessageId).not.toBe(failed.clientMessageId);
    expect(restored.attempts).toBe(0);
    expect(restored.lastError).toBeUndefined();
    expect(restored.text).toBe('doomed');
  });

  test('an uncaptured agent/model/variant stays undefined through the round trip', () => {
    // The instant shell enqueues without any of the three, and `undefined`
    // means "resolve it when this actually sends". Restoring it as `null`
    // would lock in "send no model at all".
    const { after } = removeAndUndo({ text: 'no config captured' });

    expect(after.agent).toBeUndefined();
    expect(after.model).toBeUndefined();
    expect(after.variant).toBeUndefined();
  });
});

describe('createQueueUndoAction', () => {
  // The toast renders `options.button` verbatim (components/ui/toast.tsx) and
  // the sonner id it would need to dismiss itself is only in scope inside the
  // toast's own render callback. So the button stays on screen for the full 5s
  // after it is pressed, and a second press ran the restore again — putting the
  // entry back TWICE, now including its `command`, which dispatches the command
  // twice.
  function removedEntry(text: string): WebQueuedMessage {
    useMessageQueueStore.getState().enqueue(A, { text });
    const queued = useMessageQueueStore.getState().getSessionQueue(A).pending[0];
    useMessageQueueStore.getState().remove(A, queued.id);
    return queued;
  }

  test('a second press restores nothing — one removal, one entry back', () => {
    const removed = removedEntry('bring me back');
    const undo = createQueueUndoAction({ sessionId: A, removed, index: 0 });

    undo();
    undo();

    const pending = useMessageQueueStore.getState().getSessionQueue(A).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0].text).toBe('bring me back');
  });

  test('the first press dismisses the toast, and the second does nothing at all', () => {
    const dismissed: string[] = [];
    const removed = removedEntry('one');
    const undo = createQueueUndoAction({
      sessionId: A,
      removed,
      index: 0,
      dismiss: () => dismissed.push('x'),
    });

    undo();
    undo();
    undo();

    expect(dismissed).toHaveLength(1);
  });

  test('it puts the entry back at the index it was removed from, not at the tail', () => {
    useMessageQueueStore.getState().enqueue(A, { text: 'first' });
    useMessageQueueStore.getState().enqueue(A, { text: 'second' });
    useMessageQueueStore.getState().enqueue(A, { text: 'third' });
    const queue = useMessageQueueStore.getState().getSessionQueue(A).pending;
    const removed = queue[1];
    useMessageQueueStore.getState().remove(A, removed.id);

    createQueueUndoAction({ sessionId: A, removed, index: 1 })();

    expect(
      useMessageQueueStore
        .getState()
        .getSessionQueue(A)
        .pending.map((m) => m.text),
    ).toEqual(['first', 'second', 'third']);
  });

  test('an entry removed from `failed` (index -1 in pending) is appended, not reordered', () => {
    // `handleRemoveQueuedMessage` passes the index it found in `pending`, which
    // is -1 for a failed entry. Reordering to -1 would clamp it to the head and
    // jump the queue.
    // `claimNext` claims `pending[0]`, so the doomed one has to be enqueued
    // first for the failure to land on it.
    useMessageQueueStore.getState().enqueue(A, { text: 'doomed' });
    useMessageQueueStore.getState().enqueue(A, { text: 'already waiting' });
    useMessageQueueStore.getState().claimNext(A);
    useMessageQueueStore.getState().fail(A, 'network down');
    const failed = useMessageQueueStore.getState().getSessionQueue(A).failed[0];
    useMessageQueueStore.getState().remove(A, failed.id);

    createQueueUndoAction({ sessionId: A, removed: failed, index: -1 })();

    expect(
      useMessageQueueStore
        .getState()
        .getSessionQueue(A)
        .pending.map((m) => m.text),
    ).toEqual(['already waiting', 'doomed']);
  });

  test('everything the entry carried still comes back — this is the same restore path', () => {
    useMessageQueueStore.getState().enqueue(A, FULL);
    const queued = useMessageQueueStore.getState().getSessionQueue(A).pending[0];
    useMessageQueueStore.getState().remove(A, queued.id);

    createQueueUndoAction({ sessionId: A, removed: queued, index: 0 })();

    const after = useMessageQueueStore.getState().getSessionQueue(A).pending[0];
    expect(after.command).toEqual(FULL.command);
    expect(after.text).toBe(FULL.text);
  });
});

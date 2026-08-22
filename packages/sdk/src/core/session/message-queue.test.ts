import { describe, expect, test } from 'bun:test';

import * as messageQueue from './message-queue';
import {
  claimNext,
  completeInFlight,
  createSessionQueue,
  editQueued,
  enqueue,
  failInFlight,
  removeQueued,
  reorderQueued,
  retryFailed,
  type QueuedMessageInput,
  type SessionQueue,
} from './message-queue';

/**
 * Ids and timestamps are inputs, never generated here — the module has no
 * `Date.now()` and no `crypto`, which is what makes every assertion below
 * exact rather than approximate.
 */
function item(id: string, text = id) {
  return { id, clientMessageId: `cm_${id}`, text, createdAt: 0 };
}

/** A queue holding `ids` in order, nothing in flight. */
function queueOf(...ids: string[]): SessionQueue {
  return ids.reduce((state, id) => enqueue(state, item(id)), createSessionQueue());
}

/** A queue built from full inputs, for the agent/model/variant cases. */
function queueOfInputs(...inputs: QueuedMessageInput[]): SessionQueue {
  return inputs.reduce((state, input) => enqueue(state, input), createSessionQueue());
}

/**
 * THE contract of a deprecated published subpath: the names that shipped, and
 * nothing else.
 *
 * `@kortix/sdk/message-queue` is on npm as of 0.12.8, so this module cannot be
 * deleted with the browser queue it used to drive — an external consumer's
 * import must keep resolving. What it CAN do is stop growing: `claimBatch` and
 * `inFlightIdsOf` were added after 0.12.8, are absent from the published
 * `.d.ts`, and belonged to the batch drain that Kortix no longer has.
 */
const PUBLISHED_0_12_8 = [
  'claimNext',
  'completeInFlight',
  'createSessionQueue',
  'editQueued',
  'enqueue',
  'failInFlight',
  'removeQueued',
  'reorderQueued',
  'retryFailed',
] as const;

describe('the 0.12.8 deprecation shim', () => {
  test('exports exactly what 0.12.8 published, and nothing added since', () => {
    expect(Object.keys(messageQueue).sort()).toEqual([...PUBLISHED_0_12_8].sort());
  });

  test('says it is deprecated, in the banner every consumer reads first', async () => {
    const source = Bun.file(new URL('./message-queue.ts', import.meta.url).pathname);
    // The header only. A `@deprecated` note buried 300 lines down is not a
    // banner, and slicing keeps a failure readable instead of dumping the file.
    const header = (await source.text()).slice(0, 1200);

    expect(header).toContain('@deprecated');
    // The replacement has to be NAMED, or the banner is only an insult.
    expect(header).toContain('/prompts');
  });
});

describe('createSessionQueue', () => {
  test('starts empty with nothing in flight', () => {
    expect(createSessionQueue()).toEqual({
      pending: [],
      failed: [],
      inFlightId: null,
      inFlightIds: [],
    });
  });
});

describe('enqueue', () => {
  test('appends to the tail', () => {
    const queue = queueOf('a', 'b');

    expect(queue.pending.map((m) => m.id)).toEqual(['a', 'b']);
  });

  test('appends even while something is in flight', () => {
    // Never at the head. Jumping the line is an explicit user action, not a
    // side effect of timing.
    const claimed = claimNext(queueOf('a')).state;
    const next = enqueue(claimed, item('b'));

    expect(next.pending.map((m) => m.id)).toEqual(['a', 'b']);
    expect(next.inFlightId).toBe('a');
  });

  test('starts at zero attempts', () => {
    expect(queueOf('a').pending[0].attempts).toBe(0);
  });

  test('carries agent, model and variant verbatim', () => {
    const input: QueuedMessageInput = {
      ...item('a'),
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude' },
      variant: 'thinking',
    };
    const queue = enqueue(createSessionQueue(), input);

    expect(queue.pending[0].agent).toBe('build');
    expect(queue.pending[0].model).toEqual({ providerID: 'anthropic', modelID: 'claude' });
    expect(queue.pending[0].variant).toBe('thinking');
  });

  test('does not mutate the input state', () => {
    const before = createSessionQueue();
    enqueue(before, item('a'));

    expect(before.pending).toEqual([]);
  });
});

describe('claimNext', () => {
  test('claims the head and records it in flight in one transition', () => {
    const { state, claimed } = claimNext(queueOf('a', 'b'));

    expect(claimed?.id).toBe('a');
    expect(state.inFlightId).toBe('a');
    expect(state.inFlightIds).toEqual(['a']);
    // The claimed item stays visible at the head until it completes or fails.
    expect(state.pending.map((m) => m.id)).toEqual(['a', 'b']);
  });

  test('a second claim on the returned state claims nothing', () => {
    // The whole point: two drains entering the same tick send one message,
    // not two.
    const first = claimNext(queueOf('a', 'b'));
    const second = claimNext(first.state);

    expect(second.claimed).toBeUndefined();
    expect(second.state).toBe(first.state);
  });

  test('claims nothing from an empty queue', () => {
    const { state, claimed } = claimNext(createSessionQueue());

    expect(claimed).toBeUndefined();
    expect(state).toEqual(createSessionQueue());
  });

  test('counts the attempt', () => {
    expect(claimNext(queueOf('a')).claimed?.attempts).toBe(1);
  });

  test('honours a state that predates `inFlightIds`', () => {
    // A consumer that persisted the older shape rehydrates without the field.
    // Reading `?? []` instead would unlock a message that is on the wire.
    const legacy: SessionQueue = { ...queueOf('a', 'b'), inFlightId: 'a', inFlightIds: undefined };

    expect(claimNext(legacy).claimed).toBeUndefined();
    expect(removeQueued(legacy, 'a')).toBe(legacy);
  });

  test('does not mutate the input state', () => {
    const before = queueOf('a');
    const snapshot = structuredClone(before);
    claimNext(before);

    expect(before).toEqual(snapshot);
  });
});

describe('completeInFlight', () => {
  test('removes the delivered item and frees the queue', () => {
    const next = completeInFlight(claimNext(queueOf('a', 'b')).state);

    expect(next.pending.map((m) => m.id)).toEqual(['b']);
    expect(next.inFlightId).toBeNull();
    expect(next.inFlightIds).toEqual([]);
    expect(next.failed).toEqual([]);
  });

  test('leaves a message queued after the head was claimed', () => {
    const claimed = claimNext(queueOf('a', 'b')).state;
    const next = completeInFlight(enqueue(claimed, item('c')));

    expect(next.pending.map((m) => m.id)).toEqual(['b', 'c']);
  });

  test('is a no-op when nothing is in flight', () => {
    const before = queueOf('a');

    expect(completeInFlight(before)).toBe(before);
  });
});

describe('failInFlight', () => {
  test('moves the item to failed and leaves the rest drainable', () => {
    // This is the lockout that got the queue deleted in `67749c1f76`: a failed
    // head item blocked every subsequent send. It must not recur.
    const failed = failInFlight(claimNext(queueOf('a', 'b')).state, 'network down');

    expect(failed.pending.map((m) => m.id)).toEqual(['b']);
    expect(failed.failed.map((m) => m.id)).toEqual(['a']);
    expect(failed.failed[0].lastError).toBe('network down');
    expect(failed.inFlightId).toBeNull();
    expect(failed.inFlightIds).toEqual([]);

    const { claimed } = claimNext(failed);
    expect(claimed?.id).toBe('b');
  });

  test('is a no-op when nothing is in flight', () => {
    const before = queueOf('a');

    expect(failInFlight(before, 'boom')).toBe(before);
  });
});

describe('retryFailed', () => {
  test('returns a failed item to the tail of pending', () => {
    const failed = failInFlight(claimNext(queueOf('a')).state, 'boom');
    const withMore = enqueue(failed, item('b'));
    const retried = retryFailed(withMore, 'a');

    expect(retried.pending.map((m) => m.id)).toEqual(['b', 'a']);
    expect(retried.failed).toEqual([]);
  });

  test('clears the previous error so a retry is not shown as still failing', () => {
    const failed = failInFlight(claimNext(queueOf('a')).state, 'boom');

    expect(retryFailed(failed, 'a').pending[0].lastError).toBeUndefined();
  });

  test('is a no-op for an unknown id', () => {
    const before = queueOf('a');

    expect(retryFailed(before, 'nope')).toBe(before);
  });
});

describe('removeQueued', () => {
  test('drops a pending item', () => {
    expect(removeQueued(queueOf('a', 'b'), 'a').pending.map((m) => m.id)).toEqual(['b']);
  });

  test('drops a failed item', () => {
    const failed = failInFlight(claimNext(queueOf('a')).state, 'boom');

    expect(removeQueued(failed, 'a').failed).toEqual([]);
  });

  test('refuses to drop the in-flight item — it is already on the wire', () => {
    const claimed = claimNext(queueOf('a', 'b')).state;

    expect(removeQueued(claimed, 'a')).toBe(claimed);
  });

  test('is a no-op for an unknown id', () => {
    const before = queueOf('a');

    expect(removeQueued(before, 'nope')).toBe(before);
  });
});

describe('editQueued', () => {
  test('replaces the text of a pending item', () => {
    expect(editQueued(queueOf('a'), 'a', 'rewritten').pending[0].text).toBe('rewritten');
  });

  test('refuses to edit the in-flight item', () => {
    const claimed = claimNext(queueOf('a')).state;

    expect(editQueued(claimed, 'a', 'too late')).toBe(claimed);
  });

  test('is a no-op for an unknown id, returning the same reference', () => {
    const before = queueOf('a');

    expect(editQueued(before, 'nope', 'x')).toBe(before);
  });
});

describe('reorderQueued', () => {
  test('moves an item to the target index', () => {
    expect(reorderQueued(queueOf('a', 'b', 'c'), 'c', 0).pending.map((m) => m.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  test('clamps a target beyond either end', () => {
    expect(reorderQueued(queueOf('a', 'b'), 'a', 9).pending.map((m) => m.id)).toEqual(['b', 'a']);
    expect(reorderQueued(queueOf('a', 'b'), 'b', -3).pending.map((m) => m.id)).toEqual(['b', 'a']);
  });

  test('cannot move an item into or past the in-flight slot', () => {
    const claimed = claimNext(queueOf('a', 'b', 'c')).state;
    const next = reorderQueued(claimed, 'c', 0);

    expect(next.pending.map((m) => m.id)).toEqual(['a', 'c', 'b']);
    expect(next.inFlightId).toBe('a');
  });

  test('cannot move the in-flight item itself', () => {
    const claimed = claimNext(queueOf('a', 'b')).state;

    expect(reorderQueued(claimed, 'a', 1)).toBe(claimed);
  });

  test('is a no-op for an unknown id', () => {
    const before = queueOf('a', 'b');

    expect(reorderQueued(before, 'nope', 0)).toBe(before);
  });

  test('does not mutate the input state', () => {
    const before = queueOf('a', 'b', 'c');
    const snapshot = structuredClone(before);
    reorderQueued(before, 'c', 0);

    expect(before).toEqual(snapshot);
  });
});

describe('queueOfInputs is exercised', () => {
  test('a queue built from full inputs claims its head', () => {
    const queue = queueOfInputs({ ...item('a') }, { ...item('b'), agent: 'plan' });

    expect(claimNext(queue).claimed?.id).toBe('a');
  });
});

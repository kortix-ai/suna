import { describe, expect, test } from 'bun:test';

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

describe('createSessionQueue', () => {
  test('starts empty with nothing in flight', () => {
    expect(createSessionQueue()).toEqual({ pending: [], failed: [], inFlightId: null });
  });
});

describe('enqueue', () => {
  test('appends in order', () => {
    expect(queueOf('a', 'b', 'c').pending.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  test('appends to the tail while an item is in flight — never jumps the line', () => {
    const claimed = claimNext(queueOf('a')).state;
    const next = enqueue(claimed, item('b'));

    expect(next.pending.map((m) => m.id)).toEqual(['a', 'b']);
    expect(next.inFlightId).toBe('a');
  });

  test('preserves agent, model and variant verbatim', () => {
    const model = { providerID: 'anthropic', modelID: 'claude-opus-5' };
    const next = enqueue(createSessionQueue(), {
      ...item('a'),
      agent: 'build',
      model,
      variant: 'thinking',
    });

    expect(next.pending[0].agent).toBe('build');
    expect(next.pending[0].model).toEqual(model);
    expect(next.pending[0].variant).toBe('thinking');
  });

  test('starts an item at zero attempts', () => {
    expect(queueOf('a').pending[0].attempts).toBe(0);
  });

  test('does not mutate the input state', () => {
    const before = queueOf('a');
    const snapshot = structuredClone(before);
    enqueue(before, item('b'));

    expect(before).toEqual(snapshot);
  });
});

describe('claimNext', () => {
  test('claims the head and records it in flight in one transition', () => {
    const { state, claimed } = claimNext(queueOf('a', 'b'));

    expect(claimed?.id).toBe('a');
    expect(state.inFlightId).toBe('a');
    // The claimed item stays visible at the head until it completes or fails.
    expect(state.pending.map((m) => m.id)).toEqual(['a', 'b']);
  });

  test('a second claim on the returned state claims nothing', () => {
    // The whole point: two drains entering the same tick send one message,
    // not two. The current inline queue guards with a ref written by a later
    // effect, so it reads one commit stale and can double-send.
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
    expect(next.failed).toEqual([]);
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

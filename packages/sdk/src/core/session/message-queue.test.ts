import { describe, expect, test } from 'bun:test';

import {
  claimBatch,
  claimNext,
  completeInFlight,
  createSessionQueue,
  editQueued,
  enqueue,
  failInFlight,
  inFlightIdsOf,
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

describe('inFlightIdsOf', () => {
  test('reads nothing from an idle queue', () => {
    expect(inFlightIdsOf(queueOf('a'))).toEqual([]);
  });

  test('reads the whole batch', () => {
    expect(inFlightIdsOf(claimBatch(queueOf('a', 'b')).state)).toEqual(['a', 'b']);
  });

  test('falls back to `inFlightId` on a state that predates the field', () => {
    // A host that persisted the older shape rehydrates without `inFlightIds`.
    // Reading `?? []` instead would unlock a message that is on the wire.
    const legacy: SessionQueue = { ...queueOf('a', 'b'), inFlightId: 'a', inFlightIds: undefined };

    expect(inFlightIdsOf(legacy)).toEqual(['a']);
    expect(removeQueued(legacy, 'a')).toBe(legacy);
  });
});

describe('claimBatch', () => {
  test('claims everything waiting, oldest first, in one transition', () => {
    // The whole point of the batch. Three messages typed during one turn go
    // out together on the next turn — not one turn each.
    const { state, claimed } = claimBatch(queueOf('a', 'b', 'c'));

    expect(claimed.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(state.inFlightIds).toEqual(['a', 'b', 'c']);
    // The claimed items stay visible until they complete or fail.
    expect(state.pending.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  test('reports the head as `inFlightId`, so single-item readers still work', () => {
    expect(claimBatch(queueOf('a', 'b')).state.inFlightId).toBe('a');
  });

  test('a second claim on the returned state claims nothing', () => {
    const first = claimBatch(queueOf('a', 'b'));
    const second = claimBatch(first.state);

    expect(second.claimed).toEqual([]);
    expect(second.state).toBe(first.state);
  });

  test('claims nothing from an empty queue', () => {
    const { state, claimed } = claimBatch(createSessionQueue());

    expect(claimed).toEqual([]);
    expect(state).toEqual(createSessionQueue());
  });

  test('counts an attempt on every claimed item', () => {
    expect(claimBatch(queueOf('a', 'b')).claimed.map((m) => m.attempts)).toEqual([1, 1]);
  });

  test('stops at the first message captured under a different model', () => {
    // `agent`/`model`/`variant` are captured at enqueue and sent verbatim. One
    // prompt carries one set of them, so a batch ends where they change; the
    // rest goes out on the turn after. Merging them would send a message under
    // a model the user did not pick for it.
    const opus = { providerID: 'anthropic', modelID: 'claude-opus-5' };
    const sonnet = { providerID: 'anthropic', modelID: 'claude-sonnet-5' };
    const { state, claimed } = claimBatch(
      queueOfInputs(
        { ...item('a'), model: opus },
        { ...item('b'), model: opus },
        { ...item('c'), model: sonnet },
      ),
    );

    expect(claimed.map((m) => m.id)).toEqual(['a', 'b']);
    expect(state.inFlightIds).toEqual(['a', 'b']);
  });

  test('stops at a change of agent or variant too', () => {
    expect(
      claimBatch(
        queueOfInputs({ ...item('a'), agent: 'build' }, { ...item('b'), agent: 'plan' }),
      ).claimed.map((m) => m.id),
    ).toEqual(['a']);

    expect(
      claimBatch(
        queueOfInputs({ ...item('a'), variant: 'thinking' }, { ...item('b'), variant: null }),
      ).claimed.map((m) => m.id),
    ).toEqual(['a']);
  });

  test('treats an unresolved capture as its own group', () => {
    // `undefined` means "resolve at send time" and `null` means "send none".
    // They are not interchangeable downstream, so they cannot share a prompt.
    expect(
      claimBatch(queueOfInputs({ ...item('a') }, { ...item('b'), agent: null })).claimed.map(
        (m) => m.id,
      ),
    ).toEqual(['a']);
  });

  test('does not mutate the input state', () => {
    const before = queueOf('a', 'b');
    const snapshot = structuredClone(before);
    claimBatch(before);

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

  test('removes every item of a delivered batch', () => {
    const next = completeInFlight(claimBatch(queueOf('a', 'b', 'c')).state);

    expect(next.pending).toEqual([]);
    expect(next.inFlightIds).toEqual([]);
    expect(next.inFlightId).toBeNull();
  });

  test('leaves a message queued after the batch was claimed', () => {
    const claimed = claimBatch(queueOf('a', 'b')).state;
    const next = completeInFlight(enqueue(claimed, item('c')));

    expect(next.pending.map((m) => m.id)).toEqual(['c']);
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

  test('sets aside the whole batch when the one prompt carrying it failed', () => {
    // One prompt carries the batch, so one failure is all of their failure.
    // Each keeps its own row in `failed` so the user can retry them
    // individually rather than losing three messages to one network blip.
    const failed = failInFlight(claimBatch(queueOf('a', 'b', 'c')).state, 'network down');

    expect(failed.pending).toEqual([]);
    expect(failed.failed.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(failed.failed.map((m) => m.lastError)).toEqual([
      'network down',
      'network down',
      'network down',
    ]);
    expect(failed.inFlightIds).toEqual([]);
  });

  test('leaves a message queued behind a failed batch drainable', () => {
    const claimed = claimBatch(queueOf('a', 'b')).state;
    const failed = failInFlight(enqueue(claimed, item('c')), 'boom');

    expect(claimBatch(failed).claimed.map((m) => m.id)).toEqual(['c']);
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

  test('refuses any item of an in-flight batch, not just its head', () => {
    const claimed = claimBatch(queueOf('a', 'b', 'c')).state;

    expect(removeQueued(claimed, 'b')).toBe(claimed);
    expect(removeQueued(claimed, 'c')).toBe(claimed);
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

  test('refuses any item of an in-flight batch', () => {
    const claimed = claimBatch(queueOf('a', 'b')).state;

    expect(editQueued(claimed, 'b', 'too late')).toBe(claimed);
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

  test('cannot move an item into or past an in-flight batch', () => {
    const claimed = enqueue(claimBatch(queueOf('a', 'b')).state, item('c'));
    const next = reorderQueued(claimed, 'c', 0);

    expect(next.pending.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(next.inFlightIds).toEqual(['a', 'b']);
  });

  test('cannot move a message that is part of an in-flight batch', () => {
    const claimed = enqueue(claimBatch(queueOf('a', 'b')).state, item('c'));

    expect(reorderQueued(claimed, 'b', 2)).toBe(claimed);
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

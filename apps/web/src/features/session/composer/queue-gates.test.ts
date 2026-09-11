import { describe, expect, test } from 'bun:test';
import en from '../../../../translations/en.json';
import {
  QUEUE_COLLAPSE_AT_DEPTH,
  QUEUE_FULL_HINT_KEY,
  QUEUE_MAX_DEPTH,
  nextQueueOrderAfterMoveToTop,
  queueDrainBlockedReason,
  queueHeaderAction,
  queueHeaderLabelKey,
  queueIsAtCap,
  queueStartsCollapsed,
} from './queue-gates';

/**
 * The gates return CATALOG KEYS; the words live in `hardcodedUi.i18nComplete`
 * because this list ships in nine locales. Resolving through the real English
 * catalog keeps both halves pinned in one assertion — the ranking that picks
 * the key, and the sentence that key actually names. A key that stops existing
 * fails here as `undefined`.
 */
const CATALOG = en.hardcodedUi.i18nComplete as Record<string, string>;
const headerLabel = (input: Parameters<typeof queueHeaderLabelKey>[0]) =>
  CATALOG[queueHeaderLabelKey(input)];

describe('queueIsAtCap', () => {
  test('under the cap is not blocked', () => {
    expect(queueIsAtCap(QUEUE_MAX_DEPTH - 1)).toBe(false);
  });

  test('at the cap is blocked', () => {
    expect(queueIsAtCap(QUEUE_MAX_DEPTH)).toBe(true);
  });

  test('past the cap stays blocked', () => {
    expect(queueIsAtCap(QUEUE_MAX_DEPTH + 1)).toBe(true);
  });

  test('the hint names the two ways out — send or remove — not a vague "full"', () => {
    expect(CATALOG[QUEUE_FULL_HINT_KEY]).toBe('Queue full — send or remove one');
  });
});

describe('queueDrainBlockedReason', () => {
  /**
   * Precedence, highest first: paused -> error -> awaiting_input -> run_active
   * -> null. Each case below isolates one rung; the two after it prove a
   * higher rung still wins when a lower one is also true.
   */
  test('idle with no pause drains freely', () => {
    expect(queueDrainBlockedReason({ runState: 'idle', paused: false })).toBeNull();
  });

  test('a running turn blocks the drain', () => {
    expect(queueDrainBlockedReason({ runState: 'running', paused: false })).toBe('run_active');
  });

  test('stopping is still run_active — the turn has not ended yet', () => {
    expect(queueDrainBlockedReason({ runState: 'stopping', paused: false })).toBe('run_active');
  });

  test('a structured question blocks ahead of a plain running state', () => {
    expect(queueDrainBlockedReason({ runState: 'awaiting_input', paused: false })).toBe(
      'awaiting_input',
    );
  });

  test('a failed run blocks ahead of awaiting_input', () => {
    expect(queueDrainBlockedReason({ runState: 'error', paused: false })).toBe('error');
  });

  test('paused blocks even from idle', () => {
    expect(queueDrainBlockedReason({ runState: 'idle', paused: true })).toBe('paused');
  });

  /**
   * paused WINS over error. A user who pressed Stop mid-turn (which can leave
   * runState at 'error') gets the Stop wording, not "last run failed" —
   * otherwise the row that tells them how to get moving again (resume) never
   * shows.
   */
  test('paused wins over error', () => {
    expect(queueDrainBlockedReason({ runState: 'error', paused: true })).toBe('paused');
  });

  test('paused wins over awaiting_input', () => {
    expect(queueDrainBlockedReason({ runState: 'awaiting_input', paused: true })).toBe('paused');
  });

  test('paused wins over run_active', () => {
    expect(queueDrainBlockedReason({ runState: 'running', paused: true })).toBe('paused');
  });
});

describe('queueHeaderLabelKey', () => {
  test('idle: just the count', () => {
    expect(headerLabel({ runState: 'idle', paused: false })).toBe('{count} queued');
  });

  test('running: runs after this turn', () => {
    expect(headerLabel({ runState: 'running', paused: false })).toBe(
      '{count} queued · runs after this turn',
    );
  });

  test('stopping reads the same as running — the turn is still live', () => {
    expect(headerLabel({ runState: 'stopping', paused: false })).toBe(
      '{count} queued · runs after this turn',
    );
  });

  test('awaiting_input: waiting on your approval', () => {
    expect(headerLabel({ runState: 'awaiting_input', paused: false })).toBe(
      '{count} queued · waiting on your approval',
    );
  });

  test('error: last run failed', () => {
    expect(headerLabel({ runState: 'error', paused: false })).toBe(
      '{count} queued · last run failed',
    );
  });

  test('paused: paused', () => {
    expect(headerLabel({ runState: 'idle', paused: true })).toBe('{count} queued · paused');
  });

  /** Same precedence as queueDrainBlockedReason: paused beats error in the label too. */
  test('paused wins over error in the label', () => {
    expect(headerLabel({ runState: 'error', paused: true })).toBe('{count} queued · paused');
  });

  test('paused wins over awaiting_input in the label', () => {
    expect(headerLabel({ runState: 'awaiting_input', paused: true })).toBe(
      '{count} queued · paused',
    );
  });

  test('every reason maps to a key the catalog actually holds', () => {
    // The whole point of the indirection: a key with no entry renders the raw
    // id — `text046a3f8e6983` — into the header, which is what a hand-written
    // re-key pass has already shipped once elsewhere in this app.
    for (const paused of [true, false]) {
      for (const runState of ['idle', 'running', 'stopping', 'awaiting_input', 'error'] as const) {
        expect(headerLabel({ runState, paused }), `${runState}/${paused}`).toBeString();
      }
    }
  });
});

describe('queueHeaderAction', () => {
  test('paused offers resume', () => {
    expect(queueHeaderAction({ runState: 'idle', paused: true })).toBe('resume');
  });

  test('error without pause offers retry', () => {
    expect(queueHeaderAction({ runState: 'error', paused: false })).toBe('retry');
  });

  /** paused still wins the action too: resume, not retry, gets the failed run moving again. */
  test('paused wins over error for the action', () => {
    expect(queueHeaderAction({ runState: 'error', paused: true })).toBe('resume');
  });

  test('idle with no pause offers nothing', () => {
    expect(queueHeaderAction({ runState: 'idle', paused: false })).toBeNull();
  });

  test('running offers nothing', () => {
    expect(queueHeaderAction({ runState: 'running', paused: false })).toBeNull();
  });
});

describe('queueStartsCollapsed', () => {
  /**
   * ALWAYS collapsed, at any depth. It used to open expanded below
   * `QUEUE_COLLAPSE_AT_DEPTH`, which pushed the composer down by a row for
   * every prompt parked — the box you are typing in moved while you typed.
   * The collapsed row shows the prompt that goes next, which is the only one
   * worth a line when the list is shut.
   */
  test('a queue opens collapsed at every depth', () => {
    expect(queueStartsCollapsed(0)).toBe(true);
    expect(queueStartsCollapsed(1)).toBe(true);
    expect(queueStartsCollapsed(QUEUE_COLLAPSE_AT_DEPTH - 1)).toBe(true);
    expect(queueStartsCollapsed(QUEUE_COLLAPSE_AT_DEPTH)).toBe(true);
    expect(queueStartsCollapsed(QUEUE_MAX_DEPTH)).toBe(true);
  });
});


describe('nextQueueOrderAfterMoveToTop', () => {
  test('moves the target id to index 0, keeping the others in relative order', () => {
    expect(nextQueueOrderAfterMoveToTop(['a', 'b', 'c', 'd'], 'c')).toEqual(['c', 'a', 'b', 'd']);
  });

  test('moving the last id to the top', () => {
    expect(nextQueueOrderAfterMoveToTop(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  /**
   * Already at index 0 returns null, not a copy of the same array. A caller
   * that reorders on every non-null result would otherwise fire a no-op
   * reorder request for a row that never moved.
   */
  test('already at the top is a no-op: null, not an equivalent array', () => {
    expect(nextQueueOrderAfterMoveToTop(['a', 'b', 'c'], 'a')).toBeNull();
  });

  test('an id absent from the list is a no-op', () => {
    expect(nextQueueOrderAfterMoveToTop(['a', 'b', 'c'], 'z')).toBeNull();
  });

  test('does not mutate the input array', () => {
    const input = ['a', 'b', 'c'];
    nextQueueOrderAfterMoveToTop(input, 'b');
    expect(input).toEqual(['a', 'b', 'c']);
  });
});

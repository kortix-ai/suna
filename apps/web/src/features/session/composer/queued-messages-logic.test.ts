import { describe, expect, test } from 'bun:test';

import en from '../../../../translations/en.json';
import { QUEUE_FULL_HINT_KEY } from './queue-gates';
import {
  canDuplicateRow,
  canMoveToTop,
  DUPLICATE_ATTACHMENTS_HINT_KEY,
  DUPLICATE_CAPPED_HINT_KEY,
  QUEUE_GROWTH_ANNOUNCEMENT_KEY,
  QUEUE_MOVE_ANNOUNCEMENT_KEY,
  duplicateBlockedHintKey,
  nextFocusAfterRemove,
  queueGrowthDepth,
  reorderTargetIndex,
  reorderToPendingIndex,
  runsNextId,
} from './queued-messages-logic';

/** The words these keys name, resolved through the real English catalog — see
 *  the note in `queue-gates.test.ts`. */
const CATALOG = en.hardcodedUi.i18nComplete as Record<string, string>;

describe('reorderTargetIndex', () => {
  test('moves within the list', () => {
    expect(reorderTargetIndex(2, 'up', 4, 0)).toBe(1);
    expect(reorderTargetIndex(1, 'down', 4, 0)).toBe(2);
  });

  test('returns null at the ends instead of wrapping', () => {
    // Wrapping would silently send the message the user was demoting.
    expect(reorderTargetIndex(0, 'up', 4, 0)).toBeNull();
    expect(reorderTargetIndex(3, 'down', 4, 0)).toBeNull();
  });

  test('respects the floor set by an in-flight item', () => {
    // Index 0 is already sending. Nothing may move into or above it.
    expect(reorderTargetIndex(1, 'up', 4, 1)).toBeNull();
    expect(reorderTargetIndex(2, 'up', 4, 1)).toBe(1);
  });

  test('returns null for an index outside the list', () => {
    expect(reorderTargetIndex(-1, 'up', 4, 0)).toBeNull();
    expect(reorderTargetIndex(9, 'down', 4, 0)).toBeNull();
  });
});

describe('reorderToPendingIndex', () => {
  test('maps a visible slot to the full pending array', () => {
    // 'a' and 'b' are in flight and hidden; visible list is c, d, e.
    const pending = ['a', 'b', 'c', 'd', 'e'];
    const visible = ['c', 'd', 'e'];
    // Moving 'd' to slot 0 lands where 'c' sits in the FULL array: 2, not 0.
    expect(reorderToPendingIndex(visible, pending, 'd', 0)).toBe(2);
    expect(reorderToPendingIndex(visible, pending, 'd', 2)).toBe(4);
  });

  test('maps a multi-slot drag, both directions', () => {
    const pending = ['a', 'b', 'c', 'd'];
    // Dragging 'a' to the last slot targets where 'd' sits.
    expect(reorderToPendingIndex(pending, pending, 'a', 3)).toBe(3);
    expect(reorderToPendingIndex(pending, pending, 'd', 0)).toBe(0);
  });

  test('returns null for a no-op or out-of-range slot', () => {
    const pending = ['a', 'b', 'c'];
    expect(reorderToPendingIndex(pending, pending, 'a', 0)).toBeNull();
    expect(reorderToPendingIndex(pending, pending, 'a', -1)).toBeNull();
    expect(reorderToPendingIndex(pending, pending, 'c', 3)).toBeNull();
  });

  test('returns null for a row that is not visible', () => {
    // An in-flight row cannot move, however the call was reached.
    expect(reorderToPendingIndex(['b', 'c'], ['a', 'b', 'c'], 'a', 1)).toBeNull();
  });
});

describe('nextFocusAfterRemove', () => {
  test('moves focus to the row that takes the removed slot', () => {
    expect(nextFocusAfterRemove(['a', 'b', 'c'], 1)).toBe('c');
  });

  test('falls back to the previous row when the last one goes', () => {
    expect(nextFocusAfterRemove(['a', 'b', 'c'], 2)).toBe('b');
  });

  test('returns null when the queue is now empty', () => {
    // Nothing to focus — the caller returns focus to the composer.
    expect(nextFocusAfterRemove(['a'], 0)).toBeNull();
  });

  test('returns null for an index outside the list', () => {
    expect(nextFocusAfterRemove(['a', 'b'], 5)).toBeNull();
  });
});

describe('runsNextId', () => {
  test('marks the first row when nothing is parked or in flight', () => {
    expect(runsNextId([{ id: 'a' }, { id: 'b' }], [])).toBe('a');
  });

  test('skips rows already on the wire', () => {
    // An in-flight row left the queue minutes ago. Calling it "runs next"
    // describes the past, and the row the user actually needs to find is the
    // first one still under their control.
    expect(runsNextId([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['a', 'b'])).toBe('c');
  });

  test('skips parked rows', () => {
    expect(runsNextId([{ id: 'a', parked: true }, { id: 'b' }], [])).toBe('b');
  });

  test('marks nothing when every row is parked', () => {
    // The drain would skip all of them, so there is no next row to name.
    expect(runsNextId([{ id: 'a', parked: true }, { id: 'b', parked: true }], [])).toBeNull();
  });

  test('marks nothing when every row is on the wire', () => {
    expect(runsNextId([{ id: 'a' }, { id: 'b' }], ['a', 'b'])).toBeNull();
  });

  test('marks nothing in an empty queue', () => {
    expect(runsNextId([], [])).toBeNull();
  });
});

describe('canMoveToTop', () => {
  test('a row below the top can be promoted', () => {
    expect(canMoveToTop(['a', 'b', 'c'], 'c')).toBe(true);
  });

  test('the row already at the top cannot', () => {
    // Same authority the reorder itself uses: if the promote would produce no
    // new order, the menu must not offer it.
    expect(canMoveToTop(['a', 'b', 'c'], 'a')).toBe(false);
  });

  test('a row that is not in the list cannot', () => {
    expect(canMoveToTop(['a', 'b'], 'zz')).toBe(false);
  });
});

describe('queueGrowthDepth', () => {
  test('names the position of the row that was just parked', () => {
    // A new row lands at the end, so the new depth IS its position.
    expect(queueGrowthDepth(2, 3)).toBe(3);
  });

  test('says nothing when the queue shrank', () => {
    // A removal and a drain are both already visible where they happened.
    expect(queueGrowthDepth(3, 2)).toBeNull();
  });

  test('says nothing when the depth did not change', () => {
    // An edit or a reorder changes the rows, not the count — the reorder has
    // its own announcement, and this one would double it.
    expect(queueGrowthDepth(3, 3)).toBeNull();
  });

  test('announces the first row of an empty queue', () => {
    expect(queueGrowthDepth(0, 1)).toBe(1);
  });

  test('the two live-region sentences are in the catalog, with both placeholders', () => {
    // A live region is the ONE surface a sighted reviewer never sees, so a
    // missing key here ships the raw id to a screen reader and nothing else
    // reports it.
    expect(CATALOG[QUEUE_GROWTH_ANNOUNCEMENT_KEY]).toBe(
      'Message queued, position {position} of {total}.',
    );
    expect(CATALOG[QUEUE_MOVE_ANNOUNCEMENT_KEY]).toBe(
      'Moved to position {position} of {total}',
    );
  });
});

describe('canDuplicateRow', () => {
  // 2000 is PROMPT_TEXT_PREVIEW_CHARS in
  // apps/api/src/projects/session-lifecycle/prompt-parts.ts — the server
  // slices `text` to it before the row is ever listed.
  const capped = 'x'.repeat(2000);

  test('an ordinary row copies', () => {
    expect(canDuplicateRow({ text: 'ship it' })).toBe(true);
  });

  test('a row whose text is the server preview does not', () => {
    // The copy would be the first 2000 characters of what the user wrote, and
    // nothing on screen would say so.
    expect(canDuplicateRow({ text: capped })).toBe(false);
  });

  test('one character under the cap still does not', () => {
    // A message that lands exactly on the boundary is indistinguishable from
    // one that was cut, and `promptTextMatches` already reads it that way.
    expect(canDuplicateRow({ text: 'x'.repeat(1999) })).toBe(false);
  });

  test('two characters under the cap does', () => {
    expect(canDuplicateRow({ text: 'x'.repeat(1998) })).toBe(true);
  });

  test('a row with files does not, however short its text', () => {
    // The list holds their NAMES. The parts come back only in the DELETE
    // response, which a copy must not issue — so the copy would be the words
    // with none of the files.
    expect(canDuplicateRow({ text: 'see the screenshot', attachmentCount: 1 })).toBe(false);
  });

  test('an explicit zero attachments copies', () => {
    expect(canDuplicateRow({ text: 'ship it', attachmentCount: 0 })).toBe(true);
  });
});

describe('duplicateBlockedHintKey', () => {
  const capped = 'x'.repeat(2000);

  test('says nothing for a row that copies faithfully', () => {
    expect(duplicateBlockedHintKey({ text: 'ship it' }, false)).toBeNull();
  });

  test('names the files', () => {
    expect(CATALOG[duplicateBlockedHintKey({ text: 'ship it', attachmentCount: 2 }, false)!]).toBe(
      "Can't copy attachments",
    );
    expect(duplicateBlockedHintKey({ text: 'ship it', attachmentCount: 2 }, false)).toBe(
      DUPLICATE_ATTACHMENTS_HINT_KEY,
    );
  });

  test('names the length', () => {
    expect(CATALOG[duplicateBlockedHintKey({ text: capped }, false)!]).toBe(
      'Too long to copy faithfully',
    );
    expect(duplicateBlockedHintKey({ text: capped }, false)).toBe(DUPLICATE_CAPPED_HINT_KEY);
  });

  test('the cap outranks the row itself', () => {
    // At the cap NOTHING duplicates. Naming the row's own problem would send
    // the user off editing a message when the queue is what needs draining.
    expect(duplicateBlockedHintKey({ text: capped, attachmentCount: 3 }, true)).toBe(
      QUEUE_FULL_HINT_KEY,
    );
  });

  test('the cap blocks a row that would otherwise copy', () => {
    expect(duplicateBlockedHintKey({ text: 'ship it' }, true)).toBe(QUEUE_FULL_HINT_KEY);
  });

  test('agrees with the predicate on every row below the cap', () => {
    // The menu reads `disabled` from this hint alone, so a hint that said
    // nothing for a row `canDuplicateRow` refuses would ship the lossy copy
    // the predicate exists to prevent.
    const rows = [
      { text: 'ship it' },
      { text: capped },
      { text: 'x'.repeat(1999) },
      { text: 'x'.repeat(1998) },
      { text: 'ship it', attachmentCount: 1 },
      { text: 'ship it', attachmentCount: 0 },
    ];
    for (const row of rows) {
      expect(duplicateBlockedHintKey(row, false) === null, JSON.stringify(row)).toBe(
        canDuplicateRow(row),
      );
    }
  });
});

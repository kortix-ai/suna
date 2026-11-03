import { expect, test } from 'bun:test';
import {
  isCommentShortcut,
  nextSelectionOffer,
  selectionChipPosition,
  selectionOfferKey,
} from './artifact-selection-chip';

const frame = { width: 800, height: 600 };
const chip = { width: 100, height: 32 };

test('the chip sits centered above the selection, inside the frame', () => {
  expect(selectionChipPosition({ x: 300, y: 200, width: 200, height: 20 }, frame, chip)).toEqual({
    x: 350,
    y: 160,
  });
  // Near an edge it stays 8 px inside.
  expect(selectionChipPosition({ x: 0, y: 200, width: 40, height: 20 }, frame, chip)).toEqual({
    x: 8,
    y: 160,
  });
  expect(selectionChipPosition({ x: 760, y: 200, width: 40, height: 20 }, frame, chip)).toEqual({
    x: 692,
    y: 160,
  });
});

test('without room above, the chip goes below the selection', () => {
  expect(selectionChipPosition({ x: 300, y: 10, width: 200, height: 20 }, frame, chip)).toEqual({
    x: 350,
    y: 38,
  });
});

test('a selection scrolled out of view has no chip; one the page could not measure sits top center', () => {
  expect(selectionChipPosition({ x: 300, y: -40, width: 200, height: 20 }, frame, chip)).toBeNull();
  expect(selectionChipPosition({ x: 300, y: 600, width: 200, height: 20 }, frame, chip)).toBeNull();
  expect(selectionChipPosition(null, frame, chip)).toEqual({ x: 350, y: 8 });
});

test('the comment shortcut is ⌘⌥M or Ctrl+Alt+M by key position, never with Shift', () => {
  const key = { code: 'KeyM', altKey: true, metaKey: true, ctrlKey: false, shiftKey: false };
  expect(isCommentShortcut(key)).toBe(true);
  expect(isCommentShortcut({ ...key, metaKey: false, ctrlKey: true })).toBe(true);
  expect(isCommentShortcut({ ...key, shiftKey: true })).toBe(false);
  expect(isCommentShortcut({ ...key, altKey: false })).toBe(false);
  expect(isCommentShortcut({ ...key, metaKey: false })).toBe(false);
  expect(isCommentShortcut({ ...key, code: 'KeyN' })).toBe(false);
});

const offer = {
  state: 'candidate' as const,
  anchor: { type: 'text' as const, version: 'v', quote: 'Pricing', prefix: '', suffix: '' },
  rect: null,
};
const shown = () => false;

test('a dismissed offer stays hidden through a page layout; a new gesture offers it again', () => {
  const dismissed = selectionOfferKey(offer);
  // A scroll or resize in the page withdraws the offer ("moved"), then offers it at its new box.
  let state = nextSelectionOffer(null, true, dismissed, shown);
  expect(state).toEqual({ offer: null, dismissed });
  state = nextSelectionOffer(offer, false, state.dismissed, shown);
  expect(state).toEqual({ offer: null, dismissed });
  // A press in the page, or a selection that is gone: the dismissal is forgotten.
  state = nextSelectionOffer(null, false, state.dismissed, shown);
  expect(state).toEqual({ offer: null, dismissed: '' });
  expect(nextSelectionOffer(offer, false, state.dismissed, shown)).toEqual({
    offer,
    dismissed: '',
  });
});

test('another selection shows while one is dismissed; a hidden key never shows', () => {
  const other = { ...offer, anchor: { ...offer.anchor, quote: 'Plans' } };
  const dismissed = selectionOfferKey(offer);
  expect(nextSelectionOffer(other, false, dismissed, shown)).toEqual({ offer: other, dismissed });
  const tooLong = { state: 'too_long' as const, rect: null };
  expect(selectionOfferKey(tooLong)).toBe('too_long');
  expect(nextSelectionOffer(tooLong, false, '', (key) => key === 'too_long')).toEqual({
    offer: null,
    dismissed: '',
  });
});

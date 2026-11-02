import { expect, test } from 'bun:test';
import { isCommentShortcut, selectionChipPosition } from './artifact-selection-chip';

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

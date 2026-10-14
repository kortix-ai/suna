import { describe, expect, test } from 'bun:test';

import { isSlashFocusKey } from './use-slash-focus';

// bun test has no DOM here, so the key rule is tested directly; the hook only
// wires it to `window` and the search ref.
const onPage = { closest: () => null } as unknown as EventTarget;
const inField = { closest: () => ({}) } as unknown as EventTarget;
const key = (over: Partial<KeyboardEvent> = {}) =>
  ({ key: '/', metaKey: false, ctrlKey: false, altKey: false, target: onPage, ...over }) as KeyboardEvent;

describe('isSlashFocusKey', () => {
  test('a bare "/" on the page jumps to the search', () => {
    expect(isSlashFocusKey(key(), false)).toBe(true);
  });

  test('"/" typed into a text field stays a character', () => {
    expect(isSlashFocusKey(key({ target: inField }), false)).toBe(false);
  });

  test('an open dialog or menu keeps the keyboard', () => {
    expect(isSlashFocusKey(key(), true)).toBe(false);
  });

  test('modified "/" and other keys are ignored', () => {
    expect(isSlashFocusKey(key({ metaKey: true }), false)).toBe(false);
    expect(isSlashFocusKey(key({ ctrlKey: true }), false)).toBe(false);
    expect(isSlashFocusKey(key({ altKey: true }), false)).toBe(false);
    expect(isSlashFocusKey(key({ key: 'k' }), false)).toBe(false);
  });
});

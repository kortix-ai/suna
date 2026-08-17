import { describe, expect, test } from 'bun:test';

import { shouldCountEscape } from './esc-to-stop';

const base = {
  fromComposerEditor: false,
  defaultPrevented: false,
  suggestionMenuWasOpen: false,
  focusInOverlay: false,
  isComposing: false,
};

describe('shouldCountEscape', () => {
  test('counts a plain Escape outside the composer', () => {
    expect(shouldCountEscape({ ...base })).toBe(true);
  });

  test('outside the composer, a consumed Escape (defaultPrevented) does not count', () => {
    expect(shouldCountEscape({ ...base, defaultPrevented: true })).toBe(false);
  });

  /**
   * THE regression this module exists for: ProseMirror preventDefaults every
   * Escape inside the contenteditable, so `defaultPrevented` must not veto
   * composer-origin presses — triple-ESC has to work while typing in the
   * chat input, not only with focus elsewhere.
   */
  test('inside the composer, counts even though ProseMirror set defaultPrevented', () => {
    expect(
      shouldCountEscape({ ...base, fromComposerEditor: true, defaultPrevented: true }),
    ).toBe(true);
  });

  test('inside the composer, an Escape that dismissed an @ or / menu does not count', () => {
    expect(
      shouldCountEscape({
        ...base,
        fromComposerEditor: true,
        defaultPrevented: true,
        suggestionMenuWasOpen: true,
      }),
    ).toBe(false);
  });

  test('never counts while focus is inside an overlay (dialog/menu/popover)', () => {
    expect(shouldCountEscape({ ...base, focusInOverlay: true })).toBe(false);
    expect(
      shouldCountEscape({ ...base, focusInOverlay: true, fromComposerEditor: true }),
    ).toBe(false);
  });

  test('never counts an IME composition-cancel Escape', () => {
    expect(shouldCountEscape({ ...base, isComposing: true })).toBe(false);
    expect(
      shouldCountEscape({ ...base, isComposing: true, fromComposerEditor: true }),
    ).toBe(false);
  });
});

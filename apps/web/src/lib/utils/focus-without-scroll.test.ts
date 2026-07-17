import { describe, expect, test } from 'bun:test';
import { focusWithoutScroll } from './focus-without-scroll';

describe('focusWithoutScroll', () => {
  // The contract that fixes the stuck-sideways-layout bug: every programmatic
  // focus aimed at an animated panel layer must carry preventScroll, or the
  // browser scrolls the panel's overflow-hidden ancestors to reveal the
  // still-translated target and the offset sticks.
  test('always passes preventScroll', () => {
    let received: FocusOptions | undefined | 'never-called' = 'never-called';
    focusWithoutScroll({
      focus: (opts) => {
        received = opts;
      },
    });
    expect(received).toEqual({ preventScroll: true });
  });

  test('tolerates null, undefined, and focus-less targets', () => {
    expect(() => focusWithoutScroll(null)).not.toThrow();
    expect(() => focusWithoutScroll(undefined)).not.toThrow();
    expect(() => focusWithoutScroll({})).not.toThrow();
  });
});

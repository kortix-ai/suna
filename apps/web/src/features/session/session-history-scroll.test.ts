import { describe, expect, test } from 'bun:test';
import {
  captureTurnScrollAnchor,
  restoreTurnScrollAnchor,
} from './session-history-scroll';

function rect(top: number, bottom = top + 100): DOMRect {
  return { top, bottom } as DOMRect;
}

describe('session history scroll restoration', () => {
  test('does not move when older messages grow inside the anchored turn', () => {
    let turnTop = 120;
    const turn = {
      isConnected: true,
      getBoundingClientRect: () => rect(turnTop),
    } as HTMLElement;
    const container = {
      scrollTop: 0,
      contains: (node: Node) => node === turn,
      getBoundingClientRect: () => rect(0, 600),
      querySelectorAll: () => [turn],
    } as unknown as HTMLElement;

    const anchor = captureTurnScrollAnchor(container);
    turnTop = 120;

    expect(restoreTurnScrollAnchor(container, anchor)).toBe(true);
    expect(container.scrollTop).toBe(0);
  });

  test('keeps the anchored turn at the same viewport offset when older turns prepend', () => {
    let turnTop = 120;
    const turn = {
      isConnected: true,
      getBoundingClientRect: () => rect(turnTop),
    } as HTMLElement;
    const container = {
      scrollTop: 40,
      contains: (node: Node) => node === turn,
      getBoundingClientRect: () => rect(0, 600),
      querySelectorAll: () => [turn],
    } as unknown as HTMLElement;

    const anchor = captureTurnScrollAnchor(container);
    turnTop = 480;

    expect(restoreTurnScrollAnchor(container, anchor)).toBe(true);
    expect(container.scrollTop).toBe(400);
  });

  test('prepend of N px above the anchor produces exactly +N compensation', () => {
    let turnTop = 100;
    const turn = {
      isConnected: true,
      getBoundingClientRect: () => rect(turnTop),
    } as HTMLElement;
    const container = {
      scrollTop: 0,
      contains: (node: Node) => node === turn,
      getBoundingClientRect: () => rect(0, 600),
      querySelectorAll: () => [turn],
    } as unknown as HTMLElement;

    const anchor = captureTurnScrollAnchor(container);
    // 250px of older turns rendered above the anchor; scrollTop has not been
    // touched yet, so the browser's layout alone pushes the anchor's rect
    // down by exactly the inserted height.
    const N = 250;
    turnTop += N;

    expect(restoreTurnScrollAnchor(container, anchor)).toBe(true);
    expect(container.scrollTop).toBe(N);
  });

  test('user scrolling further up during the pull is preserved — restore adds only the prepended delta', () => {
    // Regression for the teleport bug: the reader scrolls up by 500px of
    // their own accord WHILE `loadOlder()` is in flight. A viewport-absolute
    // restore would snap them back toward the pre-pull position; the
    // content-space restore must add only the height actually inserted
    // above the anchor (250px here) and leave their 500px of scrolling
    // intact.
    let turnTop = 50;
    const turn = {
      isConnected: true,
      getBoundingClientRect: () => rect(turnTop),
    } as HTMLElement;
    const container = {
      scrollTop: 600,
      contains: (node: Node) => node === turn,
      getBoundingClientRect: () => rect(0, 600),
      querySelectorAll: () => [turn],
    } as unknown as HTMLElement;

    const anchor = captureTurnScrollAnchor(container); // contentTop = 50 + 600 = 650

    // Between capture and restore: 250px prepended above the anchor AND the
    // reader independently scrolled up 500px (scrollTop 600 -> 100). Final
    // DOM state reflects both: the anchor's content-space top increased by
    // exactly the inserted 250px (650 -> 900), regardless of the reader's
    // scrolling, and its rect.top is whatever that implies at the reader's
    // own final scrollTop.
    const inserted = 250;
    const userScrollDelta = 500;
    container.scrollTop = 600 - userScrollDelta; // reader's own scroll: 100
    turnTop = 650 + inserted - container.scrollTop; // = 800, consistent with contentTop 900

    expect(restoreTurnScrollAnchor(container, anchor)).toBe(true);
    // Preserves the reader's 500px scroll and adds only the 250px insertion:
    // 100 (reader's post-scroll position) + 250 (compensation) = 350.
    // NOT 600 + 250 = 850 (what a viewport-absolute restore would produce).
    expect(container.scrollTop).toBe(350);
  });

  test('anchor element removed from the DOM — restore is a no-op returning false', () => {
    const turn = {
      isConnected: false,
      getBoundingClientRect: () => rect(120),
    } as HTMLElement;
    const container = {
      scrollTop: 40,
      contains: () => false,
      getBoundingClientRect: () => rect(0, 600),
      querySelectorAll: () => [turn],
    } as unknown as HTMLElement;

    const anchor = { element: turn, contentTop: 160 };

    expect(restoreTurnScrollAnchor(container, anchor)).toBe(false);
    expect(container.scrollTop).toBe(40);
  });
});

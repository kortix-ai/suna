import { describe, expect, test } from 'bun:test';

import { jumpToTurn } from './jump-to-turn';

// A jump (⌘K / minimap) is READER intent to leave the end. Under the virtual
// list the target turn mounts on the way — a layout change — and
// `use-auto-scroll`'s settle puts a FOLLOWING viewport back at the end, so a
// jump that did not first leave "follow" is snapped back within a frame
// (seen live on the worktree: scrollTop 2689 → 2685 → 2689 in 120 ms).
// The rule: leave the end BEFORE scrolling, on both the virtual and the DOM path.
describe('jumpToTurn', () => {
  const scrollEl = () =>
    ({
      getBoundingClientRect: () => ({ top: 100 }),
      scrollTop: 500,
      scrollTo: (() => {}) as (o: ScrollToOptions) => void,
    }) as unknown as HTMLDivElement;

  test('virtual list: scrolls via the virtualizer, then leaves the end (same tick, before any settle)', () => {
    const calls: string[] = [];
    const done = jumpToTurn({
      id: 'u7',
      behavior: 'smooth',
      api: {
        scrollToTurn: (id, opts) => {
          calls.push(`api:${id}:${opts?.align}:${opts?.behavior}`);
          return true;
        },
      },
      scrollEl: scrollEl(),
      contentEl: { querySelector: () => null } as unknown as HTMLDivElement,
      leaveEnd: (why) => calls.push(`leave:${why}`),
    });
    expect(done).toBe(true);
    expect(calls).toEqual(['api:u7:start:smooth', 'leave:jump']);
  });

  test('flat list: leaves the end, then scrolls the element 24px under the top', () => {
    const calls: string[] = [];
    const el = scrollEl();
    (el as unknown as { scrollTo: (o: ScrollToOptions) => void }).scrollTo = (o) =>
      calls.push(`scrollTo:${o.top}:${o.behavior}`);
    const target = { getBoundingClientRect: () => ({ top: 340 }) };
    const done = jumpToTurn({
      id: 'u3',
      behavior: 'auto',
      api: null,
      scrollEl: el,
      contentEl: {
        querySelector: (sel: string) => (sel.includes('u3') ? target : null),
      } as unknown as HTMLDivElement,
      leaveEnd: (why) => calls.push(`leave:${why}`),
    });
    expect(done).toBe(true);
    // 340 − 100 + 500 − 24 = 716
    expect(calls).toEqual(['leave:jump', 'scrollTo:716:auto']);
  });

  test('virtualizer declines (unknown turn) → falls through to the DOM, still leaving the end first', () => {
    const calls: string[] = [];
    const el = scrollEl();
    (el as unknown as { scrollTo: (o: ScrollToOptions) => void }).scrollTo = (o) =>
      calls.push(`scrollTo:${o.top}`);
    const done = jumpToTurn({
      id: 'u9',
      behavior: 'smooth',
      api: { scrollToTurn: () => false },
      scrollEl: el,
      contentEl: {
        querySelector: () => ({ getBoundingClientRect: () => ({ top: 124 }) }),
      } as unknown as HTMLDivElement,
      leaveEnd: (why) => calls.push(`leave:${why}`),
    });
    expect(done).toBe(true);
    expect(calls).toEqual(['leave:jump', 'scrollTo:500']);
  });

  test('nothing to jump to: no scroll, and follow is NOT disturbed', () => {
    const calls: string[] = [];
    const done = jumpToTurn({
      id: 'gone',
      behavior: 'smooth',
      api: { scrollToTurn: () => false },
      scrollEl: scrollEl(),
      contentEl: { querySelector: () => null } as unknown as HTMLDivElement,
      leaveEnd: (why) => calls.push(`leave:${why}`),
    });
    expect(done).toBe(false);
    expect(calls).toEqual([]);
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { toLayoutRect } from './sliding-tab-indicator';

/**
 * Two measured defects, one function.
 *
 * 1. The pill sat 4.5px left and 3.7px narrow of its tab, forever, on the
 *    first open of any dialog. `Modal`/`Dialog` open with
 *    `data-[state=open]:zoom-in-95`; the measuring layout effect runs on the
 *    animation's first frames, and `getBoundingClientRect` reports TRANSFORMED
 *    geometry. `ResizeObserver` never corrects it, because a transform does not
 *    change layout size.
 *
 * 2. The fix for (1) divided by `offsetWidth`, which is rounded to a whole
 *    pixel. Every track is a fraction wide, so the "scale" was never exactly 1,
 *    and the pill drifted right and widened with its distance from the left
 *    edge. On the last tab its ring landed on the track's right edge while the
 *    first tab kept its gap.
 *
 * An unscaled rect is also snapped to device pixels, because the pill is moved
 * by a transform and the browser does not snap a transform the way it snaps
 * the tab's box.
 *
 * The component needs a DOM to render and this repo's `bun test` registers
 * none, so the geometry lives in `toLayoutRect`. The first test uses the
 * horizontal numbers a real browser reported on `/debug/tabs` at 1280px, 2x.
 */

const NO_SCROLL = { left: 0, top: 0 };

describe('sliding tab indicator measurement', () => {
  // The `/debug/tabs` strip with the last of three tabs active. The track is
  // 258.969px wide; `offsetWidth` reports 259, and dividing by that put the
  // pill 0.26px right and 0.12px wide of its tab.
  const track = { left: 29.4375, top: 53.5, width: 258.969, height: 33.125 };
  const lastTab = { left: 204.0625, top: 55.5, width: 82.34375, height: 29.125 };
  const trackLayout = { width: track.width, height: track.height };

  test('a fractional-width track puts the pill on the pixels its tab covers (2x)', () => {
    const rect = toLayoutRect(track, lastTab, trackLayout, NO_SCROLL, 2);

    // Whole device pixels: 349 and 165 at 2x. The browser reported the same.
    expect(rect).toEqual({ x: 174.5, y: 2, width: 82.5, height: 29 });
    // The pill's painted edges are the tab's own snapped edges.
    const origin = Math.round(track.left * 2) / 2;
    expect(origin + rect!.x).toBe(Math.round(lastTab.left * 2) / 2);
    expect(origin + rect!.x + rect!.width).toBe(Math.round((lastTab.left + lastTab.width) * 2) / 2);
  });

  test('snaps to whole CSS pixels at 1x', () => {
    expect(toLayoutRect(track, lastTab, trackLayout, NO_SCROLL, 1)).toEqual({
      x: 175,
      y: 2,
      width: 82,
      height: 29,
    });
  });

  test('divides an ancestor transform back out of both axes', () => {
    // A 400x36 track at `scale(0.95)`: every painted length is 95% of layout.
    const container = { left: 100, top: 50, width: 380, height: 34.2 };
    const tab = { left: 290, top: 51.9, width: 76, height: 30.4 };

    const rect = toLayoutRect(container, tab, { width: 400, height: 36 }, NO_SCROLL);

    expect(rect?.x).toBeCloseTo(200, 6);
    expect(rect?.y).toBeCloseTo(2, 6);
    expect(rect?.width).toBeCloseTo(80, 6);
    expect(rect?.height).toBeCloseTo(32, 6);
  });

  test('adds the scroll offset of an overflowing track', () => {
    const box = { left: 0, top: 0, width: 200, height: 30 };
    const tab = { left: -40, top: 2, width: 60, height: 26 };

    const rect = toLayoutRect(box, tab, { width: 200, height: 30 }, { left: 120, top: 0 });

    expect(rect?.x).toBe(80);
  });

  test('returns null while the container has no layout box', () => {
    // A `display:none` ancestor: the rects are zero and the computed size is
    // `auto`, which parses to NaN. Showing the pill from that would paint it at
    // 0x0 in the corner; the ResizeObserver fires for a real size change.
    const zero = { left: 0, top: 0, width: 0, height: 0 };
    expect(toLayoutRect(zero, zero, { width: NaN, height: NaN }, NO_SCROLL)).toBeNull();
    expect(toLayoutRect(zero, zero, { width: 0, height: 0 }, NO_SCROLL)).toBeNull();
  });

  test('still observes size and scroll, which the ratio does not replace', () => {
    // The normalization fixes transforms only. Layout changes (a font load, a
    // container resize, a horizontal scroll) still need these. No DOM here, so
    // this one is pinned against the source.
    const source = readFileSync(
      fileURLToPath(new URL('./sliding-tab-indicator.tsx', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('new ResizeObserver');
    expect(source).toContain("addEventListener('scroll', measure");
    expect(source).toContain("window.addEventListener('resize', measure)");
  });
});

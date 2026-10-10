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

    expect(rect).toEqual({ x: 174.5625, y: 2, width: 82.5, height: 29 });
    // The pill paints at the container's fractional origin plus the offset, so
    // its painted edges land on the tab's own snapped edges.
    expect(track.left + rect!.x).toBe(Math.round(lastTab.left * 2) / 2);
    expect(track.left + rect!.x + rect!.width).toBe(
      Math.round((lastTab.left + lastTab.width) * 2) / 2,
    );
  });

  test('snaps to whole CSS pixels at 1x', () => {
    expect(toLayoutRect(track, lastTab, trackLayout, NO_SCROLL, 1)).toEqual({
      // The track paints from 54 (53.5 snapped), so a 2.5 offset is a 2px gap.
      x: 174.5625,
      y: 2.5,
      width: 82,
      height: 29,
    });
  });

  // Measured on `/debug/tabs` at 2x with the track nudged to x = 29.25: the
  // browser painted the track from 29.5, but the first tab's chip from 31.25,
  // so the ring touched the track's left edge while the last tab's chip kept a
  // 2.25px gap on the right. Both ends must keep the same gap.
  test('the first and last chip keep the same gap on a fractional track (2x)', () => {
    const at = { left: 29.25, top: 52.75, width: 258.953125, height: 33.109375 };
    const layout = { width: at.width, height: at.height };
    const first = { left: 31.25, top: 54.75, width: 91, height: 29.109375 };
    const last = { left: 196.203125, top: 54.75, width: 90, height: 29.109375 };
    const snap = (v: number) => Math.round(v * 2) / 2;
    const paintedTrack = { left: snap(at.left), right: snap(at.left + at.width) };

    const a = toLayoutRect(at, first, layout, NO_SCROLL, 2)!;
    const b = toLayoutRect(at, last, layout, NO_SCROLL, 2)!;
    const leftGap = at.left + a.x - paintedTrack.left;
    const rightGap = paintedTrack.right - (at.left + b.x + b.width);

    expect(leftGap).toBe(2);
    expect(rightGap).toBe(2);
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

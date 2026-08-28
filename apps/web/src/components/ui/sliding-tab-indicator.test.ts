import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The sliding tab pill sat 4.5px left and 3.7px narrow of its tab, forever,
 * on the first open of any dialog.
 *
 * `Modal`/`Dialog` open with `data-[state=open]:zoom-in-95`. The measuring
 * layout effect runs on the animation's first frames, and
 * `getBoundingClientRect` reports TRANSFORMED geometry — so the pill was saved
 * at 95% of its tab. `ResizeObserver` cannot correct it: it reports border-box
 * layout size, which a transform never changes, so it never fires when the
 * animation lands on `scale(1)`. Only an unrelated re-measure (clicking a
 * different tab) happened to run unscaled.
 *
 * The component needs a DOM to render, and this repo's `bun test` registers
 * none, so the invariant is pinned against the source in the same style as
 * `project-icon-field.test.tsx`. The behaviour itself was measured in a real
 * browser at 1280px, before and after — see the commit.
 */

const source = readFileSync(
  fileURLToPath(new URL('./sliding-tab-indicator.tsx', import.meta.url)),
  'utf8',
);

describe('sliding tab indicator measurement', () => {
  test('divides the ancestor transform back out of both axes', () => {
    // `offsetWidth`/`offsetHeight` are layout values, immune to the transform,
    // which is what makes them a valid denominator for the rect ratio.
    expect(source).toContain('containerRect.width / container.offsetWidth');
    expect(source).toContain('containerRect.height / container.offsetHeight');

    // Every saved dimension is normalized — a raw `tabRect.width` would put
    // the scale straight back in.
    expect(source).toContain('width: tabRect.width / scaleX');
    expect(source).toContain('height: tabRect.height / scaleY');
    expect(source).toContain('(tabRect.left - containerRect.left) / scaleX');
    expect(source).toContain('(tabRect.top - containerRect.top) / scaleY');
  });

  test('stays hidden while it has no layout box instead of drawing a 0x0 pill', () => {
    // A `display:none` ancestor makes every measurement zero. Showing the pill
    // from that would paint it at 0x0 in the corner; the ResizeObserver does
    // fire for a real size change, so waiting is correct.
    expect(source).toMatch(/if \(!scaleX \|\| !scaleY\) \{\s*setVisible\(false\);\s*return;/);
  });

  test('still observes size and scroll, which the ratio does not replace', () => {
    // The normalization fixes transforms only. Layout changes (a font load, a
    // container resize, a horizontal scroll) still need these.
    expect(source).toContain('new ResizeObserver');
    expect(source).toContain("addEventListener('scroll', measure");
    expect(source).toContain("window.addEventListener('resize', measure)");
  });
});

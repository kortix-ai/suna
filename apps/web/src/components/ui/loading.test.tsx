import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./loading.tsx', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('../../app/globals.css', import.meta.url)), 'utf8');

describe('Loading spokes variant', () => {
  test('the CSS step count matches the number of spokes drawn', () => {
    // These two numbers live in different files and must agree: steps(N) is
    // what lands each frame exactly one spoke on. Let them drift and the wheel
    // stops between positions — the tick becomes a stutter. Nothing else
    // catches this: it typechecks fine and renders fine, it just looks wrong.
    const spokes = Number(source.match(/const SPOKE_COUNT = (\d+)/)?.[1]);
    const steps = Number(css.match(/animation: spinner-spokes [\d.]+s steps\((\d+)\)/)?.[1]);

    expect(spokes).toBeGreaterThan(0);
    expect(steps).toBe(spokes);
  });

  test('keeps rotating under reduced motion, without the strobe', () => {
    // A spinner that stops entirely stops reporting that work is happening.
    // The repo's convention is to keep the rotation and drop the modulation.
    // The override is the LAST .animate-spinner-spokes rule — the base rule
    // appears earlier in the file, outside any media query.
    const overrideAt = css.lastIndexOf('.animate-spinner-spokes');
    const rule = css.slice(overrideAt, css.indexOf('}', overrideAt) + 1);

    expect(rule).toContain('linear');
    expect(rule).not.toContain('steps(');

    // ...and it really is inside the reduced-motion block, not just later on.
    const enclosingMedia = css.lastIndexOf('@media', overrideAt);
    expect(css.slice(enclosingMedia, enclosingMedia + 60)).toContain('prefers-reduced-motion');
  });

  test('defaults to orbit so existing call sites are untouched', () => {
    expect(source).toContain("variant = 'orbit'");
  });
});

describe('Loading ring variant', () => {
  /**
   * Same class of hazard as the spokes/steps pair above: a number in the CSS
   * that a second file has to agree with, where drift typechecks and renders
   * and just looks wrong.
   *
   * `.animate-spinner-dash` hard-codes `stroke-dasharray: 62.83` — 2*pi*r for
   * orbit's r=10 — and its keyframes step the offset through 58 -> 14 -> 58
   * against it. The ring is a different circle (r=6.3, real circumference
   * 39.58), so it declares `pathLength` to re-scale its own length to 62.83.
   * Every dash number in the CSS then means the same FRACTION of the ring it
   * meant on orbit. Change one side without the other and the arc either
   * vanishes or stops breathing.
   */
  test('the ring re-scales itself to the dasharray the CSS animates', () => {
    const declared = Number(source.match(/const RING_PATH_LENGTH = ([\d.]+)/)?.[1]);
    const animated = Number(css.match(/stroke-dasharray: ([\d.]+);/)?.[1]);

    expect(declared).toBeGreaterThan(0);
    expect(declared).toBe(animated);
  });

  test('the ring is drawn on the shared status geometry, not its own circle', () => {
    // The whole point of the variant: a todo that starts running must not swap
    // to a fatter, larger disc than the `pending` glyph it replaces.
    expect(source).toContain("import { STATUS_RING } from '@/components/ui/status-ring'");
    // Slice from AFTER the ring guard to the next variant guard — searching
    // from 0 would find the ring guard itself and yield an empty body, i.e. an
    // assertion that can never pass.
    const ringBlock = source.slice(source.indexOf("if (variant === 'ring')"));
    const body = ringBlock.slice(0, ringBlock.indexOf('if (variant ===', 1));
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain('r={STATUS_RING.RADIUS}');
    expect(body).toContain('strokeWidth={STATUS_RING.STROKE}');
    // No literal geometry smuggled in beside the shared constants.
    expect(body).not.toMatch(/r="\d/);
    expect(body).not.toMatch(/strokeWidth="\d/);
  });
});

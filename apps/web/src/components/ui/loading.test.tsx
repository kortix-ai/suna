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

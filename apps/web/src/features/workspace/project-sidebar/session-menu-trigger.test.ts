import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const listSource = readFileSync(join(import.meta.dir, 'project-session-list.tsx'), 'utf8');
const globalsSource = readFileSync(join(import.meta.dir, '../../../app/globals.css'), 'utf8');

/** Throws rather than returning '' on a missing anchor, so a rename fails the
 *  test instead of quietly retiring it. */
function between(source: string, open: string, close: string): string {
  const start = source.indexOf(open);
  if (start === -1) throw new Error(`anchor not found: ${open}`);
  const end = source.indexOf(close, start + open.length);
  if (end === -1) throw new Error(`anchor not found after ${open}: ${close}`);
  return source.slice(start, end);
}

/** The one number every spacing utility in this app is derived from. Tailwind's
 *  stock 0.25rem would make every assertion below wrong by 8%. */
function spacingRem(): number {
  const match = globalsSource.match(/--spacing:\s*([\d.]+)rem/);
  if (!match) throw new Error('--spacing not found in globals.css');
  return Number(match[1]);
}

const TOUCH_CLASS = between(listSource, 'const SESSION_MENU_TRIGGER_TOUCH_CLASS', '\n);');

const TOUCH_VARIANTS = ['max-md:', '[@media(hover:none)]:', '[@media(pointer:coarse)]:'] as const;

describe('session row menu trigger on touch', () => {
  test('splits the visible square from the touch target', () => {
    // The regression: `size-12` made the button the full height of the row, so
    // pressing it lit a slab of accent spanning the whole row.
    expect(TOUCH_CLASS).not.toContain('size-12');

    for (const variant of TOUCH_VARIANTS) {
      expect(TOUCH_CLASS).toContain(`${variant}size-8`);
      // An unpainted pseudo-element carries the finger target instead.
      expect(TOUCH_CLASS).toContain(`${variant}after:absolute`);
      expect(TOUCH_CLASS).toContain(`${variant}after:-inset-2`);
      // `absolute` inset needs a positioned button; `static` would anchor the
      // ::after to the row and stretch the target across it.
      expect(TOUCH_CLASS).toContain(`${variant}relative`);
      expect(TOUCH_CLASS).not.toContain(`${variant}static`);
    }
  });

  test('the target is exactly the row height — never more', () => {
    const step = spacingRem();
    const pxPerStep = step * 16;

    const visibleSteps = 8;
    const insetSteps = 2;
    const targetSteps = visibleSteps + insetSteps * 2;

    // The row's own floor. If these stop matching, the target either falls short
    // of the finger minimum or spills into the row above and below.
    expect(listSource).toContain('max-md:min-h-12');
    expect(targetSteps).toBe(12);

    // Apple HIG / WCAG 2.5.5 finger minimum.
    expect(targetSteps * pxPerStep).toBeGreaterThanOrEqual(44);
    // The visible square stays clearly smaller than the row it sits in.
    expect(visibleSteps * pxPerStep).toBeLessThan(32);

    // The row's horizontal padding is what the target grows into, so the target
    // ends flush with the row edge rather than overhanging it.
    expect(insetSteps * pxPerStep).toBeCloseTo(2 * pxPerStep, 5);
    expect(listSource).toContain('rounded-md px-2');
  });

  test('nothing in the row clips the overflowing hit area', () => {
    // `overflow-hidden` on the row would clip the ::after out of hit-testing and
    // silently return the target to the size of the visible square.
    const row = between(listSource, "'relative flex h-8 cursor-pointer", '}}');
    expect(row).not.toContain('overflow-hidden');
  });
});

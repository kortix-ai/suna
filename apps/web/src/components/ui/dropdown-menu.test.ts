import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const uiDir = import.meta.dir;
const srcDir = join(uiDir, '..', '..');

const dropdownSource = readFileSync(join(uiDir, 'dropdown-menu.tsx'), 'utf8');
const recipeSource = readFileSync(join(uiDir, 'menu-recipe.ts'), 'utf8');

/**
 * Regression pin for a defect that shipped and bit two consumers before anyone
 * traced it to the primitive.
 *
 * `MENU_ROW_BASE` makes a menu row `flex items-center gap-2`, so every row
 * component's children are flex items — EXCEPT `DropdownMenuRadioItem`, which
 * interposed a `<span className="min-w-0 flex-1">` to push its check to the
 * far edge. That span was a block. Tailwind's Preflight sets
 * `svg { display: block }`, so a radio row with a leading icon rendered the
 * icon stacked ABOVE its label.
 *
 * `user-menu-shared.tsx` and `reasoning-effort-selector.tsx` both worked around
 * it by hand-wrapping their children in `<span className="flex items-center
 * gap-2">` — the first even carrying a comment describing the workaround. The
 * wrapper is the component's job; these tests fail if either half regresses.
 */
describe('DropdownMenuRadioItem label column', () => {
  const radioLabel = /const RADIO_LABEL = '([^']+)'/.exec(dropdownSource)?.[1];

  test('is declared as a single shared constant', () => {
    expect(radioLabel).toBeDefined();
  });

  test('is a flex row, so a leading icon sits beside its label, not above it', () => {
    expect(radioLabel).toContain('flex');
    expect(radioLabel).toContain('items-center');
  });

  test('keeps flex-1, which is what pushes the check to the row edge', () => {
    expect(radioLabel).toContain('flex-1');
    expect(radioLabel).toContain('min-w-0');
  });

  test('spaces icon and label exactly like every other row type', () => {
    // MENU_ROW_BASE is the reference: a radio row must not invent its own gap.
    const rowGap = /gap-(\d+(?:\.\d+)?)/.exec(recipeSource.split('MENU_ROW_BASE')[1] ?? '')?.[1];
    expect(rowGap).toBeDefined();
    expect(radioLabel).toContain(`gap-${rowGap}`);
  });
});

describe('no consumer re-implements the label column', () => {
  // The exact shape both files used to carry, immediately inside a radio row.
  const WORKAROUND = /<DropdownMenuRadioItem[^>]*>\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<span className="flex items-center gap-2">/;

  // A plain loop, not `test.each`: `@types/bun` does not declare `each`, and
  // the three files that use it are the whole of this app's known tsc noise.
  for (const relativePath of [
    'features/layout/user-menu-shared.tsx',
    'features/session/reasoning-effort-selector.tsx',
  ]) {
    test(`${relativePath} puts its icon directly in the row`, () => {
      const source = readFileSync(join(srcDir, relativePath), 'utf8');
      // Guard against the test passing because the file moved or stopped using
      // radio items at all.
      expect(source).toContain('DropdownMenuRadioItem');
      expect(source).not.toMatch(WORKAROUND);
    });
  }
});

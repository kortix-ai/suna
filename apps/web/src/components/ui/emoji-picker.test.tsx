import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./emoji-picker.tsx', import.meta.url)), 'utf8');

/**
 * Source with comments stripped. The file's own comments name the wrong-way-round
 * variants in order to warn the next person off them, so any "must not appear"
 * check has to read code and not prose.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Pull the tint for one row parity at one column slot out of the source text. */
function tint(parity: 'even' | 'odd', slot: number, dark = false): string | undefined {
  const prefix = dark ? 'dark:' : '';
  const re = new RegExp(
    `(?<!dark:)${prefix}group-data-\\[row=${parity}\\]/row:nth-\\[6n\\+${slot}\\]:data-\\[active\\]:bg-\\[(hsl\\([^)]*\\))\\]`,
  );
  return source.match(re)?.[1];
}

const SLOTS = [1, 2, 3, 4, 5, 6];
const ROW_OFFSET = 3;

describe('emoji picker tint rotation', () => {
  test('all 24 tint variants are present', () => {
    // 6 columns x 2 row parities x 2 themes. A missing one is invisible: the
    // cell just has no hover background, which reads as a dead cell.
    const found = (['even', 'odd'] as const).flatMap((p) =>
      [false, true].flatMap((d) => SLOTS.map((s) => tint(p, s, d))),
    );
    expect(found.filter(Boolean)).toHaveLength(24);
  });

  test('odd rows are the even-row set rotated by three', () => {
    // This is the whole point of the offset: a tint must never sit directly
    // above itself. Rotating by anything other than 3 over a 6-tint cycle
    // puts a repeat back on an adjacent row somewhere in the grid.
    for (const [dark, label] of [
      [false, 'light'],
      [true, 'dark'],
    ] as const) {
      const even = SLOTS.map((s) => tint('even', s, dark));
      const odd = SLOTS.map((s) => tint('odd', s, dark));
      expect({ label, odd }).toEqual({
        label,
        odd: SLOTS.map((_, i) => even[(i + ROW_OFFSET) % SLOTS.length]),
      });
    }
  });

  test('every tint variant is a literal string, never interpolated', () => {
    // Tailwind v4 extracts class names by scanning source text. A class built
    // with a template literal or .map() produces no CSS at all and the hover
    // backgrounds silently never appear — it typechecks and renders fine.
    const constructed = source.match(/['"`][^'"`\n]*(?:nth-\[6n|data-\[active\])[^'"`\n]*\$\{/g);
    expect(constructed).toBeNull();
  });
});

describe('emoji picker row parity', () => {
  test('row parity comes from aria-rowindex, not :nth-child', () => {
    // frimousse virtualises the list, so a row's nth-child index counts only
    // the rows currently mounted, and is further shifted by a hidden
    // measurement div plus a spacer div before every category-starting row.
    // Measured in Chrome: logical row 17 lands on nth-child 2, row 18 on
    // nth-child 3, and the mapping changes on every scroll. aria-rowindex is
    // the only stable source of a row's logical position.
    expect(source).toContain("props['aria-rowindex']");
    expect(source).toMatch(/data-row=\{[^}]*% 2 === 0 \? 'even' : 'odd'\}/);
  });

  test('does not use the structurally-wrong nth-child row variants', () => {
    expect(code).not.toContain('group-odd/row:');
    expect(code).not.toContain('group-even/row:');
  });
});

describe('emoji picker conventions', () => {
  test('uses the shared Loading component, not a spinning icon', () => {
    expect(source).toContain("from '@/components/ui/loading'");
    expect(code).not.toMatch(/animate-spin\b/);
    expect(source).not.toMatch(/CircleNotch|SpinnerGap|SpinnerIcon/);
  });

  test('transitions name exact properties and animate scale, not transform', () => {
    // Tailwind v4's scale-* utility sets the standalone `scale` property.
    // `transition-property: transform` does not cover it, so listing transform
    // here would leave the press feedback snapping instantly.
    expect(source).toContain('transition-[background-color,scale]');
    expect(code).not.toMatch(/transition-all|transition:\s*all/);
  });
});

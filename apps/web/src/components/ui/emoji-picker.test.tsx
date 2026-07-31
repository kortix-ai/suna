import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./emoji-picker.tsx', import.meta.url)), 'utf8');
const globalsCss = readFileSync(
  fileURLToPath(new URL('../../app/globals.css', import.meta.url)),
  'utf8',
);

/**
 * Source with comments stripped. The file's own comments name the wrong-way-round
 * variants in order to warn the next person off them, so any "must not appear"
 * check has to read code and not prose. Everything below reads `code`, not
 * `source`, so that a comment edit can never turn a check green.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const TINTS = ['red', 'amber', 'green', 'teal', 'blue', 'violet'] as const;
const SLOTS = [1, 2, 3, 4, 5, 6];
const ROW_OFFSET = 3;

/** Pull the tint token name for one row parity at one column slot. */
function tint(parity: 'even' | 'odd', slot: number): string | undefined {
  return code.match(
    new RegExp(
      `group-data-\\[row=${parity}\\]/row:nth-\\[6n\\+${slot}\\]:data-\\[active\\]:bg-emoji-tint-([a-z]+)`,
    ),
  )?.[1];
}

/** Every occurrence of a literal substring in the comment-stripped source. */
const countIn = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('emoji picker tint rotation', () => {
  test('all 12 tint variants are present', () => {
    // 6 columns x 2 row parities. There is no dark set: each token is a
    // light-dark() pair. A missing variant is invisible — the cell just has no
    // active background, which reads as a dead cell.
    const found = (['even', 'odd'] as const).flatMap((p) => SLOTS.map((s) => tint(p, s)));
    expect(found.filter(Boolean)).toHaveLength(12);
  });

  test('odd rows are the even-row set rotated by three', () => {
    // This is the whole point of the offset: a tint must never sit directly
    // above itself. Rotating by anything other than 3 over a 6-tint cycle puts
    // a repeat back on an adjacent row. Rotation by 3 holds for any column
    // count, which matters because frimousse's default is 9, not the 10 its
    // own JSDoc claims.
    const even = SLOTS.map((s) => tint('even', s));
    const odd = SLOTS.map((s) => tint('odd', s));
    expect(odd).toEqual(SLOTS.map((_, i) => even[(i + ROW_OFFSET) % SLOTS.length]));
  });

  test('every tint variant is a literal string, never interpolated', () => {
    // Tailwind v4 extracts class names by scanning source text. A class built
    // with a template literal or .map() produces no CSS at all and the active
    // backgrounds silently never appear — it typechecks and renders fine.
    expect(code.match(/['"`][^'"`\n]*(?:nth-\[6n|data-\[active\])[^'"`\n]*\$\{/g)).toBeNull();
  });

  test('tint values live in globals.css, not as raw colours in the component', () => {
    // The design system forbids raw hex/hsl/oklch and hand-written dark:
    // palette overrides in app code.
    expect(code).not.toMatch(/bg-\[(?:hsl|rgb|oklch|#)/);
    expect(code).not.toMatch(/dark:group-data-\[row=/);
  });

  test('every tint token the component names is declared with a light-dark pair', () => {
    // A token that does not exist compiles to nothing, so the cell would get no
    // background at all. light-dark() is what removes the need for a dark: set;
    // it resolves through color-scheme, which :root and .dark both set.
    for (const name of TINTS) {
      expect(code).toContain(`bg-emoji-tint-${name}`);
      expect(globalsCss).toMatch(
        new RegExp(
          `--color-emoji-tint-${name}:\\s*light-dark\\(hsl\\([^)]*\\),\\s*hsl\\([^)]*\\)\\)`,
        ),
      );
    }
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
    expect(code).toContain("props['aria-rowindex']");
    expect(code).toMatch(/data-row=\{rowParity\(props\)\}/);
  });

  test('does not use the structurally-wrong nth-child row variants', () => {
    expect(code).not.toContain('group-odd/row:');
    expect(code).not.toContain('group-even/row:');
  });

  test('a missing aria-rowindex is reported rather than silently defaulted', () => {
    // Without this, losing aria-rowindex upstream would send every row to
    // `even`, collapse the rotation to one set, and fail nothing. The warning
    // is gated on role="row" because frimousse's hidden measurement row
    // legitimately carries neither role nor aria-rowindex.
    expect(code).toMatch(/console\.warn\(/);
    expect(code).toContain("props.role === 'row'");
  });
});

describe('emoji picker conventions', () => {
  test('uses the shared Loading component, not a spinning icon', () => {
    expect(code).toContain("from '@/components/ui/loading'");
    expect(code).not.toMatch(/animate-spin\b/);
    expect(code).not.toMatch(/CircleNotch|SpinnerGap|SpinnerIcon/);
  });

  test('every transition names exact properties and animates scale, not transform', () => {
    // Tailwind v4's scale-* utility sets the standalone `scale` property, which
    // `transition-property: transform` does not cover — listing transform would
    // leave the press feedback snapping instantly.
    //
    // Counted, not merely "contains": there are two pressable elements (the
    // emoji cell and the skin-tone button) carrying an identical class string,
    // so a `contains` check stays green when only one of them regresses.
    expect(countIn(code, 'active:scale-[')).toBe(2);
    expect(countIn(code, 'transition-[background-color,scale]')).toBe(2);
    expect(code).not.toContain('transition-[background-color,transform]');
    expect(code).not.toMatch(/transition-all|transition:\s*all/);
  });

  test('resets the native WebKit clear button on the search field', () => {
    // frimousse hardcodes type="search". Tailwind's preflight resets
    // ::-webkit-search-decoration but NOT ::-webkit-search-cancel-button, so
    // without this WebKit paints its own blue clear X inside the field.
    expect(code).toContain('[&::-webkit-search-cancel-button]:appearance-none');
  });

  test('the grid and the search field both have accessible names', () => {
    // Frimousse.List renders role="grid"; a grid with no name is announced as
    // an unlabelled grid. The search input would otherwise be named only by its
    // placeholder.
    expect(code).toMatch(/<Frimousse\.List\s+aria-label="/);
    expect(code).toMatch(/<Frimousse\.Search\s+aria-label="/);
  });

  test('slot classNames are merged after the prop spread, never before', () => {
    // All three slot prop types extend ComponentProps, so className is in the
    // type. frimousse passes none today, but a className placed before the
    // spread would be replaced outright and the tint system would go dead.
    expect(countIn(code, 'props.className')).toBe(3);
    expect(code).not.toMatch(/className=[^\n]*\n\s*\{\.\.\.props\}/);
  });
});

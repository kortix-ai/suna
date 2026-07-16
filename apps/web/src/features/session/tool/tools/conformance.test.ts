import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Grammar contract (docs/superpowers/specs/2026-07-16-advanced-tool-views-design.md
// §"The grammar" + §S4): forbidden chrome that must never reappear in ANY
// tool view — gradients, shadows, the old rounded-2xl cards, raw palette
// accent colors (sky/emerald/purple/amber), and a literal "Loading..." text
// node rendered outside `TextShimmer` (the grammar's one sanctioned pending
// treatment). The last clause is a JSX-text-position match — `>Loading...<`
// not immediately preceded by a `<TextShimmer>` open tag — so it doesn't
// false-positive on "Loading..." used as a plain string value (e.g. a
// trigger `subtitle`, which the shell auto-shimmers while running).
// Note: the lookbehind only recognizes a bare `<TextShimmer>` open tag — a
// prop-bearing tag (`<TextShimmer className=...>Loading...`) would
// false-positive; none exist today, tighten if one legitimately appears.
const FORBIDDEN =
  /rounded-2xl|shadow-(sm|md|lg|xl)|bg-gradient|text-(sky|emerald|purple)-\d|text-amber-\d|(?<!TextShimmer)>\s*Loading\.\.\.\s*</;

// Task 8 goes exhaustive: every .tsx view file in tool/tools/ must conform —
// not just the files converted so far. Test files (*.test.tsx) are excluded
// because they legitimately assert on these strings as literals (e.g.
// `expect(html).not.toContain('rounded-2xl')`), which would otherwise read
// as false positives.
describe('tool/tools/ conformance — no bespoke design system anywhere in tool/tools/', () => {
  const dir = join(__dirname);
  const viewFiles = readdirSync(dir)
    .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
    .sort();

  test('found tool view files to check (sanity: the sweep is not silently empty)', () => {
    expect(viewFiles.length).toBeGreaterThan(50);
  });

  for (const file of viewFiles) {
    test(`${file} has no forbidden gradient/shadow/rounded-2xl/raw-palette/literal-Loading classes`, () => {
      const source = readFileSync(join(dir, file), 'utf8');
      const match = source.match(FORBIDDEN);
      expect(match).toBeNull();
    });
  }
});

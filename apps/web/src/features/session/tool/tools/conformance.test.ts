import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Grammar contract (docs/superpowers/specs/2026-07-16-advanced-tool-views-design.md
// §"The grammar" + §S4): forbidden chrome that must never reappear in a
// converted tool view — gradients, shadows, the old rounded-2xl cards, and
// raw palette accent colors (sky/emerald/purple/amber).
const FORBIDDEN = /rounded-2xl|shadow-(sm|md|lg|xl)|bg-gradient|text-(sky|emerald|purple)-\d|text-amber-\d/;

// Tasks 5-7 extend this list as each file is rebuilt on the grammar; Task 8
// goes exhaustive (every file in tool/tools/). Keeping the assertion scoped
// to this array — rather than skipping failing files — means the test stays
// honest (RED until a file is actually converted, GREEN once it lands) at
// every commit in between.
export const CONVERTED: string[] = [
  'get-mem-tool.tsx',
  'memory-search-tool.tsx',
  'executor-tools.tsx',
  'dcp-compress-tool.tsx',
  'dcp-distill-tool.tsx',
  'dcp-prune-tool.tsx',
  'context-info-tool.tsx',
];

describe('tool/tools/ conformance — no bespoke design system in converted files', () => {
  const dir = join(__dirname);
  const allFiles = readdirSync(dir).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));

  test('CONVERTED files still exist in tool/tools/', () => {
    for (const file of CONVERTED) {
      expect(allFiles).toContain(file);
    }
  });

  for (const file of CONVERTED) {
    test(`${file} has no forbidden gradient/shadow/rounded-2xl/raw-palette classes`, () => {
      const source = readFileSync(join(dir, file), 'utf8');
      const match = source.match(FORBIDDEN);
      expect(match).toBeNull();
    });
  }
});

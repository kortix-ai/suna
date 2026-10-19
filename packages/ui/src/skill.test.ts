import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The kortix-ui skill ships with the package and is the first file an agent
// reads. Its Components table must name every export of the two barrels, and
// the copy Kortix sessions load must be the same file.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const SKILL = read('../skills/kortix-ui/SKILL.md');
const MIRROR = read('../../starter/templates/managed/skills/kortix-ui/SKILL.md');

/** Every name a barrel exports: `export { a, type B, c as d } from …`, `export function|const|… name`. */
function exportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const raw of m[1].split(',')) {
      const name = raw.replace(/^\s*type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  for (const m of source.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+(\w+)/gm)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

function componentsSection(skill: string): string {
  const match = skill.match(/^## \d+\. Components\n([\s\S]*?)(?=^## )/m);
  if (!match) throw new Error('SKILL.md has no "## <n>. Components" section');
  return match[1];
}

describe('kortix-ui skill', () => {
  const listed = new Set([...componentsSection(SKILL).matchAll(/`([\w$]+)`/g)].map((m) => m[1]));

  for (const barrel of ['./index.ts', './chat/index.ts']) {
    test(`Components table names every export of src/${barrel.slice(2)}`, () => {
      const source = read(barrel);
      expect(source).not.toMatch(/^export\s+\*/m); // a star export hides its names from this check
      const names = exportedNames(source);
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((name) => !listed.has(name))).toEqual([]);
    });
  }

  test('the managed copy for Kortix sessions is identical (copy packages/ui/skills/kortix-ui/SKILL.md)', () => {
    expect(MIRROR).toBe(SKILL);
  });

  test('stays at or under 150 lines', () => {
    expect(SKILL.trimEnd().split('\n').length).toBeLessThanOrEqual(150);
  });
});

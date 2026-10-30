import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

// @ts-expect-error -- plain .mjs script, no declaration file
import { ENTRIES } from '../scripts/gen-exports.mjs';

// The kortix-ui skill ships with the package and is the first file an agent
// reads. Its Components table must name every export of the root and theme barrels,
// references/modules.md every export of each module entry, and
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

  for (const barrel of ['./index.ts', './theme/index.ts']) {
    test(`Components table names every export of src/${barrel.slice(2)}`, () => {
      const source = read(barrel);
      expect(source).not.toMatch(/^export\s+\*/m); // a star export hides its names from this check
      const names = exportedNames(source);
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((name) => !listed.has(name))).toEqual([]);
    });
  }

  // Every module entry (gen-exports ENTRIES) has a section in references/modules.md that names
  // each export, and SKILL.md names the entry.
  const MODULES = read('../skills/kortix-ui/references/modules.md');
  for (const [key, file] of Object.entries(ENTRIES as Record<string, string>)) {
    const spec = `@kortix/ui${key.slice(1)}`;
    test(`references/modules.md names every export of ${spec}`, () => {
      const source = read(`./${file}`);
      expect(source).not.toMatch(/^export\s+\*/m);
      const section = MODULES.split(/^## /m).find((part) => part.startsWith(`\`${spec}\``));
      expect(section).toBeDefined();
      const documented = new Set([...(section ?? '').matchAll(/`([\w$]+)`/g)].map((m) => m[1]));
      const names = exportedNames(source);
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((name) => !documented.has(name))).toEqual([]);
    });
    test(`SKILL.md names ${spec}`, () => {
      expect(SKILL).toContain(`\`${spec}\``);
    });
  }

  test('the managed copy for Kortix sessions is identical (copy packages/ui/skills/kortix-ui/SKILL.md)', () => {
    expect(MIRROR).toBe(SKILL);
  });

  test('the managed copy has the same reference files (copy packages/ui/skills/kortix-ui/references/)', () => {
    const dir = (path: string) => new URL(path, import.meta.url);
    const own = readdirSync(dir('../skills/kortix-ui/references/')).sort();
    expect(own.length).toBeGreaterThan(0);
    expect(readdirSync(dir('../../starter/templates/managed/skills/kortix-ui/references/')).sort()).toEqual(own);
    for (const name of own) {
      expect(read(`../../starter/templates/managed/skills/kortix-ui/references/${name}`)).toBe(read(`../skills/kortix-ui/references/${name}`));
    }
  });

  test('every reference the skill names exists', () => {
    for (const [, name] of SKILL.matchAll(/`references\/([\w.-]+)`/g)) {
      expect(readdirSync(new URL('../skills/kortix-ui/references/', import.meta.url))).toContain(name);
    }
  });

  test('stays at or under 150 lines', () => {
    expect(SKILL.trimEnd().split('\n').length).toBeLessThanOrEqual(150);
  });
});

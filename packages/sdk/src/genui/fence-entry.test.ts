import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * `@kortix/sdk/genui/fence` exists so a markdown renderer can detect an OpenUI
 * fence without loading the parser. The `./genui` barrel pulls in
 * `@openuidev/lang-core` and `zod` (optional peers) and builds the catalog at
 * module load. This test walks the entry's static relative-import graph and
 * fails if any reachable file imports either package, even type-only.
 */
const ENTRY = join(import.meta.dir, 'fence-entry.ts');
const OPTIONAL_PEER = /^(?:@openuidev\/|zod(?:\/|$))/;
const SPECIFIER = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

function resolveRelative(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec);
  const found = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(existsSync);
  if (!found) throw new Error(`unresolved import "${spec}" in ${fromFile}`);
  return found;
}

function bareImports(entry: string): Map<string, string> {
  const seen = new Set<string>();
  const bare = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const spec = (match[1] ?? match[2] ?? match[3])!;
      if (spec.startsWith('.')) queue.push(resolveRelative(file, spec));
      else bare.set(spec, file);
    }
  }
  return bare;
}

test('./genui/fence never reaches @openuidev/* or zod', () => {
  const leaks = [...bareImports(ENTRY)]
    .filter(([spec]) => OPTIONAL_PEER.test(spec))
    .map(([spec, file]) => `${spec} (imported by ${relative(import.meta.dir, file)})`);
  expect(leaks).toEqual([]);
});

test('./genui/fence exports only the fence functions', async () => {
  const mod = (await import('./fence-entry')) as Record<string, unknown>;
  expect(Object.keys(mod).sort()).toEqual(['genuiVersionFromClassName', 'genuiVersionOf', 'separateGenuiClosers', 'splitGenui']);
});

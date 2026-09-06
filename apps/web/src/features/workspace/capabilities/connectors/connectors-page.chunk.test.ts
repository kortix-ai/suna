import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `/projects/[id]/customize/connectors` route's initial client chunk, walked as a
 * static import graph from the route entry.
 *
 * `customize/sections/connectors-view.tsx` is 5,075 lines whose own import
 * list pulls `@pipedream/sdk/browser` (10M installed), `HighlightedCode`
 * (shiki, 3.8M), `PoliciesPanel`, `DiscoverCatalogue` and
 * `ConnectorConnectionModal`. An ES module is all-or-nothing to the bundler, so
 * ONE static `import` anywhere in this graph puts all of it in front of a page
 * whose first paint is a grid of cards.
 *
 * That has already happened twice. `connector-identity.tsx` was lifted out of
 * `connectors-view.tsx` precisely to avoid it (see its header comment), and
 * `use-pipedream-connect-app.ts` was lifted out for the same reason — and then
 * `connectors-page.tsx`, `connector-modal.tsx` and `connector-accounts.tsx`
 * each added a fresh static edge straight back to it.
 *
 * A source-string assertion cannot catch this: the offending import is three
 * files away from the one being edited, and every individual import looks
 * reasonable where it is written. So this walks the real graph instead. The
 * fix is `next/dynamic` (see `connectors-page.tsx`), and a dynamic
 * `import(...)` is deliberately NOT followed here — that is the whole point of
 * it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../../../..');
const ROUTE_ENTRY = resolve(SRC, 'app/(app)/projects/[id]/(capabilities)/customize/connectors/page.tsx');

/** Modules that must not be parsed before the connectors grid paints. */
const FORBIDDEN = [
  'features/workspace/customize/sections/connectors-view',
  'features/workspace/customize/sections/discover-catalogue',
  'components/markdown/code',
];

/** Bare specifiers that must not be reachable either. */
const FORBIDDEN_PACKAGES = ['@pipedream/sdk'];

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

function resolveModule(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith('@/')
    ? resolve(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (!base) return null;

  for (const candidate of [
    ...EXTENSIONS.map((ext) => `${base}${ext}`),
    ...EXTENSIONS.map((ext) => resolve(base, `index${ext}`)),
  ]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Every STATIC specifier in a module: `import … from 'x'`, side-effect
 * `import 'x'`, and `export … from 'x'`. A dynamic `import('x')` is a separate
 * chunk by definition and is skipped — matching how the bundler splits.
 */
function staticSpecifiers(source: string): string[] {
  const withoutDynamic = source.replace(/\bimport\s*\(/g, 'DYNAMIC_IMPORT(');
  const out: string[] = [];
  const pattern =
    /(?:^|\n)\s*(?:import|export)\b[\s\S]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutDynamic)) !== null) {
    const specifier = match[1] ?? match[2];
    if (specifier) out.push(specifier);
  }
  return out;
}

/** Walks the static graph, recording how each module was first reached. */
function walkStaticGraph(entry: string) {
  const parentOf = new Map<string, string | null>([[entry, null]]);
  const packageHits = new Map<string, string>();
  const stack = [entry];

  while (stack.length > 0) {
    const file = stack.pop()!;
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    for (const specifier of staticSpecifiers(source)) {
      const bare = FORBIDDEN_PACKAGES.find(
        (pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`),
      );
      if (bare && !packageHits.has(bare)) packageHits.set(bare, file);

      const resolved = resolveModule(specifier, file);
      if (!resolved || parentOf.has(resolved)) continue;
      parentOf.set(resolved, file);
      stack.push(resolved);
    }
  }
  return { parentOf, packageHits };
}

/** The import chain that reached `file`, as repo-relative paths. */
function chain(parentOf: Map<string, string | null>, file: string): string[] {
  const path: string[] = [];
  let cursor: string | undefined | null = file;
  while (cursor) {
    path.unshift(relative(SRC, cursor));
    cursor = parentOf.get(cursor);
  }
  return path;
}

describe('connectors route initial chunk', () => {
  const { parentOf, packageHits } = walkStaticGraph(ROUTE_ENTRY);
  const reached = [...parentOf.keys()];

  test('the walker actually reached the page body (guards against a silent no-op)', () => {
    // If resolution broke, every assertion below would pass vacuously.
    expect(reached.length).toBeGreaterThan(30);
    expect(
      reached.some((file) => file.endsWith('capabilities/connectors/connectors-page.tsx')),
    ).toBe(true);
    // A control: something the page genuinely does import statically.
    expect(reached.some((file) => file.endsWith('shared/catalog/catalog-grid.tsx'))).toBe(true);
  });

  // A plain loop, not `test.each`: `@types/bun` does not declare `.each`, and
  // the three files that use it are the whole of this app's `tsc` error
  // baseline (see CLAUDE.md). Not worth becoming the fourth.
  for (const moduleId of FORBIDDEN) {
    test(`${moduleId} is not in the initial chunk`, () => {
      const hit = reached.find((file) => relative(SRC, file).startsWith(moduleId));
      const how = hit ? `\n  reached by: ${chain(parentOf, hit).join('\n           -> ')}` : '';
      expect(`${moduleId}${how}`).toBe(moduleId);
    });
  }

  for (const pkg of FORBIDDEN_PACKAGES) {
    test(`${pkg} is not in the initial chunk`, () => {
      const importer = packageHits.get(pkg);
      const how = importer
        ? `\n  reached by: ${chain(parentOf, importer).join('\n           -> ')}`
        : '';
      expect(`${pkg}${how}`).toBe(pkg);
    });
  }
});

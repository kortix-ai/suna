import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The working-state module graph, pinned acyclic (KRTX-1918).
 *
 * The decision rules used to live in `working-project.ts`, which imported the
 * freshness floors back from `working.ts` while `working.ts` imported the
 * decision in — a three-module cycle (`working` → `working-project` →
 * `working-evidence` → `working`). The rules are folded into `working.ts`
 * itself; only the leaf modules (`working-runtime`, `working-time`,
 * `working-server`) may remain, and none of them may import back.
 *
 * This asserts over VALUE edges only (`import type` and all-type imports
 * carry no runtime cycle — the codebase-analysis import_cycle metric works
 * the same way).
 */

const DIR = new URL('.', import.meta.url).pathname;

type Graph = Map<string, string[]>;

function valueImports(file: string): string[] {
  const text = readFileSync(join(DIR, file), 'utf8');
  const specs: string[] = [];
  for (const m of text.matchAll(/import\s+(type\s+)?(?:[\w*\s{},$]+)\s+from\s+'([^']+)'/g)) {
    if (m[1]) continue; // `import type` — no runtime edge
    if (!m[2]!.startsWith('./working')) continue;
    const name = m[2]!.slice(2);
    specs.push(name.endsWith('.ts') ? name : `${name}.ts`);
  }
  return specs;
}

function graphFrom(entry: string): Graph {
  const graph: Graph = new Map();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (graph.has(file)) continue;
    const imports = valueImports(file);
    graph.set(file, imports);
    queue.push(...imports);
  }
  return graph;
}

function hasCycle(graph: Graph): string | null {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const visit = (file: string): string | null => {
    color.set(file, GRAY);
    for (const next of graph.get(file) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return next;
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    color.set(file, BLACK);
    return null;
  };
  for (const file of graph.keys()) {
    if ((color.get(file) ?? WHITE) === WHITE) {
      const found = visit(file);
      if (found) return found;
    }
  }
  return null;
}

describe('the working-state module graph', () => {
  test('is acyclic over value imports — the fold left only leaves', () => {
    const graph = graphFrom('working.ts');
    expect(hasCycle(graph)).toBeNull();
  });

  test('carries no folded-away sibling: working-project.ts and working-evidence.ts are gone', () => {
    expect(existsSync(join(DIR, 'working-project.ts'))).toBe(false);
    expect(existsSync(join(DIR, 'working-evidence.ts'))).toBe(false);
  });
});

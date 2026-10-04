/**
 * Boot-order tripwire for `sandbox-proxy/index.ts`.
 *
 * CI run 36351579974 (PR #7859): the API process never reached readiness.
 * `apps/api/src/projects/routes/shared.ts` gained a top-level `import {
 * guaranteeCurrentRuntimeOnOpen } from '../lib/legacy-runtime-bootstrap-wiring'`,
 * and that wiring module has a top-level import from `sandbox-proxy/backend`.
 * `sandbox-proxy/index.ts` imports (via `routes/preview`) a chain that
 * reaches `routes/shared.ts`, so that one new static edge closed a cycle back
 * into `sandbox-proxy/index.ts` itself — and at boot, `index.ts:80`'s
 * `sandboxProxyApp.route('/', preview)` read the `preview` NAMED IMPORT
 * before its own module finished initializing:
 * `ReferenceError: Cannot access 'preview' before initialization`.
 *
 * WHY THIS TEST IS NARROWER THAN "no cycle reachable from index.ts" — tried
 * that first. `sandbox-proxy/index.ts` already sits in at least one
 * pre-existing, currently-harmless cycle (`routes/share.ts` imports back into
 * `index.ts`), and the server boots through it today: the cyclic binding is
 * read inside a function body, not at module top level, so it is never in
 * the temporal dead zone by the time anything calls it. A generic
 * "index.ts must never be part of any cycle" rule would fail on that
 * ALREADY-FINE code the moment this test lands — a false alarm, not a guard.
 * Detecting "is this SPECIFIC top-level read safe" in general means
 * simulating module evaluation order, which is a framework, not a test.
 *
 * So: the ONE precise, evidence-backed rule for the incident that actually
 * happened — `legacy-runtime-bootstrap-wiring.ts` (the module whose static
 * import closed the cycle) must stay unreachable via STATIC imports from
 * `sandbox-proxy/index.ts`. The fix (`routes/shared.ts`'s `runOpenSession`,
 * following the `session-lifecycle/stop.ts` dynamic-import precedent) keeps
 * it behind a `await import(...)` at call time — outside this graph on
 * purpose, because a dynamic import cannot participate in a module-init
 * cycle. Reintroducing a static import anywhere on this path fails this test
 * again instead of surfacing 20 minutes later as a dead CI stack.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const SRC_ROOT = resolve(import.meta.dir, '..');
const ENTRY = resolve(import.meta.dir, 'index.ts');
const FORBIDDEN = resolve(SRC_ROOT, 'services/sandboxes/legacy-runtime-bootstrap-wiring.ts');

/** `./foo` → an existing `.ts` file, trying the extensions Bun/Node resolve. */
function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every module this file STATICALLY (hoisted) imports or re-exports — never a `await import(...)`, which cannot participate in a module-init cycle. */
function staticImportsOf(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const targets: string[] = [];
  const visit = (node: ts.Node) => {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
      const resolved = resolveRelativeImport(file, specifier.text);
      if (resolved) targets.push(resolved);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return targets;
}

describe('sandbox-proxy/index.ts boot-order (static import graph)', () => {
  test('legacy-runtime-bootstrap-wiring.ts stays behind a dynamic import — unreachable via static imports from the proxy entry', () => {
    expect(existsSync(ENTRY)).toBe(true);
    expect(existsSync(FORBIDDEN)).toBe(true);

    const cameFrom = new Map<string, string>();
    const visited = new Set<string>([ENTRY]);
    const queue: string[] = [ENTRY];
    let hit = false;

    while (queue.length > 0 && !hit) {
      const file = queue.shift() as string;
      for (const next of staticImportsOf(file)) {
        if (!next.startsWith(SRC_ROOT)) continue; // package import or outside src
        if (next === FORBIDDEN) {
          cameFrom.set(FORBIDDEN, file);
          hit = true;
          break;
        }
        if (visited.has(next)) continue;
        visited.add(next);
        cameFrom.set(next, file);
        queue.push(next);
      }
    }

    if (hit) {
      const path: string[] = [FORBIDDEN];
      let cursor = FORBIDDEN;
      while (cameFrom.has(cursor) && path.length <= visited.size + 1) {
        cursor = cameFrom.get(cursor) as string;
        path.push(cursor);
        if (cursor === ENTRY) break;
      }
      const readable = path
        .reverse()
        .map((f) => f.slice(SRC_ROOT.length + 1))
        .join('\n  -> ');
      throw new Error(
        `sandbox-proxy/index.ts can now reach legacy-runtime-bootstrap-wiring.ts through a STATIC import — this is ` +
          `exactly the shape that threw "Cannot access 'preview' before initialization" at server boot (CI run ` +
          `36351579974). Fix it with a dynamic import() at the call site, not a static one (see routes/shared.ts's ` +
          `runOpenSession for the pattern):\n  ${readable}`,
      );
    }
    expect(hit).toBe(false);
  });
});

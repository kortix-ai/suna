/**
 * Boot-order tripwire for `sandbox-proxy/index.ts`.
 *
 * CI run 36351579974 (PR #7859): the API process never reached readiness.
 * `apps/api/src/projects/session-open/index.ts` gained a top-level `import {
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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const SRC_ROOT = resolve(import.meta.dir, '..');
const ENTRY = resolve(import.meta.dir, 'index.ts');
const FORBIDDEN = resolve(SRC_ROOT, 'projects/lib/legacy-runtime-bootstrap-wiring.ts');

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
    // `import type` / `export type` are erased at runtime — they create no
    // module edge, so they are not static imports for the guards below.
    // The type-only flag sits on the import clause for `import type`, and on
    // the declaration itself for `export type`.
    const typeOnly =
      (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true) ||
      (ts.isExportDeclaration(node) && node.isTypeOnly === true);
    if (!typeOnly && (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))) specifier = node.moduleSpecifier;
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

  // CI runs 38623327979 and 38644657412 (2026-10-14/15): the api unit batches died with
  // "ReferenceError: Cannot access 'publicShareApp' before initialization" at index.ts:36 —
  // an unhandled error between tests, three batches at a time. The shape: index.ts reads its
  // route sub-apps at TOP LEVEL (lines 26-37), and a static cycle put index.ts's body before
  // routes/public-share.ts's. #9874 closed the loop: config-releases/publish.ts imports the
  // `projects/surface.ts` barrel, which re-exports ./session-lifecycle, whose actions.ts
  // statically imports `../../sandbox-proxy` (this index). Entering the graph at
  // routes/public-share.ts (the probe, unit-public-session-share.test.ts, three unit batches)
  // then evaluates: public-share -> … -> publish -> surface -> session-lifecycle -> actions ->
  // sandbox-proxy/index -> (its own import of public-share is still mid-evaluation) ->
  // body reads publicShareApp -> TDZ. The narrow fix narrows publish.ts's import to the
  // projects/git modules it actually uses, restoring the pre-#9874 graph shape.
  test('public-share.ts stays out of a static cycle with the proxy entry — no static path back to index.ts', () => {
    const shareEntry = resolve(import.meta.dir, 'routes/public-share.ts');
    expect(existsSync(shareEntry)).toBe(true);

    const cameFrom = new Map<string, string>();
    const visited = new Set<string>([shareEntry]);
    const queue: string[] = [shareEntry];
    let hit = false;

    while (queue.length > 0 && !hit) {
      const file = queue.shift() as string;
      for (const next of staticImportsOf(file)) {
        if (!next.startsWith(SRC_ROOT)) continue;
        if (next === ENTRY) {
          cameFrom.set(ENTRY, file);
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
      const path: string[] = [ENTRY];
      let cursor = ENTRY;
      while (cameFrom.has(cursor) && path.length <= visited.size + 1) {
        cursor = cameFrom.get(cursor) as string;
        path.push(cursor);
        if (cursor === shareEntry) break;
      }
      const readable = path
        .reverse()
        .map((f) => f.slice(SRC_ROOT.length + 1))
        .join('\n  -> ');
      throw new Error(
        'routes/public-share.ts reaches sandbox-proxy/index.ts through a STATIC import — importing ' +
          'public-share first then evaluates index.ts while public-share is still initializing, and ' +
          "index.ts's top-level route mounts read publicShareApp from that partial module: " +
          "'Cannot access publicShareApp before initialization'. Import the narrow module instead of " +
          'the projects/surface barrel (or dynamic-import at the call site):\n  ' + readable,
      );
    }
    expect(hit).toBe(false);
  });
  // Same incident family, wider window: `bun test --parallel` evaluates test
  // files' module graphs concurrently inside one process, so ANY static cycle
  // through sandbox-proxy/index.ts opens a window where one file's graph reads
  // a route binding from a module that is still initializing — the TDZ above,
  // or bun's linking form of the same window ("Export named 'X' not found in
  // module ..."). CI runs 38623327979/38644657412 and local package-quality
  // runs surfaced both shapes across routes/share (resolveProvider from
  // '../index'), routes/public-share and three projects/ modules importing
  // '../../sandbox-proxy'. No route module may statically reach index.ts.
  test('no sandbox-proxy route module statically reaches the proxy entry', () => {
    const routesDir = join(import.meta.dir, 'routes');
    const routeFiles = readdirSync(routesDir)
      .filter((f) => f.endsWith('.test.ts') === false && f.endsWith('.ts'))
      .map((f) => join(routesDir, f));
    expect(routeFiles.length).toBeGreaterThan(0);

    for (const routeFile of routeFiles) {
      const cameFrom = new Map<string, string>();
      const visited = new Set<string>([routeFile]);
      const queue: string[] = [routeFile];
      while (queue.length > 0) {
        const file = queue.shift() as string;
        for (const next of staticImportsOf(file)) {
          if (!next.startsWith(SRC_ROOT)) continue;
          if (next === ENTRY) {
            cameFrom.set(ENTRY, file);
            const path: string[] = [ENTRY];
            let cursor = ENTRY;
            while (cameFrom.has(cursor) && path.length <= visited.size + 1) {
              cursor = cameFrom.get(cursor) as string;
              path.push(cursor);
              if (cursor === routeFile) break;
            }
            const readable = path
              .reverse()
              .map((f) => f.slice(SRC_ROOT.length + 1))
              .join('\n  -> ');
            throw new Error(
              `${routeFile.slice(SRC_ROOT.length + 1)} reaches sandbox-proxy/index.ts through a STATIC import — ` +
                'under bun test --parallel a concurrent graph evaluation then reads a route binding from a ' +
                'partially initialized module (the 2026-10-14/15 lane incidents). Read it at call time behind ' +
                `await import('../index') instead, and keep type-only imports with \`import type\`:\n  ${readable}`,
            );
          }
          if (visited.has(next)) continue;
          visited.add(next);
          cameFrom.set(next, file);
          queue.push(next);
        }
      }
    }
  });
});

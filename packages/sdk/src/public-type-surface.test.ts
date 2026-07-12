import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * A committed snapshot of the FULL type-level export surface — value AND
 * type-only bindings — reachable from every public entry point.
 *
 * Its sibling `public-surface.test.ts` snapshots `Object.keys(await import(entry))`,
 * which sees only the RUNTIME namespace: `export type` bindings erase at runtime,
 * so `SessionHandle`, `ClassifiedPart`, `KortixProject`, `Kortix`, `SessionModel`,
 * `TurnError`, … never appear there. A renamed type-only export therefore sails
 * past that guard green — yet it breaks a consumer's `import type { … }` exactly
 * as hard as a renamed function. This snapshot closes that blind spot by reading
 * exports through the TypeScript checker, which sees types and values alike.
 *
 * A snapshot diff is a QUESTION — "did I mean to change the public API?" — not a
 * file to re-record until the test goes green. A name that DISAPPEARS (rename or
 * removal) is breaking: alias the old name and bump a major. A name that APPEARS
 * is additive and fine.
 *
 * Regenerate deliberately:  UPDATE_TYPE_SURFACE_SNAPSHOT=1 bun test src/public-type-surface.test.ts
 */
const SNAPSHOT = join(import.meta.dir, 'public-type-surface.snapshot.json');
const PKG_ROOT = join(import.meta.dir, '..');

/** The entry set is every subpath in package.json's `exports` — root `.`,
 *  `./react`, `./server`, and every subpath the runtime snapshot already
 *  covers. Derived from the same source of truth as `public-surface.test.ts`,
 *  so the two snapshots can never drift on WHICH entries they describe. */
function collectTypeSurface(): Record<string, string[]> {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };
  const entries = Object.entries(pkg.exports).map(
    ([subpath, file]) => [subpath, join(PKG_ROOT, file)] as const,
  );

  // ONE ts.Program over every entry file. Building one program per entry would
  // reload the standard lib and the whole reachable graph ~30 times and dominate
  // the suite's runtime; a single program shares all of that.
  const program = ts.createProgram(
    entries.map(([, abs]) => abs),
    {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
      // We enumerate export SYMBOLS, never typecheck bodies — strictness is
      // irrelevant and off keeps this immune to unrelated type errors.
      strict: false,
    },
  );
  const checker = program.getTypeChecker();

  const surface: Record<string, string[]> = {};
  for (const [subpath, abs] of entries) {
    const sourceFile = program.getSourceFile(abs);
    if (!sourceFile) throw new Error(`type-surface: no source file for ${subpath} (${abs})`);
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) throw new Error(`type-surface: ${subpath} resolved to a non-module (no exports?)`);
    // getExportsOfModule follows `export *` and `export … from` and returns BOTH
    // value and type exports — the type-only ones are exactly what we're here for.
    surface[subpath] = checker
      .getExportsOfModule(moduleSymbol)
      .map((s) => s.getName())
      .sort();
  }
  return surface;
}

/** A human-readable, per-subpath account of what appeared and what vanished —
 *  vanished names are the breaking half a reviewer must not rubber-stamp. */
function describeDrift(
  expected: Record<string, string[]>,
  actual: Record<string, string[]>,
): string {
  const lines: string[] = [];
  for (const subpath of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
    const before = new Set(expected[subpath] ?? []);
    const after = new Set(actual[subpath] ?? []);
    const removed = [...before].filter((n) => !after.has(n));
    const added = [...after].filter((n) => !before.has(n));
    if (removed.length === 0 && added.length === 0) continue;
    lines.push(`  ${subpath}:`);
    for (const n of removed) lines.push(`    - ${n}   ← REMOVED/RENAMED — breaking; alias it and bump a major`);
    for (const n of added) lines.push(`    + ${n}   ← added — additive, fine`);
  }
  return lines.join('\n');
}

test('public TYPE-level export surface matches the committed snapshot', () => {
  const actual = collectTypeSurface();

  if (process.env.UPDATE_TYPE_SURFACE_SNAPSHOT === '1') {
    writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
    console.warn('public-type-surface.snapshot.json regenerated — REVIEW THE DIFF.');
    return;
  }

  expect(existsSync(SNAPSHOT)).toBe(true);
  const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, string[]>;

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    // A removed/renamed TYPE is a breaking change the runtime snapshot cannot
    // see. Surface the drift loudly before the bare toEqual failure, so the
    // reviewer's question — additive or breaking? — is answered at a glance.
    console.error(`\nType-level export surface changed (types + values):\n${describeDrift(expected, actual)}\n`);
  }
  expect(actual).toEqual(expected);
});

/**
 * Finds `mock.module(...)` stubs that list a module's exports by hand and
 * therefore DELETE every export they omit — `mock.module` replaces a module
 * WHOLESALE. Reports each stub whose key set is a strict subset of the real
 * module's runtime exports and that does not spread the real module.
 *
 * Why this matters: the deleted export does not fail where the stub is. It
 * fails in whatever OTHER file imports the missing name next, as
 * `SyntaxError: Export named '…' not found`, reported as "Unhandled error
 * between tests" and attributed to no test at all. It only shows up when files
 * are co-run — `bun test <dir>` — so the CI gate (scripts/test.sh, which passes
 * --isolate and gives every file its own process) never sees it, and the blame
 * lands on whichever innocent file happens to run next.
 *
 * The fix at each site is to spread the real module and override only what the
 * test needs, so a NEW export keeps working by default:
 *
 *   import * as realFoo from '../foo';
 *   mock.module('../foo', () => ({ ...realFoo, bar: () => 'fake' }));
 *
 * Two cautions before applying it mechanically:
 *   - A top-level `import` HOISTS above the file's own `process.env` writes. If
 *     the file sets env before importing config, use `const real = await
 *     import('../foo')` placed at the stub instead.
 *   - Not every module is safe to import for real. `../config` calls
 *     process.exit(1) on validation failure and `shared/db` builds a live
 *     handle, so those need per-site judgment rather than a blanket spread.
 *
 * Usage (from apps/api):  bun scripts/find-stub-export-gaps.ts .
 *
 * Static only: parses with Bun.Transpiler, never executes the target modules.
 */
import { Glob } from 'bun';
import { dirname, resolve, relative } from 'node:path';

const API_SRC = process.argv[2] ?? '.';

/** Runtime export names of a module, minus type-only ones (erased at runtime). */
async function realExports(file: string): Promise<string[] | null> {
  let src: string;
  try {
    src = await Bun.file(file).text();
  } catch {
    return null;
  }
  const t = new Bun.Transpiler({ loader: 'ts' });
  let names: string[];
  try {
    names = t.scan(src).exports;
  } catch {
    return null;
  }
  // Drop `export type X` / `export interface X` / `export type { X }` — erased.
  const typeOnly = new Set<string>();
  for (const m of src.matchAll(/^export\s+(?:type|interface)\s+([A-Za-z0-9_$]+)/gm)) typeOnly.add(m[1]);
  for (const m of src.matchAll(/^export\s+type\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) typeOnly.add(n);
    }
  }
  return names.filter((n) => !typeOnly.has(n));
}

/** Resolve a mock.module specifier to a file on disk. */
async function resolveSpec(fromFile: string, spec: string): Promise<string | null> {
  if (!spec.startsWith('.')) return null; // bare package — out of scope
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [`${base}.ts`, `${base}/index.ts`, `${base}.tsx`]) {
    if (await Bun.file(cand).exists()) return cand;
  }
  return null;
}

/** Top-level keys + whether a spread is present, from a factory object literal. */
function parseFactory(src: string, openIdx: number): { keys: string[]; hasSpread: boolean } | null {
  // openIdx points at the `{` that opens the returned object literal.
  let depth = 0;
  let end = -1;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const body = src.slice(openIdx + 1, end);

  const keys: string[] = [];
  let hasSpread = false;
  let d = 0;
  let seg = '';
  const flush = () => {
    const s = seg.trim();
    seg = '';
    if (!s) return;
    if (s.startsWith('...')) {
      hasSpread = true;
      return;
    }
    const m = s.match(/^(?:async\s+)?\*?\s*(?:'([^']+)'|"([^"]+)"|\[[^\]]*\]|([A-Za-z0-9_$]+))/);
    const name = m?.[1] ?? m?.[2] ?? m?.[3];
    if (name) keys.push(name);
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{' || c === '(' || c === '[') d++;
    else if (c === '}' || c === ')' || c === ']') d--;
    if (c === ',' && d === 0) flush();
    else seg += c;
  }
  flush();
  return { keys, hasSpread };
}

type Gap = { file: string; line: number; spec: string; missing: string[]; listed: number };
const gaps: Gap[] = [];
const glob = new Glob('**/*.{ts,tsx}');

for await (const rel of glob.scan({ cwd: API_SRC })) {
  const file = resolve(API_SRC, rel);
  const src = await Bun.file(file).text();
  if (!src.includes('mock.module(')) continue;

  const re = /mock\.module\(\s*['"]([^'"]+)['"]\s*,\s*\(\)\s*=>\s*\(?\s*\{/g;
  for (const m of src.matchAll(re)) {
    const spec = m[1];
    const target = await resolveSpec(file, spec);
    if (!target) continue;
    const exps = await realExports(target);
    if (!exps || exps.length === 0) continue;

    const openIdx = m.index! + m[0].length - 1;
    const parsed = parseFactory(src, openIdx);
    if (!parsed) continue;
    if (parsed.hasSpread) continue; // already safe

    const missing = exps.filter((e) => !parsed.keys.includes(e));
    if (missing.length === 0) continue;

    const line = src.slice(0, m.index!).split('\n').length;
    gaps.push({ file: relative(API_SRC, file), line, spec, missing, listed: parsed.keys.length });
  }
}

// Group by the module being stubbed — that is the unit of risk.
const byTarget = new Map<string, Gap[]>();
for (const g of gaps) {
  const key = g.spec.split('/').slice(-2).join('/');
  byTarget.set(key, [...(byTarget.get(key) ?? []), g]);
}
const sorted = [...byTarget.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [target, list] of sorted) {
  console.log(`\n### ${target}  — ${list.length} stub(s)`);
  for (const g of list) {
    console.log(`  ${g.file}:${g.line}  lists ${g.listed}, MISSING ${g.missing.length}: ${g.missing.join(', ')}`);
  }
}
console.log(`\nTOTAL under-specified stubs: ${gaps.length}`);

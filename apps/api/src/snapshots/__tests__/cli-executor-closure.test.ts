import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Scope guard for the in-sandbox `kortix executor` fingerprint (templates.ts
// CLI_EXECUTOR_CLOSURE).
//
// The snapshot runtime fingerprint used to hash ALL of apps/cli/src, so every
// developer-only CLI edit (`ship`, `cr`, `tunnel`, `self-host`, the scaffold
// surface, …) re-minted every project's runtime identity and moved the non-agent
// `swapKey`, disabling the cheap agent-swap and forcing a full rebuild. A sandbox
// session only ever runs `kortix executor` / `kortix executor mcp`, so the
// fingerprint now hashes just that command's import closure.
//
// This test re-derives the closure from the real import graph and asserts it is a
// SUBSET of the hashed set. If a future refactor makes the executor path import a
// file that isn't fingerprinted, this fails — so scoping can never silently ship a
// stale in-sandbox executor under an unchanged snapshot identity. When it fails,
// add the newly-imported file (or its dir) to CLI_EXECUTOR_CLOSURE in templates.ts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../..');
const CLI_SRC = resolve(REPO_ROOT, 'apps/cli/src');

// Must mirror CLI_EXECUTOR_CLOSURE in apps/api/src/snapshots/templates.ts.
const HASHED_CLOSURE = [
  'executor',
  'commands/executor.ts',
  'api/auth.ts',
  'api/client.ts',
  'api/config.ts',
  'api/sandbox-env.ts',
  'project-link.ts',
] as const;

// Entrypoints the sandbox actually invokes (`kortix executor …`). The `index.ts`
// dispatcher is deliberately NOT an entrypoint here: it imports EVERY subcommand
// for arg routing, so seeding from it would pull the whole (monolithic) CLI in.
// Its executor branch is just `argv[0] === 'executor' → runExecutor()`, whose
// behavior lives entirely in commands/executor.ts + executor/*.
const ENTRYPOINTS = [
  'commands/executor.ts',
  'executor/gateway.ts',
  'executor/io.ts',
  'executor/mcp.ts',
];

/** Resolve a relative import specifier (from `fromFile`) to a real .ts file, or null. */
function resolveImport(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** BFS the transitive relative-import closure (absolute file paths) under CLI_SRC. */
function importClosure(entrypoints: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = entrypoints.map((e) => resolve(CLI_SRC, e));
  const importRe = /from\s+['"](\.[^'"]+)['"]/g;
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(importRe)) {
      const target = resolveImport(file, m[1]);
      if (target) stack.push(target);
    }
  }
  return seen;
}

/** True iff `abs` is covered by a hashed closure entry (a file, or a dir prefix). */
function isHashed(abs: string): boolean {
  const rel = relative(CLI_SRC, abs);
  return HASHED_CLOSURE.some((entry) => {
    const norm = normalize(entry);
    return rel === norm || rel.startsWith(`${norm}/`);
  });
}

describe('kortix executor fingerprint closure', () => {
  test('every file the in-sandbox executor imports is in the hashed CLI closure', () => {
    const closure = [...importClosure(ENTRYPOINTS)];
    // All entrypoints must resolve — a typo here would make the guard vacuous.
    for (const e of ENTRYPOINTS) {
      expect(existsSync(resolve(CLI_SRC, e))).toBe(true);
    }
    const uncovered = closure
      .filter((f) => !isHashed(f))
      .map((f) => relative(CLI_SRC, f))
      .sort();
    // If this fails, the executor now depends on a file that isn't fingerprinted:
    // a change to it would ship a stale binary under an unchanged snapshot name.
    // Add the file (or its directory) to CLI_EXECUTOR_CLOSURE in templates.ts.
    expect(uncovered).toEqual([]);
  });

  test('every hashed closure entry exists (no dead fingerprint inputs)', () => {
    for (const entry of HASHED_CLOSURE) {
      const abs = resolve(CLI_SRC, entry);
      expect(isAbsolute(abs)).toBe(true);
      expect(existsSync(abs)).toBe(true);
    }
  });
});

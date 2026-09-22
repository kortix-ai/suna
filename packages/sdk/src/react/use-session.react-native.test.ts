/**
 * The tripwire's blind spot, closed for the one hook a React Native host mounts.
 *
 * `src/index.isomorphic.test.ts` walks the relative-import graph and fails on a
 * forbidden specifier. Its own docs state the limit: "The tripwire walks
 * imports. It cannot see globals." `window`, `document`, `localStorage`,
 * `sessionStorage` and `indexedDB` are globals, so a green tripwire proves the
 * core is free of framework IMPORTS — never that it RUNS on RN.
 *
 * That gap is not theoretical. Touching a bare web global on Hermes throws a
 * `ReferenceError`, not `undefined`, so one unguarded read anywhere on this
 * graph is a crash on app open — and `useSession` reaches 175 files.
 *
 * This asserts the property that makes `apps/mobile` able to mount the SDK's
 * one-hook session surface at all: every web-global read on that graph is
 * behind a `typeof … !== 'undefined'` check or a `try`. It is deliberately a
 * source-level scan rather than a runtime import — importing the graph under a
 * globals-stripped sandbox would need React, a QueryClient and a DOM, which is
 * exactly the machinery an RN host does not have.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '..');
const ENTRY = resolve(SRC, 'react/use-session.ts');

/** Globals that do not exist on Hermes / React Native. */
const WEB_ONLY_GLOBALS = ['localStorage', 'sessionStorage', 'indexedDB', 'document', 'window'];

const GUARD =
  /typeof\s+(window|localStorage|sessionStorage|indexedDB|document)\s*[!=]==?\s*['"]undefined['"]/;

/**
 * The one module whose internals may touch `localStorage` without a guard on
 * the same line.
 *
 * `managed-storage.ts` IS the package's guarded-storage boundary: every export
 * (`safeGetItem`, `safeSetItem`, `safeRemoveItem`, `ScopedCache.set/prune`,
 * `pruneDisposableCaches`, `pruneAllRegisteredCaches`) opens with
 * `if (!hasWindow()) return …`, and its private helpers (`allKeys`,
 * `disposableEntriesOldestFirst`) are reachable only through them. Verified by
 * reading every call site, because a line-window scan cannot see a guard that
 * lives in a CALLER.
 *
 * Allowlisted by exact path, never by pattern: a new unguarded global in any
 * other file on the graph still fails this test, which is the point.
 */
const GUARDED_STORAGE_BOUNDARY = 'platform/storage/managed-storage.ts';

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx']) {
    if (existsSync(candidate)) return candidate;
  }
  return existsSync(base) ? base : null;
}

interface UnguardedGlobalRead {
  file: string;
  line: number;
  global: string;
  code: string;
}

/** Walks the relative-import graph from `entry`, collecting unguarded reads. */
function scanForUnguardedWebGlobals(entry: string): {
  filesWalked: number;
  unguarded: UnguardedGlobalRead[];
} {
  const seen = new Set<string>();
  const unguarded: UnguardedGlobalRead[] = [];

  const walk = (file: string): void => {
    if (seen.has(file) || !existsSync(file) || file.includes('.test.')) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    const lines = source.split('\n');

    lines.forEach((line, index) => {
      // Drop line comments and JSDoc continuation lines — a global NAMED in
      // prose is not a global READ.
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      for (const globalName of WEB_ONLY_GLOBALS) {
        // A read is `name.` / `name[` / `name(` not preceded by a dot, word
        // character, or quote — so `window.x` counts and `opts.window` does not.
        const read = new RegExp(`(^|[^.\\w'"\`])${globalName}\\s*[.\\[(]`);
        if (!read.test(code)) continue;
        const guardedOnLine = GUARD.test(code);
        // A guard within the preceding few lines covers the block it opens —
        // `if (!hasWindow()) return;` at the top of a function, a `try {`, or an
        // early-return typeof check.
        const guardedAbove = lines
          .slice(Math.max(0, index - 6), index)
          .some((prior) => GUARD.test(prior) || /^\s*try\s*\{/.test(prior) || /hasWindow\(\)/.test(prior));
        if (guardedOnLine || guardedAbove) continue;
        const relative = file.slice(SRC.length + 1);
        if (relative === GUARDED_STORAGE_BOUNDARY) continue;
        unguarded.push({
          file: relative,
          line: index + 1,
          global: globalName,
          code: code.trim().slice(0, 100),
        });
      }
    });

    for (const match of source.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)) {
      const next = resolveRelative(file, match[1]!);
      if (next) walk(next);
    }
  };

  walk(entry);
  return { filesWalked: seen.size, unguarded };
}

describe('useSession runs on React Native', () => {
  test('reaches a large graph — a scan that walked nothing would prove nothing', () => {
    const { filesWalked } = scanForUnguardedWebGlobals(ENTRY);
    // The hook composes start/switch/health/SSE/sync/send across the package.
    // If this collapses, the resolver broke and the assertion below is vacuous.
    expect(filesWalked).toBeGreaterThan(100);
  });

  test('reads no web-only global unguarded anywhere on its import graph', () => {
    const { unguarded } = scanForUnguardedWebGlobals(ENTRY);
    const detail = unguarded
      .map((hit) => `  ${hit.file}:${hit.line}  [${hit.global}]  ${hit.code}`)
      .join('\n');
    expect(
      unguarded,
      unguarded.length === 0
        ? ''
        : `Unguarded web-global reads would ReferenceError on Hermes:\n${detail}\n` +
            `Guard with \`typeof ${unguarded[0]?.global} !== 'undefined'\` or inject the dependency.`,
    ).toEqual([]);
  });

  test('the scanner actually detects an unguarded read (it can fail)', () => {
    // A guard that cannot fail is a comment that costs CPU. Prove the detector
    // fires on the exact shape it exists to catch, without editing a real file.
    const { unguarded } = scanForUnguardedWebGlobals(
      resolve(import.meta.dir, '__fixtures__/unguarded-global-fixture.ts'),
    );
    expect(unguarded).toHaveLength(1);
    expect(unguarded[0]?.global).toBe('localStorage');
  });
});

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "The root entry is canonical" — asserted, not just documented.
 *
 * `src/index.ts` opens by promising that the whole framework-free surface is
 * reachable from `@kortix/sdk` alone, and that every legacy subpath is only an
 * alias. Every doc, README table, and deprecation notice in this package rests
 * on that promise. Until this file existed, nothing checked it: a name could be
 * exported from `@kortix/sdk/files` and from nowhere else, and the only way to
 * find out was for a consumer to follow our own advice and have their build
 * break.
 *
 * So: every runtime name reachable from an isomorphic subpath MUST also be
 * reachable from the root barrel. The root may legitimately export MORE (it is
 * the union of all of them); it may never export less.
 *
 * This is a subset check, not an equality check, and it is deliberately
 * derived from `package.json` rather than a hardcoded list — add a new subpath
 * and this test immediately demands that it either be re-exported from root or
 * be explicitly justified in `NOT_ROOT_REACHABLE` below.
 */

/**
 * The subpaths that are legitimately NOT reachable from the root barrel. Each
 * needs a reason that survives review; "it was easier" is not one.
 *
 *  - `./react`  — React is an optional peer dependency. Pulling it into the
 *                 root barrel would force it onto every consumer, including
 *                 the CLI and worker hosts that have no React at all.
 *  - `./server` — imports `node:async_hooks`. The root barrel is
 *                 `isomorphic-core` tier, which forbids every `node:` import.
 *  - the five zustand stores (and their un-prefixed `@deprecated` aliases) —
 *                 `browser-only` tier. `zustand` is a forbidden import in
 *                 `isomorphic-core`, so re-exporting these from root would
 *                 break the framework-free tripwire in `index.isomorphic.test.ts`
 *                 and drag zustand into every consumer's bundle. These are
 *                 internal machinery outside semver; `@kortix/sdk/internal/*`
 *                 is their only address on purpose.
 */
const NOT_ROOT_REACHABLE = new Set([
  './react',
  './server',
  './internal/sync-store',
  './internal/server-store',
  './internal/sandbox-connection-store',
  './internal/opencode-pending-store',
  './internal/idb-sync-cache',
  './sync-store',
  './server-store',
  './sandbox-connection-store',
  './opencode-pending-store',
  './idb-sync-cache',
]);

function packageExports(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };
  return pkg.exports;
}

async function namesOf(file: string): Promise<string[]> {
  const mod = (await import(file.replace(/^\.\/src\//, './'))) as Record<string, unknown>;
  return Object.keys(mod).sort();
}

test('every isomorphic subpath export is also reachable from the root barrel', async () => {
  const exportsMap = packageExports();
  const rootNames = new Set(await namesOf(exportsMap['.']!));

  const missingBySubpath: Record<string, string[]> = {};
  for (const [subpath, file] of Object.entries(exportsMap)) {
    if (subpath === '.' || NOT_ROOT_REACHABLE.has(subpath)) continue;
    const missing = (await namesOf(file)).filter((name) => !rootNames.has(name));
    if (missing.length > 0) missingBySubpath[subpath] = missing;
  }

  // An empty object means every alias really is only an alias.
  expect(missingBySubpath).toEqual({});
});

test('NOT_ROOT_REACHABLE only names subpaths that actually exist', () => {
  const declared = new Set(Object.keys(packageExports()));
  const stale = [...NOT_ROOT_REACHABLE].filter((subpath) => !declared.has(subpath));
  expect(stale).toEqual([]);
});

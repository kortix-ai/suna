import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Isomorphic-core tripwire, extended to cover every non-React subpath in
 * `package.json`'s `exports` map, not just the root `.` barrel — each of
 * those subpaths is a promise to SOME host (mobile, CLI, a Node backend, a
 * browser store) about what it can safely pull in. Three tiers, each with
 * its own rules (see `SUBPATH_TIERS` below):
 *
 *   1. Isomorphic core (root `.` + most subpaths): no react/next/zustand/
 *      react-query imports (even type-only — a type import still forces the
 *      dependency on every consumer's typecheck), no 'use client' directive,
 *      no `node:`-prefixed imports (these must run in a browser, RN, or a
 *      CLI with no Node-specific APIs guaranteed).
 *   2. Node-allowed (`./server` only): same react/zustand/'use client' bans,
 *      but `node:` imports ARE allowed — specifically `node:async_hooks`,
 *      which `config-node.ts` needs for per-request config isolation. Not a
 *      blanket allowance for arbitrary Node built-ins creeping in.
 *   3. Browser-only stores (idb-sync-cache, server-store, sync-store,
 *      sandbox-connection-store, opencode-pending-store): these are zustand
 *      stores (zustand is fine here, it's framework-glue-light and works
 *      outside React) meant to run in a browser — real `window`/
 *      `sessionStorage`/`localStorage`/`indexedDB` globals are expected and
 *      fine. They get ONLY the "no real `react` import" check (a truly
 *      severed tripwire against sneaking `react`/`react-dom` in), not the
 *      full isomorphic-core ruleset — 'use client' directives are expected
 *      here and not worth asserting on; the rest of a full runtime check
 *      already runs in this file's other tests.
 *
 * Every rule stays STATIC (walk the import graph — no bundler, no runtime
 * import) so it's exhaustive over every reachable file, not just what a given
 * test happens to exercise.
 */

const FORBIDDEN_MODULES = ['react', 'react-dom', 'next', 'zustand', '@tanstack/react-query'];
/** The browser-only tier only forbids the actual React family — zustand is
 *  expected there (see the module doc above). */
const REACT_ONLY = ['react', 'react-dom', 'next'];
/** The one `node:` import the node-allowed tier may carry. */
const ALLOWED_NODE_IMPORT = 'node:async_hooks';

const SRC_ROOT = join(import.meta.dir);

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return existsSync(base) ? base : null;
}

/** Walks `entryFile`'s full relative-import graph (type-only imports
 *  included — a `import type` still shows up in this regex, which is the
 *  point: a type-only react import still forces the dependency on every
 *  consumer's typecheck). Returns every reachable local file plus every
 *  external (non-relative) specifier imported, and by whom. */
function collectGraph(entryFile: string): { files: string[]; externals: Map<string, string[]> } {
  const seen = new Set<string>();
  const externals = new Map<string, string[]>();
  const importRe =
    /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

  function walk(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importRe)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec) continue;
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(file, spec);
        expect(resolved).not.toBeNull();
        if (resolved) walk(resolved);
      } else {
        const importers = externals.get(spec) ?? [];
        importers.push(file.slice(SRC_ROOT.length + 1));
        externals.set(spec, importers);
      }
    }
  }

  walk(entryFile);
  return { files: [...seen], externals };
}

function collectRootGraph() {
  return collectGraph(join(SRC_ROOT, 'index.ts'));
}

test('root export graph pulls no react/next/zustand/react-query code', () => {
  const { externals } = collectRootGraph();
  for (const [spec, importers] of externals) {
    const forbidden = FORBIDDEN_MODULES.find((m) => spec === m || spec.startsWith(`${m}/`));
    expect(forbidden ? `"${spec}" imported by ${importers.join(', ')}` : null).toBeNull();
  }
});

test("root export graph has no 'use client' directives", () => {
  const { files } = collectRootGraph();
  for (const file of files) {
    const head = readFileSync(file, 'utf8').trimStart();
    const hasDirective = head.startsWith(`'use client'`) || head.startsWith(`"use client"`);
    expect(hasDirective ? `'use client' in ${file.slice(SRC_ROOT.length + 1)}` : null).toBeNull();
  }
});

test('root entry loads and createKortix constructs outside React', async () => {
  const sdk = await import('./index');
  const kortix = sdk.createKortix({
    backendUrl: 'http://isomorphic.test/v1',
    getToken: async () => null,
  });
  expect(typeof kortix.projects.list).toBe('function');
  expect(typeof kortix.project('p').secrets.upsert).toBe('function');
  const session = kortix.session('p', 's');
  expect(typeof session.send).toBe('function');
  expect(typeof session.health).toBe('function');
  // previewUrl (like health/proxyUrl/runtime) never falls back to a globally
  // active sandbox — it throws until this handle resolves its OWN runtime via
  // ensureReady()/start()/send(). See kortix.test.ts for the resolved-runtime cases.
  expect(() => session.previewUrl(3000)).toThrow(/Session runtime not ready/);
});

// ============================================================================
// Every OTHER non-React subpath in package.json's `exports` map — tiered.
// ============================================================================

type Tier = 'isomorphic-core' | 'node-allowed' | 'browser-only';

interface Subpath {
  name: string;
  file: string;
  tier: Tier;
}

const SUBPATH_TIERS: Subpath[] = [
  { name: './server', file: 'server.ts', tier: 'node-allowed' },
  { name: './acp', file: 'acp/index.ts', tier: 'isomorphic-core' },
  { name: './acp/transcript', file: 'acp/transcript.ts', tier: 'isomorphic-core' },
  { name: './runtime-client', file: 'runtime/client.ts', tier: 'isomorphic-core' },
  { name: './config', file: 'platform/config.ts', tier: 'isomorphic-core' },
  { name: './auth', file: 'platform/auth.ts', tier: 'isomorphic-core' },
  { name: './api-client', file: 'platform/api-client.ts', tier: 'isomorphic-core' },
  { name: './projects-client', file: 'platform/projects-client/index.ts', tier: 'isomorphic-core' },
  { name: './feature-flags', file: 'platform/feature-flags.ts', tier: 'isomorphic-core' },
  { name: './fresh-sessions', file: 'platform/fresh-sessions.ts', tier: 'isomorphic-core' },
  { name: './instance-routes', file: 'platform/instance-routes.ts', tier: 'isomorphic-core' },
  { name: './opencode-errors', file: 'platform/opencode-errors.ts', tier: 'isomorphic-core' },
  { name: './idb-sync-cache', file: 'state/idb-sync-cache.ts', tier: 'browser-only' },
  { name: './platform-client', file: 'platform/platform-client/index.ts', tier: 'isomorphic-core' },
  { name: './server-store', file: 'state/server-store.ts', tier: 'browser-only' },
  { name: './sync-store', file: 'state/sync-store.ts', tier: 'browser-only' },
  { name: './event-stream', file: 'state/event-stream.ts', tier: 'isomorphic-core' },
  { name: './sandbox-connection-store', file: 'state/sandbox-connection-store.ts', tier: 'browser-only' },
  { name: './opencode-pending-store', file: 'state/opencode-pending-store.ts', tier: 'browser-only' },
  { name: './files', file: 'files/client.ts', tier: 'isomorphic-core' },
  { name: './session', file: 'session/index.ts', tier: 'isomorphic-core' },
  { name: './session/url', file: 'session/url.ts', tier: 'isomorphic-core' },
  { name: './turns', file: 'turns/index.ts', tier: 'isomorphic-core' },
];

test('SUBPATH_TIERS matches package.json exports (minus "." and "./react")', () => {
  const pkg = JSON.parse(readFileSync(join(SRC_ROOT, '..', 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };
  const exportedSubpaths = Object.keys(pkg.exports).filter((k) => k !== '.' && k !== './react');
  expect(new Set(SUBPATH_TIERS.map((s) => s.name))).toEqual(new Set(exportedSubpaths));

  // And every entry file must match what package.json actually points at.
  for (const subpath of SUBPATH_TIERS) {
    const expected = `./src/${subpath.file}`;
    expect(pkg.exports[subpath.name]).toBe(expected);
  }
});

for (const subpath of SUBPATH_TIERS) {
  const entryFile = join(SRC_ROOT, subpath.file);

  test(`${subpath.name} (${subpath.tier}): no forbidden framework imports`, () => {
    const { externals } = collectGraph(entryFile);
    const forbiddenList = subpath.tier === 'browser-only' ? REACT_ONLY : FORBIDDEN_MODULES;
    for (const [spec, importers] of externals) {
      const forbidden = forbiddenList.find((m) => spec === m || spec.startsWith(`${m}/`));
      expect(forbidden ? `"${spec}" imported by ${importers.join(', ')} (subpath ${subpath.name})` : null).toBeNull();
    }
  });

  if (subpath.tier !== 'browser-only') {
    test(`${subpath.name} (${subpath.tier}): no 'use client' directives`, () => {
      const { files } = collectGraph(entryFile);
      for (const file of files) {
        const head = readFileSync(file, 'utf8').trimStart();
        const hasDirective = head.startsWith(`'use client'`) || head.startsWith(`"use client"`);
        expect(
          hasDirective ? `'use client' in ${file.slice(SRC_ROOT.length + 1)} (subpath ${subpath.name})` : null,
        ).toBeNull();
      }
    });
  }

  if (subpath.tier === 'isomorphic-core') {
    test(`${subpath.name} (isomorphic-core): no node:-prefixed imports`, () => {
      const { externals } = collectGraph(entryFile);
      for (const [spec, importers] of externals) {
        expect(
          spec.startsWith('node:')
            ? `"${spec}" imported by ${importers.join(', ')} (subpath ${subpath.name})`
            : null,
        ).toBeNull();
      }
    });
  }

  if (subpath.tier === 'node-allowed') {
    test(`${subpath.name} (node-allowed): only ${ALLOWED_NODE_IMPORT} among node:-prefixed imports`, () => {
      const { externals } = collectGraph(entryFile);
      for (const [spec, importers] of externals) {
        if (!spec.startsWith('node:')) continue;
        expect(
          spec !== ALLOWED_NODE_IMPORT
            ? `unexpected node import "${spec}" imported by ${importers.join(', ')} (subpath ${subpath.name})`
            : null,
        ).toBeNull();
      }
    });
  }
}

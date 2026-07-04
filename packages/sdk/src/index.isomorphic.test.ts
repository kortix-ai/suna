import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Isomorphic-core tripwire. The root `.` export is the SDK's framework-free
 * surface — mobile, CLI, and server hosts load it outside any React/Next
 * context. Two guards:
 *   1. Static: walk the root entry's full import graph; no module may import
 *      react/next/zustand/react-query (even type-only — a type import still
 *      forces the dependency on every consumer's typecheck) or carry a
 *      'use client' directive.
 *   2. Runtime: the entry imports in plain bun and `createKortix` constructs.
 */

const FORBIDDEN_MODULES = ['react', 'react-dom', 'next', 'zustand', '@tanstack/react-query'];

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

function collectRootGraph(): { files: string[]; externals: Map<string, string[]> } {
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

  walk(join(SRC_ROOT, 'index.ts'));
  return { files: [...seen], externals };
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

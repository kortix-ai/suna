import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { uiSourcePath } from '@/test-utils/read-source';

const SKELETON = uiSourcePath('workspace/layout/project-files-skeleton.tsx');
const UI_SRC = resolve(SKELETON, '../../..');

/**
 * Modules too heavy to sit in the loading boundary's payload: the file browser
 * and the file viewer (every `@kortix/ui/files/…` file), and the workspace barrel
 * that re-exports screens built on them.
 */
const HEAVY = ['@kortix/ui/files', '@kortix/ui/file-viewer'];
const HEAVY_BARRELS = ['@kortix/ui/workspace'];

/**
 * The module specifiers a file actually imports — static and dynamic.
 *
 * Matching import specifiers rather than raw source text is deliberate. A bare
 * `not.toContain('@kortix/ui/files')` cannot tell an import from a
 * comment ABOUT imports, so it would fail the very doc comment that explains
 * this rule to the next reader, and the only way to pass would be to make that
 * comment vaguer. The test must constrain behaviour, not vocabulary.
 */
function importedSpecifiers(source: string): string[] {
  return [
    ...[...source.matchAll(/import\s[^;]*?from\s+'([^']+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/import\s*\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
    // Side-effect import: `import '<specifier>';` — no `from`, so the first
    // matcher above misses it entirely. Deliberately out of scope: double
    // quotes, `export ... from`, and `require()`. This repo is single-quote
    // and ESM-only by lint rule, so those forms don't occur here.
    ...[...source.matchAll(/import\s+'([^']+)'/g)].map((m) => m[1]),
  ];
}

/** A relative specifier in a packages/ui/src file, named the way a host imports it. */
function asPackageSpecifier(specifier: string, fromFile?: string): string {
  if (!fromFile || !specifier.startsWith('.')) return specifier;
  return `@kortix/ui/${relative(UI_SRC, resolve(dirname(fromFile), specifier))}`;
}

function heavyImports(source: string, fromFile?: string): string[] {
  return importedSpecifiers(source)
    .map((specifier) => asPackageSpecifier(specifier, fromFile))
    .filter(
      (specifier) =>
        HEAVY_BARRELS.includes(specifier) ||
        HEAVY.some((heavy) => specifier === heavy || specifier.startsWith(`${heavy}/`)),
    );
}

describe('files route loading boundary', () => {
  test('the route has a loading.tsx navigation boundary', () => {
    // Without it the click freezes the previous page, AND — because the project
    // layout reads cookies(), making this route dynamic — Next.js has no
    // cacheable target for the sidebar's prefetching Link.
    expect(existsSync(resolve(import.meta.dir, 'loading.tsx'))).toBe(true);
  });

  test('the loading boundary imports no heavy module', () => {
    const source = readFileSync(resolve(import.meta.dir, 'loading.tsx'), 'utf8');

    expect(heavyImports(source)).toEqual([]);
    expect(source).toContain('ProjectFilesSkeleton');
  });

  test('the shared skeleton imports no heavy module', () => {
    // It renders inside the loading boundary. Importing the 9k-LOC barrel or
    // the 1,877-LOC file viewer here would put the heavy chunk back on the
    // critical path this boundary exists to cover.
    const source = readFileSync(SKELETON, 'utf8');

    expect(heavyImports(source, SKELETON)).toEqual([]);
  });

  test('the heavy-import detector actually detects', () => {
    // Guards the guard: if the regex stops matching, the two tests above pass
    // vacuously and the constraint silently disappears.
    expect(heavyImports("import { X } from '@kortix/ui/files';")).toEqual(['@kortix/ui/files']);
    expect(heavyImports("const m = await import('@kortix/ui/file-viewer');")).toEqual([
      '@kortix/ui/file-viewer',
    ]);
    expect(heavyImports("import { X } from '@kortix/ui/workspace';")).toEqual(['@kortix/ui/workspace']);
    // A package file names the same modules relatively.
    expect(heavyImports("import { X } from '../../files/viewer/file-viewer';", SKELETON)).toEqual([
      '@kortix/ui/files/viewer/file-viewer',
    ]);
    // Side-effect import — no `from` clause — used to be missed entirely,
    // silently switching this constraint off for that import form.
    expect(heavyImports("import '@kortix/ui/files/some-styles.css';")).toEqual([
      '@kortix/ui/files/some-styles.css',
    ]);
    expect(heavyImports('// mentions @kortix/ui/files in prose only')).toEqual([]);
  });
});

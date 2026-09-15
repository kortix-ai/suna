import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_ROOT = resolve(import.meta.dir, '../../../../../..');
const SKELETON = resolve(
  WEB_ROOT,
  'src/features/workspace/project-layout/project-files-skeleton.tsx',
);

/** Modules too heavy to sit in the loading boundary's payload. */
const HEAVY = ['@/features/project-files', '@/features/file-viewer'];

/**
 * The module specifiers a file actually imports — static and dynamic.
 *
 * Matching import specifiers rather than raw source text is deliberate. A bare
 * `not.toContain('@/features/project-files')` cannot tell an import from a
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

function heavyImports(source: string): string[] {
  return importedSpecifiers(source).filter((specifier) =>
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

    expect(heavyImports(source)).toEqual([]);
  });

  test('the heavy-import detector actually detects', () => {
    // Guards the guard: if the regex stops matching, the two tests above pass
    // vacuously and the constraint silently disappears.
    expect(heavyImports("import { X } from '@/features/project-files';")).toEqual([
      '@/features/project-files',
    ]);
    expect(heavyImports("const m = await import('@/features/file-viewer/x');")).toEqual([
      '@/features/file-viewer/x',
    ]);
    // Side-effect import — no `from` clause — used to be missed entirely,
    // silently switching this constraint off for that import form.
    expect(heavyImports("import '@/features/project-files/some-styles.css';")).toEqual([
      '@/features/project-files/some-styles.css',
    ]);
    expect(heavyImports('// mentions @/features/project-files in prose only')).toEqual([]);
  });
});

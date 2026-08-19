import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_ROOT = resolve(import.meta.dir, '../../../../..');
const LOADING = resolve(WEB_ROOT, 'src/app/(app)/projects/[id]/loading.tsx');

/**
 * Modules too heavy to sit in the loading boundary's payload. ProjectHome is on
 * the list because it pulls the composer, SessionWelcome and the billing stack —
 * the whole point of this boundary is a payload small enough to prefetch.
 */
const HEAVY = [
  '@/features/project-files',
  '@/features/file-viewer',
  '@/features/workspace/project-layout/project-home',
];

/** Matches import specifiers rather than raw text, so a doc comment ABOUT an
 * import cannot fail the test. Same approach as files-route-contract.test.ts. */
function importedSpecifiers(source: string): string[] {
  return [
    ...[...source.matchAll(/import\s[^;]*?from\s+'([^']+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/import\s*\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
    ...[...source.matchAll(/import\s+'([^']+)'/g)].map((m) => m[1]),
  ];
}

describe('project home loading boundary', () => {
  test('exists', () => {
    expect(existsSync(LOADING)).toBe(true);
  });

  test('default-exports a component', () => {
    expect(readFileSync(LOADING, 'utf8')).toContain('export default function ProjectHomeLoading(');
  });

  test('imports no heavy feature module', () => {
    const specifiers = importedSpecifiers(readFileSync(LOADING, 'utf8'));

    const offenders = specifiers.filter((specifier) =>
      HEAVY.some((heavy) => specifier === heavy || specifier.startsWith(`${heavy}/`)),
    );

    expect(offenders).toEqual([]);
  });

  test("matches ProjectHome's root container so the handover does not shift layout", () => {
    const source = readFileSync(LOADING, 'utf8');

    expect(source).toContain('relative flex min-h-0 flex-1 flex-col overflow-hidden');
    expect(source).toContain('px-4.5');
  });
});

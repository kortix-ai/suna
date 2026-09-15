import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const WEB_ROOT = resolve(import.meta.dir, '../../../../..');
const LOADING = resolve(WEB_ROOT, 'src/app/(app)/projects/[id]/loading.tsx');
const SESSION_LOADING = resolve(WEB_ROOT, 'src/app/(app)/projects/[id]/sessions/[sessionId]/loading.tsx');

/**
 * Every navigation boundary inside an open project. The session boundary is
 * covered through LOADING: with no first-prompt preview it renders that one.
 */
const PANE_BOUNDARIES = [
  LOADING,
  resolve(WEB_ROOT, 'src/app/(app)/projects/[id]/(capabilities)/loading.tsx'),
  resolve(WEB_ROOT, 'src/app/(app)/projects/[id]/files/loading.tsx'),
];

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

async function renderBoundary(path: string): Promise<string> {
  const { default: Boundary } = await import(path);
  return renderToStaticMarkup(createElement(Boundary));
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

  test('a session opened from the sidebar falls back to this boundary', () => {
    // The path in the bug report: no first-prompt preview, so the session
    // boundary paints whatever LOADING paints.
    const source = readFileSync(SESSION_LOADING, 'utf8');

    expect(importedSpecifiers(source)).toContain('../../loading');
    expect(source).toContain('return <ProjectHomeLoading />');
  });
});

describe('project navigation boundaries', () => {
  for (const path of PANE_BOUNDARIES) {
    const name = path.slice(path.indexOf('projects/'));

    test(`${name} paints the Kortix mark sized to the content pane`, async () => {
      const markup = await renderBoundary(path);

      expect(markup).toContain('data-slot="project-pending-screen"');
      expect(markup).toContain('flex-1');
      // The viewport variant would overflow the pane beside the sidebar.
      expect(markup).not.toContain('min-h-svh');
    });

    // Rendered, not grepped: a source-text check passes while an extracted
    // placeholder component still paints grey bars.
    test(`${name} paints no skeleton`, async () => {
      const markup = await renderBoundary(path);
      const skeletonImports = importedSpecifiers(readFileSync(path, 'utf8')).filter((specifier) =>
        /skeleton/i.test(specifier),
      );

      // Exactly one pulsing node: the mark. The old skeleton had five bars.
      expect(markup.match(/animate-pulse/g) ?? []).toHaveLength(1);
      expect(skeletonImports).toEqual([]);
    });
  }
});

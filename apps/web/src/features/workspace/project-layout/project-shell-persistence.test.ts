import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const webRoot = join(import.meta.dir, '../../..');
const projectRouteRoot = join(webRoot, 'app/(app)/projects/[id]');
const shellSource = readFileSync(join(import.meta.dir, 'project-shell.tsx'), 'utf8');
const layoutSource = readFileSync(join(projectRouteRoot, 'layout.tsx'), 'utf8');
const pageSources = [
  'page.tsx',
  'files/page.tsx',
  'sessions/page.tsx',
  'sessions/[sessionId]/page.tsx',
].map((path) => readFileSync(join(projectRouteRoot, path), 'utf8'));

describe('persistent project shell', () => {
  test('mounts the shell once in the shared project layout', () => {
    expect(layoutSource).toContain('<ProjectShell projectId={projectId}>');
    for (const source of pageSources) expect(source).not.toContain('<ProjectShell');
  });

  test('keeps the global presentation dialog mounted across child routes', () => {
    expect(shellSource).toContain('<PresentationViewerWrapper />');
    expect(pageSources[3]).not.toContain('<PresentationViewerWrapper />');
  });
});

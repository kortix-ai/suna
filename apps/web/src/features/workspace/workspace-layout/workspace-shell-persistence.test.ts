import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const webRoot = join(import.meta.dir, '../../..');
const workspaceRouteRoot = join(webRoot, 'app/(app)/workspaces/[id]');
const shellSource = readFileSync(join(import.meta.dir, 'workspace-shell.tsx'), 'utf8');
const layoutSource = readFileSync(join(workspaceRouteRoot, 'layout.tsx'), 'utf8');
const pageSources = [
  'page.tsx',
  'files/page.tsx',
  'sessions/page.tsx',
  'sessions/[sessionId]/page.tsx',
].map((path) => readFileSync(join(workspaceRouteRoot, path), 'utf8'));

describe('persistent workspace shell', () => {
  test('mounts the shell once in the shared project layout', () => {
    expect(layoutSource).toContain('<WorkspaceShell workspaceId={workspaceId}>');
    for (const source of pageSources) expect(source).not.toContain('<WorkspaceShell');
  });

  test('keeps the global presentation dialog mounted across child routes', () => {
    expect(shellSource).toContain('<PresentationViewerWrapper />');
    expect(pageSources[3]).not.toContain('<PresentationViewerWrapper />');
  });
});

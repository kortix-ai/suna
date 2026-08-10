import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const boundarySource = readFileSync(join(import.meta.dir, 'sandbox-loading-boundary.tsx'), 'utf8');
const workspaceLayoutSource = readFileSync(
  join(import.meta.dir, '../../app/(app)/workspaces/[id]/layout.tsx'),
  'utf8',
);
const workspaceAccessSource = readFileSync(
  join(import.meta.dir, '../../components/workspaces/workspace-access-boundary.tsx'),
  'utf8',
);
const workspaceHomeSource = readFileSync(
  join(import.meta.dir, '../workspace/workspace-layout/workspace-home.tsx'),
  'utf8',
);

describe('session navigation loading boundaries', () => {
  test('runtime-not-ready retries never render the full-page ASCII logo', () => {
    expect(boundarySource).toContain('return null;');
    expect(boundarySource).not.toContain('KortixHyperLogo');
    expect(boundarySource).not.toContain('min-h-[50vh]');
  });

  test('the workspace shell cannot be replaced by a route-wide sandbox fallback', () => {
    expect(workspaceLayoutSource).not.toContain('SandboxLoadingBoundary');
    expect(workspaceLayoutSource).toContain('<WorkspaceAccessBoundary workspaceId={workspaceId}>');
    expect(workspaceLayoutSource).not.toContain('SessionCacheWarmer');
    expect(workspaceLayoutSource).toContain('<WorkspaceShell workspaceId={workspaceId}>');
  });

  test('first workspace access still keeps its intentional full-page loader', () => {
    // The mirror of the `return null` rule above: a runtime-not-ready RETRY
    // must stay invisible, but the very FIRST project fetch owns the whole
    // viewport, so it has to show something rather than a blank screen.
    expect(workspaceAccessSource).toContain('if (query.isLoading)');
    expect(workspaceAccessSource).toContain('<AuthPendingScreen footer={false} />');
    expect(workspaceAccessSource).not.toMatch(/query\.isLoading\)\s*return null/);
  });

  test('the first-fetch loader carries no legal footer', () => {
    // It resolves into the workspace shell, which has no footer of its own, so a
    // pinned Terms/Privacy line would flash once per project open and vanish.
    // The gate screens below it keep theirs — they are terminal pages.
    expect(workspaceAccessSource).toContain('<AuthPendingScreen footer={false} />');
    expect(workspaceAccessSource).toContain('<AuthFrame>');
  });

  test('the access boundary uses the lightweight project route', () => {
    expect(workspaceAccessSource).toContain('getWorkspace(workspaceId');
    expect(workspaceAccessSource).not.toContain('getWorkspaceDetail(workspaceId');
  });

  test('workspace home does not start the members query before Customize opens', () => {
    // The boundary reads the lightweight project route under its own key. The
    // key is a constant now because three call sites share it, so assert the
    // constant's value and its use rather than one inlined literal.
    expect(workspaceAccessSource).toContain("const QUERY_KEY = 'workspace-access-boundary'");
    expect(workspaceAccessSource).toContain('queryKey: [QUERY_KEY, workspaceId]');
    expect(workspaceAccessSource).not.toContain('queryKey: qk.workspace.access(workspaceId)');
    expect(workspaceHomeSource).not.toContain('queryKey: qk.workspace.access(workspaceId)');
    expect(workspaceHomeSource).not.toContain('listWorkspaceAccess(workspaceId');
    expect(workspaceHomeSource).toContain('const WORKSPACE_SETUP_TILES');
  });
});

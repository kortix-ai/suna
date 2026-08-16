import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const boundarySource = readFileSync(join(import.meta.dir, 'sandbox-loading-boundary.tsx'), 'utf8');
const projectLayoutSource = readFileSync(
  join(import.meta.dir, '../../app/(app)/projects/[id]/layout.tsx'),
  'utf8',
);
const projectAccessSource = readFileSync(
  join(import.meta.dir, '../../components/projects/project-access-boundary.tsx'),
  'utf8',
);
const projectHomeSource = readFileSync(
  join(import.meta.dir, '../workspace/project-layout/project-home.tsx'),
  'utf8',
);

describe('session navigation loading boundaries', () => {
  test('runtime-not-ready retries never render the full-page ASCII logo', () => {
    expect(boundarySource).toContain('return null;');
    expect(boundarySource).not.toContain('KortixHyperLogo');
    expect(boundarySource).not.toContain('min-h-[50vh]');
  });

  test('the project shell cannot be replaced by a route-wide sandbox fallback', () => {
    expect(projectLayoutSource).not.toContain('SandboxLoadingBoundary');
    expect(projectLayoutSource).toContain('<ProjectAccessBoundary projectId={projectId}>');
    expect(projectLayoutSource).not.toContain('SessionCacheWarmer');
    expect(projectLayoutSource).toContain('<ProjectShell projectId={projectId}>');
  });

  test('first project access still keeps its intentional full-page loader', () => {
    // The mirror of the `return null` rule above: a runtime-not-ready RETRY
    // must stay invisible, but the very FIRST project fetch owns the whole
    // viewport, so it has to show something rather than a blank screen.
    expect(projectAccessSource).toContain('if (query.isLoading)');
    expect(projectAccessSource).toContain('<AuthPendingScreen footer={false} />');
    expect(projectAccessSource).not.toMatch(/query\.isLoading\)\s*return null/);
  });

  test('the first-fetch loader carries no legal footer', () => {
    // It resolves into the project shell, which has no footer of its own, so a
    // pinned Terms/Privacy line would flash once per project open and vanish.
    // The gate screens below it keep theirs — they are terminal pages.
    expect(projectAccessSource).toContain('<AuthPendingScreen footer={false} />');
    expect(projectAccessSource).toContain('<AuthFrame>');
  });

  test('the access boundary uses the lightweight project route', () => {
    expect(projectAccessSource).toContain('getProject(projectId');
    expect(projectAccessSource).not.toContain('getProjectDetail(projectId');
  });

  test('project home does not start the members query before Customize opens', () => {
    // The boundary reads the lightweight project route under its own key. The
    // key is a constant now because three call sites share it, so assert the
    // constant's value and its use rather than one inlined literal.
    expect(projectAccessSource).toContain("const QUERY_KEY = 'project-access-boundary'");
    expect(projectAccessSource).toContain('queryKey: [QUERY_KEY, projectId]');
    expect(projectAccessSource).not.toContain('queryKey: qk.project.access(projectId)');
    expect(projectHomeSource).not.toContain('queryKey: qk.project.access(projectId)');
    expect(projectHomeSource).not.toContain('listProjectAccess(projectId');
    // Project home renders its own starter content (StarterSuggestions replaced
    // the old PROJECT_SETUP_TILES in #6467), so a members query is never the
    // thing that gates the first paint.
    expect(projectHomeSource).toContain('StarterSuggestions');
  });
});

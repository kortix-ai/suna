import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

function source(path: string): string {
  return readFileSync(resolve(import.meta.dir, path), 'utf8');
}

function filesUnder(path: string): string[] {
  const root = resolve(import.meta.dir, path);
  const files: string[] = [];
  const visit = (entry: string) => {
    if (statSync(entry).isDirectory()) {
      for (const child of readdirSync(entry)) visit(resolve(entry, child));
      return;
    }
    if (/\.(?:ts|tsx|mts)$/.test(entry)) files.push(entry);
  };
  visit(root);
  return files;
}

describe('mobile Workspace architecture', () => {
  test('Workspace routes own the implementation and Project routes are legacy adapters', () => {
    expect(source('index.tsx')).toContain('export default function WorkspacesScreen()');
    expect(source('[id].tsx')).toContain('export default function WorkspaceSessionScreen()');
    expect(source('../projects/index.tsx').trim()).toBe(
      '/** @deprecated Legacy route adapter. Use `/workspaces`. */\n' +
        "export { default } from '../workspaces/index';",
    );
    expect(source('../projects/[id].tsx').trim()).toBe(
      '/** @deprecated Legacy route adapter. Use `/workspaces/:id`. */\n' +
        "export { default } from '../workspaces/[id]';",
    );
  });

  test('canonical Workspace modules never import legacy Project modules', () => {
    const canonicalFiles = [
      ...filesUnder('.'),
      ...filesUnder('../../components/workspaces'),
      ...filesUnder('../../lib/workspaces'),
    ];
    const legacyImports = [
      '@/components/projects',
      '@/lib/projects',
      '@kortix/sdk/projects-client',
      "../projects/",
    ];

    for (const file of canonicalFiles) {
      if (file === import.meta.path) continue;
      const text = readFileSync(file, 'utf8');
      for (const legacyImport of legacyImports) expect(text).not.toContain(legacyImport);
    }
  });

  test('primary navigation uses canonical Workspace routes', () => {
    const expectedRoutes = [
      ['../index.tsx', "router.replace('/workspaces')"],
      ['../auth/_layout.tsx', '<Redirect href="/workspaces" />'],
      ['../auth/index.tsx', "router.replace('/workspaces')"],
      ['index.tsx', 'router.push(`/workspaces/${workspace.workspace_id}`)'],
      ['../../components/workspaces/AccountMenuSheet.tsx', "router.replace('/workspaces')"],
      ['../../components/settings/UsagePage.tsx', 'router.push(`/workspaces/${workspaceId}`)'],
      ['../../components/accounts/MembersTab.tsx', "router.replace('/workspaces')"],
    ] as const;

    for (const [path, route] of expectedRoutes) expect(source(path)).toContain(route);
  });

  test('the container list uses Workspace terminology and no marketing description', () => {
    const list = source('index.tsx');
    const create = source('../../components/workspaces/NewWorkspaceSheet.tsx');

    expect(list).toContain('Workspaces');
    expect(list).toContain('Search workspaces');
    expect(list).toContain("Couldn't load workspaces");
    expect(list).toContain('No workspaces yet');
    expect(list).toContain('Create your first workspace');
    expect(list).not.toContain('Pick up where you left off');
    expect(create).toContain('New workspace');
    expect(create).toContain('Workspace name');
    expect(create).toContain('Workspace created');
  });

  test('OpenCode repository entities remain Project-named', () => {
    const detail = source('[id].tsx');
    const projectPage = source('../../components/pages/ProjectDetailPage.tsx');
    const projectClient = source('../../lib/kortix/use-kortix-projects.ts');

    expect(detail).toContain("import { ProjectsPage } from '@/components/pages/ProjectsPage'");
    expect(detail).toContain('page:project:');
    expect(projectPage).toContain('projectId: string');
    expect(projectClient).toContain('/kortix/projects');
    expect(projectClient).toContain('project_id=');
  });
});

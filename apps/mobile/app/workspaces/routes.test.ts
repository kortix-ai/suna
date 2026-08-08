import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('mobile Workspace routes', () => {
  test('canonical collection and detail routes share the compatibility implementation', () => {
    expect(readFileSync(resolve(import.meta.dir, 'index.tsx'), 'utf8').trim()).toBe(
      "export { default } from '../projects/index';"
    );
    expect(readFileSync(resolve(import.meta.dir, '[id].tsx'), 'utf8').trim()).toBe(
      "export { default } from '../projects/[id]';"
    );
  });

  test('primary navigation uses the canonical Workspace routes', () => {
    const expectedRoutes = [
      ['../index.tsx', "router.replace('/workspaces')"],
      ['../auth/_layout.tsx', '<Redirect href="/workspaces" />'],
      ['../auth/index.tsx', "router.replace('/workspaces')"],
      ['../projects/index.tsx', 'router.push(`/workspaces/${p.project_id}`)'],
      ['../../components/projects/AccountMenuSheet.tsx', "router.replace('/workspaces')"],
      ['../../components/settings/UsagePage.tsx', 'router.push(`/workspaces/${projectId}`)'],
      ['../../components/accounts/MembersTab.tsx', "router.replace('/workspaces')"],
    ] as const;

    for (const [path, route] of expectedRoutes) {
      expect(readFileSync(resolve(import.meta.dir, path), 'utf8')).toContain(route);
    }
  });

  test('the primary container list uses Workspace terminology', () => {
    const list = readFileSync(resolve(import.meta.dir, '../projects/index.tsx'), 'utf8');
    const create = readFileSync(
      resolve(import.meta.dir, '../../components/projects/NewProjectSheet.tsx'),
      'utf8'
    );

    expect(list).toContain('Workspaces');
    expect(list).toContain('Search workspaces');
    expect(list).toContain("Couldn't load workspaces");
    expect(list).toContain('No workspaces yet');
    expect(list).toContain('Create your first workspace');
    expect(create).toContain('New workspace');
    expect(create).toContain('Workspace name');
    expect(create).toContain('Workspace created');
  });
});

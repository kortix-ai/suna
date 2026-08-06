import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'workspace-switcher.tsx'), 'utf8');

describe('workspace switcher menu', () => {
  test('never truncates the workspace list', () => {
    expect(source).not.toContain('.slice(0, 8)');
    expect(source).not.toContain('.slice(0, 12)');
  });

  test('search is unconditional, not gated on a count', () => {
    expect(source).not.toContain('showSearch');
    expect(source).toContain('Find workspace');
  });

  test('renders groups through the shared grouping helpers', () => {
    expect(source).toContain('groupWorkspacesByAccount');
    expect(source).toContain('filterWorkspaceGroups');
  });

  test('the all-projects and new-project items are gone', () => {
    expect(source).not.toContain('AllProjects');
    expect(source).not.toContain("/projects?new=1");
  });

  test('create points at /new', () => {
    expect(source).toContain("'/new'");
  });
});

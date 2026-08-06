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

  test('a failed account keeps its group header, not a vanished group', () => {
    // An account whose workspace fetch errors must still render (header +
    // retry row), not silently look like it has zero workspaces —
    // `groupWorkspacesByAccount` drops any account with zero workspaces, and
    // without an explicit isError branch that's indistinguishable from a
    // genuinely empty account.
    expect(source).toContain('result.isError');
    expect(source).toContain('result.refetch()');
    expect(source).toContain("Couldn't load");
    expect(source).toContain('Retry');
  });

  test('the loading gate covers the accounts query, not just the per-account fetches', () => {
    // `useQueries` is fed accounts data that is `[]` while accounts are still
    // in flight, so `workspaceQueries.some(isLoading)` alone is `false` before
    // the account count is even known — a false "No workspaces yet" on the
    // product's only complete workspace directory.
    expect(source).toContain('accountsQuery.isLoading || workspaceQueries.some(');
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dir, 'page.tsx'), 'utf8');

/**
 * `/projects` is a redirect back to THIS route (`page.tsx`, Task 21). Before
 * this fix, the terminal "nothing to open, nothing to auto-create" case
 * bounced there via `router.replace(withCurrentQuery('/projects'))`, which
 * looped forever the moment `/projects` stopped rendering a real list.
 *
 * Every assertion here is paired — absence of the loop AND presence of its
 * replacement — per this workspace's own Task 7 lesson: an absence-only test
 * survives a regression that guts the fix while dodging the literal string
 * that was removed.
 */
describe('/workspaces/start does not bounce to /projects', () => {
  test('the terminal branch renders inline instead of redirecting to /projects', () => {
    expect(source).not.toContain("withCurrentQuery('/projects')");
    expect(source).not.toContain("'/projects'");
    expect(source).toContain('setTerminal(classifyLandingTerminal(');
    expect(source).toContain('<WorkspaceStartEmpty');
  });

  test("the failure screen's secondary action does not point back at /projects either", () => {
    expect(source).not.toContain('href="/projects"');
    expect(source).toContain('href="/new"');
  });

  test('the only /projects destination left is a real workspace id, never the bare list', () => {
    expect(source).toContain('withCurrentQuery(`/workspaces/${workspace.workspace_id}`)');
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('project access read model', () => {
  test('retains direct and group custom-role policy projection and effective source', () => {
    const view = readFileSync(new URL('../projects/lib/project-access-view.ts', import.meta.url), 'utf8');
    expect(view).toContain("source: 'direct', group_id: null, group_name: null");
    expect(view).toContain("source: 'group', group_id: groupId, group_name: groupName");
    expect(view).toContain('effective_source: fold.effective_source');
  });
});

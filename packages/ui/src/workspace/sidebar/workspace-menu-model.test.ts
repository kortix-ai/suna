import { describe, expect, test } from 'bun:test';

import { workspaceMenuGroups } from './workspace-menu-model';

const ALL = { canInvite: true, canOpenSettings: true, canCreate: true, canLeave: true };
const NONE = { canInvite: false, canOpenSettings: false, canCreate: false, canLeave: false };

describe('workspaceMenuGroups — the workspace menu, top to bottom', () => {
  test('an owner of a shared workspace: workspace actions first, Preferences in the middle, Leave above Log out', () => {
    expect(workspaceMenuGroups(ALL)).toEqual([
      ['header'],
      ['invite', 'settings'],
      ['switch', 'create'],
      ['preferences', 'apps', 'appearance', 'help', 'download'],
      ['leave', 'logout'],
    ]);
  });

  test('a member: no Invite, no Workspace settings, and Leave', () => {
    expect(workspaceMenuGroups({ ...NONE, canLeave: true, canCreate: true })).toEqual([
      ['header'],
      ['switch', 'create'],
      ['preferences', 'apps', 'appearance', 'help', 'download'],
      ['leave', 'logout'],
    ]);
  });

  test('the last owner gets no Leave; a restricted self-host offers no Create', () => {
    const rows = workspaceMenuGroups({ ...ALL, canLeave: false, canCreate: false }).flat();
    expect(rows).not.toContain('leave');
    expect(rows).not.toContain('create');
    expect(rows.at(-1)).toBe('logout');
  });

  test('Preferences is never a workspace row, and there is no Rename row', () => {
    const rows = workspaceMenuGroups(ALL).flat();
    expect(rows.indexOf('preferences')).toBeGreaterThan(rows.indexOf('switch'));
    expect(rows as string[]).not.toContain('rename');
  });
});

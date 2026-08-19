import { describe, expect, test } from 'bun:test';

import {
  ALL_AGENTS,
  accessDialogCopy,
  agentSelectionFromCurrent,
  bulkGroupPlan,
  diffAccessDraft,
  diffAgentGrants,
  fixedPrincipalsOf,
  roleScopeFor,
  type AccessDialogCurrent,
  type AccessDialogMode,
  type AccessDialogScope,
} from './access-dialog';
import { builtinRole, customRole } from './role-select';

const ACCOUNT: AccessDialogScope = { kind: 'account' };
const PROJECT: AccessDialogScope = { kind: 'project', projectId: 'p_1', projectName: 'Atlas' };
const GROUP: AccessDialogScope = { kind: 'group', groupId: 'g_1', groupName: 'Engineering' };

describe('roleScopeFor', () => {
  test('group membership carries no role', () => {
    expect(roleScopeFor(ACCOUNT)).toBe('account');
    expect(roleScopeFor(PROJECT)).toBe('project');
    expect(roleScopeFor(GROUP)).toBeNull();
  });
});

describe('agentSelectionFromCurrent', () => {
  test("'all' and an empty list both mean every agent", () => {
    expect(agentSelectionFromCurrent('all')).toEqual(ALL_AGENTS);
    expect(agentSelectionFromCurrent([])).toEqual(ALL_AGENTS);
    expect(agentSelectionFromCurrent(undefined)).toEqual(ALL_AGENTS);
  });

  test('a real list becomes a subset', () => {
    expect(agentSelectionFromCurrent(['a', 'b'])).toEqual({ mode: 'subset', ids: ['a', 'b'] });
  });

  test('copies the ids so the caller cannot mutate the current grant', () => {
    const current = ['a'];
    const next = agentSelectionFromCurrent(current);
    next.ids.push('b');
    expect(current).toEqual(['a']);
  });
});

describe('diffAgentGrants', () => {
  test('all → subset only ever adds', () => {
    expect(diffAgentGrants('all', { mode: 'subset', ids: ['a', 'b'] })).toEqual({
      add: ['a', 'b'],
      remove: [],
    });
  });

  test('subset → all removes every existing grant', () => {
    expect(diffAgentGrants(['a', 'b'], ALL_AGENTS)).toEqual({ add: [], remove: ['a', 'b'] });
  });

  test('subset → subset adds and removes the delta only', () => {
    expect(diffAgentGrants(['a', 'b'], { mode: 'subset', ids: ['b', 'c'] })).toEqual({
      add: ['c'],
      remove: ['a'],
    });
  });

  test('an unchanged subset produces no writes', () => {
    expect(diffAgentGrants(['a', 'b'], { mode: 'subset', ids: ['a', 'b'] })).toEqual({
      add: [],
      remove: [],
    });
  });

  test('all → all is a no-op', () => {
    expect(diffAgentGrants('all', ALL_AGENTS)).toEqual({ add: [], remove: [] });
  });
});

describe('diffAccessDraft — Save fires ONLY changed fields', () => {
  const current: AccessDialogCurrent = {
    role: builtinRole('manager'),
    agentIds: ['agent-a'],
    expiresAt: null,
  };

  test('an untouched draft is not dirty', () => {
    const diff = diffAccessDraft(current, {
      role: builtinRole('manager'),
      agents: { mode: 'subset', ids: ['agent-a'] },
      expiresAt: '',
    });
    expect(diff).toEqual({
      roleChanged: false,
      expiryChanged: false,
      agentsAdded: [],
      agentsRemoved: [],
      agentsChanged: false,
      dirty: false,
    });
  });

  test('built-in → custom is a role change', () => {
    const diff = diffAccessDraft(current, {
      role: customRole('r_1'),
      agents: { mode: 'subset', ids: ['agent-a'] },
      expiresAt: '',
    });
    expect(diff.roleChanged).toBe(true);
    expect(diff.agentsChanged).toBe(false);
    expect(diff.dirty).toBe(true);
  });

  test('custom → the same custom role is not a change', () => {
    const diff = diffAccessDraft(
      { role: customRole('r_1'), agentIds: 'all', expiresAt: null },
      { role: customRole('r_1'), agents: ALL_AGENTS, expiresAt: '' },
    );
    expect(diff.dirty).toBe(false);
  });

  test('custom → a different custom role is a change', () => {
    const diff = diffAccessDraft(
      { role: customRole('r_1'), agentIds: 'all', expiresAt: null },
      { role: customRole('r_2'), agents: ALL_AGENTS, expiresAt: '' },
    );
    expect(diff.roleChanged).toBe(true);
  });

  test('an agent subset change is reported without touching the role', () => {
    const diff = diffAccessDraft(current, {
      role: builtinRole('manager'),
      agents: { mode: 'subset', ids: ['agent-b'] },
      expiresAt: '',
    });
    expect(diff.roleChanged).toBe(false);
    expect(diff.agentsAdded).toEqual(['agent-b']);
    expect(diff.agentsRemoved).toEqual(['agent-a']);
    expect(diff.dirty).toBe(true);
  });

  test('setting an expiry on a permanent grant is a change', () => {
    const diff = diffAccessDraft(current, {
      role: builtinRole('manager'),
      agents: { mode: 'subset', ids: ['agent-a'] },
      expiresAt: '2026-12-31',
    });
    expect(diff.expiryChanged).toBe(true);
    expect(diff.dirty).toBe(true);
  });

  test('an unchanged existing expiry is not a change', () => {
    const withExpiry: AccessDialogCurrent = {
      role: builtinRole('member'),
      agentIds: 'all',
      expiresAt: new Date('2026-12-31T23:59:59').toISOString(),
    };
    const diff = diffAccessDraft(withExpiry, {
      role: builtinRole('member'),
      agents: ALL_AGENTS,
      expiresAt: '2026-12-31',
    });
    expect(diff.expiryChanged).toBe(false);
    expect(diff.dirty).toBe(false);
  });

  test('clearing an existing expiry is a change', () => {
    const withExpiry: AccessDialogCurrent = {
      role: builtinRole('member'),
      agentIds: 'all',
      expiresAt: new Date('2026-12-31T23:59:59').toISOString(),
    };
    const diff = diffAccessDraft(withExpiry, {
      role: builtinRole('member'),
      agents: ALL_AGENTS,
      expiresAt: '',
    });
    expect(diff.expiryChanged).toBe(true);
  });
});

describe('accessDialogCopy', () => {
  const grant: AccessDialogMode = { kind: 'grant' };

  test('every grant scope shares the title and only swaps the sentence', () => {
    expect(accessDialogCopy(ACCOUNT, grant).title).toBe('Grant access');
    expect(accessDialogCopy(PROJECT, grant).title).toBe('Grant access');
    expect(accessDialogCopy(GROUP, grant).title).toBe('Grant access');
    expect(accessDialogCopy(ACCOUNT, grant).description).toContain('on this account.');
    expect(accessDialogCopy(PROJECT, grant).description).toContain('on this project.');
    expect(accessDialogCopy(GROUP, grant).description).toBe(
      'Pick account members to add to this group.',
    );
  });

  test('the grant submit label carries the selected count', () => {
    expect(accessDialogCopy(PROJECT, grant, { selectedCount: 0 }).submitLabel).toBe('Grant access');
    expect(accessDialogCopy(PROJECT, grant, { selectedCount: 3 }).submitLabel).toBe(
      'Grant access (3)',
    );
  });

  test('edit names the principal and the scope', () => {
    const mode: AccessDialogMode = {
      kind: 'edit',
      principal: { type: 'member', id: 'u_1', label: 'alice@corp.com' },
      current: { role: builtinRole('member') },
    };
    expect(accessDialogCopy(PROJECT, mode)).toEqual({
      title: 'Edit access',
      description: 'Change what alice@corp.com can do in Atlas.',
      submitLabel: 'Save',
    });
  });

  test('account scope falls back to "this account" without an account name', () => {
    const mode: AccessDialogMode = {
      kind: 'edit',
      principal: { type: 'member', id: 'u_1', label: 'alice@corp.com' },
      current: { role: builtinRole('member') },
    };
    expect(accessDialogCopy(ACCOUNT, mode).description).toContain('in this account.');
    expect(accessDialogCopy(ACCOUNT, mode, { accountName: 'Kortix' }).description).toContain(
      'in Kortix.',
    );
  });

  test('attach reads as a grant and submits as Attach', () => {
    const mode: AccessDialogMode = {
      kind: 'attach',
      principal: { type: 'group', id: 'g_1', label: 'Engineering' },
    };
    expect(accessDialogCopy(GROUP, mode)).toEqual({
      title: 'Grant access',
      description: 'Attach Engineering to a project — every member inherits the role.',
      submitLabel: 'Attach',
    });
  });

  test('bulk-role pluralises the principal count', () => {
    const one: AccessDialogMode = {
      kind: 'bulk-role',
      principals: [{ type: 'member', id: 'u_1', label: 'a' }],
    };
    const many: AccessDialogMode = {
      kind: 'bulk-role',
      principals: [
        { type: 'member', id: 'u_1', label: 'a' },
        { type: 'member', id: 'u_2', label: 'b' },
      ],
    };
    expect(accessDialogCopy(ACCOUNT, one, { accountName: 'Kortix' }).description).toBe(
      'Change what 1 person can do in Kortix.',
    );
    expect(accessDialogCopy(ACCOUNT, many, { accountName: 'Kortix' }).description).toBe(
      'Change what 2 people can do in Kortix.',
    );
    expect(accessDialogCopy(ACCOUNT, many).submitLabel).toBe('Save');
  });

  test('bulk-group is its own title and submit label', () => {
    const one: AccessDialogMode = {
      kind: 'bulk-group',
      principals: [{ type: 'member', id: 'u_1', label: 'a' }],
    };
    const many: AccessDialogMode = {
      kind: 'bulk-group',
      principals: [
        { type: 'member', id: 'u_1', label: 'a' },
        { type: 'member', id: 'u_2', label: 'b' },
      ],
    };
    expect(accessDialogCopy(ACCOUNT, many)).toEqual({
      title: 'Add to group',
      description: 'Pick the group these 2 people join.',
      submitLabel: 'Add to group',
    });
    // One person still reads as English.
    expect(accessDialogCopy(ACCOUNT, one).description).toBe('Pick the group this person joins.');
  });
});

describe('bulk-group submit', () => {
  const principals = [
    { type: 'member' as const, id: 'u_1', label: 'alice@corp.com' },
    { type: 'member' as const, id: 'u_2', label: 'bob@corp.com' },
  ];
  const mode: AccessDialogMode = { kind: 'bulk-group', principals };

  test('every selected person lands in ONE addGroupMembers call', () => {
    expect(bulkGroupPlan(mode, 'g_1')).toEqual({ groupId: 'g_1', userIds: ['u_1', 'u_2'] });
  });

  test('no group picked, or nobody selected, writes nothing', () => {
    expect(bulkGroupPlan(mode, '')).toBeNull();
    expect(bulkGroupPlan({ kind: 'bulk-group', principals: [] }, 'g_1')).toBeNull();
  });

  test('every other mode is left alone', () => {
    expect(bulkGroupPlan({ kind: 'grant' }, 'g_1')).toBeNull();
    expect(bulkGroupPlan({ kind: 'bulk-role', principals }, 'g_1')).toBeNull();
  });

  test('the body shows the selected people as fixed rows, not a picker', () => {
    expect(fixedPrincipalsOf(mode)).toEqual(principals);
    expect(fixedPrincipalsOf({ kind: 'grant' })).toEqual([]);
  });
});

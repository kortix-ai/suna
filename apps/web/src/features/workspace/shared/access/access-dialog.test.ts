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
      subprojectsAdded: [],
      subprojectsRemoved: [],
      subprojectsChanged: false,
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

// ─── The canonical write path ───────────────────────────────────────────────
//
// `access-dialog.tsx` is the ONE place the product writes an access grant, so
// these are source pins on the shape of that write. A custom role must be one
// `createAssignment` call, never a built-in write followed by a policy write —
// the two-store sequence `Promise.allSettled` could leave half-applied.

const dialogSource = await Bun.file(
  new URL('./access-dialog.tsx', import.meta.url).pathname,
).text();

describe('the dialog writes assignments, not policies', () => {
  test('the retired two-store write is gone', () => {
    expect(dialogSource).not.toContain('createPolicy(');
    expect(dialogSource).not.toContain('deletePolicy(');
  });

  test('a custom role is ONE createAssignment call', () => {
    expect(dialogSource).toContain('function assignCustomRole(');
    expect(dialogSource).toContain('return createAssignment(accountId, {');
    // Every custom-role branch goes through that one writer.
    const customRoleWrites = dialogSource.match(/assignCustomRole\(/g) ?? [];
    expect(customRoleWrites.length).toBeGreaterThanOrEqual(5);
  });

  test('agent access is an OBJECT assignment carrying the agent-user role', () => {
    expect(dialogSource).toContain("const OBJECT_ASSIGNMENT_ROLE_KEY = 'agent-user'");
    expect(dialogSource).toContain('roleKey: OBJECT_ASSIGNMENT_ROLE_KEY');
    expect(dialogSource).toContain("object: { type: 'agent', id: agentId }");
    // The old per-resource grant endpoints are no longer reachable from here.
    expect(dialogSource).not.toContain('createProjectResourceGrant(');
    expect(dialogSource).not.toContain('deleteProjectResourceGrant(');
  });

  test('a revoke reads the assignment id back rather than trusting a legacy id', () => {
    // `iam_policies.policy_id` is NOT `role_assignments.assignment_id` — the
    // backfill mints a new uuid — so a stale roster id must never be revoked.
    expect(dialogSource).toContain('async function unassignAgent(');
    expect(dialogSource).toContain('async function revokeCustomRole(');
    expect(dialogSource).toContain('listAssignments(accountId, {');
  });

  test('every write busts the permission-probe cache', () => {
    expect(dialogSource).toContain('invalidatePermissionProbes(queryClient, { accountId })');
  });

  test('expiry is offered wherever an assignment is written', () => {
    // It used to be offered only where the underlying store happened to have
    // the column — a UI capability derived from an SDK gap.
    expect(dialogSource).toContain(
      "const expirySupported = scope.kind !== 'group' && mode.kind !== 'bulk-group';",
    );
  });
});

describe('diffAccessDraft — subprojects diff by the SAME rules as agents', () => {
  const current: AccessDialogCurrent = {
    role: builtinRole('member'),
    agentIds: ['agent-a'],
    subprojectIds: ['marketing'],
    expiresAt: null,
  };
  const unchanged = {
    role: builtinRole('member'),
    agents: { mode: 'subset' as const, ids: ['agent-a'] },
    expiresAt: '',
  };

  test('an omitted subproject selection touches nothing when none are held', () => {
    // Every caller that does not edit subprojects (account scope, the older
    // tests above) must keep diffing to exactly what it always did.
    const diff = diffAccessDraft(
      { role: builtinRole('member'), agentIds: ['agent-a'], expiresAt: null },
      unchanged,
    );
    expect(diff.subprojectsAdded).toEqual([]);
    expect(diff.subprojectsRemoved).toEqual([]);
    expect(diff.subprojectsChanged).toBe(false);
    expect(diff.dirty).toBe(false);
  });

  test('adding one subproject is dirty on its own, with the role untouched', () => {
    const diff = diffAccessDraft(current, {
      ...unchanged,
      subprojects: { mode: 'subset', ids: ['marketing', 'research'] },
    });
    expect(diff.subprojectsAdded).toEqual(['research']);
    expect(diff.subprojectsRemoved).toEqual([]);
    expect(diff.subprojectsChanged).toBe(true);
    expect(diff.roleChanged).toBe(false);
    expect(diff.agentsChanged).toBe(false);
    expect(diff.dirty).toBe(true);
  });

  test('switching back to "all" removes every subproject grant that exists', () => {
    const diff = diffAccessDraft(current, { ...unchanged, subprojects: ALL_AGENTS });
    expect(diff.subprojectsRemoved).toEqual(['marketing']);
    expect(diff.subprojectsAdded).toEqual([]);
    expect(diff.dirty).toBe(true);
  });

  test('the same subset is not a change', () => {
    const diff = diffAccessDraft(current, {
      ...unchanged,
      subprojects: { mode: 'subset', ids: ['marketing'] },
    });
    expect(diff.subprojectsChanged).toBe(false);
    expect(diff.dirty).toBe(false);
  });

  test('agents and subprojects move independently in one save', () => {
    const diff = diffAccessDraft(current, {
      role: builtinRole('member'),
      agents: { mode: 'subset', ids: ['agent-b'] },
      subprojects: { mode: 'subset', ids: ['research'] },
      expiresAt: '',
    });
    expect(diff.agentsAdded).toEqual(['agent-b']);
    expect(diff.agentsRemoved).toEqual(['agent-a']);
    expect(diff.subprojectsAdded).toEqual(['research']);
    expect(diff.subprojectsRemoved).toEqual(['marketing']);
  });
});

describe('agentSelectionFromCurrent seeds a subproject picker too', () => {
  test('the initialSubprojectIds seed is the same subset shape agents use', () => {
    // `initialDraftState` builds `{mode:'subset', ids:[...]}` from the prop and
    // `agentSelectionFromCurrent` from `current.subprojectIds`; both feed the
    // one `diffAgentGrants`, which is what makes the two object types behave
    // identically without a second code path.
    expect(agentSelectionFromCurrent(['marketing'])).toEqual({
      mode: 'subset',
      ids: ['marketing'],
    });
    expect(diffAgentGrants('all', agentSelectionFromCurrent(['marketing']))).toEqual({
      add: ['marketing'],
      remove: [],
    });
  });
});

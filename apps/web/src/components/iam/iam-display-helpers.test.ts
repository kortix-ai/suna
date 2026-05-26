import { describe, expect, test } from 'bun:test';
import {
  countOverridingMembers,
  floatCurrentUserFirst,
  inheritedFromGroupSummary,
  isInheritedFromGroupOnly,
  isOverridingAccountRole,
  sortGroupMembersByOverride,
  type AccountMeta,
} from './iam-display-helpers';

const meta = (
  partial: Partial<AccountMeta> & { accountRole: AccountMeta['accountRole'] },
): AccountMeta => ({
  email: partial.email ?? null,
  accountRole: partial.accountRole,
  isSuperAdmin: partial.isSuperAdmin ?? false,
});

describe('isOverridingAccountRole', () => {
  test('owner overrides', () => {
    expect(isOverridingAccountRole(meta({ accountRole: 'owner' }))).toBe(true);
  });
  test('admin overrides', () => {
    expect(isOverridingAccountRole(meta({ accountRole: 'admin' }))).toBe(true);
  });
  test('plain member does NOT override', () => {
    expect(isOverridingAccountRole(meta({ accountRole: 'member' }))).toBe(false);
  });
  test('super_admin override beats accountRole=member', () => {
    // Important corner: someone can be a plain "member" by accountRole but
    // still hold the super-admin flag. They should still override.
    expect(
      isOverridingAccountRole(meta({ accountRole: 'member', isSuperAdmin: true })),
    ).toBe(true);
  });
});

describe('countOverridingMembers', () => {
  const members = [
    { user_id: 'u1' },
    { user_id: 'u2' },
    { user_id: 'u3' },
    { user_id: 'u4' },
  ];
  const byId = new Map<string, AccountMeta>([
    ['u1', meta({ accountRole: 'owner' })],
    ['u2', meta({ accountRole: 'admin' })],
    ['u3', meta({ accountRole: 'member' })],
    ['u4', meta({ accountRole: 'member', isSuperAdmin: true })],
  ]);

  test('counts owner + admin + super-admin', () => {
    expect(countOverridingMembers(members, byId)).toBe(3);
  });

  test('ignores user_ids missing from the meta map', () => {
    expect(countOverridingMembers([{ user_id: 'ghost' }], byId)).toBe(0);
  });

  test('returns 0 for empty member list', () => {
    expect(countOverridingMembers([], byId)).toBe(0);
  });
});

describe('sortGroupMembersByOverride', () => {
  // Mixed dates so we can verify tie-break (older addedAt first within a tier).
  const olderAdminAdded = '2024-01-01T00:00:00Z';
  const newerAdminAdded = '2024-06-01T00:00:00Z';
  const memberAdded = '2024-03-01T00:00:00Z';

  const members = [
    { user_id: 'newer-admin', added_at: newerAdminAdded },
    { user_id: 'plain', added_at: memberAdded },
    { user_id: 'older-admin', added_at: olderAdminAdded },
    { user_id: 'sa', added_at: memberAdded },
    { user_id: 'owner', added_at: memberAdded },
  ];
  const byId = new Map<string, AccountMeta>([
    ['newer-admin', meta({ accountRole: 'admin' })],
    ['plain', meta({ accountRole: 'member' })],
    ['older-admin', meta({ accountRole: 'admin' })],
    ['sa', meta({ accountRole: 'member', isSuperAdmin: true })],
    ['owner', meta({ accountRole: 'owner' })],
  ]);

  test('orders by override severity: super-admin < owner < admin < member', () => {
    const sorted = sortGroupMembersByOverride(members, byId);
    expect(sorted.map((m) => m.user_id)).toEqual([
      'sa',
      'owner',
      'older-admin', // older of the two admins
      'newer-admin',
      'plain',
    ]);
  });

  test('does not mutate input array', () => {
    const before = members.map((m) => m.user_id);
    sortGroupMembersByOverride(members, byId);
    expect(members.map((m) => m.user_id)).toEqual(before);
  });

  test('members missing from the meta map fall to the bottom', () => {
    const orphaned = [
      { user_id: 'ghost', added_at: memberAdded },
      { user_id: 'owner', added_at: memberAdded },
    ];
    const sorted = sortGroupMembersByOverride(orphaned, byId);
    expect(sorted[0].user_id).toBe('owner');
    expect(sorted[1].user_id).toBe('ghost');
  });
});

describe('floatCurrentUserFirst', () => {
  const list = [
    { user_id: 'a' },
    { user_id: 'b' },
    { user_id: 'me' },
    { user_id: 'c' },
  ];

  test('moves the current user to position 0', () => {
    expect(floatCurrentUserFirst(list, 'me').map((m) => m.user_id)).toEqual([
      'me',
      'a',
      'b',
      'c',
    ]);
  });

  test('no-op when current user already first', () => {
    const me = [{ user_id: 'me' }, { user_id: 'a' }];
    const result = floatCurrentUserFirst(me, 'me');
    expect(result.map((m) => m.user_id)).toEqual(['me', 'a']);
  });

  test('no-op when current user is absent', () => {
    expect(floatCurrentUserFirst(list, 'absent').map((m) => m.user_id)).toEqual([
      'a',
      'b',
      'me',
      'c',
    ]);
  });

  test('no-op when currentUserId is null', () => {
    expect(floatCurrentUserFirst(list, null).map((m) => m.user_id)).toEqual([
      'a',
      'b',
      'me',
      'c',
    ]);
  });

  test('does not mutate the input', () => {
    const before = list.map((m) => m.user_id);
    floatCurrentUserFirst(list, 'me');
    expect(list.map((m) => m.user_id)).toEqual(before);
  });
});

describe('isInheritedFromGroupOnly', () => {
  test('true: no direct grant, no implicit, has group source', () => {
    expect(
      isInheritedFromGroupOnly({
        has_implicit_access: false,
        project_role: null,
        effective_project_role: 'viewer',
        group_sources: [{ group_name: 'Viewers', role: 'viewer' }],
      }),
    ).toBe(true);
  });

  test('false: implicit Manager overrides — not "group-only" access', () => {
    expect(
      isInheritedFromGroupOnly({
        has_implicit_access: true,
        project_role: null,
        effective_project_role: 'manager',
        group_sources: [{ group_name: 'Viewers', role: 'viewer' }],
      }),
    ).toBe(false);
  });

  test('false: has a direct project_members grant', () => {
    expect(
      isInheritedFromGroupOnly({
        has_implicit_access: false,
        project_role: 'editor',
        effective_project_role: 'editor',
        group_sources: [{ group_name: 'Viewers', role: 'viewer' }],
      }),
    ).toBe(false);
  });

  test('false: no group sources', () => {
    expect(
      isInheritedFromGroupOnly({
        has_implicit_access: false,
        project_role: null,
        effective_project_role: null,
        group_sources: [],
      }),
    ).toBe(false);
  });

  test('false: group_sources omitted entirely', () => {
    expect(
      isInheritedFromGroupOnly({
        has_implicit_access: false,
        project_role: null,
        effective_project_role: null,
      }),
    ).toBe(false);
  });
});

describe('inheritedFromGroupSummary', () => {
  test('single group: "Inherited Viewer via Viewers"', () => {
    expect(
      inheritedFromGroupSummary({
        has_implicit_access: false,
        project_role: null,
        effective_project_role: 'viewer',
        group_sources: [{ group_name: 'Viewers', role: 'viewer' }],
      }),
    ).toBe('Inherited Viewer via Viewers');
  });

  test('multiple groups: head + "+ N more"', () => {
    expect(
      inheritedFromGroupSummary({
        has_implicit_access: false,
        project_role: null,
        effective_project_role: 'editor',
        group_sources: [
          { group_name: 'Engineering', role: 'editor' },
          { group_name: 'Viewers', role: 'viewer' },
        ],
      }),
    ).toBe('Inherited Editor via Engineering + 1 more');
  });

  test('three groups: "+ 2 more"', () => {
    expect(
      inheritedFromGroupSummary({
        has_implicit_access: false,
        project_role: null,
        effective_project_role: 'manager',
        group_sources: [
          { group_name: 'A', role: 'manager' },
          { group_name: 'B', role: 'editor' },
          { group_name: 'C', role: 'viewer' },
        ],
      }),
    ).toBe('Inherited Manager via A + 2 more');
  });

  test('null when the row is not group-inherited', () => {
    expect(
      inheritedFromGroupSummary({
        has_implicit_access: true,
        project_role: null,
        effective_project_role: 'manager',
        group_sources: [],
      }),
    ).toBeNull();
  });

  test('null when group_sources is omitted', () => {
    expect(
      inheritedFromGroupSummary({
        has_implicit_access: false,
        project_role: null,
        effective_project_role: 'viewer',
      }),
    ).toBeNull();
  });
});

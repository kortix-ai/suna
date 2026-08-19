// What a plain ACCOUNT MEMBER sees of the account hub.
//
// The bug this pins: `sectionVisible.roles` was hard-coded `true` "for
// discoverability", so every plain member got a Roles rail item that opened
// straight into "Failed to load roles — You don't have permission
// (role.read)". `role.read` lives in ADMIN_EXTRAS (`apps/api/src/iam/
// role-perms.ts`), and `GET .../iam/roles` asserts it
// (`apps/api/src/accounts/iam/custom-roles.ts`), so that item could never
// resolve for a member. Same class of hole for Members/Groups, which were also
// unconditional — they happen to be in the member baseline today, but nothing
// said so and nothing would have caught it changing.
//
// The rule these tests hold: a rail item is visible when the probe for the
// leaf its own list route asserts came back `true`. Nothing else.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');
// Line comments FIRST: this file has `//` comments that themselves contain
// `/*`, and stripping block comments first makes one of those open a match
// that runs to the next `*/` far below, swallowing real code with it.
const code = source.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const probes = code.slice(
  code.indexOf('const ACCOUNT_PERMISSION_PROBES'),
  code.indexOf('];', code.indexOf('const ACCOUNT_PERMISSION_PROBES')),
);
const sectionVisible = code.slice(
  code.indexOf('const sectionVisible: Record<AccountSection, boolean> = {'),
  code.indexOf('};', code.indexOf('const sectionVisible: Record<AccountSection, boolean> = {')),
);
const destructure = code.slice(
  code.indexOf('const [\n    { allowed: canReadMembers }'),
  code.indexOf('] = usePermissions(accountId, ACCOUNT_PERMISSION_PROBES);'),
);

describe('account hub — the read probes exist and are ordered', () => {
  // The batch is positional: `usePermissions` returns results in the order the
  // probes went out, and the page destructures them by position. A probe
  // inserted without moving its binding silently hands `role.read`'s answer to
  // `canWriteAccount`.
  test('probe list and destructure agree, name for name, position for position', () => {
    const actions = [...probes.matchAll(/action: '([^']+)'/g)].map((m) => m[1]);
    const bindings = [...destructure.matchAll(/\{ allowed: (\w+) \}/g)].map((m) => m[1]);

    expect(actions).toEqual([
      'member.read',
      'group.read',
      'role.read',
      'audit.read',
      'account.write',
      'account.delete',
      'member.invite',
      'member.remove',
      'member.update',
      'group.create',
      'group.members.manage',
      'role.create',
    ]);
    expect(bindings).toEqual([
      'canReadMembers',
      'canReadGroups',
      'canReadRoles',
      'canReadAudit',
      'canWriteAccount',
      'canDeleteAccount',
      'canInviteMember',
      'canRemoveMember',
      'canUpdateMember',
      'canCreateGroup',
      'canManageGroupMembers',
      'canManageRoles',
    ]);
    expect(actions.length).toBe(bindings.length);
  });

  test('one batched request, not one GET per leaf', () => {
    expect(code).toContain('usePermissions(accountId, ACCOUNT_PERMISSION_PROBES)');
    expect((code.match(/usePermissions\(/g) ?? []).length).toBe(1);
  });
});

describe('account hub — every Access rail item maps to its own READ probe', () => {
  // The mapping, one line per section. `access-projects` and `help` are the
  // only two without an account leaf, and both have a stated reason.
  test('members/groups/roles/audit each gate on their own read probe', () => {
    for (const [section, gate] of [
      ['members', 'canReadMembers === true'],
      ['groups', 'canReadGroups === true'],
      ['roles', 'canReadRoles === true'],
      ['audit', 'canReadAudit === true'],
    ] as const) {
      expect(sectionVisible).toContain(`${section}: ${gate}`);
    }
  });

  test('roles is no longer hard-coded visible — the original bug', () => {
    expect(sectionVisible).not.toContain('roles: true');
    expect(sectionVisible).not.toContain('members: true');
    expect(sectionVisible).not.toContain('groups: true');
  });

  // Its list is `GET /projects?account_id=` (already scoped to what the caller
  // can read) and `GET /projects/:id/access` (a PROJECT leaf, probed per
  // project inside AccessProjectsTab). An account member with no projects gets
  // an empty list, never a 403 — so there is no account leaf to gate on.
  test('access-projects stays visible, and says why', () => {
    expect(sectionVisible).toContain("'access-projects': true");
    expect(source).toContain('No account-level leaf of its own');
  });

  test('help stays visible for everyone — reference copy, no fetch', () => {
    expect(sectionVisible).toContain('help: true');
  });

  test('the write-only sections keep their write gate', () => {
    for (const section of ['identity', 'transactions', 'git', 'tokens', 'settings']) {
      expect(sectionVisible).toContain(`${section}: canWriteAccount === true`);
    }
    expect(sectionVisible).toContain('billing: canWriteAccount === true && billingActive');
  });
});

describe('account hub — nothing renders into a section the rail hides', () => {
  // Members is no longer unconditionally visible, so it cannot be the blanket
  // fallback for an unknown/denied `?tab=`: a caller denied `member.read`
  // would land on a section the rail does not list and stare at an empty pane.
  test('the fallback is the first VISIBLE section, not a hard-coded members', () => {
    expect(code).toContain("NAV_GROUPS.flatMap((group) => group.items).find((item) => sectionVisible[item.id])?.id ?? 'help'");
    expect(code).toContain('sectionVisible[requestedTab]\n    ? requestedTab\n    : firstVisibleSection');
  });

  test('each gated pane re-checks its own visibility before rendering', () => {
    expect(code).toContain("activeSection === 'members' && sectionVisible.members");
    expect(code).toContain("activeSection === 'groups' && sectionVisible.groups");
    expect(code).toContain("activeSection === 'roles' && sectionVisible.roles");
  });

  // `members` is `[]` when the query never runs, and "0 members" on an account
  // the viewer is demonstrably a member of is a lie, not a placeholder.
  test('the rail member count is suppressed when the member list is unreadable', () => {
    expect(code).toContain('{sectionVisible.members && !membersQuery.isLoading ? (');
  });

  // Optimistic (`!== false`, not `=== true`): an in-flight probe must not
  // delay the list for someone who does hold the leaf.
  test('the member list waits for its read probe before firing', () => {
    const query = code.slice(
      code.indexOf("queryKey: ['account-members', accountId]"),
      code.indexOf('staleTime: 20_000'),
    );
    expect(query).toContain('canReadMembers !== false');
  });
});

describe('account hub — a visible pane offers no control the caller cannot use', () => {
  // Every write control takes its OWN probe, never a blanket `canWriteAccount`
  // — so a member sees a clean read-only list rather than disabled buttons or
  // a 403 toast on submit. The list components take these as props
  // (`components/iam/*`), which is why the mapping is pinned here.
  test('member/group write props come from their own leaves', () => {
    expect(code).toContain('canInvite={canInviteMember}');
    expect(code).toContain('canRemove={canRemoveMember}');
    expect(code).toContain('canUpdateRole={canUpdateMember}');
    expect(code).toContain('canAddToGroup={canManageGroupMembers}');
    expect(code).toContain('canCreate={canCreateGroup}');
    expect(code).toContain('canManage={canManageRoles}');
  });

  test('no list surface is handed the blanket account.write flag', () => {
    for (const wrong of [
      'canInvite={canWriteAccount}',
      'canRemove={canWriteAccount}',
      'canUpdateRole={canWriteAccount}',
      'canCreate={canWriteAccount}',
      'canManageRoles={canWriteAccount}',
    ]) {
      expect(code).not.toContain(wrong);
    }
  });
});

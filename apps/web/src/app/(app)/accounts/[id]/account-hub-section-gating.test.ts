// What a plain ACCOUNT MEMBER sees of the account hub.
//
// The bug this pins: `sectionVisible.roles` was hard-coded `true` "for
// discoverability", so every plain member got a Roles nav item that opened
// straight into "Failed to load roles — You don't have permission
// (role.read)". `role.read` lives in ADMIN_EXTRAS (`apps/api/src/iam/
// role-perms.ts`), and `GET .../iam/roles` asserts it
// (`apps/api/src/accounts/iam/custom-roles.ts`), so that item could never
// resolve for a member. Same class of hole for Members/Groups, which were also
// unconditional — they happen to be in the member baseline today, but nothing
// said so and nothing would have caught it changing.
//
// The rule these tests hold: a nav item is visible when the probe for the
// leaf its own list route asserts came back `true`. Nothing else.
//
// Where the rule lives moved on 2026-09-01: the sidebar left `page.tsx` for
// `accounts/layout.tsx` (so every `/accounts/**` route shares it), and a
// layout cannot read a page's constants. The probe list, the visibility rule
// and the fallback now sit in `features/accounts/hub/use-account-hub-access.ts`;
// the page and the sidebar both read that ONE hook. Each assertion below reads
// the file the rule actually lives in.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const hubDir = join(import.meta.dir, '../../../../features/accounts/hub');
const source = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');
const accessSource = readFileSync(join(hubDir, 'use-account-hub-access.ts'), 'utf8');
const membersSource = readFileSync(join(hubDir, 'use-account-members.ts'), 'utf8');
const sidebarSource = readFileSync(join(hubDir, 'account-settings-sidebar.tsx'), 'utf8');

// Line comments FIRST: these files have `//` comments that themselves contain
// `/*`, and stripping block comments first makes one of those open a match
// that runs to the next `*/` far below, swallowing real code with it.
const strip = (text: string) =>
  text.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const code = strip(source);
const access = strip(accessSource);
const membersHook = strip(membersSource);
const sidebar = strip(sidebarSource);

const probes = access.slice(
  access.indexOf('const ACCOUNT_PERMISSION_PROBES'),
  access.indexOf('];', access.indexOf('const ACCOUNT_PERMISSION_PROBES')),
);
const sectionVisible = access.slice(
  access.indexOf('const sectionVisible: Record<AccountSection, boolean> = {'),
  access.indexOf('};', access.indexOf('const sectionVisible: Record<AccountSection, boolean> = {')),
);
const destructure = access.slice(
  access.indexOf('const [\n    { allowed: canReadMembers }'),
  access.indexOf('] = usePermissions(accountId, ACCOUNT_PERMISSION_PROBES);'),
);

describe('account hub — the read probes exist and are ordered', () => {
  // The batch is positional: `usePermissions` returns results in the order the
  // probes went out, and the hook destructures them by position. A probe
  // inserted without moving its binding silently hands `role.read`'s answer to
  // `canWriteAccount`.
  test('probe list and destructure agree, name for name, position for position', () => {
    const actions = [...probes.matchAll(/action: '([^']+)'/g)].map((m) => m[1]);
    const bindings = [...destructure.matchAll(/\{ allowed: (\w+) \}/g)].map((m) => m[1]);

    expect(actions).toEqual([
      'member.read',
      'group.read',
      'role.read',
      'policy.read',
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
      'canReadPolicies',
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
    expect(access).toContain('usePermissions(accountId, ACCOUNT_PERMISSION_PROBES)');
    expect((access.match(/usePermissions\(/g) ?? []).length).toBe(1);
  });

  // The page and the sidebar are two consumers of the SAME verdict. Neither
  // may re-probe: a second `usePermissions` with a different list would be a
  // second request AND a second, drifting copy of the rule.
  test('the page and the sidebar read the hook, never a probe of their own', () => {
    expect(code).toContain('useAccountHubSection(accountId)');
    expect(sidebar).toContain('useAccountHubSection(accountId)');
    expect(code).not.toContain('usePermissions(');
    expect(sidebar).not.toContain('usePermissions(');
  });
});

describe('account hub — every Access nav item maps to its own READ probe', () => {
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
    expect(accessSource).toContain('No account-level leaf of its own');
  });

  test('help stays visible for everyone — reference copy, no fetch', () => {
    expect(sectionVisible).toContain('help: true');
  });

  test('the write-only sections keep their write gate', () => {
    for (const section of ['identity', 'transactions', 'git', 'tokens', 'settings', 'branding']) {
      expect(sectionVisible).toContain(`${section}: canWriteAccount === true`);
    }
    expect(sectionVisible).toContain('billing: canWriteAccount === true && billingActive');
  });
});

describe('account hub — nothing renders into a section the nav hides', () => {
  // Members is no longer unconditionally visible, so it cannot be the blanket
  // fallback for an unknown/denied `?tab=`: a caller denied `member.read`
  // would land on a section the nav does not list and stare at an empty pane.
  test('the fallback is the first VISIBLE section, not a hard-coded members', () => {
    // Whitespace-insensitive: prettier is free to wrap either expression.
    const flat = access.replace(/\s+/g, ' ');
    expect(flat).toContain(
      "NAV_GROUPS.flatMap((group) => group.items).find((item) => sectionVisible[item.id])?.id ?? 'help'",
    );
    expect(flat).toContain('sectionVisible[requestedTab] ? requestedTab : firstVisibleSection');
  });

  test('each gated pane re-checks its own visibility before rendering', () => {
    expect(code).toContain("activeSection === 'members' && sectionVisible.members");
    expect(code).toContain("activeSection === 'groups' && sectionVisible.groups");
    expect(code).toContain("activeSection === 'roles' && sectionVisible.roles");
  });

  // The sidebar lists only the sections the verdict allows — the same filter
  // the fallback walks, so "listed" and "openable" stay one set.
  test('the sidebar lists a section only when the verdict allows it', () => {
    expect(sidebar).toContain('group.items.filter((item) => sectionVisible[item.id])');
  });

  // `members` is `[]` when the query never runs, and "0" beside Members on an
  // account the viewer is demonstrably a member of is a lie, not a placeholder.
  test('the nav member count is suppressed when the member list is unreadable', () => {
    expect(sidebar).toContain('sectionVisible.members && !membersQuery.isLoading ?');
  });

  // Optimistic (`!== false`, not `=== true`): an in-flight probe must not
  // delay the list for someone who does hold the leaf. One hook, read by the
  // page and the sidebar, so the list is fetched once for both.
  test('the member list waits for its read probe before firing', () => {
    const query = membersHook.slice(
      membersHook.indexOf("queryKey: ['account-members', accountId]"),
      membersHook.indexOf('staleTime: 20_000'),
    );
    expect(query).toContain('canReadMembers !== false');
    expect(code).toContain('useAccountMembers(accountId, canReadMembers)');
    expect(sidebar).toContain('useAccountMembers(accountId, canReadMembers)');
    // The page still NAMES the key when it invalidates after a mutation; what
    // it must not do is run a list query of its own.
    expect(code).not.toContain('listAccountMembers(');
    expect(sidebar).not.toContain('listAccountMembers(');
  });
});

// `rbac` is an ENTITLEMENT (the account's tier) and `role.read`/`policy.read`
// are PERMISSIONS (this viewer's leaves). They are independent, and the two
// members-list background reads need BOTH. The bug this pins: the gate was the
// entitlement alone, so an account that HAS `rbac` whose viewer is a plain
// member fired `GET .../iam/roles` and `GET .../iam/policies` on every hub load
// and took two 403s in the background — the member baseline holds neither leaf
// (`apps/api/src/iam/role-perms.ts`, both sit in ADMIN_EXTRAS).
describe('account hub — the members-list IAM reads need entitlement AND permission', () => {
  const membersCard = code.slice(
    code.indexOf('function MembersCard({'),
    code.indexOf('const accountPolicyByUser'),
  );

  test('the roles read is gated on rbac AND role.read', () => {
    expect(membersCard).toContain(
      'useAccountRoles(account.account_id, rbacEnabled && canReadRoles === true)',
    );
  });

  test('the policies read is gated on rbac AND policy.read', () => {
    const query = membersCard.slice(
      membersCard.indexOf("queryKey: ['iam-policies', account.account_id]"),
      membersCard.indexOf('staleTime: 30_000'),
    );
    expect(query).toContain('enabled: rbacEnabled && canReadPolicies === true');
  });

  // Strict `=== true`, NOT the optimistic `!== false` the member list uses:
  // `CanResult.allowed` is a plain boolean that reads `false` while the probe
  // is in flight, so an optimistic gate would fire the exact request it exists
  // to suppress before the verdict lands.
  test('neither read is gated on the entitlement alone', () => {
    expect(membersCard).not.toContain('useAccountRoles(account.account_id, rbacEnabled)');
    expect(membersCard).not.toContain('enabled: rbacEnabled,');
  });

  test('both permission flags reach MembersCard from the batched probe', () => {
    expect(code).toContain('canReadRoles={canReadRoles}');
    expect(code).toContain('canReadPolicies={canReadPolicies}');
  });
});

// The same two-axis rule, one level down. Both drill-down panels are hub panes
// reached by a URL param (`?tab=members&member=<id>`, `?tab=groups&group=<id>`)
// and BOTH are reachable by a plain member: `member.read` and `group.read` are
// in MEMBER_BASELINE, while `role.read` and `policy.read` are in ADMIN_EXTRAS.
// So each panel had the identical hole the members list had — `MemberAccessPanel`
// gated its policies read on the entitlement alone, and `GroupAccessPanel` gated
// its roles read on NOTHING at all.
describe('account hub — the drill-down panels need entitlement AND permission too', () => {
  const readPanel = (file: string) =>
    strip(readFileSync(join(import.meta.dir, '../../../../components/iam', file), 'utf8'));

  const memberPanel = readPanel('member-access-panel.tsx');
  const groupPanel = readPanel('group-access-panel.tsx');
  const groupsTab = readPanel('groups-tab.tsx');

  test('MemberAccessPanel gates its policies read on rbac AND policy.read', () => {
    expect(memberPanel).toContain('enabled: rbacEnabled && canReadPolicies === true');
    expect(memberPanel).not.toContain('enabled: rbacEnabled,');
  });

  test('GroupAccessPanel gates its roles read on rbac AND role.read', () => {
    expect(groupPanel).toContain(
      'useAccountRoles(accountId, rbacEnabled && canReadRoles === true)',
    );
    // The original bug: no second argument at all, so `enabled` defaulted true.
    expect(groupPanel).not.toContain('useAccountRoles(accountId)');
  });

  test('GroupAccessPanel gates its policies read on rbac AND policy.read', () => {
    expect(groupPanel).toContain('enabled: rbacEnabled && canReadPolicies === true');
  });

  // Required props, never optional-with-a-default: a `= true` default is how
  // this hole reopens silently the next time someone adds a call site.
  test('both panels take the probe verdicts as REQUIRED props', () => {
    expect(memberPanel).toContain('canReadPolicies: boolean;');
    expect(memberPanel).toContain('canReadRoles: boolean;');
    expect(memberPanel).not.toContain('canReadPolicies?: boolean');
    expect(memberPanel).not.toContain('canReadRoles?: boolean');
    expect(groupPanel).toContain('canReadRoles: boolean;');
    expect(groupPanel).toContain('canReadPolicies: boolean;');
    expect(groupPanel).not.toContain('canReadRoles?: boolean');
    expect(groupPanel).not.toContain('canReadPolicies?: boolean');
  });

  // The THIRD site of this bug class, and the one nobody had named: the member
  // panel's "What they can do" grid and its "View as this member" simulator
  // both build themselves from `GET .../iam/permissions`, which asserts
  // `role.read` (`apps/api/src/accounts/iam/assignments.ts`). Both rendered
  // unconditionally, so a plain member drilling into `?member=<id>` took a 403
  // and got an empty grid. Gating the QUERY alone is not enough here — an empty
  // "What they can do" section is the "pane that can only fail" the nav rule
  // exists to prevent — so the surfaces themselves are gone for that viewer.
  test('the capabilities grid and the View-as simulator need role.read', () => {
    expect(memberPanel).toContain('{member && canReadRoles ? (');
    expect(memberPanel).toContain('{canReadRoles ? (');
    // Neither may render off `member` alone, which is what it used to do.
    expect(memberPanel).not.toContain('{member ? <CapabilitiesCard');
  });

  // `RolesTab` reads the same catalog plus `listRoles`, and needs no prop: the
  // hub only mounts it when `sectionVisible.roles`, which IS `canReadRoles`.
  // Pinned so a future "show it for discoverability" edit has to face this.
  test('the Roles tab stays gated by its nav entry, not mounted and left to 403', () => {
    expect(code).toContain("activeSection === 'roles' && sectionVisible.roles");
    expect(sectionVisible).toContain('roles: canReadRoles === true');
  });

  // One batched probe answers both leaves at the hub. Threading the verdict
  // costs no request; a local re-probe in each panel would cost one each.
  test('the verdicts are threaded from the hub, not re-probed in the panels', () => {
    expect(code).toContain('canReadPolicies={canReadPolicies}');
    expect(code).toContain('canReadRoles={canReadRoles}');
    expect(groupsTab).toContain('canReadRoles={canReadRoles}');
    expect(groupsTab).toContain('canReadPolicies={canReadPolicies}');
    for (const panel of [memberPanel, groupPanel]) {
      expect(panel).not.toContain("usePermission(accountId, 'policy.read')");
      expect(panel).not.toContain("usePermission(accountId, 'role.read')");
    }
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

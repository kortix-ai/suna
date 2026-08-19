// The member-detail page (reached via the members-list "View access" kebab)
// must SURFACE its built actions — the "View as" simulator, the super-admin
// grant/revoke dialogs, and (since the access unification) "Edit access" on a
// project row. They regressed once to fully unreachable (dialogs + mutation
// present, but nothing opened them and the permission probe was a `void`
// no-op), leaving a page about permissions that was read-only. These pins keep
// the triggers wired and the page on the shared access primitives.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'member-access-panel.tsx'), 'utf8');
const flat = source.replace(/\s+/g, ' ');
const legacyRouteSource = readFileSync(
  join(import.meta.dir, '../../app/(app)/accounts/[id]/members/[userId]/page.tsx'),
  'utf8',
);
const hubSource = readFileSync(
  join(import.meta.dir, '../../app/(app)/accounts/[id]/page.tsx'),
  'utf8',
);

describe('member-detail actions are reachable', () => {
  test('an actions dropdown menu is rendered with an accessible label', () => {
    expect(source).toContain('DropdownMenuTrigger');
    expect(source).toContain('Actions for ${memberLabel}');
  });

  test('"View as this member" opens the simulator dialog', () => {
    expect(flat).toContain('setViewAsOpen(true)');
  });

  test('super-admin grant/revoke is gated on the permission probe (no dead no-op)', () => {
    // The probe must be USED to gate the menu, not discarded.
    expect(source).not.toContain('void canPromoteSuperAdmin');
    expect(source).toContain('canPromoteSuperAdmin');
    // Grant vs Revoke is chosen from the member's current state.
    expect(source).toContain('is_super_admin');
    expect(flat).toMatch(/setGrantConfirmOpen\(true\)|setRevokeConfirmOpen\(true\)/);
  });
});

describe('member-detail uses the shared access primitives', () => {
  test('the panel chrome is AccessDetailShell, not a hand-rolled header', () => {
    expect(source).toContain('AccessDetailShell');
    // Back goes to the members LIST in the same pane — a callback, not a
    // route change, so the hub's left rail stays put.
    expect(flat).toContain("back={{ label: 'All members', onClick: onBack }}");
  });

  test('both lists are AccessList/AccessRow', () => {
    expect(source).toContain('AccessList');
    expect(source).toContain('AccessRow');
  });

  test('a project grant is edited through AccessDialog, not a local dialog', () => {
    expect(source).toContain('AccessDialog');
    expect(flat).toContain("label: 'Edit access'");
    expect(flat).toContain("kind: 'edit'");
  });

  test('the Agents field is seeded from the project’s real resource grants', () => {
    // Opening on the "All agents" default when a subset exists would make a
    // blind Save look like a widening.
    expect(source).toContain('listProjectResourceGrants');
    expect(source).toContain('agentIds');
  });
});

describe('the member detail renders inside the account hub, not on its own route', () => {
  test('the hub mounts the panel from ?tab=members&member=<id>', () => {
    expect(hubSource).toContain("searchParams.get('member')");
    expect(hubSource).toContain('MemberAccessPanel');
    // The list row's "View access" stays in the pane.
    expect(hubSource).toContain('onSelectMember(member.user_id)');
    expect(hubSource).not.toContain('/members/${member.user_id}');
  });

  test('the kebab is a superset of the list row: Edit access + Remove from account', () => {
    expect(flat).toContain('Edit access');
    expect(flat).toContain('Remove from account');
    // Account-scope edit runs through the shared dialog, not a local form.
    expect(flat).toContain("scope={{ kind: 'account' }}");
  });

  test('a group row opens the hub Groups pane instead of a standalone route', () => {
    expect(flat).toContain('onOpenGroup(group.group_id)');
    expect(source).not.toContain('/groups/${');
  });

  test('the old standalone route redirects so bookmarks keep working', () => {
    expect(legacyRouteSource).toContain('router.replace');
    expect(legacyRouteSource.replace(/\s+/g, ' ')).toContain(
      '`/accounts/${accountId}?tab=members&member=${encodeURIComponent(userId)}`',
    );
    expect(legacyRouteSource).not.toContain('AccessDetailShell');
  });
});

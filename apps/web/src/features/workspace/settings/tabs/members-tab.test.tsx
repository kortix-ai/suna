import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AccountInvitation, ProjectAccessMember } from '@kortix/sdk';

import { MembersTabView } from './members-tab';

const accountInvite = (o: Partial<AccountInvitation>): AccountInvitation => ({
  invite_id: 'ainv1',
  email: 'invitee@kortix.com',
  initial_role: 'member',
  invited_by: 'u0',
  created_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-02-01T00:00:00Z',
  invite_url: 'https://kortix.com/invite/ainv1',
  ...o,
});

/**
 * `MembersTabView` is the pure, props-only half — see this tab's header
 * comment. `inviteDialogSlot` is the one slot (the invite composer owns its
 * own `useMutation`, can't render under `renderToStaticMarkup` with no
 * `QueryClientProvider` — same reasoning `general-tab.tsx`'s
 * `generalFieldsSlot` documents). Every mutation's real network round trip,
 * Select interaction, and dialog open state need a live network and a real
 * DOM — untestable here by the task's hard constraint (no
 * `@testing-library/react`, no jsdom/happy-dom). These tests pin table
 * shape, column presence, per-row gating, and the pending invites / access
 * requests sections below the table.
 */
const member = (o: Partial<ProjectAccessMember>): ProjectAccessMember => ({
  user_id: 'u1',
  email: 'a@b.c',
  account_role: 'member',
  project_role: null,
  effective_project_role: null,
  has_implicit_access: false,
  effective_source: null,
  group_sources: [],
  joined_at: '',
  granted_by: null,
  granted_at: null,
  updated_at: null,
  ...o,
});

describe('MembersTabView', () => {
  test('renders the header title and description', () => {
    const out = renderToStaticMarkup(<MembersTabView />);
    expect(out).toContain('Members');
    expect(out).toContain('project standing, in one table.');
  });

  test('renders the permissions help slot in the header action', () => {
    const out = renderToStaticMarkup(<MembersTabView permissionsHelpSlot={<div>help-marker</div>} />);
    expect(out).toContain('help-marker');
  });

  test('renders one row per member, with an Account role and a Workspace access column', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[
          member({ user_id: 'u1', email: 'owner@kortix.com', account_role: 'owner' }),
          member({ user_id: 'u2', email: 'viewer@kortix.com', account_role: 'member' }),
        ]}
      />,
    );
    expect(out).toContain('Account role');
    expect(out).toContain('Workspace access');
    expect(out).toContain('owner@kortix.com');
    expect(out).toContain('viewer@kortix.com');
    expect(out.match(/<tr/g)?.length).toBe(3); // 1 header row + 2 member rows
  });

  test('a group-sourced grant shows memberAccessLabel\'s "via <group>" annotation', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[
          member({
            email: 'grouped@kortix.com',
            effective_project_role: 'editor',
            effective_source: 'group',
            group_sources: [{ group_id: 'g1', group_name: 'Engineering', role: 'editor' }],
          }),
        ]}
      />,
    );
    expect(out).toContain('Editor');
    expect(out).toContain('via Engineering');
  });

  test('an account member with no project access reads as an em dash, not a hidden row', () => {
    const out = renderToStaticMarkup(<MembersTabView members={[member({ email: 'none@kortix.com' })]} />);
    expect(out).toContain('none@kortix.com');
    expect(out).toContain('—');
  });

  test('no role select or remove control when canManageMembers is false', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({ project_role: 'editor', effective_project_role: 'editor', effective_source: 'direct' })]}
        canManageMembers={false}
      />,
    );
    expect(out).not.toContain('role="combobox"');
  });

  test('a role select renders for a directly-granted member when canManageMembers is true', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({ project_role: 'editor', effective_project_role: 'editor', effective_source: 'direct' })]}
        canManageMembers
      />,
    );
    expect(out).toContain('role="combobox"');
  });

  test('implicit (account admin) access has no editable control, even when canManageMembers is true', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[
          member({
            account_role: 'admin',
            effective_project_role: 'manager',
            effective_source: 'implicit',
            has_implicit_access: true,
          }),
        ]}
        canManageMembers
      />,
    );
    expect(out).not.toContain('role="combobox"');
  });

  test('group-inherited access has no editable control on this table, even when canManageMembers is true', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[
          member({
            effective_project_role: 'editor',
            effective_source: 'group',
            group_sources: [{ group_id: 'g1', group_name: 'Engineering', role: 'editor' }],
          }),
        ]}
        canManageMembers
      />,
    );
    expect(out).not.toContain('role="combobox"');
  });

  test('the Invite button only renders when canManageMembers is true', () => {
    const withPerm = renderToStaticMarkup(<MembersTabView canManageMembers members={[member({})]} />);
    const withoutPerm = renderToStaticMarkup(<MembersTabView canManageMembers={false} members={[member({})]} />);
    expect(withPerm).toContain('Invite');
    expect(withoutPerm).not.toContain('>Invite<');
  });

  test('renders the invite dialog slot', () => {
    const out = renderToStaticMarkup(<MembersTabView inviteDialogSlot={<div>invite-dialog-marker</div>} />);
    expect(out).toContain('invite-dialog-marker');
  });

  test('renders groupGrantsSlot, resourceAccessSlot, and roleAssignmentsSlot, in that order, below the table', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({})]}
        groupGrantsSlot={<div>group-grants-marker</div>}
        resourceAccessSlot={<div>resource-access-marker</div>}
        roleAssignmentsSlot={<div>role-assignments-marker</div>}
      />,
    );
    expect(out).toContain('group-grants-marker');
    expect(out).toContain('resource-access-marker');
    expect(out).toContain('role-assignments-marker');
    // Rehomed in their existing order (members-view.tsx's own composition
    // order: ProjectGroupGrantsCard, ResourceAccessCard,
    // ProjectRoleAssignmentsCard) — see members-tab.tsx's header comment.
    expect(out.indexOf('group-grants-marker')).toBeLessThan(out.indexOf('resource-access-marker'));
    expect(out.indexOf('resource-access-marker')).toBeLessThan(out.indexOf('role-assignments-marker'));
    // Below the table, not inside it.
    expect(out.indexOf('</table>')).toBeLessThan(out.indexOf('group-grants-marker'));
  });

  test('the three rehomed slots are absent by default (undefined), same as inviteDialogSlot', () => {
    const out = renderToStaticMarkup(<MembersTabView members={[member({})]} />);
    expect(out).not.toContain('group-grants-marker');
    expect(out).not.toContain('resource-access-marker');
    expect(out).not.toContain('role-assignments-marker');
  });

  test('renders a loading skeleton for the table while isLoading', () => {
    const out = renderToStaticMarkup(<MembersTabView isLoading members={[member({})]} />);
    expect(out).not.toContain('<table');
  });

  test('renders an error state with retry when isError', () => {
    const out = renderToStaticMarkup(<MembersTabView isError errorMessage="boom" />);
    expect(out).toContain('Failed to load members');
    expect(out).toContain('boom');
    expect(out).toContain('Retry');
  });

  test('renders an empty state when there are no members at all', () => {
    const out = renderToStaticMarkup(<MembersTabView members={[]} />);
    expect(out).toContain('No members yet');
    expect(out).not.toContain('<table');
  });

  test('pending invites render below the table', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({})]}
        pendingInvites={[
          {
            invite_id: 'inv1',
            email: 'pending@kortix.com',
            project_role: 'member',
            expires_at: null,
            invited_by_email: null,
            created_at: '2026-01-01T00:00:00Z',
            invite_expires_at: '2026-02-01T00:00:00Z',
            invite_expired: false,
          },
        ]}
      />,
    );
    expect(out).toContain('Pending invites');
    expect(out).toContain('pending@kortix.com');
    expect(out.indexOf('Pending invites')).toBeGreaterThan(out.indexOf('Account role'));
  });

  test('access requests render below the table', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({})]}
        accessRequests={[
          {
            request_id: 'req1',
            account_id: 'acc1',
            project_id: 'proj1',
            requester_user_id: 'u9',
            requester_email: 'requester@kortix.com',
            message: null,
            status: 'pending',
            reviewed_by: null,
            reviewed_at: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ]}
      />,
    );
    expect(out).toContain('Access requests');
    expect(out).toContain('requester@kortix.com');
  });

  test('pending invites / access requests sections are absent with nothing pending', () => {
    const out = renderToStaticMarkup(<MembersTabView members={[member({})]} />);
    expect(out).not.toContain('Pending invites');
    expect(out).not.toContain('Access requests');
  });

  // ── JAY-548: account invites + leave account (rehomed from
  // accounts/[id]/page.tsx — see members-tab.tsx's header comment). ──

  test('account invites render below the table, under a title distinct from "Pending invites"', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({})]}
        accountId="acc1"
        accountInvites={[accountInvite({ email: 'joiner@kortix.com' })]}
      />,
    );
    expect(out).toContain('Account invites');
    expect(out).toContain('joiner@kortix.com');
    expect(out.indexOf('Account invites')).toBeGreaterThan(out.indexOf('Account role'));
  });

  test('account invites section is absent with no accountId, even with invites data', () => {
    const out = renderToStaticMarkup(
      <MembersTabView members={[member({})]} accountInvites={[accountInvite({})]} />,
    );
    expect(out).not.toContain('Account invites');
  });

  test('account invites section is absent with an accountId but nothing pending', () => {
    const out = renderToStaticMarkup(<MembersTabView members={[member({})]} accountId="acc1" />);
    expect(out).not.toContain('Account invites');
  });

  test('resend/cancel controls on an account invite gate on canManageAccountInvites, NOT canManageMembers', () => {
    const withoutPerm = renderToStaticMarkup(
      <MembersTabView
        members={[member({})]}
        accountId="acc1"
        accountInvites={[accountInvite({})]}
        canManageMembers
        canManageAccountInvites={false}
      />,
    );
    expect(withoutPerm).not.toContain('>Resend<');
    expect(withoutPerm).not.toContain('>Cancel<');

    const withPerm = renderToStaticMarkup(
      <MembersTabView
        members={[member({})]}
        accountId="acc1"
        accountInvites={[accountInvite({})]}
        canManageMembers={false}
        canManageAccountInvites
      />,
    );
    expect(withPerm).toContain('>Resend<');
    expect(withPerm).toContain('>Cancel<');
  });

  test('leave account section renders only when an accountId is resolved', () => {
    const withAccount = renderToStaticMarkup(<MembersTabView members={[member({})]} accountId="acc1" />);
    const withoutAccount = renderToStaticMarkup(<MembersTabView members={[member({})]} />);
    expect(withAccount).toContain('Leave account');
    expect(withoutAccount).not.toContain('Leave account');
  });

  test('the Leave button is disabled when the viewer is the last owner', () => {
    const out = renderToStaticMarkup(
      <MembersTabView members={[member({})]} accountId="acc1" isLastOwner />,
    );
    expect(out).toContain('disabled=""');
    expect(out).toContain("only owner");
  });

  test('the Leave button is enabled when the viewer is not the last owner', () => {
    const out = renderToStaticMarkup(
      <MembersTabView members={[member({})]} accountId="acc1" isLastOwner={false} />,
    );
    expect(out).not.toContain('disabled=""');
  });

  // ── JAY-549: inviteAccountMember / updateAccountMemberRole /
  // removeAccountMember — see members-tab.tsx's header comment, "JAY-549".
  // The ConfirmDialogs staged by these controls are untestable here for the
  // same reason every other ConfirmDialog in this file is (AlertDialog's
  // portal gates on a mounted flag — never rendered by `renderToStaticMarkup`,
  // confirmed directly: no existing test in this file queries `removeTarget`/
  // `revokeInviteTarget`/`cancelAccountInviteTarget`'s dialog content either).
  // These tests cover what the pure view CAN prove statically: which control
  // renders, for whom, and its disabled state. ──

  test('the account role is a read-only Badge, not a Select, when canUpdateAccountRole is false', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({ user_id: 'u1', email: 'other@kortix.com' })]}
        currentUserId="viewer"
      />,
    );
    expect(out).not.toContain('Account role for other@kortix.com');
    expect(out).not.toContain('role="combobox"');
  });

  test('the account role becomes a Select for another member when canUpdateAccountRole is true', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({ user_id: 'u1', email: 'other@kortix.com' })]}
        currentUserId="viewer"
        canUpdateAccountRole
      />,
    );
    expect(out).toContain('Account role for other@kortix.com');
    expect(out).toContain('role="combobox"');
  });

  test('a "Remove from account" button renders for another member when canRemoveFromAccount is true', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({ user_id: 'u1', email: 'other@kortix.com' })]}
        currentUserId="viewer"
        canRemoveFromAccount
      />,
    );
    expect(out).toContain('Remove other@kortix.com from account');
  });

  test('no "Remove from account" button when canRemoveFromAccount is false', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({ user_id: 'u1', email: 'other@kortix.com' })]}
        currentUserId="viewer"
      />,
    );
    expect(out).not.toContain('Remove other@kortix.com from account');
  });

  test('both account-role controls are hidden on the viewer\'s own row, even with both permissions', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({ user_id: 'viewer', email: 'self@kortix.com' })]}
        currentUserId="viewer"
        canUpdateAccountRole
        canRemoveFromAccount
      />,
    );
    expect(out).not.toContain('Account role for self@kortix.com');
    expect(out).not.toContain('Remove self@kortix.com from account');
    // Falls back to the read-only Badge on the viewer's own row.
    expect(out).toContain('member');
  });

  test('a busy account row shows a spinner instead of either control', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({ user_id: 'u1', email: 'busy@kortix.com' })]}
        currentUserId="viewer"
        canUpdateAccountRole
        canRemoveFromAccount
        accountPendingUserIds={new Set(['u1'])}
      />,
    );
    expect(out).not.toContain('Account role for busy@kortix.com');
    expect(out).not.toContain('Remove busy@kortix.com from account');
  });

  test('"Remove from account" is disabled for the account\'s sole owner', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({ user_id: 'u1', email: 'owner@kortix.com', account_role: 'owner' })]}
        currentUserId="viewer"
        canRemoveFromAccount
      />,
    );
    expect(out).toContain('The account needs at least one owner.');
  });

  test('"Remove from account" is enabled for an owner when a second owner exists', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[
          member({ user_id: 'u1', email: 'owner1@kortix.com', account_role: 'owner' }),
          member({ user_id: 'u2', email: 'owner2@kortix.com', account_role: 'owner' }),
        ]}
        currentUserId="viewer"
        canRemoveFromAccount
      />,
    );
    expect(out).not.toContain('The account needs at least one owner.');
    expect(out).toContain('Remove owner1@kortix.com from account');
    expect(out).toContain('Remove owner2@kortix.com from account');
  });

  test('renders the account invite dialog slot', () => {
    const out = renderToStaticMarkup(
      <MembersTabView accountInviteDialogSlot={<div>account-invite-dialog-marker</div>} />,
    );
    expect(out).toContain('account-invite-dialog-marker');
  });

  test('the "Account invites" section shows an Invite button gated on canManageAccountInvites, even with zero invites', () => {
    const withoutPerm = renderToStaticMarkup(
      <MembersTabView members={[member({})]} accountId="acc1" canManageAccountInvites={false} />,
    );
    expect(withoutPerm).not.toContain('Account invites');

    const withPerm = renderToStaticMarkup(
      <MembersTabView members={[member({})]} accountId="acc1" canManageAccountInvites />,
    );
    expect(withPerm).toContain('Account invites');
    expect(withPerm).toContain('No pending invites.');
    expect(withPerm).toContain('>Invite<');
  });
});

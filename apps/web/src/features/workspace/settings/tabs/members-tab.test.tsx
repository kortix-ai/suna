import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectAccessMember } from '@kortix/sdk';

import { MembersTabView } from './members-tab';

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
});

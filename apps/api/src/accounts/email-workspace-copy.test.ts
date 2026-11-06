import { describe, expect, test } from 'bun:test';
import { renderAccountInviteEmail, renderProjectAccessRequestEmail, renderProjectAddedEmail } from './email';

/**
 * The invite, added and access-request emails name the one container, the
 * workspace, and the invite names the ladder role it grants (Member,
 * Manager, Admin). Synthetic values only.
 */
describe('workspace emails', () => {
  test('a Manager invite says Role: Manager and joins the workspace', () => {
    const out = renderAccountInviteEmail({
      email: 'invitee@example.test',
      accountName: 'Synthetic Workspace',
      inviterEmail: 'owner@example.test',
      inviteId: '00000000-0000-4000-8000-000000000001',
      role: 'manager',
    });
    expect(out.text).toContain('owner@example.test invited you to join the Synthetic Workspace workspace on Kortix.');
    expect(out.text).toContain('Role: Manager');
    expect(out.text).toContain('it will appear in your workspaces.');
    expect(out.subject).toBe('You\'re invited to join "Synthetic Workspace" on Kortix');
    for (const body of [out.text, out.html]) {
      expect(body).not.toMatch(/\bteam\b|\baccounts list\b|\bproject\b/i);
    }
  });

  test('an invite from a workspace\'s access screen names the workspace too', () => {
    const out = renderAccountInviteEmail({
      email: 'invitee@example.test',
      accountName: 'Synthetic Account',
      inviterEmail: 'owner@example.test',
      inviteId: '00000000-0000-4000-8000-000000000002',
      role: 'member',
      projectName: 'Synthetic Workspace',
    });
    expect(out.text).toContain('invited you to join the Synthetic Workspace workspace on Kortix.');
    expect(out.text).toContain('Role: Member');
    expect(out.text).not.toMatch(/\bproject\b/i);
  });

  test('the added email opens the workspace', () => {
    const out = renderProjectAddedEmail({
      email: 'member@example.test',
      projectId: '00000000-0000-4000-8000-000000000003',
      projectName: 'Synthetic Workspace',
      inviterEmail: null,
      role: 'member',
    });
    expect(out.text).toContain('added you to the Synthetic Workspace workspace as member.');
    expect(out.text).toContain('Open workspace');
    expect(out.text).not.toMatch(/\bproject\b/i);
  });

  test('the access request asks a workspace admin or manager', () => {
    const out = renderProjectAccessRequestEmail({
      email: 'manager@example.test',
      projectName: null,
      requesterEmail: 'requester@example.test',
      reviewUrl: 'https://app.example.test/review',
    });
    expect(out.text).toContain('requested access to a Kortix workspace.');
    expect(out.text).toContain('Workspace admins and managers can approve or decline this in Workspace settings → Members.');
    expect(out.text).not.toMatch(/\bproject\b/i);
  });
});

describe('inviteLadderRole', () => {
  test('reads Manager back from the stored manager grant; Admin and Member from the role', async () => {
    const { inviteLadderRole } = await import('./core/invites');
    expect(inviteLadderRole({ initialRole: 'member', bootstrapGrants: [{ project_id: 'p', role: 'manager' }] })).toBe('manager');
    expect(inviteLadderRole({ initialRole: 'member', bootstrapGrants: [{ account_expires_at: '2026-12-01T00:00:00.000Z' }] })).toBe('member');
    expect(inviteLadderRole({ initialRole: 'admin', bootstrapGrants: [] })).toBe('admin');
    expect(inviteLadderRole({ initialRole: 'member' })).toBe('member');
  });
});

import { describe, expect, test } from 'bun:test';

import { INVITE_ROLES, parseInviteEmails } from './invite-people-dialog';
import { assignableWorkspaceRoles } from './workspace-role-dialog';

describe('parseInviteEmails — the chips an invite sends', () => {
  test('splits on commas, semicolons, spaces and new lines, and lowercases', () => {
    expect(parseInviteEmails('A@Example.com, b@example.com;c@example.com\nd@example.com', [])).toEqual({
      emails: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'],
      rest: '',
    });
  });

  test('drops an email already chipped or typed twice, and keeps a partial entry typed', () => {
    expect(parseInviteEmails('a@example.com a@example.com b@example.com name@', ['b@example.com'])).toEqual({
      emails: ['a@example.com'],
      rest: 'name@',
    });
  });
});

describe('the roles an invite and a role change offer', () => {
  test('an invite carries Member, Manager or Admin, never Owner', () => {
    expect([...INVITE_ROLES]).toEqual(['member', 'manager', 'admin']);
  });

  test('only an owner can make an owner; Admin needs member.update', () => {
    expect(assignableWorkspaceRoles({ viewerIsOwner: true, canGrantAdmin: true })).toEqual([
      'owner',
      'admin',
      'manager',
      'member',
    ]);
    expect(assignableWorkspaceRoles({ viewerIsOwner: false, canGrantAdmin: true })).toEqual(['admin', 'manager', 'member']);
    expect(assignableWorkspaceRoles({ viewerIsOwner: false, canGrantAdmin: false })).toEqual(['manager', 'member']);
  });
});

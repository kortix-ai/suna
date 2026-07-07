import { describe, expect, test } from 'bun:test';
import { visibleMemberRows } from '../accounts/core/member-visibility';

// The roster is deliberately filtered for plain members so an account that
// hosts unrelated invitees doesn't leak the rest of the roster. These lock in
// that cut — the same cut the members list AND its header count rely on.
const rows = [
  { userId: 'owner-1', accountRole: 'owner' },
  { userId: 'admin-1', accountRole: 'admin' },
  { userId: 'member-me', accountRole: 'member' },
  { userId: 'member-other', accountRole: 'member' },
];

describe('visibleMemberRows', () => {
  test('managers see every member', () => {
    expect(visibleMemberRows(rows, 'member-me', true)).toHaveLength(4);
  });

  test('a plain member sees owners/admins + themselves, never other bare members', () => {
    const seen = visibleMemberRows(rows, 'member-me', false).map((r) => r.userId);
    expect(seen).toContain('owner-1');
    expect(seen).toContain('admin-1');
    expect(seen).toContain('member-me');
    // The roster-leak guard: another plain member is NOT visible, so neither
    // the list nor the count (members.length) exposes them or the true size.
    expect(seen).not.toContain('member-other');
    expect(seen).toHaveLength(3);
  });

  test('a plain member who is not themselves a member still sees only owners/admins', () => {
    // e.g. a viewer who was just removed; they never see other bare members.
    const seen = visibleMemberRows(rows, 'ghost', false).map((r) => r.userId);
    expect(seen).toEqual(['owner-1', 'admin-1']);
  });

  test('does not mutate the input rows', () => {
    const snapshot = JSON.parse(JSON.stringify(rows));
    visibleMemberRows(rows, 'member-me', false);
    visibleMemberRows(rows, 'anyone', true);
    expect(rows).toEqual(snapshot);
  });
});

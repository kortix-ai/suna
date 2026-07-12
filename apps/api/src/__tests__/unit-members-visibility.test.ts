import { describe, expect, test } from 'bun:test';
import { canSeeSensitiveMemberColumns } from '../accounts/core/member-visibility';

// The member DIRECTORY is visible to everyone in the account (all rows are
// returned). This gate is ONLY about the sensitive per-member columns — PAT
// count, MFA, groups, project grants — which stay manager-only + own-row.
describe('canSeeSensitiveMemberColumns', () => {
  test('member-managers (owner/admin/member.invite) see sensitive columns on every row', () => {
    expect(canSeeSensitiveMemberColumns('mgr', 'someone-else', true)).toBe(true);
    expect(canSeeSensitiveMemberColumns('mgr', 'mgr', true)).toBe(true);
  });

  test('a plain member sees sensitive columns only on their OWN row', () => {
    expect(canSeeSensitiveMemberColumns('me', 'me', false)).toBe(true);
    // Another member's PAT count / MFA / groups stay hidden from a plain member,
    // even though that member IS visible in the directory.
    expect(canSeeSensitiveMemberColumns('me', 'someone-else', false)).toBe(false);
  });
});

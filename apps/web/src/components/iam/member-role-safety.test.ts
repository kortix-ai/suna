// Two safety/consistency pins, originally against the account members page
// (`accounts/[id]/page.tsx`), repointed at `members-tab.tsx` for JAY-549 —
// that page is deleted by JAY-505, and `members-tab.tsx` is now the only
// caller of `inviteAccountMember`/`updateAccountMemberRole`/
// `removeAccountMember` (see that file's header comment, "JAY-549").
//  1. Changing a member's account role — including promotion to Owner (full
//     account control + billing + deletion) — must go through a
//     confirmation dialog, matching remove; it must never fire directly from
//     a menu selection.
//  2. Role labels/blurbs come from ONE source (ACCOUNT_ROLE_DESCRIPTORS), so
//     the invite dialog, the row's "Change account role" menu, and the
//     permissions-popover copy can't drift apart.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(import.meta.dir, '../../features/workspace/settings/tabs/members-tab.tsx'),
  'utf8',
);
const flat = source.replace(/\s+/g, ' ');

describe('account role change is confirmed', () => {
  test('selecting a role stages a confirmation instead of mutating directly', () => {
    // The mutation must fire from the confirm dialog's onConfirm, not the
    // dropdown menu item's onSelect.
    expect(source).toContain('setAccountRoleChangeTarget(');
    expect(flat).toMatch(
      /if \(!accountRoleChangeTarget\) return; const \{ member, role \} = accountRoleChangeTarget; setAccountRoleChangeTarget\(null\); accountRoleMutation\.mutate\(/,
    );
    // The role menu item stages the target, it does not mutate directly.
    expect(source).not.toMatch(/onSelect=\{\(\) => accountRoleMutation\.mutate/);
  });
});

describe('account removal is confirmed', () => {
  test('requesting removal stages a confirmation instead of mutating directly', () => {
    expect(source).toContain('setAccountRemoveTarget(');
    expect(flat).toMatch(
      /if \(!accountRemoveTarget\) return; const target = accountRemoveTarget; setAccountRemoveTarget\(null\); accountRemoveMutation\.mutate\(/,
    );
    expect(source).not.toMatch(/onSelect=\{\(\) => accountRemoveMutation\.mutate/);
  });
});

describe('role copy has a single source of truth', () => {
  test('the tab renders role labels/blurbs from ACCOUNT_ROLE_DESCRIPTORS', () => {
    expect(source).toContain(
      "import { ACCOUNT_ROLE_DESCRIPTORS } from '@/components/iam/project-role-descriptors';",
    );
    expect(source).toContain('ACCOUNT_ROLE_DESCRIPTORS');
  });
});

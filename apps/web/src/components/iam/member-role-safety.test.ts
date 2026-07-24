// Two safety/consistency pins on the account members page:
//  1. Changing a member's role — including promotion to Owner (full account
//     control + billing + deletion) — must go through a confirmation dialog,
//     matching remove/leave; it previously fired instantly on menu select.
//  2. Role labels/blurbs come from ONE source (ACCOUNT_ROLE_DESCRIPTORS), so the
//     Invite, bulk-change, and permissions-popover copy can't drift apart.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(import.meta.dir, '../../app/(app)/accounts/[id]/page.tsx'),
  'utf8',
);
const flat = source.replace(/\s+/g, ' ');

describe('member role change is confirmed', () => {
  test('selecting a role stages a confirmation instead of mutating directly', () => {
    // The mutation must fire from the confirm dialog, not the menu onSelect.
    expect(source).toContain('setPendingRole(');
    expect(flat).toMatch(/if \(pendingRole\) roleMutation\.mutate\(pendingRole\)/);
  });
});

describe('role copy has a single source of truth', () => {
  test('the page renders role labels/blurbs from ACCOUNT_ROLE_DESCRIPTORS', () => {
    expect(source).toContain(
      "import { ACCOUNT_ROLE_DESCRIPTORS } from '@/components/iam/project-role-descriptors'",
    );
    expect(source).toContain('ACCOUNT_ROLE_DESCRIPTORS');
  });
});

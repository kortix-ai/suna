// The member-detail page (reached via the members-list "View & edit
// permissions" kebab) must SURFACE its built actions — the "View as" simulator
// and the super-admin grant/revoke dialogs. They regressed once to fully
// unreachable (dialogs + mutation present, but nothing opened them and the
// permission probe was a `void` no-op), leaving a page literally labelled
// "…& edit permissions" that was read-only. These pins keep the triggers wired.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(import.meta.dir, '../../app/(app)/accounts/[id]/members/[userId]/page.tsx'),
  'utf8',
);
const flat = source.replace(/\s+/g, ' ');

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

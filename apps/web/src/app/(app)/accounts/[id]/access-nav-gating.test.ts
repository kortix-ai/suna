// The account settings left rail must not offer a section the API will refuse.
//
// ENTITLEMENT gating (does this plan include the feature?) is covered by
// `components/iam/enterprise-upsell.test.ts`. This file covers the other axis:
// PERMISSION gating (may THIS caller read it at all?). The two are independent,
// and conflating them is what produced the bug this file guards:
//
//   `GET /accounts/:id/iam/roles` asserts `role.read`
//   (apps/api/src/accounts/iam/custom-roles.ts). `role.read` is in
//   ADMIN_EXTRAS, NOT in the account `member` floor — unlike `member.read` and
//   `group.read`, which are both in MEMBER_BASELINE
//   (apps/api/src/iam/role-perms.ts). The rail hardcoded `roles: true` for
//   "discoverability", so a plain member saw Roles, clicked it, and landed on
//   "Failed to load roles — You don't have permission to perform this action
//   (role.read)".
//
// Source assertions rather than a render test: the rail is a map of booleans
// inside a large client page, and pinning the map is what stops the regression.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pageSource = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');

const sectionVisible = pageSource.slice(
  pageSource.indexOf('const sectionVisible'),
  pageSource.indexOf('const activeSection'),
);

describe('Access rail gates each section on the permission its data fetch asserts', () => {
  test('probes role.read, not just role.create', () => {
    // role.create answers "can this caller MAKE a role", which is a different
    // question from "may they LIST them" — probing only the former is exactly
    // how the rail item stayed visible for a caller the list route refuses.
    expect(pageSource).toContain("{ action: 'role.read' }");
    expect(pageSource).toContain("{ action: 'role.create' }");
    expect(pageSource).toContain('{ allowed: canReadRoles }');
  });

  test('Roles is hidden unless role.read came back allowed', () => {
    expect(sectionVisible).toContain('roles: canReadRoles === true');
    expect(sectionVisible).not.toMatch(/roles:\s*true/);
  });

  test('Members and Groups stay unconditional — both leaves are in the member floor', () => {
    // Deliberate asymmetry, not an oversight: MEMBER_BASELINE carries
    // member.read and group.read, so gating these would hide rows every member
    // can actually open. Members is also the fallback section, so it must never
    // resolve false.
    expect(sectionVisible).toContain('members: true');
    expect(sectionVisible).toContain('groups: true');
  });

  test('a denied deep link falls back to Members instead of an error pane', () => {
    expect(pageSource).toContain(
      'const activeSection: AccountSection = sectionVisible[requestedTab] ? requestedTab : \'members\'',
    );
  });

  test('a group whose every item is hidden drops its heading too', () => {
    expect(pageSource).toContain('group.items.filter((item) => sectionVisible[item.id])');
  });
});

/**
 * The role VOCABULARY — the two parsers in `iam/roles.ts` and the rank fold.
 *
 * All that is left of `unit-iam-v2-role-perms.test.ts`. Everything it pinned
 * about what a role CAN DO moved to `integration-iam-role-catalog-parity.test.ts`,
 * because the permission Sets it asserted against are rows now
 * (`kortix.role_permissions`) and a code-only test could no longer see the truth.
 *
 * These are policy decisions — if one breaks, it is a deliberate scope change,
 * not a bug.
 */
import { describe, test, expect } from 'bun:test';
import {
  isAccountManager,
  maxProjectRole,
  normalizeProjectRole,
  parseAssignableProjectRole,
  PROJECT_ROLE_RANK,
} from '../iam/roles';

describe('project role rank', () => {
  test('manager outranks member, and maxProjectRole picks the stronger', () => {
    expect(PROJECT_ROLE_RANK.manager).toBeGreaterThan(PROJECT_ROLE_RANK.member);
    expect(maxProjectRole('member', 'member')).toBe('member');
    expect(maxProjectRole('member', 'manager')).toBe('manager');
    expect(maxProjectRole('manager', 'member')).toBe('manager');
    expect(maxProjectRole('manager', 'manager')).toBe('manager');
  });
});

describe('the two parsers', () => {
  // The removed `editor` role: stored values FOLD (a read must never fail on a
  // row Postgres can still hold — the enum label is undroppable), assignable
  // input REJECTS (nobody is silently promoted to full project control by asking
  // for the old middle tier).
  test('editor folds to manager on read and is rejected on write', () => {
    expect(normalizeProjectRole('editor')).toBe('manager');
    expect(normalizeProjectRole(' EDITOR ')).toBe('manager');
    expect(parseAssignableProjectRole('editor')).toBeNull();
    expect(parseAssignableProjectRole(' EDITOR ')).toBeNull();
  });

  test('the other retired tiers fold to member on both paths', () => {
    for (const parse of [normalizeProjectRole, parseAssignableProjectRole]) {
      expect(parse('user')).toBe('member');
      expect(parse('viewer')).toBe('member');
      expect(parse(' USER ')).toBe('member');
      expect(parse(' VIEWER ')).toBe('member');
      expect(parse('manager')).toBe('manager');
      expect(parse('member')).toBe('member');
      expect(parse(' Manager ')).toBe('manager');
      expect(parse('owner')).toBeNull();
      expect(parse(null)).toBeNull();
      expect(parse(7)).toBeNull();
      expect(parse('')).toBeNull();
    }
  });

  // The SQL half of the fold — `kortix.rbac_project_role_key()`, used by the
  // compatibility views' INSTEAD OF triggers — must agree with the TypeScript
  // half, or a write through `kortix.project_members` lands on a different role
  // than the same value written through `assignRole`.
  test('the fold table is exactly the one the SQL function implements', () => {
    expect(
      Object.fromEntries(
        ['editor', 'viewer', 'user', 'manager', 'member'].map((v) => [v, normalizeProjectRole(v)]),
      ),
    ).toEqual({
      editor: 'manager',
      viewer: 'member',
      user: 'member',
      manager: 'manager',
      member: 'member',
    });
  });
});

describe('account manager tier', () => {
  // Owner and admin get implicit Manager on every project in the account; a
  // plain member gets nothing implicitly. The ENGINE expresses this as scope
  // containment (`isImplicitManager` in iam/authorize.ts) rather than as a role
  // lookup — this helper is the display-tier spelling of the same rule.
  test('owner and admin only', () => {
    expect(isAccountManager('owner')).toBe(true);
    expect(isAccountManager('admin')).toBe(true);
    expect(isAccountManager('member')).toBe(false);
    expect(isAccountManager(null)).toBe(false);
  });
});

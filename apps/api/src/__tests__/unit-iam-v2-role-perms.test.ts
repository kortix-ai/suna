// Pin the invariants of the V2 role table. These are policy decisions —
// if a test here breaks, that's a deliberate scope change, not a bug.

import { describe, test, expect } from 'bun:test';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from '../iam/actions';
import {
  ACCOUNT_ROLE_PERMS,
  PROJECT_ROLE_PERMS,
  accountRoleAllows,
  projectRoleAllows,
  maxProjectRole,
  implicitProjectRoleForAccount,
} from '../iam/role-perms';

describe('IAM V2 — account role table', () => {
  test('owner ⊇ admin ⊇ member', () => {
    for (const a of ACCOUNT_ROLE_PERMS.member) {
      expect(ACCOUNT_ROLE_PERMS.admin.has(a)).toBe(true);
      expect(ACCOUNT_ROLE_PERMS.owner.has(a)).toBe(true);
    }
    for (const a of ACCOUNT_ROLE_PERMS.admin) {
      expect(ACCOUNT_ROLE_PERMS.owner.has(a)).toBe(true);
    }
  });

  test('plain member has no write actions', () => {
    for (const a of ACCOUNT_ROLE_PERMS.member) {
      expect(a).not.toMatch(/\.(create|update|delete|invite|remove|write|revoke|manage|grant)$/);
    }
  });

  test('owner-only actions are owner-only', () => {
    const ownerOnly = [
      ACCOUNT_ACTIONS.ACCOUNT_DELETE,
      ACCOUNT_ACTIONS.BILLING_WRITE,
      ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT,
    ];
    for (const a of ownerOnly) {
      expect(accountRoleAllows('owner', a)).toBe(true);
      expect(accountRoleAllows('admin', a)).toBe(false);
      expect(accountRoleAllows('member', a)).toBe(false);
    }
  });

  test('admin can create projects, member cannot', () => {
    expect(accountRoleAllows('admin', ACCOUNT_ACTIONS.PROJECT_CREATE)).toBe(true);
    expect(accountRoleAllows('member', ACCOUNT_ACTIONS.PROJECT_CREATE)).toBe(false);
  });
});

describe('IAM V2 — project role table', () => {
  test('manager ⊇ editor ⊇ viewer', () => {
    for (const a of PROJECT_ROLE_PERMS.viewer) {
      expect(PROJECT_ROLE_PERMS.editor.has(a)).toBe(true);
      expect(PROJECT_ROLE_PERMS.manager.has(a)).toBe(true);
    }
    for (const a of PROJECT_ROLE_PERMS.editor) {
      expect(PROJECT_ROLE_PERMS.manager.has(a)).toBe(true);
    }
  });

  test('viewer has only read-ish actions', () => {
    for (const a of PROJECT_ROLE_PERMS.viewer) {
      expect(a).toMatch(/\.(read)$/);
    }
  });

  test('editor can fire and write triggers but not manage members or delete project', () => {
    expect(projectRoleAllows('editor', PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE)).toBe(true);
    expect(projectRoleAllows('editor', PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE)).toBe(true);
    expect(projectRoleAllows('editor', PROJECT_ACTIONS.PROJECT_WRITE)).toBe(true);
    expect(projectRoleAllows('editor', PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)).toBe(false);
    expect(projectRoleAllows('editor', PROJECT_ACTIONS.PROJECT_DELETE)).toBe(false);
  });

  test('only manager can delete project or manage members', () => {
    expect(projectRoleAllows('manager', PROJECT_ACTIONS.PROJECT_DELETE)).toBe(true);
    expect(projectRoleAllows('manager', PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)).toBe(true);
    expect(projectRoleAllows('editor', PROJECT_ACTIONS.PROJECT_DELETE)).toBe(false);
    expect(projectRoleAllows('viewer', PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)).toBe(false);
  });
});

describe('IAM V2 — role helpers', () => {
  test('maxProjectRole picks the stronger role', () => {
    expect(maxProjectRole('viewer', 'viewer')).toBe('viewer');
    expect(maxProjectRole('viewer', 'editor')).toBe('editor');
    expect(maxProjectRole('editor', 'viewer')).toBe('editor');
    expect(maxProjectRole('editor', 'manager')).toBe('manager');
    expect(maxProjectRole('manager', 'editor')).toBe('manager');
  });

  test('implicit project role: owner/admin get manager, member gets none', () => {
    expect(implicitProjectRoleForAccount('owner')).toBe('manager');
    expect(implicitProjectRoleForAccount('admin')).toBe('manager');
    expect(implicitProjectRoleForAccount('member')).toBeNull();
  });
});

describe('IAM V2 — no unknown actions', () => {
  // Every action in the V2 role table must exist in actions.ts. A typo
  // here would silently grant nothing.
  test('every role action is a known action key', () => {
    const known = new Set<string>([
      ...Object.values(ACCOUNT_ACTIONS),
      ...Object.values(PROJECT_ACTIONS),
    ]);
    for (const role of Object.values(ACCOUNT_ROLE_PERMS)) {
      for (const a of role) expect(known.has(a)).toBe(true);
    }
    for (const role of Object.values(PROJECT_ROLE_PERMS)) {
      for (const a of role) expect(known.has(a)).toBe(true);
    }
  });
});

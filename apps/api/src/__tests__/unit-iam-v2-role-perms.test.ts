// Pin the invariants of the V2 role table. These are policy decisions —
// if a test here breaks, that's a deliberate scope change, not a bug.

import { describe, test, expect } from 'bun:test';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from '../iam/actions';
import {
  accountRoleAllows,
  projectRoleAllows,
  maxProjectRole,
  implicitProjectRoleForAccount,
} from '../iam/role-perms';

describe('IAM V2 — account role table', () => {
  test('owner ⊇ admin ⊇ member', () => {
    for (const a of memberAccountActions) {
      expect(accountRoleAllows('admin', a)).toBe(true);
      expect(accountRoleAllows('owner', a)).toBe(true);
    }
    for (const a of adminAccountActions) {
      expect(accountRoleAllows('owner', a)).toBe(true);
    }
  });

  test('plain member has no write actions', () => {
    for (const a of memberAccountActions) {
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
    for (const a of viewerProjectActions) {
      expect(projectRoleAllows('editor', a)).toBe(true);
      expect(projectRoleAllows('manager', a)).toBe(true);
    }
    for (const a of editorProjectActions) {
      expect(projectRoleAllows('manager', a)).toBe(true);
    }
  });

  test('viewer has only read-ish actions', () => {
    for (const a of viewerProjectActions) {
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
  test('role probes match the full explicit action matrix', () => {
    assertAccountRoleMatrix('member', memberAccountActions);
    assertAccountRoleMatrix('admin', adminAccountActions);
    assertAccountRoleMatrix('owner', ownerAccountActions);
    assertProjectRoleMatrix('viewer', viewerProjectActions);
    assertProjectRoleMatrix('editor', editorProjectActions);
    assertProjectRoleMatrix('manager', managerProjectActions);
  });
});

const memberAccountActions = [
  ACCOUNT_ACTIONS.ACCOUNT_READ,
  ACCOUNT_ACTIONS.BILLING_READ,
  ACCOUNT_ACTIONS.MEMBER_READ,
  ACCOUNT_ACTIONS.GROUP_READ,
  ACCOUNT_ACTIONS.TOKEN_READ,
] as const;

const adminAccountActions = [
  ...memberAccountActions,
  ACCOUNT_ACTIONS.ACCOUNT_WRITE,
  ACCOUNT_ACTIONS.MEMBER_INVITE,
  ACCOUNT_ACTIONS.MEMBER_UPDATE,
  ACCOUNT_ACTIONS.MEMBER_REMOVE,
  ACCOUNT_ACTIONS.GROUP_CREATE,
  ACCOUNT_ACTIONS.GROUP_UPDATE,
  ACCOUNT_ACTIONS.GROUP_DELETE,
  ACCOUNT_ACTIONS.GROUP_MEMBERS_MANAGE,
  ACCOUNT_ACTIONS.TOKEN_CREATE,
  ACCOUNT_ACTIONS.TOKEN_REVOKE,
  ACCOUNT_ACTIONS.AUDIT_READ,
  ACCOUNT_ACTIONS.PROJECT_CREATE,
] as const;

const ownerAccountActions = [
  ...adminAccountActions,
  ACCOUNT_ACTIONS.ACCOUNT_DELETE,
  ACCOUNT_ACTIONS.BILLING_WRITE,
  ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT,
] as const;

const viewerProjectActions = [
  PROJECT_ACTIONS.PROJECT_READ,
  PROJECT_ACTIONS.PROJECT_SESSION_READ,
  PROJECT_ACTIONS.PROJECT_MEMBERS_READ,
  PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
] as const;

const editorProjectActions = [
  ...viewerProjectActions,
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_DEPLOY,
  PROJECT_ACTIONS.PROJECT_SESSION_START,
  PROJECT_ACTIONS.PROJECT_SESSION_EXEC,
  PROJECT_ACTIONS.PROJECT_SESSION_STOP,
  PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE,
  PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
] as const;

const managerProjectActions = [
  ...editorProjectActions,
  PROJECT_ACTIONS.PROJECT_DELETE,
  PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
] as const;

function assertAccountRoleMatrix(role: 'owner' | 'admin' | 'member', allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  for (const action of Object.values(ACCOUNT_ACTIONS)) {
    expect(accountRoleAllows(role, action)).toBe(allowedSet.has(action));
  }
  for (const action of Object.values(PROJECT_ACTIONS)) {
    expect(accountRoleAllows(role, action)).toBe(false);
  }
  expect(accountRoleAllows(role, 'unknown.action')).toBe(false);
}

function assertProjectRoleMatrix(role: 'manager' | 'editor' | 'viewer', allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  for (const action of Object.values(PROJECT_ACTIONS)) {
    expect(projectRoleAllows(role, action)).toBe(allowedSet.has(action));
  }
  for (const action of Object.values(ACCOUNT_ACTIONS)) {
    expect(projectRoleAllows(role, action)).toBe(false);
  }
  expect(projectRoleAllows(role, 'unknown.action')).toBe(false);
}

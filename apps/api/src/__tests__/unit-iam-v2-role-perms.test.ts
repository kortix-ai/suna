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
  test('manager ⊇ editor ⊇ user', () => {
    for (const a of PROJECT_ROLE_PERMS.user) {
      expect(PROJECT_ROLE_PERMS.editor.has(a)).toBe(true);
      expect(PROJECT_ROLE_PERMS.manager.has(a)).toBe(true);
    }
    for (const a of PROJECT_ROLE_PERMS.editor) {
      expect(PROJECT_ROLE_PERMS.manager.has(a)).toBe(true);
    }
  });

  test('user is the floor role: reads + runs sessions + fires triggers, no customization', () => {
    // Every user action is a read, a session-lifecycle action, or trigger.fire —
    // the floor role can use the agent/chat and operate automations, but never
    // edit, deploy, create/delete triggers, or manage. (The old `viewer` tier
    // folded into `user`, which adds trigger.fire on top of read+run.)
    for (const a of PROJECT_ROLE_PERMS.user) {
      expect(a).toMatch(/\.(read|start|exec|stop|fire)$/);
    }
    // Can start / run / stop sessions (the floor role must be able to USE Kortix).
    expect(projectRoleAllows('user', PROJECT_ACTIONS.PROJECT_SESSION_START)).toBe(true);
    expect(projectRoleAllows('user', PROJECT_ACTIONS.PROJECT_SESSION_EXEC)).toBe(true);
    expect(projectRoleAllows('user', PROJECT_ACTIONS.PROJECT_SESSION_STOP)).toBe(true);
    // ...and can FIRE the project's triggers (operate its automations).
    expect(projectRoleAllows('user', PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE)).toBe(true);
    // ...but cannot customize the project in any way.
    expect(projectRoleAllows('user', PROJECT_ACTIONS.PROJECT_WRITE)).toBe(false);
    expect(projectRoleAllows('user', PROJECT_ACTIONS.PROJECT_DEPLOY)).toBe(false);
    expect(projectRoleAllows('user', PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE)).toBe(false);
    expect(projectRoleAllows('user', PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)).toBe(false);
    expect(projectRoleAllows('user', PROJECT_ACTIONS.PROJECT_DELETE)).toBe(false);
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
    expect(projectRoleAllows('user', PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)).toBe(false);
  });
});

describe('IAM V2 — role helpers', () => {
  test('maxProjectRole picks the stronger role', () => {
    expect(maxProjectRole('user', 'user')).toBe('user');
    expect(maxProjectRole('user', 'editor')).toBe('editor');
    expect(maxProjectRole('editor', 'user')).toBe('editor');
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
  // IAM v1 per-capability leaves: backward-compat invariant. Editor must hold
  // every write leaf (it had all of these via project.write before) and the
  // User floor role every read leaf (via project.read). User must NOT gain any
  // write leaf.
  test('per-capability leaves preserve the editor/user capability surface', () => {
    const writeLeaves = [
      PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
      PROJECT_ACTIONS.PROJECT_SKILL_WRITE,
      PROJECT_ACTIONS.PROJECT_COMMAND_WRITE,
      PROJECT_ACTIONS.PROJECT_SCHEDULE_WRITE,
      PROJECT_ACTIONS.PROJECT_WEBHOOK_WRITE,
      PROJECT_ACTIONS.PROJECT_FILE_WRITE,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
      PROJECT_ACTIONS.PROJECT_GITOPS_PUSH,
      PROJECT_ACTIONS.PROJECT_GITOPS_MERGE,
      PROJECT_ACTIONS.PROJECT_SECRET_WRITE,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    ];
    const readLeaves = [
      PROJECT_ACTIONS.PROJECT_AGENT_READ,
      PROJECT_ACTIONS.PROJECT_SKILL_READ,
      PROJECT_ACTIONS.PROJECT_COMMAND_READ,
      PROJECT_ACTIONS.PROJECT_SCHEDULE_READ,
      PROJECT_ACTIONS.PROJECT_WEBHOOK_READ,
      PROJECT_ACTIONS.PROJECT_FILE_READ,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
      PROJECT_ACTIONS.PROJECT_GITOPS_READ,
      PROJECT_ACTIONS.PROJECT_SECRET_READ,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
    ];
    for (const a of writeLeaves) {
      expect(projectRoleAllows('editor', a)).toBe(true);
      expect(projectRoleAllows('manager', a)).toBe(true);
      expect(projectRoleAllows('user', a)).toBe(false);
    }
    for (const a of readLeaves) {
      expect(projectRoleAllows('user', a)).toBe(true);
      expect(projectRoleAllows('editor', a)).toBe(true);
    }
  });

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

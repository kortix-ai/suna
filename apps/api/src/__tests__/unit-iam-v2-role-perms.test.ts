// Pin the invariants of the V2 role table. These are policy decisions —
// if a test here breaks, that's a deliberate scope change, not a bug.

import { describe, test, expect } from 'bun:test';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from '../iam/actions';
import {
  ACCOUNT_ONLY_PROJECT_ACTIONS,
  ACCOUNT_ROLE_PERMS,
  PROJECT_ROLE_PERMS,
  PROJECT_ROLE_RANK,
  accountRoleAllows,
  projectRoleAllows,
  maxProjectRole,
  implicitProjectRoleForAccount,
  normalizeProjectRole,
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

  // Project-role collapse (manager retired): the three former manager-only
  // project leaves are promoted to account owner/admin authority. Plain
  // account member never gets them.
  test('owner and admin hold the three former manager-only project actions; plain member does not', () => {
    for (const a of ACCOUNT_ONLY_PROJECT_ACTIONS) {
      expect(accountRoleAllows('owner', a)).toBe(true);
      expect(accountRoleAllows('admin', a)).toBe(true);
      expect(accountRoleAllows('member', a)).toBe(false);
    }
  });

  test('ACCOUNT_ONLY_PROJECT_ACTIONS is exactly the three former manager-only leaves', () => {
    expect([...ACCOUNT_ONLY_PROJECT_ACTIONS].sort()).toEqual(
      [
        PROJECT_ACTIONS.PROJECT_DELETE,
        PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
        PROJECT_ACTIONS.PROJECT_GATEWAY_KEYS_MANAGE,
      ].sort(),
    );
  });
});

describe('IAM V2 — project role table (2 tiers: manager was retired)', () => {
  test('exactly two project roles exist: editor and member', () => {
    expect(Object.keys(PROJECT_ROLE_PERMS).sort()).toEqual(['editor', 'member']);
    expect(Object.keys(PROJECT_ROLE_RANK).sort()).toEqual(['editor', 'member']);
  });

  test('editor ⊇ member (strict superset)', () => {
    for (const a of PROJECT_ROLE_PERMS.member) {
      expect(PROJECT_ROLE_PERMS.editor.has(a)).toBe(true);
    }
  });

  test('member is the floor role: reads + runs sessions + fires triggers, no customization', () => {
    // Every member action is a read, a session-lifecycle action, trigger.fire,
    // or review.submit — the floor role can use the agent/chat, operate
    // automations, and have its agent put work up for human review, but never
    // edit, deploy, create/delete triggers, act on a review item, or manage.
    // (The old `viewer` tier folded into `member`, which adds trigger.fire on
    // top of read+run. review.submit is not a "write": it's the agent
    // producing output for a human to decide on, not a project customization —
    // see PROJECT_REVIEW_SUBMIT vs PROJECT_REVIEW_ACT in actions.ts.)
    for (const a of PROJECT_ROLE_PERMS.member) {
      expect(a).toMatch(/\.(read|start|stop|fire|submit)$/);
    }
    // Can start / run / stop sessions (the floor role must be able to USE Kortix).
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_SESSION_START)).toBe(true);
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_SESSION_STOP)).toBe(true);
    // ...and can FIRE the project's triggers (operate its automations).
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE)).toBe(true);
    // ...but cannot customize the project in any way.
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_WRITE)).toBe(false);
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_DEPLOY)).toBe(false);
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE)).toBe(false);
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)).toBe(false);
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_DELETE)).toBe(false);
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_GATEWAY_KEYS_MANAGE)).toBe(false);
  });

  test('editor (the top project role) can fire and write triggers but NEVER manage members, delete the project, or manage gateway keys', () => {
    expect(projectRoleAllows('editor', PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE)).toBe(true);
    expect(projectRoleAllows('editor', PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE)).toBe(true);
    expect(projectRoleAllows('editor', PROJECT_ACTIONS.PROJECT_WRITE)).toBe(true);
    // The three actions that used to belong to the retired `manager` role are
    // NOT reachable via editor — they moved to account owner/admin authority.
    expect(projectRoleAllows('editor', PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)).toBe(false);
    expect(projectRoleAllows('editor', PROJECT_ACTIONS.PROJECT_DELETE)).toBe(false);
    expect(projectRoleAllows('editor', PROJECT_ACTIONS.PROJECT_GATEWAY_KEYS_MANAGE)).toBe(false);
  });

  test('no project role — built-in or otherwise — ever grants the three former manager-only actions', () => {
    for (const role of Object.keys(PROJECT_ROLE_PERMS) as Array<keyof typeof PROJECT_ROLE_PERMS>) {
      for (const a of ACCOUNT_ONLY_PROJECT_ACTIONS) {
        expect(projectRoleAllows(role, a)).toBe(false);
      }
    }
  });
});

describe('IAM V2 — role helpers', () => {
  test('maxProjectRole picks the stronger role', () => {
    expect(maxProjectRole('member', 'member')).toBe('member');
    expect(maxProjectRole('member', 'editor')).toBe('editor');
    expect(maxProjectRole('editor', 'member')).toBe('editor');
    expect(maxProjectRole('editor', 'editor')).toBe('editor');
  });

  test('implicit project role: owner/admin get editor (the top project role), member gets none', () => {
    expect(implicitProjectRoleForAccount('owner')).toBe('editor');
    expect(implicitProjectRoleForAccount('admin')).toBe('editor');
    expect(implicitProjectRoleForAccount('member')).toBeNull();
  });

  test('normalizeProjectRole folds every retired alias (manager, viewer, user) into its current tier', () => {
    expect(normalizeProjectRole('manager')).toBe('editor');
    expect(normalizeProjectRole('MANAGER')).toBe('editor');
    expect(normalizeProjectRole('viewer')).toBe('member');
    expect(normalizeProjectRole('user')).toBe('member');
    expect(normalizeProjectRole('editor')).toBe('editor');
    expect(normalizeProjectRole('member')).toBe('member');
    expect(normalizeProjectRole('nonsense')).toBeNull();
    expect(normalizeProjectRole(null)).toBeNull();
    expect(normalizeProjectRole(undefined)).toBeNull();
    expect(normalizeProjectRole(42)).toBeNull();
  });
});

describe('IAM V2 — no unknown actions', () => {
  // IAM v1 per-capability leaves: backward-compat invariant. Editor must hold
  // every write leaf (it had all of these via project.write before) and the
  // Member floor role every read leaf (via project.read). Member must NOT gain any
  // write leaf.
  test('per-capability leaves preserve the editor/member capability surface', () => {
    const writeLeaves = [
      PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
      PROJECT_ACTIONS.PROJECT_SKILL_WRITE,
      PROJECT_ACTIONS.PROJECT_COMMAND_WRITE,
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
      PROJECT_ACTIONS.PROJECT_FILE_READ,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
      PROJECT_ACTIONS.PROJECT_GITOPS_READ,
      PROJECT_ACTIONS.PROJECT_SECRET_READ,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
    ];
    for (const a of writeLeaves) {
      expect(projectRoleAllows('editor', a)).toBe(true);
      expect(projectRoleAllows('member', a)).toBe(false);
    }
    for (const a of readLeaves) {
      expect(projectRoleAllows('member', a)).toBe(true);
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

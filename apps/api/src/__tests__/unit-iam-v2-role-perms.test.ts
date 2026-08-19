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
  normalizeProjectRole,
  parseAssignableProjectRole,
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
  // Owner decision 2026-08-18: `editor` is removed. Two roles remain.
  test('there are exactly two project roles: member and manager', () => {
    expect(Object.keys(PROJECT_ROLE_PERMS).sort()).toEqual(['manager', 'member']);
  });

  test('manager ⊇ member', () => {
    for (const a of PROJECT_ROLE_PERMS.member) {
      expect(PROJECT_ROLE_PERMS.manager.has(a)).toBe(true);
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
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE)).toBe(false);
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)).toBe(false);
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_DELETE)).toBe(false);
  });

  test('Apps own their leaves: member reads, manager writes and deploys', () => {
    // Apps used to assert project.customize.write / project.gitops.read, so a
    // custom role could not turn Apps on or off without dragging every other
    // customization leaf with it. Seeding follows the documented convention:
    // read leaf → floor member, write leaves → manager. WHICH Apps a member then
    // sees is the App access policy's job, not this leaf's (see apps/access.ts).
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_APP_READ)).toBe(true);
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_APP_WRITE)).toBe(false);
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_APP_DEPLOY)).toBe(false);

    expect(projectRoleAllows('manager', PROJECT_ACTIONS.PROJECT_APP_READ)).toBe(true);
    expect(projectRoleAllows('manager', PROJECT_ACTIONS.PROJECT_APP_WRITE)).toBe(true);
    expect(projectRoleAllows('manager', PROJECT_ACTIONS.PROJECT_APP_DEPLOY)).toBe(true);
  });

  test('manager can fire and write triggers, manage members and delete the project', () => {
    expect(projectRoleAllows('manager', PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE)).toBe(true);
    expect(projectRoleAllows('manager', PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE)).toBe(true);
    expect(projectRoleAllows('manager', PROJECT_ACTIONS.PROJECT_WRITE)).toBe(true);
    expect(projectRoleAllows('manager', PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)).toBe(true);
    expect(projectRoleAllows('manager', PROJECT_ACTIONS.PROJECT_DELETE)).toBe(true);
  });

  test('only manager can delete project or manage members', () => {
    expect(projectRoleAllows('manager', PROJECT_ACTIONS.PROJECT_DELETE)).toBe(true);
    expect(projectRoleAllows('manager', PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)).toBe(true);
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_DELETE)).toBe(false);
    expect(projectRoleAllows('member', PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)).toBe(false);
  });
});

describe('IAM V2 — role helpers', () => {
  test('maxProjectRole picks the stronger role', () => {
    expect(maxProjectRole('member', 'member')).toBe('member');
    expect(maxProjectRole('member', 'manager')).toBe('manager');
    expect(maxProjectRole('manager', 'member')).toBe('manager');
    expect(maxProjectRole('manager', 'manager')).toBe('manager');
  });

  // The removed `editor` role: stored values FOLD (a read must never fail on a
  // row Postgres can still hold), assignable input REJECTS (nobody is silently
  // promoted to full project control by asking for the old middle tier).
  test('editor folds to manager on read and is rejected on write', () => {
    expect(normalizeProjectRole('editor')).toBe('manager');
    expect(normalizeProjectRole(' EDITOR ')).toBe('manager');
    expect(parseAssignableProjectRole('editor')).toBeNull();
    expect(parseAssignableProjectRole(' EDITOR ')).toBeNull();
  });

  test('the other retired tiers still fold to member on both paths', () => {
    for (const parse of [normalizeProjectRole, parseAssignableProjectRole]) {
      expect(parse('user')).toBe('member');
      expect(parse('viewer')).toBe('member');
      expect(parse('manager')).toBe('manager');
      expect(parse('member')).toBe('member');
      expect(parse('owner')).toBeNull();
      expect(parse(null)).toBeNull();
    }
  });

  test('implicit project role: owner/admin get manager, member gets none', () => {
    expect(implicitProjectRoleForAccount('owner')).toBe('manager');
    expect(implicitProjectRoleForAccount('admin')).toBe('manager');
    expect(implicitProjectRoleForAccount('member')).toBeNull();
  });
});

describe('IAM V2 — no unknown actions', () => {
  // IAM v1 per-capability leaves: backward-compat invariant. Manager must hold
  // every write leaf (it had all of these via project.write before). The floor
  // Member role keeps only the non-Customize read leaves — file.read,
  // secret.read, agent.read, connector.read, skill.read, and customize.read are
  // ALL manager-tier: a plain member gets zero default access to Agents,
  // Connectors, Skills, or the Customize surface. Member must NOT gain any
  // write leaf.
  test('per-capability leaves preserve the manager/member capability surface', () => {
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
    // Reads the floor member role keeps. project.agent.read is one of them:
    // "member = read + run" is only true if the role can reach an agent at all,
    // and a per-resource grant NARROWS an allow rather than creating one. The
    // deny-by-default grant fold is what limits a member to the agents granted
    // to them (see iam/resource-grants.ts).
    const memberReadLeaves = [
      PROJECT_ACTIONS.PROJECT_COMMAND_READ,
      PROJECT_ACTIONS.PROJECT_GITOPS_READ,
      PROJECT_ACTIONS.PROJECT_AGENT_READ,
    ];
    // Sensitive/Customize reads that are manager-tier (member is denied): files,
    // secrets, and the Connectors/Skills/Customize surface. These folds remain
    // unscoped-is-open, so holding the leaf would grant the whole surface.
    const managerReadLeaves = [
      PROJECT_ACTIONS.PROJECT_FILE_READ,
      PROJECT_ACTIONS.PROJECT_SECRET_READ,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
      PROJECT_ACTIONS.PROJECT_SKILL_READ,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
    ];
    for (const a of writeLeaves) {
      expect(projectRoleAllows('manager', a)).toBe(true);
      expect(projectRoleAllows('member', a)).toBe(false);
    }
    for (const a of memberReadLeaves) {
      expect(projectRoleAllows('member', a)).toBe(true);
      expect(projectRoleAllows('manager', a)).toBe(true);
    }
    for (const a of managerReadLeaves) {
      expect(projectRoleAllows('member', a)).toBe(false);
      expect(projectRoleAllows('manager', a)).toBe(true);
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

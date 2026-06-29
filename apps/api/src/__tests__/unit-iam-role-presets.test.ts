import { describe, expect, test } from 'bun:test';

import {
  BUILTIN_BY_ID,
  BUILTIN_PRESETS,
  USER_PRESET_ACTIONS,
  validateActions,
} from '../accounts/iam/role-presets';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS, VALID_ACTIONS } from '../iam/actions';

describe('built-in role presets', () => {
  test('exposes the built-ins with "user" as the project floor (no viewer)', () => {
    const keys = BUILTIN_PRESETS.map((p) => p.key).sort();
    // `viewer` was retired — folded into `user`, the read+run floor role.
    expect(keys).toEqual(['admin', 'editor', 'manager', 'member', 'owner', 'user']);
  });

  test('every preset action is a real action (no drift from actions.ts)', () => {
    for (const p of BUILTIN_PRESETS) {
      for (const a of p.actions) expect(VALID_ACTIONS.has(a)).toBe(true);
    }
  });

  test('BUILTIN_BY_ID keys on the synthetic builtin: id', () => {
    expect(BUILTIN_BY_ID.get('builtin:manager')?.key).toBe('manager');
    expect(BUILTIN_BY_ID.has('builtin:nope')).toBe(false);
  });

  test('User tier = read + run: has session start/exec/stop + trigger.fire, NOT write/config', () => {
    const set = new Set(USER_PRESET_ACTIONS);
    expect(set.has(PROJECT_ACTIONS.PROJECT_READ)).toBe(true);
    expect(set.has(PROJECT_ACTIONS.PROJECT_SESSION_START)).toBe(true);
    expect(set.has(PROJECT_ACTIONS.PROJECT_SESSION_EXEC)).toBe(true);
    expect(set.has(PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE)).toBe(true);
    // read leaves yes…
    expect(set.has(PROJECT_ACTIONS.PROJECT_AGENT_READ)).toBe(true);
    // …but NO write/config/gitops/members/deploy
    expect(set.has(PROJECT_ACTIONS.PROJECT_WRITE)).toBe(false);
    expect(set.has(PROJECT_ACTIONS.PROJECT_AGENT_WRITE)).toBe(false);
    expect(set.has(PROJECT_ACTIONS.PROJECT_GITOPS_MERGE)).toBe(false);
    expect(set.has(PROJECT_ACTIONS.PROJECT_DEPLOY)).toBe(false);
    expect(set.has(PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)).toBe(false);
  });
});

describe('validateActions', () => {
  test('accepts known actions and dedupes', () => {
    const r = validateActions([PROJECT_ACTIONS.PROJECT_READ, PROJECT_ACTIONS.PROJECT_READ, PROJECT_ACTIONS.PROJECT_AGENT_WRITE]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actions).toEqual([PROJECT_ACTIONS.PROJECT_READ, PROJECT_ACTIONS.PROJECT_AGENT_WRITE]);
  });

  test('rejects an unknown / injected action string', () => {
    const r = validateActions([PROJECT_ACTIONS.PROJECT_READ, 'project.everything.hax']);
    expect(r.ok).toBe(false);
  });

  test('rejects a non-array', () => {
    expect(validateActions('project.read').ok).toBe(false);
    expect(validateActions(null).ok).toBe(false);
  });

  test('accepts an empty set (a role that grants nothing yet)', () => {
    const r = validateActions([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actions).toEqual([]);
  });
});

describe('validateActions — privilege-escalation ceiling', () => {
  // Owner-only + IAM-management powers can never be packed into a custom role,
  // regardless of the role's scope. Otherwise an admin (who holds role.create +
  // policy.create) could mint such a role, bind themselves, and become owner.
  const FORBIDDEN = [
    ACCOUNT_ACTIONS.ACCOUNT_DELETE,
    ACCOUNT_ACTIONS.BILLING_WRITE,
    ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT,
    ACCOUNT_ACTIONS.MEMBER_INVITE,
    ACCOUNT_ACTIONS.MEMBER_UPDATE,
    ACCOUNT_ACTIONS.MEMBER_REMOVE,
    ACCOUNT_ACTIONS.GROUP_CREATE,
    ACCOUNT_ACTIONS.GROUP_MEMBERS_MANAGE,
    ACCOUNT_ACTIONS.ROLE_CREATE,
    ACCOUNT_ACTIONS.ROLE_UPDATE,
    ACCOUNT_ACTIONS.ROLE_DELETE,
    ACCOUNT_ACTIONS.POLICY_CREATE,
    ACCOUNT_ACTIONS.POLICY_DELETE,
    ACCOUNT_ACTIONS.TOKEN_CREATE,
    ACCOUNT_ACTIONS.TOKEN_REVOKE,
  ];

  test('every non-delegable action is rejected even in an account role', () => {
    for (const a of FORBIDDEN) {
      const r = validateActions([a], 'account');
      expect(r.ok).toBe(false);
    }
  });

  test('every non-delegable action is in the built-in admin/owner presets (so they are not lost, just non-delegable)', () => {
    const owner = new Set(BUILTIN_BY_ID.get('builtin:owner')!.actions);
    for (const a of FORBIDDEN) expect(owner.has(a)).toBe(true);
  });

  test('benign account-read actions ARE delegable into an account role', () => {
    const r = validateActions([ACCOUNT_ACTIONS.AUDIT_READ, ACCOUNT_ACTIONS.ROLE_READ, ACCOUNT_ACTIONS.POLICY_READ], 'account');
    expect(r.ok).toBe(true);
  });
});

describe('validateActions — namespace integrity', () => {
  test('a project role rejects account-scoped actions', () => {
    const r = validateActions([PROJECT_ACTIONS.PROJECT_READ, ACCOUNT_ACTIONS.AUDIT_READ], 'project');
    expect(r.ok).toBe(false);
  });

  test('an account role rejects project-scoped actions', () => {
    const r = validateActions([ACCOUNT_ACTIONS.AUDIT_READ, PROJECT_ACTIONS.PROJECT_AGENT_WRITE], 'account');
    expect(r.ok).toBe(false);
  });

  test('project.members.manage + gateway.keys.manage stay delegable in a project role (department lead)', () => {
    const r = validateActions(
      [PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, PROJECT_ACTIONS.PROJECT_GATEWAY_KEYS_MANAGE],
      'project',
    );
    expect(r.ok).toBe(true);
  });

  test('project.create is account-scoped (lives at account scope) — rejected in a project role', () => {
    const r = validateActions([ACCOUNT_ACTIONS.PROJECT_CREATE], 'project');
    expect(r.ok).toBe(false);
  });

  test('no resourceType arg → namespace check skipped (back-compat)', () => {
    const r = validateActions([PROJECT_ACTIONS.PROJECT_READ, ACCOUNT_ACTIONS.AUDIT_READ]);
    expect(r.ok).toBe(true);
  });
});

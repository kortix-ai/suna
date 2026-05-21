import { describe, expect, test } from 'bun:test';
import {
  ACCOUNT_ACTIONS,
  CHANNEL_ACTIONS,
  PROJECT_ACTIONS,
  RESOURCE_TYPES,
  SANDBOX_ACTIONS,
  TRIGGER_ACTIONS,
  resourceTypeForAction,
  type ResourceType,
} from '../iam/actions';
import { policyMatchesTarget } from '../iam/engine';
import { SYSTEM_ROLES, SYSTEM_ROLE_KEY } from '../iam/system-roles';

describe('resourceTypeForAction', () => {
  test('account-prefixed actions resolve to account', () => {
    expect(resourceTypeForAction(ACCOUNT_ACTIONS.ACCOUNT_READ)).toBe('account');
    expect(resourceTypeForAction(ACCOUNT_ACTIONS.BILLING_WRITE)).toBe('account');
    expect(resourceTypeForAction(ACCOUNT_ACTIONS.MEMBER_INVITE)).toBe('account');
    expect(resourceTypeForAction(ACCOUNT_ACTIONS.GROUP_CREATE)).toBe('account');
    expect(resourceTypeForAction(ACCOUNT_ACTIONS.POLICY_CREATE)).toBe('account');
    expect(resourceTypeForAction(ACCOUNT_ACTIONS.ROLE_READ)).toBe('account');
    expect(resourceTypeForAction(ACCOUNT_ACTIONS.TOKEN_CREATE)).toBe('account');
    expect(resourceTypeForAction(ACCOUNT_ACTIONS.AUDIT_READ)).toBe('account');
  });

  test('project.create is account-scoped (no project exists yet)', () => {
    expect(resourceTypeForAction(ACCOUNT_ACTIONS.PROJECT_CREATE)).toBe('account');
  });

  test('project.* actions resolve to project', () => {
    expect(resourceTypeForAction(PROJECT_ACTIONS.PROJECT_READ)).toBe('project');
    expect(resourceTypeForAction(PROJECT_ACTIONS.PROJECT_SESSION_EXEC)).toBe('project');
    expect(resourceTypeForAction(PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE)).toBe('project');
    expect(resourceTypeForAction(PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)).toBe('project');
  });

  test('sandbox/trigger/channel actions resolve to their own type', () => {
    expect(resourceTypeForAction(SANDBOX_ACTIONS.SANDBOX_EXEC)).toBe('sandbox');
    expect(resourceTypeForAction(TRIGGER_ACTIONS.TRIGGER_FIRE)).toBe('trigger');
    expect(resourceTypeForAction(CHANNEL_ACTIONS.CHANNEL_SEND)).toBe('channel');
  });

  test('unknown actions defensively fall back to account', () => {
    expect(resourceTypeForAction('whatever.unknown')).toBe('account');
  });
});

describe('policyMatchesTarget', () => {
  const allow = (rest: { scopeType: ResourceType; scopeId: string | null }) => ({
    ...rest,
    effect: 'allow' as const,
  });

  test('account-Everything policy matches every target', () => {
    const policy = allow({ scopeType: 'account', scopeId: null });
    expect(policyMatchesTarget(policy, 'project', { type: 'project', id: 'p1' })).toBe(true);
    expect(policyMatchesTarget(policy, 'sandbox', { type: 'sandbox', id: 's1' })).toBe(true);
    expect(policyMatchesTarget(policy, 'account', { type: 'account' })).toBe(true);
  });

  test('project-NULL policy matches any project, not other types', () => {
    const policy = allow({ scopeType: 'project', scopeId: null });
    expect(policyMatchesTarget(policy, 'project', { type: 'project', id: 'p1' })).toBe(true);
    expect(policyMatchesTarget(policy, 'project', { type: 'project', id: 'p2' })).toBe(true);
    expect(policyMatchesTarget(policy, 'sandbox', { type: 'sandbox', id: 's1' })).toBe(false);
  });

  test('project-specific policy matches only that project id', () => {
    const policy = allow({ scopeType: 'project', scopeId: 'p1' });
    expect(policyMatchesTarget(policy, 'project', { type: 'project', id: 'p1' })).toBe(true);
    expect(policyMatchesTarget(policy, 'project', { type: 'project', id: 'p2' })).toBe(false);
  });

  test('resource-scoped policy never satisfies an account-only target', () => {
    const policy = allow({ scopeType: 'project', scopeId: null });
    expect(policyMatchesTarget(policy, 'account', { type: 'account' })).toBe(false);
  });

  test('mismatched scope_type with target type fails closed', () => {
    const policy = allow({ scopeType: 'trigger', scopeId: 't1' });
    expect(policyMatchesTarget(policy, 'project', { type: 'project', id: 'p1' })).toBe(false);
  });

  test('matcher ignores effect — that is the caller’s concern', () => {
    const denyPolicy = { scopeType: 'project' as const, scopeId: 'p1', effect: 'deny' as const };
    expect(policyMatchesTarget(denyPolicy, 'project', { type: 'project', id: 'p1' })).toBe(true);
  });
});

describe('system role catalog', () => {
  test('every system role has a non-empty action set', () => {
    for (const role of SYSTEM_ROLES) {
      expect(role.actions.length).toBeGreaterThan(0);
    }
  });

  test('every system role key referenced by the bridge actually exists', () => {
    const keys = new Set(SYSTEM_ROLES.map((r) => r.key));
    for (const key of Object.values(SYSTEM_ROLE_KEY)) {
      expect(keys.has(key)).toBe(true);
    }
  });

  test('every system role declares one of the known resource types', () => {
    const types = new Set<string>(RESOURCE_TYPES);
    for (const role of SYSTEM_ROLES) {
      expect(types.has(role.resourceType)).toBe(true);
    }
  });

  test('system role keys are unique', () => {
    const keys = SYSTEM_ROLES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('super_administrator role has every action', () => {
    const all = new Set<string>([
      ...Object.values(ACCOUNT_ACTIONS),
      ...Object.values(PROJECT_ACTIONS),
      ...Object.values(SANDBOX_ACTIONS),
      ...Object.values(TRIGGER_ACTIONS),
      ...Object.values(CHANNEL_ACTIONS),
    ]);
    const sa = SYSTEM_ROLES.find((r) => r.key === SYSTEM_ROLE_KEY.SUPER_ADMINISTRATOR);
    expect(sa).toBeDefined();
    for (const action of all) {
      expect(sa!.actions).toContain(action);
    }
  });

  test('administrator role does NOT grant account.delete or billing.write', () => {
    const admin = SYSTEM_ROLES.find((r) => r.key === SYSTEM_ROLE_KEY.ADMINISTRATOR);
    expect(admin).toBeDefined();
    expect(admin!.actions).not.toContain(ACCOUNT_ACTIONS.ACCOUNT_DELETE);
    expect(admin!.actions).not.toContain(ACCOUNT_ACTIONS.BILLING_WRITE);
  });

  test('administrator_read_only is purely read-only', () => {
    const ro = SYSTEM_ROLES.find((r) => r.key === SYSTEM_ROLE_KEY.ADMINISTRATOR_READ_ONLY);
    expect(ro).toBeDefined();
    for (const action of ro!.actions) {
      // Allow .read, .effective, audit.read; reject anything containing
      // create/update/delete/write/start/stop/exec/fire/etc.
      expect(action).toMatch(/(\.read|audit\.read|account\.read)$/);
    }
  });

  test('project_viewer cannot exec or write', () => {
    const viewer = SYSTEM_ROLES.find((r) => r.key === SYSTEM_ROLE_KEY.PROJECT_VIEWER);
    expect(viewer).toBeDefined();
    expect(viewer!.actions).not.toContain(PROJECT_ACTIONS.PROJECT_WRITE);
    expect(viewer!.actions).not.toContain(PROJECT_ACTIONS.PROJECT_SESSION_EXEC);
  });
});

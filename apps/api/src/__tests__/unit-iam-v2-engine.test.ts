// Pure-function tests for the V2 engine. DB-bound paths get covered by
// a separate integration suite that runs only when TEST_DATABASE_URL
// is set (mirrors the V1 setup).

import { describe, test, expect } from 'bun:test';
import {
  scopeForActionV2,
  deriveEffectiveProjectRole,
} from '../iam/engine-v2';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from '../iam/actions';

describe('scopeForActionV2', () => {
  test('account.* / billing.* / audit.* → account', () => {
    expect(scopeForActionV2(ACCOUNT_ACTIONS.ACCOUNT_READ)).toBe('account');
    expect(scopeForActionV2(ACCOUNT_ACTIONS.ACCOUNT_WRITE)).toBe('account');
    expect(scopeForActionV2(ACCOUNT_ACTIONS.BILLING_WRITE)).toBe('account');
    expect(scopeForActionV2(ACCOUNT_ACTIONS.AUDIT_READ)).toBe('account');
  });

  test('member.* / group.* / role.* / policy.* / token.* → account', () => {
    expect(scopeForActionV2(ACCOUNT_ACTIONS.MEMBER_INVITE)).toBe('account');
    expect(scopeForActionV2(ACCOUNT_ACTIONS.GROUP_CREATE)).toBe('account');
    expect(scopeForActionV2(ACCOUNT_ACTIONS.TOKEN_CREATE)).toBe('account');
    expect(scopeForActionV2('role.read')).toBe('account');
    expect(scopeForActionV2('policy.read')).toBe('account');
  });

  test('project.create is account (no project to scope to yet)', () => {
    expect(scopeForActionV2(ACCOUNT_ACTIONS.PROJECT_CREATE)).toBe('account');
  });

  test('every other project.* → project', () => {
    expect(scopeForActionV2(PROJECT_ACTIONS.PROJECT_READ)).toBe('project');
    expect(scopeForActionV2(PROJECT_ACTIONS.PROJECT_WRITE)).toBe('project');
    expect(scopeForActionV2(PROJECT_ACTIONS.PROJECT_DELETE)).toBe('project');
    expect(scopeForActionV2(PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE)).toBe('project');
    expect(scopeForActionV2(PROJECT_ACTIONS.PROJECT_SESSION_START)).toBe('project');
  });

  test('sandbox.* / trigger.* / channel.* collapse into project scope', () => {
    expect(scopeForActionV2('sandbox.start')).toBe('project');
    expect(scopeForActionV2('trigger.fire')).toBe('project');
    expect(scopeForActionV2('channel.send')).toBe('project');
  });
});

describe('deriveEffectiveProjectRole', () => {
  test('owner gets implicit Manager even with no other path', () => {
    expect(deriveEffectiveProjectRole('owner', null, [])).toBe('manager');
  });

  test('admin gets implicit Manager even with no other path', () => {
    expect(deriveEffectiveProjectRole('admin', null, [])).toBe('manager');
  });

  test('member with no direct row and no groups → no role', () => {
    expect(deriveEffectiveProjectRole('member', null, [])).toBeNull();
  });

  test('member with a direct Viewer row → viewer', () => {
    expect(deriveEffectiveProjectRole('member', 'viewer', [])).toBe('viewer');
  });

  test('member with only a group Editor → editor', () => {
    expect(deriveEffectiveProjectRole('member', null, ['editor'])).toBe('editor');
  });

  test('member with direct Viewer + group Editor → editor (max wins)', () => {
    expect(deriveEffectiveProjectRole('member', 'viewer', ['editor'])).toBe('editor');
  });

  test('member with multiple group grants → max of all', () => {
    expect(deriveEffectiveProjectRole('member', null, ['viewer', 'editor', 'viewer'])).toBe('editor');
    expect(deriveEffectiveProjectRole('member', null, ['viewer', 'manager', 'editor'])).toBe('manager');
  });

  test('owner stays Manager even when group says Viewer (no demotion)', () => {
    expect(deriveEffectiveProjectRole('owner', 'viewer', ['viewer'])).toBe('manager');
  });

  test('member with direct Manager → manager (no implicit needed)', () => {
    expect(deriveEffectiveProjectRole('member', 'manager', [])).toBe('manager');
  });
});

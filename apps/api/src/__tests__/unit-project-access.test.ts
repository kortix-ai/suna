import { describe, expect, test } from 'bun:test';

import {
  effectiveProjectRole,
  isAccountManager,
  parseProjectRole,
  roleAllows,
  type AccountRole,
  type ProjectAccessAction,
  type ProjectRole,
} from '../projects/access';

describe('project access roles', () => {
  test.each([
    ['owner', true],
    ['admin', true],
    ['member', false],
  ] as Array<[AccountRole, boolean]>)('account role %s manager=%p', (role, expected) => {
    expect(isAccountManager(role)).toBe(expected);
  });

  test.each([
    ['owner', null, 'manager'],
    ['admin', 'viewer', 'manager'],
    ['member', 'editor', 'editor'],
    ['member', null, null],
  ] as Array<[AccountRole, ProjectRole | null, ProjectRole | null]>)(
    'effective role for %s + %s',
    (accountRole, projectRole, expected) => {
      expect(effectiveProjectRole(accountRole, projectRole)).toBe(expected);
    },
  );

  test.each([
    ['viewer', 'read', true],
    ['viewer', 'write', false],
    ['viewer', 'manage', false],
    ['editor', 'read', true],
    ['editor', 'write', true],
    ['editor', 'manage', false],
    ['manager', 'read', true],
    ['manager', 'write', true],
    ['manager', 'manage', true],
    [null, 'read', false],
  ] as Array<[ProjectRole | null, ProjectAccessAction, boolean]>)(
    '%s can %s => %p',
    (role, action, expected) => {
      expect(roleAllows(role, action)).toBe(expected);
    },
  );

  test('normalizes valid role input and rejects invalid values', () => {
    expect(parseProjectRole(' Manager ')).toBe('manager');
    expect(parseProjectRole('editor')).toBe('editor');
    expect(parseProjectRole('viewer')).toBe('viewer');
    expect(parseProjectRole('owner')).toBeNull();
    expect(parseProjectRole(null)).toBeNull();
  });
});

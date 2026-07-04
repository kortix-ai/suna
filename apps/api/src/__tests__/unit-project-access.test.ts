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
import { iamActionForProjectAccess, isUuid } from '../projects/lib/access';

describe('isUuid project-id guard', () => {
  test.each([
    ['fda4e35e', false], // truncated id — used to 500 via Postgres 22P02
    ['not-a-uuid', false],
    ['', false],
    ['fda4e35e-1234-4abc-89ef-0123456789ab', true],
    ['FDA4E35E-1234-4ABC-89EF-0123456789AB', true], // case-insensitive
  ])('isUuid(%p) === %p', (value, expected) => {
    expect(isUuid(value)).toBe(expected);
  });
});

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
    ['admin', 'member', 'manager'],
    ['member', 'editor', 'editor'],
    ['member', null, null],
  ] as Array<[AccountRole, ProjectRole | null, ProjectRole | null]>)(
    'effective role for %s + %s',
    (accountRole, projectRole, expected) => {
      expect(effectiveProjectRole(accountRole, projectRole)).toBe(expected);
    },
  );

  test.each([
    ['member', 'read', true],
    ['member', 'session', true], // member is the floor usable role — can run sessions
    ['member', 'write', false],
    ['member', 'manage', false],
    ['editor', 'read', true],
    ['editor', 'session', true],
    ['editor', 'write', true],
    ['editor', 'manage', false],
    ['manager', 'read', true],
    ['manager', 'session', true],
    ['manager', 'write', true],
    ['manager', 'manage', true],
    [null, 'read', false],
    [null, 'session', false], // no role → no session
  ] as Array<[ProjectRole | null, ProjectAccessAction, boolean]>)(
    '%s can %s => %p',
    (role, action, expected) => {
      expect(roleAllows(role, action)).toBe(expected);
    },
  );

  test.each([
    ['read', 'project.read'],
    ['session', 'project.session.start'],
    ['write', 'project.write'],
    ['manage', 'project.write'],
  ] as Array<[ProjectAccessAction, string]>)(
    'iamActionForProjectAccess(%p) === %p',
    (action, expected) => {
      expect(iamActionForProjectAccess(action)).toBe(expected);
    },
  );

  test('normalizes valid role input and rejects invalid values', () => {
    expect(parseProjectRole(' Manager ')).toBe('manager');
    expect(parseProjectRole('editor')).toBe('editor');
    expect(parseProjectRole('member')).toBe('member');
    // `user` and `viewer` are deprecated aliases — both fold into `member`, never round-trip.
    expect(parseProjectRole('user')).toBe('member');
    expect(parseProjectRole(' USER ')).toBe('member');
    expect(parseProjectRole('viewer')).toBe('member');
    expect(parseProjectRole(' VIEWER ')).toBe('member');
    expect(parseProjectRole('owner')).toBeNull();
    expect(parseProjectRole(null)).toBeNull();
  });
});

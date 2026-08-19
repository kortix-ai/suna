import { describe, expect, test } from 'bun:test';
import type { IamRole } from '@kortix/sdk';

import {
  ACCOUNT_ROLES_ASCENDING,
  BUILTIN_BASELINE,
  PROJECT_ROLES_ASCENDING,
  ROLE_NONE,
  baselineBuiltinRole,
  builtinRole,
  builtinRoleLabel,
  builtinRolesForScope,
  customRole,
  customRolesForScope,
  roleValueLabel,
  roleValueToSelectValue,
  roleValuesEqual,
  selectValueToRoleValue,
  type RoleValue,
} from './role-select';

function role(overrides: Partial<IamRole>): IamRole {
  return {
    role_id: 'r_1',
    key: 'custom_key',
    name: 'Support',
    description: null,
    resource_type: 'project',
    is_system: false,
    account_id: 'acc_1',
    ...overrides,
  } as IamRole;
}

describe('RoleValue ↔ Select value mapping', () => {
  test('round-trips every kind', () => {
    const cases: RoleValue[] = [
      builtinRole('owner'),
      builtinRole('manager'),
      customRole('r_abc'),
      ROLE_NONE,
    ];
    for (const value of cases) {
      expect(selectValueToRoleValue(roleValueToSelectValue(value))).toEqual(value);
    }
  });

  test('built-in and custom encodings can never collide', () => {
    expect(roleValueToSelectValue(builtinRole('member'))).toBe('builtin:member');
    expect(roleValueToSelectValue(customRole('member'))).toBe('custom:member');
    expect(roleValueToSelectValue(ROLE_NONE)).toBe('__none__');
  });

  test('an unknown raw value decodes to none rather than a bogus role', () => {
    expect(selectValueToRoleValue('garbage')).toEqual(ROLE_NONE);
  });
});

describe('roleValuesEqual', () => {
  test('same kind and same payload', () => {
    expect(roleValuesEqual(builtinRole('manager'), builtinRole('manager'))).toBe(true);
    expect(roleValuesEqual(customRole('r_1'), customRole('r_1'))).toBe(true);
    expect(roleValuesEqual(ROLE_NONE, ROLE_NONE)).toBe(true);
  });

  test('different payload or different kind', () => {
    expect(roleValuesEqual(builtinRole('member'), builtinRole('manager'))).toBe(false);
    expect(roleValuesEqual(customRole('r_1'), customRole('r_2'))).toBe(false);
    expect(roleValuesEqual(builtinRole('member'), customRole('r_1'))).toBe(false);
    expect(roleValuesEqual(builtinRole('member'), ROLE_NONE)).toBe(false);
  });
});

describe('baselineBuiltinRole', () => {
  test('a built-in is its own baseline', () => {
    expect(baselineBuiltinRole('account', builtinRole('admin'))).toBe('admin');
    expect(baselineBuiltinRole('project', builtinRole('manager'))).toBe('manager');
  });

  test('a custom role rides on the LOWEST built-in for its scope', () => {
    expect(baselineBuiltinRole('account', customRole('r_1'))).toBe(BUILTIN_BASELINE.account);
    expect(baselineBuiltinRole('project', customRole('r_1'))).toBe(BUILTIN_BASELINE.project);
    expect(BUILTIN_BASELINE.account).toBe('member');
    expect(BUILTIN_BASELINE.project).toBe('member');
  });

  test('none has no built-in at all', () => {
    expect(baselineBuiltinRole('project', ROLE_NONE)).toBeNull();
  });
});

describe('built-in role lists', () => {
  test('ordered low → high per scope', () => {
    expect(ACCOUNT_ROLES_ASCENDING).toEqual(['member', 'admin', 'owner']);
    expect(builtinRolesForScope('account')).toEqual(['member', 'admin', 'owner']);
  });

  // Owner decision 2026-08-18: Member and Manager are the only project roles.
  test('project has exactly two roles', () => {
    expect(PROJECT_ROLES_ASCENDING).toEqual(['member', 'manager']);
    expect(builtinRolesForScope('project')).toEqual(['member', 'manager']);
  });

  test('labels come from the descriptors', () => {
    expect(builtinRoleLabel('account', 'owner')).toBe('Owner');
    expect(builtinRoleLabel('project', 'manager')).toBe('Manager');
    expect(builtinRoleLabel('project', 'member')).toBe('Member');
  });
});

describe('customRolesForScope', () => {
  const roles: IamRole[] = [
    role({ role_id: 'r_sys', is_system: true, resource_type: 'project', name: 'Manager' }),
    role({ role_id: 'r_proj', resource_type: 'project', name: 'Support' }),
    role({ role_id: 'r_acct', resource_type: 'account', name: 'Auditor' }),
  ];

  test('drops system roles and roles from the other scope', () => {
    expect(customRolesForScope(roles, 'project').map((r) => r.role_id)).toEqual(['r_proj']);
    expect(customRolesForScope(roles, 'account').map((r) => r.role_id)).toEqual(['r_acct']);
  });

  test('tolerates an unloaded roles list', () => {
    expect(customRolesForScope(undefined, 'project')).toEqual([]);
  });
});

describe('roleValueLabel', () => {
  const roles = [role({ role_id: 'r_proj', name: 'Support' })];

  test('built-in → display name', () => {
    expect(roleValueLabel('project', builtinRole('manager'), roles)).toBe('Manager');
  });

  test('custom → the role name', () => {
    expect(roleValueLabel('project', customRole('r_proj'), roles)).toBe('Support');
  });

  test('custom with no roles loaded → a stable placeholder, never a raw uuid', () => {
    expect(roleValueLabel('project', customRole('r_unknown'), roles)).toBe('Custom role');
    expect(roleValueLabel('project', customRole('r_proj'))).toBe('Custom role');
  });

  test('none → the em dash the access list uses for "no access"', () => {
    expect(roleValueLabel('project', ROLE_NONE, roles)).toBe('—');
  });
});

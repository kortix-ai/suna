import { describe, expect, test } from 'bun:test';

import { accountRoleLabel } from './account-memberships';

describe('accountRoleLabel', () => {
  test('labels the three roles the API sends', () => {
    expect(accountRoleLabel('owner')).toBe('Owner');
    expect(accountRoleLabel('admin')).toBe('Admin');
    expect(accountRoleLabel('member')).toBe('Member');
  });

  /** Never echoes an unrecognized value into the UI — the row renders with no
   *  description instead. */
  test('returns undefined for anything else', () => {
    expect(accountRoleLabel(undefined)).toBeUndefined();
    expect(accountRoleLabel(null)).toBeUndefined();
    expect(accountRoleLabel('superuser')).toBeUndefined();
  });
});

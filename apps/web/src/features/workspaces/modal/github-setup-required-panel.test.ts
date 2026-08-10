import { describe, expect, test } from 'bun:test';

import { isAccountGitAdmin } from './github-setup-required-panel';

describe('isAccountGitAdmin', () => {
  test('owner can manage Git settings', () => {
    expect(isAccountGitAdmin('owner')).toBe(true);
  });

  test('admin can manage Git settings', () => {
    expect(isAccountGitAdmin('admin')).toBe(true);
  });

  test('a plain member cannot', () => {
    expect(isAccountGitAdmin('member')).toBe(false);
  });

  test('an unresolved role is treated as non-admin', () => {
    expect(isAccountGitAdmin(undefined)).toBe(false);
    expect(isAccountGitAdmin(null)).toBe(false);
  });
});

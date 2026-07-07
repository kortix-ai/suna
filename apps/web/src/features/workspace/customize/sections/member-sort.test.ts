import { describe, expect, test } from 'bun:test';
import { accountRoleRank, sortByRoleThenLabel } from './member-sort';

describe('accountRoleRank', () => {
  test('ranks known roles in order', () => {
    expect(accountRoleRank('owner')).toBe(0);
    expect(accountRoleRank('admin')).toBe(1);
    expect(accountRoleRank('member')).toBe(2);
  });

  test('ranks unknown/empty roles last and never returns NaN', () => {
    expect(accountRoleRank('guest')).toBe(99);
    expect(accountRoleRank('')).toBe(99);
    expect(Number.isNaN(accountRoleRank('anything-else'))).toBe(false);
  });
});

describe('sortByRoleThenLabel', () => {
  const label = (m: { account_role: string; name: string }) => m.name;

  test('orders by role, then alphabetically by label within a role', () => {
    const members = [
      { account_role: 'member', name: 'zed' },
      { account_role: 'owner', name: 'ann' },
      { account_role: 'admin', name: 'bob' },
      { account_role: 'member', name: 'amy' },
    ];
    expect(sortByRoleThenLabel(members, label).map((m) => m.name)).toEqual([
      'ann',
      'bob',
      'amy',
      'zed',
    ]);
  });

  test('places unknown roles last with a deterministic (non-NaN) order', () => {
    const members = [
      { account_role: 'guest', name: 'gary' },
      { account_role: 'owner', name: 'olga' },
      { account_role: 'member', name: 'mike' },
      { account_role: 'guest', name: 'gabe' },
    ];
    expect(sortByRoleThenLabel(members, label).map((m) => m.name)).toEqual([
      'olga',
      'mike',
      'gabe',
      'gary',
    ]);
  });

  test('does not mutate the input array', () => {
    const members = [
      { account_role: 'member', name: 'b' },
      { account_role: 'owner', name: 'a' },
    ];
    const copy = [...members];
    sortByRoleThenLabel(members, label);
    expect(members).toEqual(copy);
  });
});

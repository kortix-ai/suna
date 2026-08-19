import { describe, expect, test } from 'bun:test';

import { sortAccountsForListing } from './account-order';

/**
 * GET /v1/accounts historically carried no ORDER BY, so `accounts[0]` — the
 * web landing door's fallback account — was whatever Postgres returned first.
 * A user in both a personal (owner) account and a team (member) account could
 * nondeterministically land on the empty team and see "No workspace yet".
 * This pins the contract: owned accounts first, oldest first within a role.
 */

function row(accountId: string, accountRole: string, createdAt: string) {
  return { accountId, accountRole, createdAt: new Date(createdAt) };
}

describe('sortAccountsForListing', () => {
  test('owner accounts come before member accounts regardless of row order', () => {
    const sorted = sortAccountsForListing([
      row('team', 'member', '2020-01-01T00:00:00Z'),
      row('personal', 'owner', '2026-01-01T00:00:00Z'),
    ]);
    expect(sorted.map((r) => r.accountId)).toEqual(['personal', 'team']);
  });

  test('within the same role, the oldest account comes first', () => {
    const sorted = sortAccountsForListing([
      row('newer', 'owner', '2026-02-01T00:00:00Z'),
      row('older', 'owner', '2026-01-01T00:00:00Z'),
    ]);
    expect(sorted.map((r) => r.accountId)).toEqual(['older', 'newer']);
  });

  test('admin sits between owner and member', () => {
    const sorted = sortAccountsForListing([
      row('m', 'member', '2026-01-01T00:00:00Z'),
      row('a', 'admin', '2026-01-01T00:00:00Z'),
      row('o', 'owner', '2026-01-01T00:00:00Z'),
    ]);
    expect(sorted.map((r) => r.accountId)).toEqual(['o', 'a', 'm']);
  });

  test('fully deterministic: equal role and timestamp tie-break by account id', () => {
    const sorted = sortAccountsForListing([
      row('bbb', 'owner', '2026-01-01T00:00:00Z'),
      row('aaa', 'owner', '2026-01-01T00:00:00Z'),
    ]);
    expect(sorted.map((r) => r.accountId)).toEqual(['aaa', 'bbb']);
  });

  test('a null createdAt sorts last within its role instead of throwing', () => {
    const sorted = sortAccountsForListing([
      { accountId: 'no-date', accountRole: 'owner', createdAt: null },
      row('dated', 'owner', '2026-01-01T00:00:00Z'),
    ]);
    expect(sorted.map((r) => r.accountId)).toEqual(['dated', 'no-date']);
  });
});

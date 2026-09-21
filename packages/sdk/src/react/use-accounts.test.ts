import { describe, expect, test } from 'bun:test';
import { qk } from './query-keys';
import { contract } from './query-contracts';
import { accountsQueryOptions, projectsQueryOptions } from './use-accounts';

/**
 * `useAccounts` / `useProjects` have no hook-render harness in this package —
 * it has no React test renderer, by design (the core is framework-free). So
 * the key, the gate and the freshness contract are split into pure option
 * builders and asserted directly, the same way `apps/web`'s
 * `accountsListQueryOptions` is. A source-text assertion could not tell a
 * working gate from a deleted one; this can.
 */

describe('accountsQueryOptions', () => {
  test('reads the user-scoped account-list key from the qk factory', () => {
    // NOT a hand-typed literal. `qk.accounts.list(userId)` carries identity:
    // a bare ['accounts'] is one entry for every user, which is how a leftover
    // list belonging to the previous user made POST /projects/provision go out
    // with a foreign account_id.
    expect(accountsQueryOptions('user-1').queryKey).toEqual(qk.accounts.list('user-1'));
    expect(accountsQueryOptions('user-1').queryKey).not.toEqual(qk.accounts.list('user-2'));
  });

  test('two users never share a cache entry', () => {
    expect(accountsQueryOptions('user-1').queryKey).not.toEqual(
      accountsQueryOptions('user-2').queryKey,
    );
  });

  test('a single-identity host (CLI/TUI) still gets one stable key', () => {
    expect(accountsQueryOptions().queryKey).toEqual(qk.accounts.list(undefined));
    expect(accountsQueryOptions(null).queryKey).toEqual(accountsQueryOptions().queryKey);
  });

  test('the caller gate is honoured and defaults to on', () => {
    expect(accountsQueryOptions('user-1').enabled).toBe(true);
    expect(accountsQueryOptions('user-1', false).enabled).toBe(false);
  });

  test('carries the inventory freshness contract, never a hand-written staleTime', () => {
    expect(accountsQueryOptions('user-1').staleTime).toBe(contract('inventory').staleTime);
    expect(accountsQueryOptions('user-1').gcTime).toBe(contract('inventory').gcTime);
  });
});

describe('projectsQueryOptions', () => {
  test('keys per account through the qk factory', () => {
    expect(projectsQueryOptions('acct-1').queryKey).toEqual(qk.projects.list('acct-1'));
    expect(projectsQueryOptions('acct-1').queryKey).not.toEqual(qk.projects.list('acct-2'));
  });

  test('the accountless slot is a SIBLING of a scoped list, not a parent', () => {
    // `GET /projects` with no account_id resolves server-side to ONE default
    // account, so the unscoped list is a different answer — never a superset.
    expect(projectsQueryOptions().queryKey).toEqual(qk.projects.list());
    expect(projectsQueryOptions().queryKey).not.toEqual(projectsQueryOptions('acct-1').queryKey);
  });

  test('is gated off until an account id is known when one is expected', () => {
    expect(projectsQueryOptions('acct-1').enabled).toBe(true);
    expect(projectsQueryOptions('acct-1', false).enabled).toBe(false);
  });

  test('carries the inventory freshness contract', () => {
    expect(projectsQueryOptions('acct-1').staleTime).toBe(contract('inventory').staleTime);
  });
});

import { describe, expect, test } from 'bun:test';

import type { KortixAccount, KortixProject } from '@kortix/sdk';

import type { EnsureFirstProjectClient } from './ensure-first-project';
import { resolveLandingDestination } from './resolve-landing-destination';

/**
 * These tests pin the fix for the "No workspace yet" landing bug: `/projects/start`
 * used to resolve exactly ONE account (`find(selectedAccountId) ?? accounts[0]`)
 * and render a terminal state when it was empty — even when another account of
 * the same user (their personal one) had projects. The resolver must scan every
 * membership before ever concluding the user has nowhere to land.
 *
 * Plain-fake DI, matching `ensure-first-project.ts`'s injectable-client pattern.
 * No `mock.module` — it is process-wide in this package and leaks into sibling
 * suites.
 */

function account(id: string, role: 'owner' | 'admin' | 'member'): KortixAccount {
  return { account_id: id, name: id, account_role: role };
}

function project(id: string, accountId: string): KortixProject {
  return { project_id: id, account_id: accountId, name: id } as KortixProject;
}

function fakeClient(
  projectsByAccount: Record<string, KortixProject[]>,
  provisionProject: EnsureFirstProjectClient['provisionProject'] = async () => {
    throw new Error('provision must not be called in this scenario');
  },
): EnsureFirstProjectClient {
  return {
    listProjectsForAccount: async (accountId) => projectsByAccount[accountId ?? ''] ?? [],
    provisionProject,
  };
}

describe('resolveLandingDestination', () => {
  test('a stale member-team selection does not hide the personal account project', async () => {
    // The reported bug: localStorage remembered a team where the user is a
    // plain member with zero project grants. The old resolver stopped there
    // and rendered "No workspace yet" although the personal account has a
    // project.
    const result = await resolveLandingDestination({
      accounts: [account('team', 'member'), account('personal', 'owner')],
      selectedAccountId: 'team',
      preferredProjectId: null,
      isAccountSuppressed: () => false,
      mayCreate: true,
      client: fakeClient({
        team: [],
        personal: [project('p1', 'personal')],
      }),
    });

    expect(result).toEqual({
      kind: 'project',
      accountId: 'personal',
      project: project('p1', 'personal'),
    });
  });

  test('with no selection, an owned account beats a member account listed before it', async () => {
    // GET /v1/accounts carries no ORDER BY, so the raw list order is
    // arbitrary. When both accounts have projects and nothing is selected,
    // landing must still be deterministic: the account the user owns.
    const result = await resolveLandingDestination({
      accounts: [account('team', 'member'), account('personal', 'owner')],
      selectedAccountId: null,
      preferredProjectId: null,
      isAccountSuppressed: () => false,
      mayCreate: true,
      client: fakeClient({
        team: [project('t1', 'team')],
        personal: [project('p1', 'personal')],
      }),
    });

    expect(result).toEqual({
      kind: 'project',
      accountId: 'personal',
      project: project('p1', 'personal'),
    });
  });

  test('the remembered (cookie) project wins even from a non-selected member account', async () => {
    // The route's contract is "resolve last-used first". The cookie names the
    // exact project the user last had open; if it is still in one of their
    // accounts' lists, that beats both the persisted selection and the
    // owner-first ordering.
    const result = await resolveLandingDestination({
      accounts: [account('personal', 'owner'), account('team', 'member')],
      selectedAccountId: 'personal',
      preferredProjectId: 't1',
      isAccountSuppressed: () => false,
      mayCreate: true,
      client: fakeClient({
        personal: [project('p1', 'personal')],
        team: [project('t1', 'team')],
      }),
    });

    expect(result).toEqual({
      kind: 'project',
      accountId: 'team',
      project: project('t1', 'team'),
    });
  });

  test('all empty, no selection: provisions in the first account the user owns', async () => {
    // The fresh-signup / invited-user default: with no explicit workspace
    // context, the user's own account is the primary candidate and the first
    // project is created there.
    const provisioned: string[] = [];
    const result = await resolveLandingDestination({
      accounts: [account('team', 'member'), account('personal', 'owner')],
      selectedAccountId: null,
      preferredProjectId: null,
      isAccountSuppressed: () => false,
      mayCreate: true,
      client: fakeClient({ team: [], personal: [] }, async (input) => {
        // `account_id` is optional on the wire type; the assertion below
        // pins that the resolver always sends it.
        const accountId = input.account_id ?? 'missing-account-id';
        provisioned.push(accountId);
        return project('fresh', accountId);
      }),
    });

    expect(provisioned).toEqual(['personal']);
    expect(result).toEqual({
      kind: 'project',
      accountId: 'personal',
      project: project('fresh', 'personal'),
    });
  });

  test('an explicitly selected member workspace never provisions elsewhere', async () => {
    // Flow 08 contract (tests/e2e/specs/08-accounts-project-access.spec.ts):
    // a member whose project access was just revoked, with the org still
    // selected, sees "No workspace yet" — the app must not react by minting a
    // project in their personal account. Provisioning is scoped to the
    // PRIMARY candidate account, and here that is the selected member org.
    let provisionCalls = 0;
    const result = await resolveLandingDestination({
      accounts: [account('team', 'member'), account('personal', 'owner')],
      selectedAccountId: 'team',
      preferredProjectId: null,
      isAccountSuppressed: () => false,
      mayCreate: true,
      client: fakeClient({ team: [], personal: [] }, async () => {
        provisionCalls += 1;
        return project('fresh', 'personal');
      }),
    });

    expect(provisionCalls).toBe(0);
    expect(result).toEqual({ kind: 'terminal', canCreate: false, suppressed: false });
  });

  test('member everywhere with nothing to open is the ONLY true no-permission terminal', async () => {
    const result = await resolveLandingDestination({
      accounts: [account('team-a', 'member'), account('team-b', 'member')],
      selectedAccountId: null,
      preferredProjectId: null,
      isAccountSuppressed: () => false,
      mayCreate: true,
      client: fakeClient({ 'team-a': [], 'team-b': [] }),
    });

    expect(result).toEqual({ kind: 'terminal', canCreate: false, suppressed: false });
  });

  test('suppression after a delete holds back the create but reports it was possible', async () => {
    let provisionCalls = 0;
    const result = await resolveLandingDestination({
      accounts: [account('personal', 'owner')],
      selectedAccountId: 'personal',
      preferredProjectId: null,
      isAccountSuppressed: (accountId) => accountId === 'personal',
      mayCreate: true,
      client: fakeClient({ personal: [] }, async () => {
        provisionCalls += 1;
        return project('fresh', 'personal');
      }),
    });

    expect(provisionCalls).toBe(0);
    expect(result).toEqual({ kind: 'terminal', canCreate: true, suppressed: true });
  });

  // JAY: review round 1 finding. The suppression check applies to the ONE
  // primary candidate account this resolver evaluates for creation
  // (`creator`, above) — never "any account the caller happens to own". A
  // flag left over from account 'other' (its own last-project archive) must
  // never suppress auto-create in an unrelated account 'personal' the SAME
  // user also owns. Two owned accounts, `isAccountSuppressed` scoped to the
  // one that is NOT the primary candidate.
  test('a suppression flag scoped to a DIFFERENT account does not block auto-create on the primary candidate', async () => {
    const provisioned: string[] = [];
    const result = await resolveLandingDestination({
      accounts: [account('personal', 'owner'), account('other', 'owner')],
      selectedAccountId: 'personal',
      preferredProjectId: null,
      isAccountSuppressed: (accountId) => accountId === 'other',
      mayCreate: true,
      client: fakeClient({ personal: [], other: [] }, async (input) => {
        const accountId = input.account_id ?? 'missing-account-id';
        provisioned.push(accountId);
        return project('fresh', accountId);
      }),
    });

    expect(provisioned).toEqual(['personal']);
    expect(result).toEqual({
      kind: 'project',
      accountId: 'personal',
      project: project('fresh', 'personal'),
    });
  });

  test('one account list failing does not block landing in another account', async () => {
    // A transient 500 on ONE membership must not demote the user to the error
    // screen when a different account resolves fine.
    const result = await resolveLandingDestination({
      accounts: [account('team', 'member'), account('personal', 'owner')],
      selectedAccountId: 'team',
      preferredProjectId: null,
      isAccountSuppressed: () => false,
      mayCreate: true,
      client: {
        listProjectsForAccount: async (accountId) => {
          if (accountId === 'team') throw new Error('transient 500');
          return [project('p1', 'personal')];
        },
        provisionProject: async () => {
          throw new Error('provision must not be called');
        },
      },
    });

    expect(result).toEqual({
      kind: 'project',
      accountId: 'personal',
      project: project('p1', 'personal'),
    });
  });

  test('every account list failing surfaces the error to the retry loop', async () => {
    await expect(
      resolveLandingDestination({
        accounts: [account('personal', 'owner')],
        selectedAccountId: null,
        preferredProjectId: null,
        isAccountSuppressed: () => false,
        mayCreate: true,
        client: {
          listProjectsForAccount: async () => {
            throw new Error('backend down');
          },
          provisionProject: async () => {
            throw new Error('provision must not be called');
          },
        },
      }),
    ).rejects.toThrow('backend down');
  });
});

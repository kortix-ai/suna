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
      suppressed: false,
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
      suppressed: false,
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
      suppressed: false,
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

  test('every account empty: provisions in the first account the user can create in', async () => {
    // A member-team selection must not block auto-provision either — the
    // create falls back to the account where PROJECT_CREATE is actually held.
    const provisioned: string[] = [];
    const result = await resolveLandingDestination({
      accounts: [account('team', 'member'), account('personal', 'owner')],
      selectedAccountId: 'team',
      preferredProjectId: null,
      suppressed: false,
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

  test('member everywhere with nothing to open is the ONLY true no-permission terminal', async () => {
    const result = await resolveLandingDestination({
      accounts: [account('team-a', 'member'), account('team-b', 'member')],
      selectedAccountId: null,
      preferredProjectId: null,
      suppressed: false,
      mayCreate: true,
      client: fakeClient({ 'team-a': [], 'team-b': [] }),
    });

    expect(result).toEqual({ kind: 'terminal', canCreateAnywhere: false });
  });

  test('suppression after a delete holds back the create but reports it was possible', async () => {
    let provisionCalls = 0;
    const result = await resolveLandingDestination({
      accounts: [account('personal', 'owner')],
      selectedAccountId: 'personal',
      preferredProjectId: null,
      suppressed: true,
      mayCreate: true,
      client: fakeClient({ personal: [] }, async () => {
        provisionCalls += 1;
        return project('fresh', 'personal');
      }),
    });

    expect(provisionCalls).toBe(0);
    expect(result).toEqual({ kind: 'terminal', canCreateAnywhere: true });
  });

  test('one account list failing does not block landing in another account', async () => {
    // A transient 500 on ONE membership must not demote the user to the error
    // screen when a different account resolves fine.
    const result = await resolveLandingDestination({
      accounts: [account('team', 'member'), account('personal', 'owner')],
      selectedAccountId: 'team',
      preferredProjectId: null,
      suppressed: false,
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
        suppressed: false,
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

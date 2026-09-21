import { describe, expect, test } from 'bun:test';

import type { KortixAccount, KortixProject } from '@kortix/sdk';

import {
  type LandingClient,
  pickLandingProject,
  resolveLandingDestination,
} from './resolve-landing-destination';

/**
 * These tests pin the fix for the "No workspace yet" landing bug: `/projects/start`
 * used to resolve exactly ONE account (`find(selectedAccountId) ?? accounts[0]`)
 * and render a terminal state when it was empty — even when another account of
 * the same user (their personal one) had projects. The resolver must scan every
 * membership before ever concluding the user has nowhere to land.
 *
 * Plain-fake DI through the injectable `client` parameter.
 * No `mock.module` — it is process-wide in this package and leaks into sibling
 * suites.
 */

function account(id: string, role: 'owner' | 'admin' | 'member'): KortixAccount {
  return { account_id: id, name: id, account_role: role };
}

function project(id: string, accountId: string): KortixProject {
  return { project_id: id, account_id: accountId, name: id } as KortixProject;
}

function fakeClient(projectsByAccount: Record<string, KortixProject[]>): LandingClient {
  return {
    listProjectsForAccount: async (accountId) => projectsByAccount[accountId ?? ''] ?? [],
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

  test('all empty, no selection: lands on the chooser and never creates a project', async () => {
    // A fresh sign-up owns an empty personal account. The landing door no
    // longer mints "My First Project" there: it returns the chooser terminal,
    // which offers the user's pending invites and a create action. The fake
    // client has no provision function, so any create attempt would throw.
    const result = await resolveLandingDestination({
      accounts: [account('team', 'member'), account('personal', 'owner')],
      selectedAccountId: null,
      preferredProjectId: null,
      client: fakeClient({ team: [], personal: [] }),
    });

    expect(result).toEqual({ kind: 'terminal', canCreate: true });
  });

  test('an explicitly selected member workspace reports no create permission', async () => {
    // Flow 08 contract (tests/e2e/specs/08-accounts-project-access.spec.ts):
    // a member whose project access was just revoked, with the org still
    // selected, sees "No workspace yet". The primary candidate is the selected
    // member org, so the chooser offers no create action.
    const result = await resolveLandingDestination({
      accounts: [account('team', 'member'), account('personal', 'owner')],
      selectedAccountId: 'team',
      preferredProjectId: null,
      client: fakeClient({ team: [], personal: [] }),
    });

    expect(result).toEqual({ kind: 'terminal', canCreate: false });
  });

  test('member everywhere with nothing to open is the ONLY true no-permission terminal', async () => {
    const result = await resolveLandingDestination({
      accounts: [account('team-a', 'member'), account('team-b', 'member')],
      selectedAccountId: null,
      preferredProjectId: null,
      client: fakeClient({ 'team-a': [], 'team-b': [] }),
    });

    expect(result).toEqual({ kind: 'terminal', canCreate: false });
  });

  test('one account list failing does not block landing in another account', async () => {
    // A transient 500 on ONE membership must not demote the user to the error
    // screen when a different account resolves fine.
    const result = await resolveLandingDestination({
      accounts: [account('team', 'member'), account('personal', 'owner')],
      selectedAccountId: 'team',
      preferredProjectId: null,
      client: {
        listProjectsForAccount: async (accountId) => {
          if (accountId === 'team') throw new Error('transient 500');
          return [project('p1', 'personal')];
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
        client: {
          listProjectsForAccount: async () => {
            throw new Error('backend down');
          },
        },
      }),
    ).rejects.toThrow('backend down');
  });
});

describe('pickLandingProject', () => {
  const A = { project_id: '11111111-1111-4111-8111-111111111111', name: 'A' };
  const B = { project_id: '22222222-2222-4222-8222-222222222222', name: 'B' };
  const projects = [A, B] as never[];

  test('returns null for an empty account', () => {
    expect(pickLandingProject([])).toBeNull();
  });

  test('prefers the remembered project over the first one', () => {
    expect(pickLandingProject(projects, B.project_id)).toMatchObject({ project_id: B.project_id });
  });

  test('falls back to the first project when the remembered id is not owned', () => {
    // A cookie naming someone else's project must never select it — the list
    // came from the server and is the only source of truth here.
    expect(pickLandingProject(projects, '33333333-3333-4333-8333-333333333333')).toMatchObject({
      project_id: A.project_id,
    });
  });

  test('ignores a malformed remembered id', () => {
    expect(pickLandingProject(projects, '../../etc/passwd')).toMatchObject({
      project_id: A.project_id,
    });
    expect(pickLandingProject(projects, null)).toMatchObject({ project_id: A.project_id });
  });
});

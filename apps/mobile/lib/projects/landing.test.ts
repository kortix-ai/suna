import { describe, expect, test } from 'bun:test';

import type { KortixAccount, KortixProject } from '@/lib/projects/projects-client';
import {
  checkLastProject,
  creatableAccounts,
  freshOrCached,
  orderLandingAccounts,
  resolveLandingProject,
} from './landing';

function account(account_id: string, account_role: string): KortixAccount {
  return { account_id, account_role } as KortixAccount;
}

function project(project_id: string): KortixProject {
  return { project_id } as KortixProject;
}

const personal = account('acc-personal', 'owner');
const team = account('acc-team', 'admin');
const member = account('acc-member', 'member');

function lists(byAccount: Record<string, KortixProject[] | Error>) {
  return async (accountId: string) => {
    const value = byAccount[accountId];
    if (value instanceof Error) throw value;
    return value ?? [];
  };
}

describe('creatableAccounts', () => {
  test('keeps owner and admin accounts in order, drops member-only accounts', () => {
    expect(creatableAccounts([member, personal, team]).map((a) => a.account_id)).toEqual(['acc-personal', 'acc-team']);
  });
  test('an account with no role is not creatable', () => {
    expect(creatableAccounts([{ account_id: 'x' } as KortixAccount])).toEqual([]);
  });
});

describe('orderLandingAccounts', () => {
  test('selected account first, then owned or admin accounts, then member-only accounts', () => {
    const order = orderLandingAccounts([member, personal, team], 'acc-member');
    expect(order.map((a) => a.account_id)).toEqual(['acc-member', 'acc-personal', 'acc-team']);
  });

  test('a stale selection is ignored', () => {
    const order = orderLandingAccounts([member, personal], 'acc-gone');
    expect(order.map((a) => a.account_id)).toEqual(['acc-personal', 'acc-member']);
  });
});

describe('resolveLandingProject: the app opens the last project', () => {
  test('opens the last project, found in a different account than the selected one', async () => {
    const result = await resolveLandingProject({
      accounts: [personal, team],
      selectedAccountId: 'acc-personal',
      lastProjectId: 'p-team-2',
      listProjects: lists({
        'acc-personal': [project('p-personal-1')],
        'acc-team': [project('p-team-1'), project('p-team-2')],
      }),
    });
    expect(result).toEqual({ kind: 'project', projectId: 'p-team-2', accountId: 'acc-team' });
  });

  test('a last project that no longer exists falls back to the first project of the selected account', async () => {
    const result = await resolveLandingProject({
      accounts: [personal, team],
      selectedAccountId: 'acc-team',
      lastProjectId: 'p-deleted',
      listProjects: lists({
        'acc-personal': [project('p-personal-1')],
        'acc-team': [project('p-team-1')],
      }),
    });
    expect(result).toEqual({ kind: 'project', projectId: 'p-team-1', accountId: 'acc-team' });
  });

  test('with no last project and an empty selected account, opens the next account with a project', async () => {
    const result = await resolveLandingProject({
      accounts: [personal, member],
      selectedAccountId: 'acc-personal',
      lastProjectId: null,
      listProjects: lists({ 'acc-personal': [], 'acc-member': [project('p-member-1')] }),
    });
    expect(result).toEqual({ kind: 'project', projectId: 'p-member-1', accountId: 'acc-member' });
  });

  test('one failed account does not block a project in another account', async () => {
    const result = await resolveLandingProject({
      accounts: [personal, team],
      selectedAccountId: 'acc-personal',
      lastProjectId: 'p-team-1',
      listProjects: lists({ 'acc-personal': new Error('500'), 'acc-team': [project('p-team-1')] }),
    });
    expect(result).toEqual({ kind: 'project', projectId: 'p-team-1', accountId: 'acc-team' });
  });

  test('throws when every project list fails, so the caller retries instead of opening the list', async () => {
    await expect(
      resolveLandingProject({
        accounts: [personal, team],
        selectedAccountId: null,
        lastProjectId: 'p-1',
        listProjects: lists({ 'acc-personal': new Error('offline'), 'acc-team': new Error('offline') }),
      })
    ).rejects.toThrow('offline');
  });

  test('no project in any account resolves to empty', async () => {
    const result = await resolveLandingProject({
      accounts: [personal, team],
      selectedAccountId: 'acc-personal',
      lastProjectId: null,
      listProjects: lists({}),
    });
    expect(result).toEqual({ kind: 'empty' });
  });
});

describe('checkLastProject: the project that opened blind, confirmed in the background', () => {
  test('listed in another account than the selected one: stay, and select that account', async () => {
    const result = await checkLastProject({
      accounts: [personal, team],
      selectedAccountId: 'acc-personal',
      lastProjectId: 'p-team-2',
      listProjects: lists({
        'acc-personal': [project('p-personal-1')],
        'acc-team': [project('p-team-1'), project('p-team-2')],
      }),
    });
    expect(result).toEqual({ kind: 'listed', accountId: 'acc-team' });
  });

  test('every account answered and none lists it: gone, resolve again', async () => {
    const result = await checkLastProject({
      accounts: [personal, team],
      selectedAccountId: 'acc-personal',
      lastProjectId: 'p-deleted',
      listProjects: lists({ 'acc-personal': [project('p-personal-1')], 'acc-team': [] }),
    });
    expect(result).toEqual({ kind: 'gone' });
  });

  test('the account that may hold it failed: unknown, a network error never moves the user', async () => {
    const result = await checkLastProject({
      accounts: [personal, team],
      selectedAccountId: 'acc-personal',
      lastProjectId: 'p-team-1',
      listProjects: lists({
        'acc-personal': [project('p-personal-1')],
        'acc-team': new Error('502'),
      }),
    });
    expect(result).toEqual({ kind: 'unknown' });
  });

  test('listed wins over another account’s failure', async () => {
    const result = await checkLastProject({
      accounts: [personal, team],
      selectedAccountId: null,
      lastProjectId: 'p-personal-1',
      listProjects: lists({
        'acc-personal': [project('p-personal-1')],
        'acc-team': new Error('502'),
      }),
    });
    expect(result).toEqual({ kind: 'listed', accountId: 'acc-personal' });
  });

  test('every list failed: unknown', async () => {
    const result = await checkLastProject({
      accounts: [personal, team],
      selectedAccountId: null,
      lastProjectId: 'p-1',
      listProjects: lists({
        'acc-personal': new Error('offline'),
        'acc-team': new Error('offline'),
      }),
    });
    expect(result).toEqual({ kind: 'unknown' });
  });

  test('no account at all: gone, no account can hold the project', async () => {
    const result = await checkLastProject({
      accounts: [],
      selectedAccountId: null,
      lastProjectId: 'p-1',
      listProjects: lists({}),
    });
    expect(result).toEqual({ kind: 'gone' });
  });
});

describe('freshOrCached: the failure screens show only with nothing kept', () => {
  const kept = [project('p-kept')];
  const failWith = (status: number | undefined) => async (): Promise<KortixProject[]> => {
    throw Object.assign(new Error(`status ${status}`), { status });
  };

  test('a fresh answer wins over the kept one', async () => {
    const fresh = [project('p-fresh')];
    expect(await freshOrCached(async () => fresh, () => kept)).toBe(fresh);
  });

  test('offline, a gateway error or a server error: the kept answer', async () => {
    expect(await freshOrCached(failWith(undefined), () => kept)).toBe(kept);
    expect(await freshOrCached(failWith(503), () => kept)).toBe(kept);
    expect(await freshOrCached(failWith(500), () => kept)).toBe(kept);
  });

  test('nothing kept: the original error, so the start screen can say why', async () => {
    await expect(freshOrCached(failWith(503), () => undefined)).rejects.toThrow('status 503');
  });

  test('an ended login never opens the kept lists: the user signs in again', async () => {
    await expect(freshOrCached(failWith(401), () => kept)).rejects.toThrow('status 401');
    await expect(freshOrCached(failWith(403), () => kept)).rejects.toThrow('status 403');
  });
});

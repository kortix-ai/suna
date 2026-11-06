import { describe, expect, test } from 'bun:test';
import type { KortixAccount, KortixProject } from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';
import { workspaceQueryOptions, workspacesQueryOptions, workspacesState } from './use-workspaces';

// Synthetic ids; workspace id != account id.
const WS_A = '11111111-1111-4111-8111-111111111111';
const ACC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = '22222222-2222-4222-8222-222222222222';
const ACC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const project = (id: string, accountId: string, opened: string | null): KortixProject => ({
  project_id: id,
  account_id: accountId,
  name: id,
  repo_url: '',
  default_branch: 'main',
  manifest_path: 'kortix.yaml',
  status: 'active',
  metadata: {},
  last_opened_at: opened,
  created_at: '',
  updated_at: '',
});
const account = (id: string, role: string): KortixAccount => ({ account_id: id, name: id, account_role: role });

describe('workspacesState', () => {
  test('flat list, most recent first, with each account\'s role', () => {
    const state = workspacesState({
      accounts: { data: [account(ACC_A, 'owner'), account(ACC_B, 'member')], isLoading: false, isError: false },
      lists: [
        { accountId: ACC_A, data: [project(WS_A, ACC_A, '2026-01-01T00:00:00.000Z')], isLoading: false, isError: false },
        { accountId: ACC_B, data: [project(WS_B, ACC_B, '2026-02-01T00:00:00.000Z')], isLoading: false, isError: false },
      ],
    });
    expect(state.workspaces.map((w) => [w.workspace_id, w.role])).toEqual([
      [WS_B, 'member'],
      [WS_A, 'owner'],
    ]);
    expect(state.isLoading).toBe(false);
    expect(state.isError).toBe(false);
    expect(state.failedAccountIds).toEqual([]);
  });

  test('loading while the accounts load: never "no workspaces" before the question was asked', () => {
    const state = workspacesState({
      accounts: { data: undefined, isLoading: true, isError: false },
      lists: [],
    });
    expect(state.isLoading).toBe(true);
    expect(state.workspaces).toEqual([]);
  });

  test('loading while any account list loads', () => {
    const state = workspacesState({
      accounts: { data: [account(ACC_A, 'owner')], isLoading: false, isError: false },
      lists: [{ accountId: ACC_A, data: undefined, isLoading: true, isError: false }],
    });
    expect(state.isLoading).toBe(true);
  });

  test('one failed account list is reported, not hidden, and does not hide the rest', () => {
    const state = workspacesState({
      accounts: { data: [account(ACC_A, 'owner'), account(ACC_B, 'owner')], isLoading: false, isError: false },
      lists: [
        { accountId: ACC_A, data: [project(WS_A, ACC_A, null)], isLoading: false, isError: false },
        { accountId: ACC_B, data: undefined, isLoading: false, isError: true },
      ],
    });
    expect(state.workspaces.map((w) => w.workspace_id)).toEqual([WS_A]);
    expect(state.failedAccountIds).toEqual([ACC_B]);
    expect(state.isError).toBe(false);
  });

  test('isError when the accounts failed or every list failed', () => {
    expect(
      workspacesState({ accounts: { data: undefined, isLoading: false, isError: true }, lists: [] }).isError,
    ).toBe(true);
    expect(
      workspacesState({
        accounts: { data: [account(ACC_A, 'owner')], isLoading: false, isError: false },
        lists: [{ accountId: ACC_A, data: undefined, isLoading: false, isError: true }],
      }).isError,
    ).toBe(true);
  });
});

describe('workspaceQueryOptions', () => {
  test('keys the workspace under its project scope, so invalidating the project reaches it', () => {
    const key = workspaceQueryOptions(WS_A).queryKey;
    expect(key).toEqual(qk.project.workspace(WS_A));
    expect(key.slice(0, qk.project.scope(WS_A).length)).toEqual([...qk.project.scope(WS_A)]);
  });

  test('is a different cache entry from the bare project row: the shapes differ', () => {
    expect(workspaceQueryOptions(WS_A).queryKey).not.toEqual(qk.project.summary(WS_A));
  });

  test('is off without an id and honours the caller gate', () => {
    expect(workspaceQueryOptions(null).enabled).toBe(false);
    expect(workspaceQueryOptions(WS_A).enabled).toBe(true);
    expect(workspaceQueryOptions(WS_A, false).enabled).toBe(false);
  });

  test('carries the config freshness contract', () => {
    expect(workspaceQueryOptions(WS_A).staleTime).toBe(contract('config').staleTime);
  });
});

describe('workspacesQueryOptions', () => {
  test('keys the one-request list per user under the projects scope, so a create or a rename refetches it', () => {
    const key = workspacesQueryOptions('u1').queryKey;
    expect(key).toEqual(qk.projects.workspaces('u1'));
    expect(key.slice(0, qk.projects.scope().length)).toEqual([...qk.projects.scope()]);
    expect(qk.projects.workspaces('u1')).not.toEqual(qk.projects.workspaces('u2'));
    expect(qk.projects.workspaces('u1')).not.toEqual(qk.projects.list('u1'));
  });

  test('honours the caller gate and carries the inventory freshness contract', () => {
    expect(workspacesQueryOptions('u1').enabled).toBe(true);
    expect(workspacesQueryOptions('u1', false).enabled).toBe(false);
    expect(workspacesQueryOptions('u1').staleTime).toBe(contract('inventory').staleTime);
  });
});

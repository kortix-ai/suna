/**
 * Workspace identity decisions that need no database: the resolver's pick, the
 * store's patch split, and the 1:1 conflict matcher. The DB suite
 * (`workspaces.integration.test.ts`) proves the same rules against Postgres.
 */
import { describe, expect, test } from 'bun:test';

import { asWorkspaceAccountKey, asWorkspaceId } from './ids';
import { isWorkspaceOnePerAccountConflict, WORKSPACE_ONE_PER_ACCOUNT_INDEX } from './one-project';
import { pickWorkspace, WorkspaceAmbiguousError } from './resolve';
import { splitWorkspacePatch } from './store';

const WS_A = '00000000-0000-4000-a000-00000000c101';
const WS_B = '00000000-0000-4000-a000-00000000c102';
const ACCT_1 = '00000000-0000-4000-a000-00000000c201';
const ACCT_LEGACY = '00000000-0000-4000-a000-00000000c202';

describe('pickWorkspace', () => {
  test('a project id resolves to its workspace and account', () => {
    expect(pickWorkspace(WS_A, [{ workspaceId: WS_A, accountId: ACCT_1, splitPending: false }])).toEqual({
      workspaceId: asWorkspaceId(WS_A),
      accountId: asWorkspaceAccountKey(ACCT_1),
      splitPending: false,
    });
  });

  test('the account key of a 1:1 workspace resolves to the same workspace', () => {
    expect(pickWorkspace(ACCT_1, [{ workspaceId: WS_A, accountId: ACCT_1, splitPending: false }])?.workspaceId).toBe(
      asWorkspaceId(WS_A),
    );
  });

  test('upper-case input matches', () => {
    expect(pickWorkspace(WS_A.toUpperCase(), [{ workspaceId: WS_A, accountId: ACCT_1, splitPending: false }])?.workspaceId).toBe(
      asWorkspaceId(WS_A),
    );
  });

  test('no candidate is null', () => {
    expect(pickWorkspace(WS_A, [])).toBeNull();
  });

  test('the account key of a split-pending legacy account is ambiguous', () => {
    const rows = [
      { workspaceId: WS_A, accountId: ACCT_LEGACY, splitPending: true },
      { workspaceId: WS_B, accountId: ACCT_LEGACY, splitPending: true },
    ];
    expect(() => pickWorkspace(ACCT_LEGACY, rows)).toThrow(WorkspaceAmbiguousError);
    // Each project id of that account still resolves.
    expect(pickWorkspace(WS_B, rows)).toEqual({
      workspaceId: asWorkspaceId(WS_B),
      accountId: asWorkspaceAccountKey(ACCT_LEGACY),
      splitPending: true,
    });
  });
});

describe('asWorkspaceId / asWorkspaceAccountKey', () => {
  test('refuse a non-uuid', () => {
    expect(() => asWorkspaceId('not-a-uuid')).toThrow(TypeError);
    expect(() => asWorkspaceAccountKey('')).toThrow(TypeError);
  });
});

describe('splitWorkspacePatch', () => {
  test('a 1:1 rename writes both names; settings go to the account', () => {
    expect(splitWorkspacePatch({ name: 'Synthetic WS', mfaRequired: true, secretDefaultStrategy: 'broker' }, false)).toEqual({
      project: { name: 'Synthetic WS', secretDefaultStrategy: 'broker' },
      account: { name: 'Synthetic WS', mfaRequired: true },
    });
  });

  test('a split-pending rename leaves the shared account name alone', () => {
    expect(splitWorkspacePatch({ name: 'Synthetic WS' }, true)).toEqual({ project: { name: 'Synthetic WS' }, account: {} });
  });

  test('null clears a nullable setting; undefined leaves it', () => {
    expect(splitWorkspacePatch({ sessionMaxLifetimeMinutes: null, patIdleRevokeDays: undefined }, false)).toEqual({
      project: {},
      account: { sessionMaxLifetimeMinutes: null },
    });
  });
});

describe('isWorkspaceOnePerAccountConflict', () => {
  test('matches the 1:1 index violation, bare or wrapped', () => {
    const pg = { code: '23505', constraint_name: WORKSPACE_ONE_PER_ACCOUNT_INDEX };
    expect(isWorkspaceOnePerAccountConflict(pg)).toBe(true);
    expect(isWorkspaceOnePerAccountConflict({ message: 'Failed query', cause: pg })).toBe(true);
  });

  test('does not match another unique index or another error', () => {
    expect(isWorkspaceOnePerAccountConflict({ code: '23505', constraint_name: 'idx_projects_account_idempotency_key' })).toBe(false);
    expect(isWorkspaceOnePerAccountConflict(new Error('boom'))).toBe(false);
    expect(isWorkspaceOnePerAccountConflict(null)).toBe(false);
  });
});

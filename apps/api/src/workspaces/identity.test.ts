/**
 * Workspace identity decisions that need no database: the resolver's pick, the
 * served state, the shadow comparison and the 1:1 conflict matcher. The DB suite
 * (`workspaces.integration.test.ts`) proves the same rules against Postgres.
 */
import { describe, expect, test } from 'bun:test';

import { asWorkspaceAccountKey, asWorkspaceId } from './ids';
import { isWorkspaceOnePerAccountConflict, WORKSPACE_ONE_PER_ACCOUNT_INDEX } from './one-project';
import { pickWorkspace, WorkspaceAmbiguousError } from './resolve';
import { shadowMismatchFields } from './shadow';
import { workspaceState } from './store';

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

describe('workspaceState', () => {
  const record = (lifecycle: 'active' | 'dormant' | 'closing') =>
    ({ lifecycle }) as unknown as Parameters<typeof workspaceState>[0];

  test('active is served as active whatever it pays', () => {
    expect(workspaceState(record('active'), false)).toBe('active');
  });

  test('a dormant workspace is served only while it pays (setup_required)', () => {
    expect(workspaceState(record('dormant'), true)).toBe('setup_required');
    expect(workspaceState(record('dormant'), false)).toBeNull();
  });

  test('a closing workspace is deleting', () => {
    expect(workspaceState(record('closing'), false)).toBe('deleting');
  });
});

describe('shadowMismatchFields', () => {
  test('equal rows differ in nothing; synced_at is never compared', () => {
    expect(shadowMismatchFields({ workspace_id: WS_A, name: 'a', synced_at: '1' }, { workspace_id: WS_A, name: 'a', synced_at: '2' })).toEqual([]);
  });

  test('names the differing fields, sorted, without values', () => {
    expect(
      shadowMismatchFields({ workspace_id: WS_A, name: 'a', lifecycle: 'active' }, { workspace_id: WS_A, name: 'b', lifecycle: 'closing' }),
    ).toEqual(['lifecycle', 'name']);
  });

  test('a row on one side only is the field "row"', () => {
    expect(shadowMismatchFields({ workspace_id: WS_A }, null)).toEqual(['row']);
    expect(shadowMismatchFields(null, { workspace_id: WS_A })).toEqual(['row']);
    expect(shadowMismatchFields(null, null)).toEqual([]);
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

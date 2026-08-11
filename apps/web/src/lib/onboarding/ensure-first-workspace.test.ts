import { describe, expect, test } from 'bun:test';

import { pickLandingWorkspace, shouldAutoCreateFirstWorkspace } from './ensure-first-workspace';

type State = Parameters<typeof shouldAutoCreateFirstWorkspace>[0];

const READY: State = {
  activeAccountId: 'acct_123',
  canCreateWorkspaces: true,
  autoCreateAttempted: false,
  accountsLoading: false,
  workspacesLoading: false,
  workspacesError: false,
  workspacesLoaded: true,
  workspaceCount: 0,
  legacyMachinesLoaded: true,
  legacyMachineCount: 0,
  billingEnabled: true,
  accountStateLoading: false,
  canRun: true,
  suppressedAfterDelete: false,
};

describe('shouldAutoCreateFirstWorkspace', () => {
  test('an empty account provisions without needing a signup signal', () => {
    // Reaching an empty workspace list is enough.
    // It used to also require ?auth_event=signup, so every other route into an
    // empty account dead-ended on a manual "create your first workspace" button.
    expect(shouldAutoCreateFirstWorkspace(READY)).toBe(true);
  });

  test('does not resurrect the workspace the user just deleted', () => {
    expect(shouldAutoCreateFirstWorkspace({ ...READY, suppressedAfterDelete: true })).toBe(false);
  });

  test('does not create for a member who lacks PROJECT_CREATE', () => {
    expect(shouldAutoCreateFirstWorkspace({ ...READY, canCreateWorkspaces: false })).toBe(false);
  });

  test('does not create when the account already has workspaces', () => {
    expect(shouldAutoCreateFirstWorkspace({ ...READY, workspaceCount: 1 })).toBe(false);
  });

  test('does not create twice for the same account', () => {
    expect(shouldAutoCreateFirstWorkspace({ ...READY, autoCreateAttempted: true })).toBe(false);
  });

  test('waits for workspaces to load rather than racing to create', () => {
    expect(shouldAutoCreateFirstWorkspace({ ...READY, workspacesLoaded: false })).toBe(false);
    expect(shouldAutoCreateFirstWorkspace({ ...READY, workspacesLoading: true })).toBe(false);
  });

  test('does not create on a workspaces fetch error', () => {
    // An errored list is not evidence of an empty account.
    expect(shouldAutoCreateFirstWorkspace({ ...READY, workspacesError: true })).toBe(false);
  });

  test('respects the billing gate when billing is on', () => {
    expect(shouldAutoCreateFirstWorkspace({ ...READY, canRun: false })).toBe(false);
    expect(shouldAutoCreateFirstWorkspace({ ...READY, accountStateLoading: true })).toBe(false);
  });

  test('ignores the billing gate when billing is off (self-host)', () => {
    expect(shouldAutoCreateFirstWorkspace({ ...READY, billingEnabled: false, canRun: false })).toBe(
      true,
    );
  });

  test('leaves legacy-machine accounts alone', () => {
    expect(
      shouldAutoCreateFirstWorkspace({ ...READY, legacyMachinesLoaded: true, legacyMachineCount: 2 }),
    ).toBe(false);
  });
});

describe('pickLandingWorkspace', () => {
  const A = { workspace_id: '11111111-1111-4111-8111-111111111111', name: 'A' };
  const B = { workspace_id: '22222222-2222-4222-8222-222222222222', name: 'B' };
  const workspaces = [A, B] as never[];

  test('returns null for an empty account', () => {
    expect(pickLandingWorkspace([])).toBeNull();
  });

  test('prefers the remembered workspace over the first one', () => {
    expect(pickLandingWorkspace(workspaces, B.workspace_id)).toMatchObject({ workspace_id: B.workspace_id });
  });

  test('falls back to the first workspace when the remembered id is not owned', () => {
    // A cookie naming someone else's workspace must never select it — the list
    // came from the server and is the only source of truth here.
    expect(pickLandingWorkspace(workspaces, '33333333-3333-4333-8333-333333333333')).toMatchObject({
      workspace_id: A.workspace_id,
    });
  });

  test('ignores a malformed remembered id', () => {
    expect(pickLandingWorkspace(workspaces, '../../etc/passwd')).toMatchObject({
      workspace_id: A.workspace_id,
    });
    expect(pickLandingWorkspace(workspaces, null)).toMatchObject({ workspace_id: A.workspace_id });
  });
});

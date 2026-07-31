import { describe, expect, test } from 'bun:test';

import { pickLandingProject, shouldAutoCreateFirstProject } from './ensure-first-project';

type State = Parameters<typeof shouldAutoCreateFirstProject>[0];

const READY: State = {
  activeAccountId: 'acct_123',
  canCreateProjects: true,
  autoCreateAttempted: false,
  accountsLoading: false,
  projectsLoading: false,
  projectsError: false,
  projectsLoaded: true,
  projectCount: 0,
  legacyMachinesLoaded: true,
  legacyMachineCount: 0,
  billingEnabled: true,
  accountStateLoading: false,
  canRun: true,
  suppressedAfterDelete: false,
};

describe('shouldAutoCreateFirstProject', () => {
  test('an empty account provisions without needing a signup signal', () => {
    // The whole point of the change: reaching an empty projects list is enough.
    // It used to also require ?auth_event=signup, so every other route into an
    // empty account dead-ended on a manual "create your first project" button.
    expect(shouldAutoCreateFirstProject(READY)).toBe(true);
  });

  test('does not resurrect the project the user just deleted', () => {
    expect(shouldAutoCreateFirstProject({ ...READY, suppressedAfterDelete: true })).toBe(false);
  });

  test('does not create for a member who lacks PROJECT_CREATE', () => {
    expect(shouldAutoCreateFirstProject({ ...READY, canCreateProjects: false })).toBe(false);
  });

  test('does not create when the account already has projects', () => {
    expect(shouldAutoCreateFirstProject({ ...READY, projectCount: 1 })).toBe(false);
  });

  test('does not create twice for the same account', () => {
    expect(shouldAutoCreateFirstProject({ ...READY, autoCreateAttempted: true })).toBe(false);
  });

  test('waits for projects to load rather than racing to create', () => {
    expect(shouldAutoCreateFirstProject({ ...READY, projectsLoaded: false })).toBe(false);
    expect(shouldAutoCreateFirstProject({ ...READY, projectsLoading: true })).toBe(false);
  });

  test('does not create on a projects fetch error', () => {
    // An errored list is not evidence of an empty account.
    expect(shouldAutoCreateFirstProject({ ...READY, projectsError: true })).toBe(false);
  });

  test('respects the billing gate when billing is on', () => {
    expect(shouldAutoCreateFirstProject({ ...READY, canRun: false })).toBe(false);
    expect(shouldAutoCreateFirstProject({ ...READY, accountStateLoading: true })).toBe(false);
  });

  test('ignores the billing gate when billing is off (self-host)', () => {
    expect(shouldAutoCreateFirstProject({ ...READY, billingEnabled: false, canRun: false })).toBe(
      true,
    );
  });

  test('leaves legacy-machine accounts alone', () => {
    expect(
      shouldAutoCreateFirstProject({ ...READY, legacyMachinesLoaded: true, legacyMachineCount: 2 }),
    ).toBe(false);
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

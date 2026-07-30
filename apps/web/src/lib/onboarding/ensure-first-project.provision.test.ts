import { beforeEach, describe, expect, mock, test } from 'bun:test';

const provisionCalls: Array<Record<string, unknown>> = [];
let projects: Array<{ project_id: string; account_id: string; name: string }> = [];
let provisionError: Error | null = null;

mock.module('@kortix/sdk', () => ({
  listProjectsForAccount: async () => projects,
  provisionProject: async (input: Record<string, unknown>) => {
    provisionCalls.push(input);
    if (provisionError) throw provisionError;
    const created = {
      project_id: '99999999-9999-4999-8999-999999999999',
      account_id: 'acct_1',
      name: 'My First Project',
    };
    projects = [created];
    return created;
  },
}));

mock.module('@/lib/marketplace-client', () => ({
  listDefaultProjectMarketplaceItems: async () => [{ id: 'kortix-starter:agent-browser' }],
}));

const EXISTING = {
  project_id: '11111111-1111-4111-8111-111111111111',
  account_id: 'acct_1',
  name: 'Existing',
};
const OTHER = {
  project_id: '22222222-2222-4222-8222-222222222222',
  account_id: 'acct_1',
  name: 'Other',
};

describe('ensureFirstProject provisioning', () => {
  beforeEach(() => {
    provisionCalls.length = 0;
    projects = [];
    provisionError = null;
  });

  test('provisions a starter project for an empty account', async () => {
    // Reverses the previous contract ("does not silently create a managed
    // repository"). Sign-up already provisioned a managed repo server-side, so
    // returning null here only ever produced a manual create-project step on
    // the path where the automatic one had failed.
    const { ensureFirstProject } = await import('./ensure-first-project');

    await expect(ensureFirstProject('acct_1')).resolves.toMatchObject({
      project_id: '99999999-9999-4999-8999-999999999999',
    });
    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0]).toMatchObject({
      account_id: 'acct_1',
      seed_starter: true,
      starter_template: 'general-knowledge-worker',
    });
  });

  test('never provisions when allowCreate is false', async () => {
    // The team-member (no PROJECT_CREATE) and just-deleted cases both land here.
    const { ensureFirstProject } = await import('./ensure-first-project');

    await expect(ensureFirstProject('acct_1', { allowCreate: false })).resolves.toBeNull();
    expect(provisionCalls).toEqual([]);
  });

  test('returns an existing project without provisioning', async () => {
    projects = [EXISTING];
    const { ensureFirstProject } = await import('./ensure-first-project');

    await expect(ensureFirstProject('acct_1')).resolves.toMatchObject({
      project_id: EXISTING.project_id,
    });
    expect(provisionCalls).toEqual([]);
  });

  test('opens the remembered project when the account has several', async () => {
    projects = [EXISTING, OTHER];
    const { ensureFirstProject } = await import('./ensure-first-project');

    await expect(
      ensureFirstProject('acct_1', { preferredProjectId: OTHER.project_id }),
    ).resolves.toMatchObject({ project_id: OTHER.project_id });
    expect(provisionCalls).toEqual([]);
  });

  test('re-reads instead of failing when the project cap is already hit', async () => {
    // Losing a create race against another tab surfaces as project_limit_reached
    // while the account DOES now have a project. Erroring here would strand the
    // user on the landing door.
    provisionError = new Error('project_limit_reached');
    let call = 0;
    mock.module('@kortix/sdk', () => ({
      listProjectsForAccount: async () => (call++ === 0 ? [] : [EXISTING]),
      provisionProject: async () => {
        throw new Error('project_limit_reached');
      },
    }));
    const { ensureFirstProject } = await import('./ensure-first-project');

    await expect(ensureFirstProject('acct_1')).resolves.toMatchObject({
      project_id: EXISTING.project_id,
    });
  });
});

describe('isManagedGitUnavailableError', () => {
  test('true for a 503-status error', async () => {
    const { isManagedGitUnavailableError } = await import('./ensure-first-project');
    const err = new Error('nope');
    (err as Error & { status: number }).status = 503;
    expect(isManagedGitUnavailableError(err)).toBe(true);
  });

  test('true for the not-configured message with no status', async () => {
    const { isManagedGitUnavailableError } = await import('./ensure-first-project');
    expect(
      isManagedGitUnavailableError(
        new Error('Managed git provider "github" is not configured on this server'),
      ),
    ).toBe(true);
  });

  test('false for an unrelated error', async () => {
    const { isManagedGitUnavailableError } = await import('./ensure-first-project');
    expect(isManagedGitUnavailableError(new Error('network error'))).toBe(false);
  });
});

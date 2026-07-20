import { beforeEach, describe, expect, mock, test } from 'bun:test';

const provisionCalls: unknown[] = [];
let projects: Array<{ project_id: string; account_id: string; name: string }> = [];
let provisionError: Error | null = null;

mock.module('@kortix/sdk/projects-client', () => ({
  listProjectsForAccount: async () => projects,
  provisionProject: async (input: unknown) => {
    provisionCalls.push(input);
    if (provisionError) throw provisionError;
    return { project_id: 'proj_1', account_id: 'acct_1', name: 'My First Project' };
  },
}));

mock.module('@/lib/marketplace-client', () => ({
  listDefaultProjectMarketplaceItems: async () => [
    { id: 'kortix-starter:agent-browser' },
  ],
}));

describe('ensureFirstProject provisioning', () => {
  beforeEach(() => {
    provisionCalls.length = 0;
    projects = [];
    provisionError = null;
  });

  test('does not silently create a managed repository for a new account', async () => {
    const { ensureFirstProject } = await import('./ensure-first-project');

    await expect(ensureFirstProject('acct_1')).resolves.toBeNull();
    expect(provisionCalls).toEqual([]);
  });

  test('returns an existing project without provisioning', async () => {
    projects = [{ project_id: 'proj_existing', account_id: 'acct_1', name: 'Existing' }];
    const { ensureFirstProject } = await import('./ensure-first-project');

    await expect(ensureFirstProject('acct_1')).resolves.toMatchObject({
      project_id: 'proj_existing',
    });
    expect(provisionCalls).toEqual([]);
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
      isManagedGitUnavailableError(new Error('Managed git provider "github" is not configured on this server')),
    ).toBe(true);
  });

  test('false for an unrelated error', async () => {
    const { isManagedGitUnavailableError } = await import('./ensure-first-project');
    expect(isManagedGitUnavailableError(new Error('network error'))).toBe(false);
  });
});

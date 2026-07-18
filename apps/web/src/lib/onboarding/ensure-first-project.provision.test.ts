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

  test('creates the first project with default marketplace skill ids', async () => {
    const { ensureFirstProject } = await import('./ensure-first-project');

    await expect(ensureFirstProject('acct_1')).resolves.toMatchObject({
      project_id: 'proj_1',
    });
    expect(provisionCalls).toEqual([
      {
        account_id: 'acct_1',
        name: 'My First Project',
        starter_template: 'general-knowledge-worker',
        marketplace_items: ['kortix-starter:agent-browser'],
      },
    ]);
  });

  test('returns an existing project without provisioning', async () => {
    projects = [{ project_id: 'proj_existing', account_id: 'acct_1', name: 'Existing' }];
    const { ensureFirstProject } = await import('./ensure-first-project');

    await expect(ensureFirstProject('acct_1')).resolves.toMatchObject({
      project_id: 'proj_existing',
    });
    expect(provisionCalls).toEqual([]);
  });

  test('returns null (not a thrown error) when managed git is not configured (503)', async () => {
    const err = new Error('Managed git provider "github" is not configured on this server');
    (err as Error & { status: number }).status = 503;
    provisionError = err;
    const { ensureFirstProject } = await import('./ensure-first-project');

    await expect(ensureFirstProject('acct_1')).resolves.toBeNull();
  });

  test('returns null when the 503 has no status but the message matches', async () => {
    provisionError = new Error('Managed git provider "github" is not configured on this server');
    const { ensureFirstProject } = await import('./ensure-first-project');

    await expect(ensureFirstProject('acct_1')).resolves.toBeNull();
  });

  test('still rethrows unrelated failures', async () => {
    provisionError = new Error('boom');
    const { ensureFirstProject } = await import('./ensure-first-project');

    await expect(ensureFirstProject('acct_1')).rejects.toThrow('boom');
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

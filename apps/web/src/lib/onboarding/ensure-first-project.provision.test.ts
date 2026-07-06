import { beforeEach, describe, expect, mock, test } from 'bun:test';

const provisionCalls: unknown[] = [];
let projects: Array<{ project_id: string; account_id: string; name: string }> = [];

mock.module('@kortix/sdk/projects-client', () => ({
  listProjectsForAccount: async () => projects,
  provisionProject: async (input: unknown) => {
    provisionCalls.push(input);
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
});

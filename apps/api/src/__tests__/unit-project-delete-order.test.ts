/**
 * `DELETE /v1/projects/:projectId` runs three steps in a fixed order, and each
 * order was a production bug:
 *
 * 1. Release prompt attachments. After the archive the project answers 404, so
 *    a release that failed later could never be retried (#7148).
 * 2. Delete the managed repository. A failure answers 502 and the project stays
 *    active, so the delete can be retried (#5071).
 * 3. Archive the project row.
 *
 * PROJ-8 (tests/src/flows) proves the archive over real HTTP. A local stack has
 * no managed git provider to fail and no way to fail the attachment release,
 * so the fault paths live here.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const steps: string[] = [];
let releaseError: Error | null = null;
let repoError: Error | null = null;

const realAccess = await import('../projects/lib/access');
mock.module('../projects/lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    userId: '00000000-0000-4000-a000-000000000001',
    row: { projectId: PROJECT_ID, accountId: '00000000-0000-4000-a000-000000000101', metadata: {} },
  }),
  assertProjectCapability: async () => {},
}));

const realAttachments = await import('../projects/prompt-attachments');
mock.module('../projects/prompt-attachments', () => ({
  ...realAttachments,
  releasePromptAttachmentsForProject: async () => {
    steps.push('release');
    if (releaseError) throw releaseError;
  },
}));

mock.module('../projects/lib/project-deletion', () => ({
  deleteManagedProjectRepo: async () => {
    steps.push('delete-repo');
    if (repoError) throw repoError;
    return true;
  },
}));

const realDb = await import('../shared/db');
mock.module('../shared/db', () => ({
  ...realDb,
  db: {
    update: () => ({
      set: (values: { status?: string }) => ({
        where: () => ({
          returning: async () => {
            steps.push(`archive:${values.status}`);
            return [{ projectId: PROJECT_ID, status: values.status }];
          },
        }),
      }),
    }),
  },
}));

const { projectsApp } = await import('../projects/lib/app');
(await import('../projects/routes/project-settings')).registerProjectSettingsRoutes();

const deleteProject = () => projectsApp.request(`/${PROJECT_ID}`, { method: 'DELETE' });

beforeEach(() => {
  steps.length = 0;
  releaseError = null;
  repoError = null;
});

describe('DELETE /projects/:projectId step order', () => {
  test('release, then repository delete, then archive', async () => {
    const res = await deleteProject();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, archived: true, repo_deleted: true });
    expect(steps).toEqual(['release', 'delete-repo', 'archive:archived']);
  });

  test('a failed repository delete answers 502 and leaves the project active', async () => {
    repoError = new Error('provider unavailable');

    const res = await deleteProject();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Failed to delete managed project repository' });
    expect(steps).toEqual(['release', 'delete-repo']);
  });

  test('a failed attachment release answers 500 before the repository is touched', async () => {
    releaseError = new Error('database unavailable');

    const res = await deleteProject();

    expect(res.status).toBe(500);
    expect(steps).toEqual(['release']);
  });
});

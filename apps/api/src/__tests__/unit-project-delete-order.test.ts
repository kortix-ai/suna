/**
 * `DELETE /v1/projects/:projectId` on a legacy project of a `split_pending`
 * account (the pre-K2 delete) runs five steps in a fixed order, and each order
 * was a production bug:
 *
 * 1. Release prompt attachments. After the archive the project answers 404, so
 *    a release that failed later could never be retried (#7148).
 * 2. Delete the managed repository. A failure answers 502 and the project stays
 *    active, so the delete can be retried (#5071).
 * 3. Purge the project's connector rows (KRTX-1907). The archive leaves the
 *    project row as a tombstone, so the database's FK cascade never fires and
 *    the rows would outlive the purged project. Same retry rule as the
 *    repository delete: a failure answers 500 and the project stays active.
 * 4. Release the chat channels: the Telegram bot, the Slack and Teams installs
 *    and bindings outlive the archive for the same reason, and kept routing
 *    messages to the deleted project. Same retry rule.
 * 5. Archive the project row (`closeWorkspace`, which archives only, for a
 *    split_pending workspace).
 *
 * Any other workspace is closed instead (K2): `closeWorkspace` opens the
 * account's 14-day deletion request and none of the five steps run now; the
 * account-deletion sweep deletes the repository and the connectors at the end
 * of the grace (`workspaces.integration.test.ts`, flow WS-LIFE-2).
 *
 * PROJ-8 (tests/src/flows) proves the archive over real HTTP. A local stack has
 * no managed git provider to fail and no way to fail the attachment release,
 * so the fault paths live here.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockIamEngineAllowAll } from './helpers/iam-mocks';

const PROJECT_ID = '00000000-0000-4000-a000-000000000201';
const steps: string[] = [];
let releaseError: Error | null = null;
let repoError: Error | null = null;
let connectorError: Error | null = null;
let splitPending = true;

// The 1:1 close asks the engine for account.delete; this suite covers the step
// order, not the gate (DEL-2 covers who may delete over HTTP).
mockIamEngineAllowAll();

const realAccess = await import('../projects/lib/access');
mock.module('../projects/lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    userId: '00000000-0000-4000-a000-000000000001',
    row: { projectId: PROJECT_ID, accountId: '00000000-0000-4000-a000-000000000101', metadata: {}, splitPending },
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

const realDeletion = await import('../projects/lib/project-deletion');
mock.module('../projects/lib/project-deletion', () => ({
  ...realDeletion,
  deleteManagedProjectRepo: async () => {
    steps.push('delete-repo');
    if (repoError) throw repoError;
    return true;
  },
  purgeProjectConnectors: async () => {
    steps.push('purge-connectors');
    if (connectorError) throw connectorError;
  },
}));

const realInstallStore = await import('../channels/install-store');
mock.module('../channels/install-store', () => ({
  ...realInstallStore,
  releaseProjectChannels: async () => {
    steps.push('release-channels');
  },
}));

const realSurface = await import('../workspaces/surface');
mock.module('../workspaces/surface', () => ({
  ...realSurface,
  closeWorkspace: async () => {
    steps.push(splitPending ? 'archive' : 'close');
    return splitPending
      ? { mode: 'archived_project' }
      : { mode: 'closed', deletionScheduledFor: new Date('2026-11-20T00:00:00.000Z') };
  },
}));

const realSubscriptions = await import('../projects/trigger-events/subscriptions');
mock.module('../projects/trigger-events/subscriptions', () => ({
  ...realSubscriptions,
  releaseProjectEventSubscriptions: async () => {
    steps.push('release-events');
  },
}));

const { projectsApp } = await import('../projects/lib/app');
(await import('../projects/routes/project-settings')).registerProjectSettingsRoutes();

const deleteProject = () => projectsApp.request(`/${PROJECT_ID}`, { method: 'DELETE' });

beforeEach(() => {
  steps.length = 0;
  releaseError = null;
  repoError = null;
  connectorError = null;
  splitPending = true;
});

describe('DELETE /projects/:projectId step order', () => {
  test('release, then repository delete, then connector purge, then the chat channels, then archive', async () => {
    const res = await deleteProject();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: true, archived: true, repo_deleted: true, deletion_scheduled_for: null });
    expect(steps).toEqual(['release', 'delete-repo', 'purge-connectors', 'release-channels', 'archive', 'release-events']);
  });

  test('a 1:1 workspace is closed instead: no step of the immediate delete runs', async () => {
    splitPending = false;
    const res = await deleteProject();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      deleted: true,
      archived: true,
      repo_deleted: false,
      deletion_scheduled_for: '2026-11-20T00:00:00.000Z',
    });
    expect(steps).toEqual(['close']);
  });

  test('a failed repository delete answers 502 and leaves the project active', async () => {
    repoError = new Error('provider unavailable');

    const res = await deleteProject();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Failed to delete managed project repository' });
    expect(steps).toEqual(['release', 'delete-repo']);
  });

  test('a failed connector purge answers 500 and leaves the project active', async () => {
    connectorError = new Error('database unavailable');

    const res = await deleteProject();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to purge project connectors' });
    expect(steps).toEqual(['release', 'delete-repo', 'purge-connectors']);
  });

  test('a failed attachment release answers 500 before the repository is touched', async () => {
    releaseError = new Error('database unavailable');

    const res = await deleteProject();

    expect(res.status).toBe(500);
    expect(steps).toEqual(['release']);
  });
});

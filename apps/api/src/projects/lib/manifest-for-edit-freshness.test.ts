import { beforeEach, expect, mock, test } from 'bun:test';
import * as realTriggers from '../triggers';

/**
 * A Customize editor reads the manifest it is about to show or rewrite. Every
 * API replica keeps its own git mirror and refreshes it at most every 60 s
 * (`KORTIX_GIT_REFRESH_INTERVAL_MS`), and a write refreshes only the replica
 * that handled it. Without a forced refresh, a `GET` that lands on another
 * replica right after a `PUT` serves the previous manifest: the release gate
 * caught `repository_access` reading back `true` immediately after it was saved
 * as `false` on staging (spec 29), and on prod an agent config write took
 * minutes to show. Editor reads must always see the committed manifest.
 */

const readCalls: Array<{ forceRefresh?: boolean } | undefined> = [];

mock.module('../triggers', () => ({
  ...realTriggers,
  readManifest: async (_project: unknown, opts?: { forceRefresh?: boolean }) => {
    readCalls.push(opts);
    return null;
  },
}));

const { loadManifestForEdit } = await import('./triggers');

beforeEach(() => {
  readCalls.length = 0;
});

test('an editor read forces a mirror refresh so it sees the committed manifest', async () => {
  await loadManifestForEdit({
    projectId: 'project-1',
    accountId: 'account-1',
    name: 'Project',
    repoUrl: 'https://example.test/acme/repo.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: null,
  } as never);

  expect(readCalls).toEqual([{ forceRefresh: true }]);
});

/**
 * Integration test (real PostgreSQL): a monitor box left live when the box was
 * removed is removed at the provider, its compute window is closed, and its row
 * is marked deleted. A box already deleted is left alone. The provider and the
 * meter are stubbed; every query is real.
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { projectMonitorBoxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { removeSeeded, seedProject, type SeededProject } from '../../__tests__/helpers/integration-fixtures';

const removed: string[] = [];
const ended: string[] = [];
const realProviders = await import('../../platform/providers');
mock.module('../../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({ remove: async (externalId: string) => { removed.push(externalId); } }),
}));
const realMetering = await import('../../billing/services/compute-metering');
mock.module('../../billing/services/compute-metering', () => ({
  ...realMetering,
  endComputeSession: async (sandboxId: string) => { ended.push(sandboxId); },
}));
const { retireMonitorBoxes } = await import('./monitor-retire');

let project: SeededProject;
const live = crypto.randomUUID();
const gone = crypto.randomUUID();

beforeAll(async () => {
  project = await seedProject('monitor-retire');
  await db.insert(projectMonitorBoxes).values([
    { boxId: live, projectId: project.project_id, accountId: project.account_id, provider: 'platinum', externalId: 'sbx-live', status: 'running', boxEpoch: 'e1' },
    { boxId: gone, projectId: project.project_id, accountId: project.account_id, provider: 'platinum', externalId: 'sbx-gone', status: 'deleted', boxEpoch: 'e0' },
  ]);
});

afterAll(async () => {
  await removeSeeded([project]);
});

test('a live box is removed, its window closed and its row marked deleted; a deleted box is untouched', async () => {
  expect(await retireMonitorBoxes()).toEqual({ retired: 1, errors: 0 });
  expect(removed).toEqual(['sbx-live']);
  expect(ended).toEqual([live]);
  const [row] = await db.select({ status: projectMonitorBoxes.status }).from(projectMonitorBoxes).where(eq(projectMonitorBoxes.boxId, live));
  expect(row?.status).toBe('deleted');
  expect(await retireMonitorBoxes()).toEqual({ retired: 0, errors: 0 });
});

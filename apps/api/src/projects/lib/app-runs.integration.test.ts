/**
 * Integration test (real PostgreSQL): one-off App runs on the trigger engine.
 * A run is a dotted-slug runtime row with an App target; the catalog's prune
 * never removes it; cancel removes only a pending run of that App; the purge
 * removes only fired runs past retention.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { projectTriggerRuntime } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { removeSeeded, seedProject, type SeededProject } from '../../__tests__/helpers/integration-fixtures';
import { cancelAppRun, insertAppRun, purgeFiredAppRuns } from './app-runs';
import { reconcileProjectTriggerRuntime } from '../trigger-runtime-catalog';

let project: SeededProject;
beforeAll(async () => { project = await seedProject('app-runs'); });
afterAll(async () => { await removeSeeded([project]); });

const row = async (slug: string) =>
  (await db.select().from(projectTriggerRuntime).where(and(eq(projectTriggerRuntime.projectId, project.project_id), eq(projectTriggerRuntime.slug, slug))))[0];

test('a run is a due-at row with an App target, and a manifest reconcile never prunes it', async () => {
  const runAt = new Date(Date.now() + 600_000);
  const run = await insertAppRun({ projectId: project.project_id, app: 'watcher', runAt, method: 'POST', path: '/tick', payload: { n: 1 } });
  if ('error' in run) throw new Error(run.error);
  expect(run.runId).toMatch(/^apprun\.[a-f0-9]{16}$/);
  const stored = await row(run.runId);
  expect(stored?.nextFireAt?.toISOString()).toBe(runAt.toISOString());
  expect((stored?.scheduleSpec as { target: unknown }).target).toEqual({ app: 'watcher', path: '/tick', method: 'POST', payload: { n: 1 } });

  expect(await reconcileProjectTriggerRuntime(project.project_id, [])).toEqual({ upserted: 0, removed: 0 });
  expect(await row(run.runId)).toBeDefined();
});

test('cancel removes a pending run of that App only', async () => {
  const run = await insertAppRun({ projectId: project.project_id, app: 'watcher', runAt: new Date(Date.now() + 60_000), method: 'GET', path: '/', payload: {} });
  if ('error' in run) throw new Error(run.error);
  expect(await cancelAppRun(project.project_id, 'other', run.runId)).toBe(false);
  expect(await cancelAppRun(project.project_id, 'watcher', 'reminder.abc')).toBe(false);
  expect(await cancelAppRun(project.project_id, 'watcher', run.runId)).toBe(true);
  expect(await row(run.runId)).toBeUndefined();
});

test('the purge deletes fired runs past retention and keeps pending and recent ones', async () => {
  const old = await insertAppRun({ projectId: project.project_id, app: 'watcher', runAt: new Date(), method: 'POST', path: '/', payload: {} });
  const recent = await insertAppRun({ projectId: project.project_id, app: 'watcher', runAt: new Date(), method: 'POST', path: '/', payload: {} });
  if ('error' in old || 'error' in recent) throw new Error('insert failed');
  const fired = (slug: string, updatedAt: Date) => db.update(projectTriggerRuntime).set({ nextFireAt: null, lastFiredAt: updatedAt, updatedAt })
    .where(and(eq(projectTriggerRuntime.projectId, project.project_id), eq(projectTriggerRuntime.slug, slug)));
  await fired(old.runId, new Date(Date.now() - 31 * 86_400_000));
  await fired(recent.runId, new Date());
  expect(await purgeFiredAppRuns()).toBe(1);
  expect(await row(old.runId)).toBeUndefined();
  expect(await row(recent.runId)).toBeDefined();
});

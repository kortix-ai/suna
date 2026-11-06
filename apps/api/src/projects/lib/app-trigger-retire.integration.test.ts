/**
 * Integration test (real PostgreSQL): an App delete takes its runtime triggers.
 *
 * A runtime agent trigger that calls an App (`run: { app }`) and one that
 * listens to it are found by the App's slug; a session trigger on it (its
 * session's owner removes it), a kortix.yaml row (no `.` in its slug), another
 * App's trigger and another project's trigger are not. Dropping them removes their
 * rows and their watchers.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { projectTriggerRuntime, triggerWatchers } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { removeSeeded, seedProject, type SeededProject } from '../../__tests__/helpers/integration-fixtures';

const { dropRetiredAppTriggers, runtimeTriggersNamingApp } = await import('./app-trigger-retire');

const WATCHER = crypto.randomUUID();
let project: SeededProject;
let other: SeededProject;

async function seed(target: SeededProject, slug: string, spec: Record<string, unknown>, type = 'app') {
  await db.insert(projectTriggerRuntime).values({
    projectId: target.project_id, slug, triggerType: type, enabled: true, scheduleRevision: 'a'.repeat(64),
    scheduleSpec: { slug, type, agent: 'default', enabled: true, ...spec },
  });
}

async function slugs(target: SeededProject) {
  const rows = await db.select({ slug: projectTriggerRuntime.slug }).from(projectTriggerRuntime)
    .where(eq(projectTriggerRuntime.projectId, target.project_id));
  return rows.map((row) => row.slug).sort();
}

beforeAll(async () => {
  project = await seedProject('app-trigger-retire');
  other = await seedProject('app-trigger-retire-other');
  await seed(project, 'trigger.0000000000a1', { app: 'status-watch', reminder: true, pinnedSessionId: crypto.randomUUID() });
  await seed(project, 'trigger.0000000000a2', { app: null, target: { app: 'status-watch', path: '/tick', method: 'POST' } }, 'cron');
  await seed(project, 'automation.0000000000a3', { app: 'status-watch' });
  await seed(project, 'trigger.0000000000b1', { app: 'price-watch' });
  await seed(project, 'status-work', { app: 'status-watch' });
  await seed(other, 'trigger.0000000000c1', { app: 'status-watch' });
  await db.insert(triggerWatchers).values({ projectId: project.project_id, slug: 'trigger.0000000000a1', userId: WATCHER, muted: false });
});

afterAll(async () => {
  await db.delete(triggerWatchers).where(eq(triggerWatchers.projectId, project.project_id));
  await db.delete(projectTriggerRuntime).where(eq(projectTriggerRuntime.projectId, project.project_id));
  await db.delete(projectTriggerRuntime).where(eq(projectTriggerRuntime.projectId, other.project_id));
  await removeSeeded([project, other]);
});

test('finds the caller and the listener of the App; not a session trigger, a kortix.yaml row, or another App\'s', async () => {
  // trigger.…a1 is a session trigger: its session's owner removes it (the reminder routes' gate).
  expect(await runtimeTriggersNamingApp(project.project_id, 'status-watch'))
    .toEqual(['automation.0000000000a3', 'trigger.0000000000a2']);
  expect(await runtimeTriggersNamingApp(project.project_id, 'nothing-watch')).toEqual([]);
});

test('dropping them removes their rows and watchers; the rest stay', async () => {
  const found = await runtimeTriggersNamingApp(project.project_id, 'status-watch');
  await dropRetiredAppTriggers(project.project_id, [...found, 'status-work']);
  expect(await slugs(project)).toEqual(['trigger.0000000000a1', 'trigger.0000000000b1']);
  expect(await slugs(other)).toEqual(['trigger.0000000000c1']);
  await db.insert(triggerWatchers).values({ projectId: project.project_id, slug: 'automation.0000000000a3', userId: WATCHER, muted: false });
  await dropRetiredAppTriggers(project.project_id, ['automation.0000000000a3']);
  const watchers = await db.select().from(triggerWatchers)
    .where(and(eq(triggerWatchers.projectId, project.project_id), eq(triggerWatchers.slug, 'automation.0000000000a3')));
  expect(watchers).toEqual([]);
});

test('an empty list touches nothing', async () => {
  await dropRetiredAppTriggers(project.project_id, []);
  expect(await slugs(project)).toEqual(['trigger.0000000000a1', 'trigger.0000000000b1']);
});

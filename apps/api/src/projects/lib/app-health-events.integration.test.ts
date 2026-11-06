/**
 * Integration test (real PostgreSQL): the events Kortix writes about an App.
 *
 * A silence alert writes `kortix.app.silent`, the App's next post writes
 * `kortix.app.recovered`, and an always-on App that keeps crashing opens a
 * `crash` streak on its work triggers and writes `kortix.app.crashed`. Each
 * reaches only a trigger whose event is that exact name (never `event: "*"`),
 * once per episode, and none counts as the App posting. With no listener the
 * App's log still records it as `unmatched`, with the fix in the reason.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accountMembers, apps, notifications, projectMonitorEvents, projectTriggerRuntime } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { insertIntoView } from '../../__tests__/helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from '../../__tests__/helpers/integration-fixtures';

const { checkAppTriggerSilence } = await import('./app-trigger-silence');
const { emitAppPlatformEvent, ingestAppEvents, parseAppEventsBody } = await import('./app-events');
const { clearAppCrashAlerts, crashMessage, raiseAppCrashAlerts } = await import('./app-health-alerts');
const { setTriggerAlertNotifierForTest, settleTriggerAlerts } = await import('./trigger-alerts');

const OWNER = crypto.randomUUID();
const APP_ID = crypto.randomUUID();
const QUIET_APP_ID = crypto.randomUUID();
const MIN = 60_000;
let project: SeededProject;

async function seed(slug: string, app: string, opts: { event?: string; expect?: number; heardMinutesAgo?: number } = {}) {
  await db.insert(projectTriggerRuntime).values({
    projectId: project.project_id, slug, triggerType: 'app', enabled: true, scheduleRevision: 'a'.repeat(64),
    scheduleSpec: {
      slug, path: `kortix.yaml#triggers.${slug}`, name: `Trigger ${slug}`, type: 'app', agent: 'default', model: null, enabled: true,
      promptTemplate: 'x', cron: null, runAt: null, timezone: 'UTC', secretEnv: null, sessionMode: 'fresh', pinnedSessionId: null,
      sessionKey: null, app, filter: opts.event ? { 'event.name': opts.event } : null,
      ...(opts.expect ? { expectEventWithinSeconds: opts.expect } : {}),
    },
    lastEventAt: opts.heardMinutesAgo === undefined ? null : new Date(Date.now() - opts.heardMinutesAgo * MIN),
    updatedAt: new Date(Date.now() - 120 * MIN),
  });
}

async function runtime(slug: string) {
  const [row] = await db.select().from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, project.project_id), eq(projectTriggerRuntime.slug, slug)));
  return row!;
}

/** The log rows of one trigger slug ('' = unmatched), oldest first. */
async function rows(slug: string) {
  const list = await db.select().from(projectMonitorEvents)
    .where(and(eq(projectMonitorEvents.projectId, project.project_id), eq(projectMonitorEvents.slug, slug)))
    .orderBy(projectMonitorEvents.ingestedAt);
  return list.map((row) => ({ name: (row.line as { name?: string }).name, line: row.line as Record<string, unknown>, status: row.status, reason: row.lastError, epoch: row.boxEpoch }));
}

async function inbox(slug: string) {
  await settleTriggerAlerts();
  return db.select({ kind: notifications.kind, body: notifications.body }).from(notifications)
    .where(and(eq(notifications.projectId, project.project_id), eq(notifications.triggerSlug, slug)))
    .orderBy(notifications.createdAt);
}

beforeAll(async () => {
  project = await seedProject('app-health-events');
  await insertIntoView(db, accountMembers, [{ userId: OWNER, accountId: project.account_id, accountRole: 'owner' }]);
  setTriggerAlertNotifierForTest({
    pushEnabled: true, listDevices: async () => [], sendExpo: async () => undefined,
    sendWebPush: async () => ({ sent: 0 }), emailAvailable: () => false, sendEmailNow: async () => 'sent',
  });
  await db.insert(apps).values([
    { appId: APP_ID, accountId: project.account_id, projectId: project.project_id, slug: 'status-watch', name: 'Status watch', routeKey: 'dddddddddddddd01', desiredState: 'running' },
    { appId: QUIET_APP_ID, accountId: project.account_id, projectId: project.project_id, slug: 'quiet-watch', name: 'Quiet watch', routeKey: 'dddddddddddddd02', desiredState: 'running' },
  ] as never);
  await seed('work', 'status-watch', { event: 'status.changed', expect: 600, heardMinutesAgo: 25 });
  await seed('any', 'status-watch');
  await seed('repair', 'status-watch', { event: 'kortix.app.silent' });
  await seed('back', 'status-watch', { event: 'kortix.app.recovered' });
  await seed('crashed', 'status-watch', { event: 'kortix.app.crashed' });
  // A repair trigger with a window of its own: Kortix never stamps it, so no window applies.
  await seed('repair-window', 'status-watch', { event: 'kortix.app.recovered', expect: 600, heardMinutesAgo: 25 });
  await seed('quiet-work', 'quiet-watch', { event: 'tick', expect: 600, heardMinutesAgo: 25 });
});

afterAll(async () => {
  setTriggerAlertNotifierForTest(null);
  await db.delete(projectMonitorEvents).where(eq(projectMonitorEvents.projectId, project.project_id));
  await db.delete(projectTriggerRuntime).where(eq(projectTriggerRuntime.projectId, project.project_id));
  await db.delete(apps).where(eq(apps.projectId, project.project_id));
  await removeSeeded([project]);
});

test('the test route may send a kortix.app.* name; an App may not, and no other kortix. name passes', () => {
  expect(parseAppEventsBody({ name: 'kortix.app.silent' }, { platform: true })).toEqual([{ name: 'kortix.app.silent' }]);
  expect('error' in (parseAppEventsBody({ name: 'kortix.app.silent' }) as object)).toBe(true);
  expect('error' in (parseAppEventsBody({ name: 'kortix.app.other' }, { platform: true }) as object)).toBe(true);
});

test('a silence alert writes kortix.app.silent to the trigger on that name only, once per episode', async () => {
  const pass = await checkAppTriggerSilence(new Date(), true);
  expect(pass?.raised).toBe(2); // work, quiet-work
  expect((await runtime('repair-window')).alertFailingSince).toBeNull();
  const repair = await rows('repair');
  expect(repair.map((row) => row.name)).toEqual(['kortix.app.silent']);
  expect(repair[0]!.line).toMatchObject({ platform: true, data: { trigger: 'work', expect_event_within_seconds: 600 } });
  expect(repair[0]!.epoch).toBe(`app:${APP_ID}`);
  // Never to `event: "*"`, the work trigger itself, or the other listeners.
  for (const slug of ['any', 'work', 'back', 'crashed']) expect(await rows(slug)).toEqual([]);
  // No listener on quiet-watch: the log keeps it as unmatched, with the fix.
  const unmatched = (await rows('')).filter((row) => row.epoch === `app:${QUIET_APP_ID}`);
  expect(unmatched.map((row) => [row.name, row.status])).toEqual([['kortix.app.silent', 'skipped']]);
  expect(unmatched[0]!.reason).toContain('add one with on: { event: kortix.app.silent, app: quiet-watch }');
  // Kortix speaking is not the App speaking.
  expect((await runtime('work')).lastEventAt!.getTime()).toBeLessThan(Date.now() - 20 * MIN);

  // A second pass in the same episode writes nothing (the alert is open; the id is the episode).
  await checkAppTriggerSilence(new Date(), true);
  expect(await rows('repair')).toHaveLength(1);
});

test('the App posts again: the alert ends and kortix.app.recovered reaches its listener once', async () => {
  await ingestAppEvents({ projectId: project.project_id, appId: APP_ID, appSlug: 'status-watch', events: [{ name: 'status.changed', id: 'ok-1' }] });
  expect((await runtime('work')).alertFailingSince).toBeNull();
  const back = await rows('back');
  expect(back.map((row) => row.name)).toEqual(['kortix.app.recovered']);
  expect(back[0]!.line).toMatchObject({ platform: true, data: { trigger: 'work', cause: 'silence' } });
  await ingestAppEvents({ projectId: project.project_id, appId: APP_ID, appSlug: 'status-watch', events: [{ name: 'status.changed', id: 'ok-2' }] });
  expect(await rows('back')).toHaveLength(1);
});

test('a crashing App: one crash alert per work trigger, kortix.app.crashed once, then recovered', async () => {
  const at = Date.now();
  expect(await raiseAppCrashAlerts({ projectId: project.project_id, appSlug: 'status-watch', episode: `rt-1:${at}`, restarts: 3 })).toBe(2); // work, any
  expect((await runtime('work')).alertSource).toBe('crash');
  expect((await runtime('any')).alertSource).toBe('crash');
  // The repair listeners get the event, not an alert.
  for (const slug of ['repair', 'back', 'crashed', 'repair-window']) expect((await runtime(slug)).alertFailingSince).toBeNull();
  const work = await inbox('work');
  expect(work.at(-1)).toMatchObject({ kind: 'automation_failed', body: expect.stringContaining(crashMessage('status-watch', 3)) });
  expect((await rows('crashed')).map((row) => row.name)).toEqual(['kortix.app.crashed']);

  // The next pass in the same episode: no new alert, no new event.
  expect(await raiseAppCrashAlerts({ projectId: project.project_id, appSlug: 'status-watch', episode: `rt-1:${at}`, restarts: 3 })).toBe(0);
  expect(await rows('crashed')).toHaveLength(1);
  expect(await inbox('work')).toHaveLength(work.length);

  expect(await clearAppCrashAlerts({ projectId: project.project_id, appSlug: 'status-watch' })).toBe(2);
  expect((await runtime('work')).alertFailingSince).toBeNull();
  expect((await inbox('work')).at(-1)?.kind).toBe('automation_recovered');
  expect((await rows('back')).map((row) => row.line.data)).toEqual([{ trigger: 'work', cause: 'silence' }, { cause: 'crash' }]);
  expect(await clearAppCrashAlerts({ projectId: project.project_id, appSlug: 'status-watch' })).toBe(0);
});

test('a deleted App gets no platform event', async () => {
  await db.update(apps).set({ deletedAt: new Date() }).where(eq(apps.appId, QUIET_APP_ID));
  expect(await emitAppPlatformEvent({ projectId: project.project_id, appSlug: 'quiet-watch', name: 'kortix.app.silent', id: 'x', data: {} })).toBeNull();
});

test('a test narrowed to one trigger reaches only that trigger; one that does not listen is unmatched with the fix', async () => {
  const { asTestEvents } = await import('./app-events');
  await seed('work-2', 'status-watch', { event: 'status.changed' });
  const one = asTestEvents([{ name: 'status.changed', id: 'narrow-1' }]);
  const narrowed = await ingestAppEvents({ projectId: project.project_id, appId: APP_ID, appSlug: 'status-watch', events: one, test: true, only: 'work-2' });
  expect(narrowed).toMatchObject({ triggers: 1, accepted: 1, unmatched: 0 });
  const reached = (await db.select().from(projectMonitorEvents).where(eq(projectMonitorEvents.projectId, project.project_id)))
    .filter((row) => (row.line as { id?: string }).id === 'test-narrow-1').map((row) => row.slug);
  expect(reached).toEqual(['work-2']);

  const miss = await ingestAppEvents({ projectId: project.project_id, appId: APP_ID, appSlug: 'status-watch', events: asTestEvents([{ name: 'status.changed' }]), test: true, only: 'nope' });
  expect(miss).toMatchObject({ triggers: 0, unmatched: 1 });
  expect(miss.hint).toContain('trigger "nope" does not listen to App "status-watch"');

  // A platform test on the exact listener, and on a trigger that listens to another name.
  const repair = await emitAppPlatformEvent({ projectId: project.project_id, appSlug: 'status-watch', name: 'kortix.app.silent', id: 'test-p-1', data: {}, test: true, only: 'repair' });
  expect(repair).toMatchObject({ triggers: 1, accepted: 1 });
  const wrong = await emitAppPlatformEvent({ projectId: project.project_id, appSlug: 'status-watch', name: 'kortix.app.silent', id: 'test-p-2', data: {}, test: true, only: 'back' });
  expect(wrong).toMatchObject({ triggers: 0, unmatched: 1 });
});

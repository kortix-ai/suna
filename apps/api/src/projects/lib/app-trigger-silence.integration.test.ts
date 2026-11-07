/**
 * Integration test (real PostgreSQL): the silence alert of app triggers.
 *
 * An app trigger with `expect_event_within` tells its watchers once when its
 * App posts nothing for that long. Every App POST to the trigger counts as
 * heard, a deduplicated one too (a watcher posts the same content id while
 * nothing changes); a test event does not. The App's next post ends the alert
 * with a recovery notice.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accountMembers, apps, notifications, projectTriggerRuntime } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { insertIntoView } from '../../__tests__/helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from '../../__tests__/helpers/integration-fixtures';
import type { ParsedManifest } from '../triggers';

const { checkAppTriggerSilence, silenceMessage } = await import('./app-trigger-silence');
const { ingestAppEvents } = await import('./app-events');
const { setTriggerAlertNotifierForTest, settleTriggerAlerts } = await import('./trigger-alerts');

const OWNER = crypto.randomUUID();
const APP_ID = crypto.randomUUID();
const MIN = 60_000;
let project: SeededProject;

function appSpec(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug, path: `kortix.yaml#triggers.${slug}`, name: `Trigger ${slug}`, type: 'app', agent: 'default', model: null, enabled: true,
    promptTemplate: 'Status: {{ event.data.status }}', cron: null, runAt: null, timezone: 'UTC', secretEnv: null,
    sessionMode: 'fresh', pinnedSessionId: null, sessionKey: null, filter: null, app: 'status-watch', ...extra,
  };
}

async function seed(slug: string, opts: { expect?: number; heardMinutesAgo: number | null; enabled?: boolean; app?: string }) {
  const heard = opts.heardMinutesAgo === null ? null : new Date(Date.now() - opts.heardMinutesAgo * MIN);
  await db.insert(projectTriggerRuntime).values({
    projectId: project.project_id, slug, triggerType: 'app', enabled: opts.enabled ?? true, scheduleRevision: 'a'.repeat(64),
    scheduleSpec: appSpec(slug, { ...(opts.expect ? { expectEventWithinSeconds: opts.expect } : {}), ...(opts.app ? { app: opts.app } : {}) }),
    lastEventAt: heard,
    // Before any event, the window runs from when the trigger was written.
    updatedAt: new Date(Date.now() - 120 * MIN),
  });
}

async function runtime(slug: string) {
  const [row] = await db.select().from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, project.project_id), eq(projectTriggerRuntime.slug, slug)));
  return row!;
}

async function inbox(slug: string) {
  await settleTriggerAlerts();
  // Ordered: without ORDER BY, Postgres returns heap order, and the notifier's later UPDATE of a row moves it
  // (a failed then a recovered alert came back swapped in 1 of 4 combined runs).
  return db.select({ kind: notifications.kind, body: notifications.body }).from(notifications)
    .where(and(eq(notifications.projectId, project.project_id), eq(notifications.triggerSlug, slug)))
    .orderBy(notifications.createdAt);
}

beforeAll(async () => {
  project = await seedProject('app-trigger-silence');
  await insertIntoView(db, accountMembers, [{ userId: OWNER, accountId: project.account_id, accountRole: 'owner' }]);
  setTriggerAlertNotifierForTest({
    pushEnabled: true, listDevices: async () => [], sendExpo: async () => undefined,
    sendWebPush: async () => ({ sent: 0 }), emailAvailable: () => false, sendEmailNow: async () => 'sent',
  });
  await db.insert(apps).values([
    { appId: APP_ID, accountId: project.account_id, projectId: project.project_id, slug: 'status-watch', name: 'Status watch', routeKey: 'ffffffffffffff01', desiredState: 'running' },
    { appId: crypto.randomUUID(), accountId: project.account_id, projectId: project.project_id, slug: 'gone-watch', name: 'Gone', routeKey: 'ffffffffffffff02', desiredState: 'stopped', deletedAt: new Date() },
  ] as never);
  await seed('quiet', { expect: 600, heardMinutesAgo: 25 });
  // Its App was deleted (a session trigger an App delete leaves to its owner): never a silent App.
  await seed('app-gone', { expect: 600, heardMinutesAgo: 25, app: 'gone-watch' });
  await seed('lively', { expect: 600, heardMinutesAgo: 2 });
  await seed('never-heard', { expect: 3600, heardMinutesAgo: null });
  await seed('off', { expect: 600, heardMinutesAgo: 25, enabled: false });
  await seed('no-window', { heardMinutesAgo: 600 });
  // A window the parser would refuse (stored by an older server or a hand edit): never alerts, never fails the pass.
  await seed('huge', { expect: 100_000_000_000_000, heardMinutesAgo: 600 });
});

afterAll(async () => {
  setTriggerAlertNotifierForTest(null);
  await db.delete(apps).where(eq(apps.projectId, project.project_id));
  await removeSeeded([project]);
});

test('the message says how long, the window, and where to look', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  expect(silenceMessage({ app: 'status-watch', windowSeconds: 600, heardAt: new Date('2026-11-05T11:35:00Z') }, now))
    .toBe('App "status-watch" sent no event for 25m; this trigger expects one within 10m. Check the App: kortix apps events status-watch, kortix apps logs status-watch.');
});

test('only an enabled trigger past its window is alerted, once, with the flag off', async () => {
  const first = await checkAppTriggerSilence(new Date(), true);
  expect(first?.raised).toBe(2); // quiet (25 min > 10 min), never-heard (120 min since written > 60 min)
  expect((await runtime('quiet')).alertSource).toBe('silence');
  expect((await runtime('never-heard')).alertSource).toBe('silence');
  for (const slug of ['lively', 'off', 'no-window', 'huge', 'app-gone']) expect((await runtime(slug)).alertFailingSince).toBeNull();
  const rows = await inbox('quiet');
  expect(rows.map((r) => r.kind)).toEqual(['automation_failed']);
  expect(rows[0]!.body).toContain('App "status-watch" sent no event for 25m; this trigger expects one within 10m.');

  expect((await checkAppTriggerSilence(new Date(), true))?.raised).toBe(0);
  expect(await inbox('quiet')).toHaveLength(1);
});

test('a test event does not count as heard; the App\'s own deduplicated post does, and ends the alert', async () => {
  // Point the silent triggers' App at this App id's slug.
  const event = { name: 'status.checked', id: 'state-ok' };
  await ingestAppEvents({ projectId: project.project_id, appId: APP_ID, appSlug: 'status-watch', events: [{ ...event, id: 'test-1' }], test: true });
  expect((await runtime('quiet')).alertSource).toBe('silence');

  await ingestAppEvents({ projectId: project.project_id, appId: APP_ID, appSlug: 'status-watch', events: [event] });
  const again = await ingestAppEvents({ projectId: project.project_id, appId: APP_ID, appSlug: 'status-watch', events: [event] });
  expect(again.deduped).toBeGreaterThan(0);
  const quiet = await runtime('quiet');
  expect(quiet.alertFailingSince).toBeNull();
  expect(quiet.lastEventAt!.getTime()).toBeGreaterThan(Date.now() - MIN);
  expect((await inbox('quiet')).map((r) => r.kind)).toEqual(['automation_failed', 'automation_recovered']);
  // A disabled trigger is not stamped and keeps no alert.
  expect((await runtime('off')).alertFailingSince).toBeNull();
});

test('kortix.heartbeat counts as heard and ends the alert, but is never stored; other kortix. names are refused', async () => {
  const { parseAppEventsBody } = await import('./app-events');
  const { projectMonitorEvents } = await import('@kortix/db');
  expect(parseAppEventsBody({ name: 'kortix.heartbeat' })).toEqual([{ name: 'kortix.heartbeat' }]);
  expect(parseAppEventsBody({ name: 'kortix.app.silent' })).toEqual({
    error: 'name: names starting with "kortix." are reserved; an App sends only "kortix.heartbeat"',
  });

  await db.update(projectTriggerRuntime).set({ lastEventAt: new Date(Date.now() - 30 * MIN) })
    .where(and(eq(projectTriggerRuntime.projectId, project.project_id), eq(projectTriggerRuntime.slug, 'quiet')));
  await checkAppTriggerSilence(new Date(), true);
  expect((await runtime('quiet')).alertSource).toBe('silence');

  const before = await db.select().from(projectMonitorEvents).where(eq(projectMonitorEvents.projectId, project.project_id));
  const answer = await ingestAppEvents({ projectId: project.project_id, appId: APP_ID, appSlug: 'status-watch', events: [{ name: 'kortix.heartbeat' }] });
  expect(answer).toMatchObject({ heartbeats: 1, accepted: 0, unmatched: 0 });
  const after = await db.select().from(projectMonitorEvents).where(eq(projectMonitorEvents.projectId, project.project_id));
  const added = after.filter((row) => !before.some((old) => old.eventId === row.eventId));
  // The heartbeat is not stored; the alert it ended is, as kortix.app.recovered (no listener here: unmatched).
  expect(added.map((row) => [(row.line as { name: string }).name, row.slug])).toEqual([['kortix.app.recovered', '']]);
  expect((await runtime('quiet')).alertFailingSince).toBeNull();
  expect((await inbox('quiet')).map((r) => r.kind)).toEqual(['automation_failed', 'automation_recovered', 'automation_failed', 'automation_recovered']);
});

test('an app trigger saved through the manifest keeps its window and still raises its silence alert', async () => {
  const { draftToSpec, parseTriggerDraft, specToBody } = await import('./trigger-draft');
  const { upsertTriggerInManifest } = await import('./trigger-manifest');
  const { extractTriggers } = await import('../triggers');
  const { reconcileProjectTriggerRuntime } = await import('../trigger-runtime-catalog');

  // The manifest entry an edited app trigger has, with the silence window set.
  const manifest: ParsedManifest = {
    raw: {
      triggers: [{
        slug: 'saved', name: 'Saved watch', type: 'app', agent: 'default', enabled: true,
        app: 'status-watch', prompt: 'Status: {{ event.data.status }}', expect_event_within: '10m',
      }],
    },
    path: 'kortix.yaml',
  };
  const before = extractTriggers(manifest);
  expect(before.errors).toEqual([]);

  // An edit through the trigger UI: specToBody → parseTriggerDraft → the manifest write.
  const draft = parseTriggerDraft({ ...specToBody(before.specs[0]!), name: 'Saved watcher' }, { existingSlug: 'saved' });
  if ('error' in draft) throw new Error(draft.error);
  const { specs, errors } = extractTriggers(upsertTriggerInManifest(manifest, draftToSpec(draft)));
  expect(errors).toEqual([]);
  await reconcileProjectTriggerRuntime(project.project_id, specs);

  const row = await runtime('saved');
  expect(row.scheduleSpec).toMatchObject({ app: 'status-watch', expectEventWithinSeconds: 600 });
  // Written 120 min ago and heard nothing since: past its 10 min window.
  await db.update(projectTriggerRuntime).set({ updatedAt: new Date(Date.now() - 120 * MIN) })
    .where(and(eq(projectTriggerRuntime.projectId, project.project_id), eq(projectTriggerRuntime.slug, 'saved')));

  await checkAppTriggerSilence(new Date(), true);
  expect((await runtime('saved')).alertSource).toBe('silence');
  expect((await inbox('saved')).map((r) => r.kind)).toEqual(['automation_failed']);
});

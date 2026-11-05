/**
 * Integration test (real PostgreSQL): the silence alert of app triggers.
 *
 * An app trigger with `expect_event_within` tells its watchers once when its
 * App posts nothing for that long, with the `notification_center` flag off
 * (its default). Every App POST to the trigger counts as heard, a
 * deduplicated one too (a watcher posts the same content id while nothing
 * changes); a test event does not. The App's next post ends the alert with a
 * recovery notice.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accountMembers, notifications, projectTriggerRuntime } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { insertIntoView } from '../../__tests__/helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from '../../__tests__/helpers/integration-fixtures';

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
  return db.select({ kind: notifications.kind, body: notifications.body }).from(notifications)
    .where(and(eq(notifications.projectId, project.project_id), eq(notifications.triggerSlug, slug)));
}

beforeAll(async () => {
  project = await seedProject('app-trigger-silence');
  await insertIntoView(db, accountMembers, [{ userId: OWNER, accountId: project.account_id, accountRole: 'owner' }]);
  setTriggerAlertNotifierForTest({
    pushEnabled: true, listDevices: async () => [], sendExpo: async () => undefined,
    sendWebPush: async () => ({ sent: 0 }), emailAvailable: () => false, sendEmailNow: async () => 'sent',
  });
  await seed('quiet', { expect: 600, heardMinutesAgo: 25 });
  await seed('lively', { expect: 600, heardMinutesAgo: 2 });
  await seed('never-heard', { expect: 3600, heardMinutesAgo: null });
  await seed('off', { expect: 600, heardMinutesAgo: 25, enabled: false });
  await seed('no-window', { heardMinutesAgo: 600 });
});

afterAll(async () => {
  setTriggerAlertNotifierForTest(null);
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
  for (const slug of ['lively', 'off', 'no-window']) expect((await runtime(slug)).alertFailingSince).toBeNull();
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

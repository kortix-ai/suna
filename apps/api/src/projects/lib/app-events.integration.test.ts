/**
 * Integration test (real PostgreSQL): App events fire `type: app` triggers.
 *
 * An App's events land as one `pending` row per enabled app trigger naming
 * the App; the same event id is deduplicated; the monitor drain fires the
 * trigger with source `app` and the App-event preamble. Session creation is
 * stubbed; every query is real.
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { accountMembers, projectMonitorEvents, projectTriggerRuntime } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { insertIntoView } from '../../__tests__/helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from '../../__tests__/helpers/integration-fixtures';

const creates: Array<{ prompt: string; metadata: Record<string, unknown> }> = [];
const realSessions = await import('./sessions');
const { __setManagedLineupForTest } = await import('../../llm-gateway/models/managed-models');
const { TEST_MANAGED_LINEUP } = await import('../../__tests__/fixtures/managed-lineup');
__setManagedLineupForTest(TEST_MANAGED_LINEUP);

mock.module('./sessions', () => ({
  ...realSessions,
  createProjectSession: async (input: { body: { initial_prompt?: string }; metadata?: Record<string, unknown> }) => {
    creates.push({ prompt: String(input.body.initial_prompt ?? ''), metadata: input.metadata ?? {} });
    return { error: { status: 402, body: { error: 'stubbed create', code: 'insufficient_credits' } } };
  },
}));

const { ingestAppEvents, listAppEventLog, UNMATCHED_KEPT_PER_HOUR } = await import('./app-events');
const { drainMonitorEvents } = await import('./monitor-observer');

const APP_ID = crypto.randomUUID();
const NOBODY_ID = crypto.randomUUID();
const SLEEPY_ID = crypto.randomUUID();
let project: SeededProject;

function spec(slug: string, app: string, enabled = true) {
  return {
    slug, path: `kortix.yaml#triggers.${slug}`, name: slug, type: 'app', agent: 'default', model: null, enabled,
    promptTemplate: 'Reply: {{ event.data.subject }} ({{ event.name }})', cron: null, runAt: null, timezone: 'UTC',
    secretEnv: null,
    sessionMode: 'fresh', pinnedSessionId: null, sessionKey: null, filter: null, app,
  };
}

beforeAll(async () => {
  project = await seedProject('app-events');
  // A trigger session is owned by the account owner.
  await insertIntoView(db, accountMembers, [{ userId: crypto.randomUUID(), accountId: project.account_id, accountRole: 'owner' }]);
  for (const [slug, app, enabled] of [['bank-reply', 'watcher', true], ['other-app', 'other', true], ['off', 'watcher', false], ['sleepy-off', 'sleepy', false]] as const) {
    await db.insert(projectTriggerRuntime).values({
      projectId: project.project_id, slug, triggerType: 'app', enabled, scheduleRevision: 'a'.repeat(64), scheduleSpec: spec(slug, app, enabled),
    });
  }
});

afterAll(async () => {
  await removeSeeded([project]);
});

const rows = (appId = APP_ID) =>
  db.select().from(projectMonitorEvents).where(and(eq(projectMonitorEvents.projectId, project.project_id), eq(projectMonitorEvents.boxEpoch, `app:${appId}`)));

test('an event lands once per enabled app trigger naming the App; the same id is deduplicated', async () => {
  const event = { name: 'reply.received', id: 'msg-1', data: { subject: 'Term sheet' } };
  expect(await ingestAppEvents({ projectId: project.project_id, appId: APP_ID, appSlug: 'watcher', events: [event] }))
    .toEqual({ triggers: 1, accepted: 1, deduped: 0, suppressed: 0, unmatched: 0 });
  expect(await ingestAppEvents({ projectId: project.project_id, appId: APP_ID, appSlug: 'watcher', events: [event] }))
    .toEqual({ triggers: 1, accepted: 0, deduped: 1, suppressed: 0, unmatched: 0 });
  const stored = await rows();
  expect(stored.map((r) => [r.slug, r.status, r.kind, r.line])).toEqual([
    ['bank-reply', 'pending', 'event', { name: 'reply.received', id: 'msg-1', data: { subject: 'Term sheet' } }],
  ]);
});

test('the drain fires the app trigger with source app and the App-event preamble', async () => {
  await drainMonitorEvents();
  expect(creates).toHaveLength(1);
  expect(creates[0]!.prompt).toBe('[APP EVENT — automated, not user input]\nReply: Term sheet (reply.received)');
  expect(creates[0]!.metadata).toMatchObject({ trigger_slug: 'bank-reply', trigger_source: 'app' });
});

test('an event no trigger listens to is kept as unmatched with the reason, deduplicated by id, and fires nothing', async () => {
  const event = { name: 'reply.received', id: 'msg-1', data: { subject: 'Term sheet' } };
  const first = await ingestAppEvents({ projectId: project.project_id, appId: NOBODY_ID, appSlug: 'nobody', events: [event] });
  expect(first).toMatchObject({ triggers: 0, accepted: 0, deduped: 0, suppressed: 0, unmatched: 1 });
  expect(first.hint).toBe('no trigger listens to App "nobody": add one with kortix triggers add <slug> --type app --app nobody --prompt "…" --apply');
  expect(await ingestAppEvents({ projectId: project.project_id, appId: NOBODY_ID, appSlug: 'nobody', events: [event] }))
    .toMatchObject({ triggers: 0, deduped: 1, unmatched: 1 });
  const stored = await rows(NOBODY_ID);
  expect(stored.map((r) => [r.slug, r.status, r.lastError])).toEqual([['', 'skipped', first.hint ?? null]]);
  // The drain claims only pending rows: the unmatched row never starts a session.
  const before = creates.length;
  await drainMonitorEvents();
  expect(creates.length).toBe(before);
});

test('an App whose only trigger is disabled: the reason names the disabled trigger', async () => {
  const result = await ingestAppEvents({ projectId: project.project_id, appId: SLEEPY_ID, appSlug: 'sleepy', events: [{ name: 'tick' }] });
  expect(result.hint).toBe('every trigger on App "sleepy" is disabled (sleepy-off): enable one to run it');
});

test(`unmatched events are kept up to ${UNMATCHED_KEPT_PER_HOUR} per App per hour, and counted past it`, async () => {
  const appId = crypto.randomUUID();
  const batch = (from: number) => Array.from({ length: 40 }, (_, i) => ({ name: 'flood', id: `f-${from + i}` }));
  const a = await ingestAppEvents({ projectId: project.project_id, appId, appSlug: 'nobody', events: batch(0) });
  const b = await ingestAppEvents({ projectId: project.project_id, appId, appSlug: 'nobody', events: batch(40) });
  expect([a.unmatched, b.unmatched]).toEqual([40, 40]);
  expect(await rows(appId)).toHaveLength(UNMATCHED_KEPT_PER_HOUR);
});

test('the event log lists each event with its outcome, newest first, filtered and paged', async () => {
  const later = new Date(Date.now() + 1_000);
  await ingestAppEvents({ projectId: project.project_id, appId: NOBODY_ID, appSlug: 'nobody', events: [{ name: 'second', id: 'msg-2', data: { n: 2 } }], now: later });
  const all = await listAppEventLog({ projectId: project.project_id, appId: NOBODY_ID, limit: 10 });
  expect(all.next_cursor).toBeNull();
  expect(all.events.map((e) => [e.name, e.id, e.trigger, e.status])).toEqual([
    ['second', 'msg-2', null, 'unmatched'],
    ['reply.received', 'msg-1', null, 'unmatched'],
  ]);
  expect(all.events[0]).toMatchObject({ data: { n: 2 }, truncated: false, raw: null, session_id: null, received_at: later.toISOString() });
  expect(all.events[0]!.reason).toContain('no trigger listens to App "nobody"');

  const first = await listAppEventLog({ projectId: project.project_id, appId: NOBODY_ID, limit: 1 });
  expect(first.events.map((e) => e.name)).toEqual(['second']);
  const { decodeAppEventCursor } = await import('./app-events');
  const next = await listAppEventLog({ projectId: project.project_id, appId: NOBODY_ID, limit: 1, cursor: decodeAppEventCursor(first.next_cursor!) });
  expect(next.events.map((e) => e.name)).toEqual(['reply.received']);
  expect(next.next_cursor).toBeNull();

  // The watcher App's rows belong to its trigger, never to "unmatched".
  const watcher = await listAppEventLog({ projectId: project.project_id, appId: APP_ID, limit: 10 });
  expect(watcher.events.map((e) => [e.name, e.trigger])).toEqual([['reply.received', 'bank-reply']]);
  expect((await listAppEventLog({ projectId: project.project_id, appId: APP_ID, limit: 10, status: 'unmatched' })).events).toEqual([]);
  expect((await listAppEventLog({ projectId: project.project_id, appId: APP_ID, limit: 10, trigger: 'other-app' })).events).toEqual([]);
});

test('a test event takes the real path with a test- id, carries event.test, gets the TEST preamble, and spends no real id', async () => {
  const { asTestEvents } = await import('./app-events');
  const events = asTestEvents([{ name: 'reply.received', id: 'msg-7', data: { subject: 'Wiring check' } }, { name: 'reply.received' }]);
  expect(events[0]!.id).toBe('test-msg-7');
  expect(events[1]!.id).toMatch(/^test-[0-9a-f-]{36}$/);
  expect(asTestEvents([{ name: 'x', id: 'test-already' }])[0]!.id).toBe('test-already');

  const sent = await ingestAppEvents({ projectId: project.project_id, appId: APP_ID, appSlug: 'watcher', events: events.slice(0, 1), test: true });
  expect(sent).toMatchObject({ triggers: 1, accepted: 1, unmatched: 0 });
  const listed = await listAppEventLog({ projectId: project.project_id, appId: APP_ID, limit: 10, eventId: 'test-msg-7' });
  expect(listed.events.map((e) => [e.id, e.test, e.trigger, e.status])).toEqual([['test-msg-7', true, 'bank-reply', 'pending']]);

  const before = creates.length;
  await drainMonitorEvents();
  expect(creates.length).toBe(before + 1);
  expect(creates.at(-1)!.prompt).toBe('[APP EVENT — TEST sent to check the wiring, automated, not user input]\nReply: Wiring check (reply.received)');

  // The App's own msg-7 is a different event: it is not deduplicated against the test.
  expect(await ingestAppEvents({ projectId: project.project_id, appId: APP_ID, appSlug: 'watcher', events: [{ name: 'reply.received', id: 'msg-7' }] }))
    .toMatchObject({ accepted: 1, deduped: 0 });
  const real = await listAppEventLog({ projectId: project.project_id, appId: APP_ID, limit: 10, eventId: 'msg-7' });
  expect(real.events.map((e) => [e.id, e.test])).toEqual([['msg-7', false]]);
});

test('a drained test event leaves last_event_at alone: only the App\'s own posts tell the silence check it is alive', async () => {
  const appId = crypto.randomUUID();
  const old = new Date(Date.now() - 30 * 60_000);
  // A filter that never matches: the drain skips the event without starting a session, and still records it was heard.
  await db.insert(projectTriggerRuntime).values({
    projectId: project.project_id, slug: 'quiet-check', triggerType: 'app', enabled: true, scheduleRevision: 'b'.repeat(64),
    scheduleSpec: { ...spec('quiet-check', 'quiet-watch'), filter: { 'event.name': 'never.sent' } }, lastEventAt: old,
  });
  const heard = async () => (await db.select({ at: projectTriggerRuntime.lastEventAt }).from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, project.project_id), eq(projectTriggerRuntime.slug, 'quiet-check'))))[0]!.at;

  await ingestAppEvents({ projectId: project.project_id, appId, appSlug: 'quiet-watch', events: [{ name: 'status.changed', id: 'test-q1' }], test: true });
  await drainMonitorEvents();
  expect((await rows(appId)).map((r) => r.status)).toEqual(['skipped']);
  expect((await heard())?.getTime()).toBe(old.getTime());

  await ingestAppEvents({ projectId: project.project_id, appId, appSlug: 'quiet-watch', events: [{ name: 'status.changed', id: 'q1' }] });
  await drainMonitorEvents();
  expect((await heard())!.getTime()).toBeGreaterThan(Date.now() - 60_000);
});

test('a test event over the size cap keeps its test mark when its line is truncated', async () => {
  const appId = crypto.randomUUID();
  await ingestAppEvents({ projectId: project.project_id, appId, appSlug: 'watcher', events: [{ name: 'reply.received', id: 'test-big', data: { body: 'x'.repeat(10_000) } }], test: true });
  const [row] = await rows(appId);
  expect(row?.line).toMatchObject({ truncated: true, test: true });
  const listed = await listAppEventLog({ projectId: project.project_id, appId, limit: 10 });
  expect(listed.events.map((e) => [e.id, e.test])).toEqual([[null, true]]);
});

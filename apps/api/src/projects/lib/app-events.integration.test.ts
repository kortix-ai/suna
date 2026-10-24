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

const { ingestAppEvents } = await import('./app-events');
const { drainMonitorEvents } = await import('./monitor-observer');

const APP_ID = crypto.randomUUID();
let project: SeededProject;

function spec(slug: string, app: string, enabled = true) {
  return {
    slug, path: `kortix.yaml#triggers.${slug}`, name: slug, type: 'app', agent: 'default', model: null, enabled,
    promptTemplate: 'Reply: {{ event.data.subject }} ({{ event.name }})', cron: null, runAt: null, timezone: 'UTC',
    secretEnv: null, run: null, monitorMode: null, intervalSeconds: null, expectEventWithinSeconds: null,
    sessionMode: 'fresh', pinnedSessionId: null, sessionKey: null, filter: null, app,
  };
}

beforeAll(async () => {
  project = await seedProject('app-events');
  // A trigger session is owned by the account owner.
  await insertIntoView(db, accountMembers, [{ userId: crypto.randomUUID(), accountId: project.account_id, accountRole: 'owner' }]);
  for (const [slug, app, enabled] of [['bank-reply', 'watcher', true], ['other-app', 'other', true], ['off', 'watcher', false]] as const) {
    await db.insert(projectTriggerRuntime).values({
      projectId: project.project_id, slug, triggerType: 'app', enabled, scheduleRevision: 'a'.repeat(64), scheduleSpec: spec(slug, app, enabled),
    });
  }
});

afterAll(async () => {
  await removeSeeded([project]);
});

const rows = () =>
  db.select().from(projectMonitorEvents).where(and(eq(projectMonitorEvents.projectId, project.project_id), eq(projectMonitorEvents.boxEpoch, `app:${APP_ID}`)));

test('an event lands once per enabled app trigger naming the App; the same id is deduplicated', async () => {
  const event = { name: 'reply.received', id: 'msg-1', data: { subject: 'Term sheet' } };
  expect(await ingestAppEvents({ projectId: project.project_id, appId: APP_ID, appSlug: 'watcher', events: [event] }))
    .toEqual({ triggers: 1, accepted: 1, deduped: 0, suppressed: 0 });
  expect(await ingestAppEvents({ projectId: project.project_id, appId: APP_ID, appSlug: 'watcher', events: [event] }))
    .toEqual({ triggers: 1, accepted: 0, deduped: 1, suppressed: 0 });
  expect(await ingestAppEvents({ projectId: project.project_id, appId: APP_ID, appSlug: 'nobody', events: [event] }))
    .toEqual({ triggers: 0, accepted: 0, deduped: 0, suppressed: 0 });
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

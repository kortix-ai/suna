/**
 * Integration test (real PostgreSQL): a trigger with `target: { app }` calls
 * the App with the fire's payload instead of starting an agent session.
 * The App call and session creation are stubbed; every query is real.
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { removeSeeded, seedProject, type SeededProject } from '../../__tests__/helpers/integration-fixtures';

const calls: Array<Record<string, unknown>> = [];
let answer = { ok: true, status: 200, error: null as string | null, retryable: false };
mock.module('../../apps/app-call', () => ({
  callAppTarget: async (input: Record<string, unknown>) => {
    calls.push(input);
    return answer;
  },
}));
const creates: unknown[] = [];
const realSessions = await import('./sessions');
mock.module('./sessions', () => ({
  ...realSessions,
  createProjectSession: async (input: unknown) => {
    creates.push(input);
    return { error: { status: 402, body: { error: 'stubbed create', code: 'insufficient_credits' } } };
  },
}));

const { fireGitTrigger } = await import('./trigger-fire');
let project: SeededProject;

const spec = {
  slug: 'poll-bank', path: 'kortix.yaml#triggers.poll-bank', name: 'poll-bank', type: 'cron', agent: 'default', model: null,
  enabled: true, promptTemplate: '', cron: '0 */5 * * * *', runAt: null, timezone: 'UTC', secretEnv: null,
  sessionMode: 'fresh', pinnedSessionId: null,
  sessionKey: null, filter: null, target: { app: 'bank-watcher', path: '/tick', method: 'POST' },
} as const;

beforeAll(async () => {
  project = await seedProject('trigger-app-target');
});

afterAll(async () => {
  await removeSeeded([project]);
});

const fire = async () => {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, project.project_id));
  return fireGitTrigger({
    spec: spec as never, project: row! as never, payload: { trigger: { slug: 'poll-bank', type: 'cron' } },
    renderedPrompt: '', source: 'cron', idempotencyKey: 'trigger:cron:poll-bank:slot-1',
  });
};

test('a fire calls the App with the payload and the trigger headers; no session is created', async () => {
  expect(await fire()).toEqual({ status: 'fired' });
  expect(calls).toEqual([{
    projectId: project.project_id, app: 'bank-watcher', method: 'POST', path: '/tick',
    payload: { trigger: { slug: 'poll-bank', type: 'cron' } },
    headers: { 'x-kortix-trigger': 'poll-bank', 'x-kortix-trigger-source': 'cron', 'x-kortix-delivery-id': 'trigger:cron:poll-bank:slot-1' },
  }]);
  expect(creates).toEqual([]);
});

test('a failed App call is a failed fire that keeps the retryable verdict', async () => {
  answer = { ok: false, status: 503, error: 'App "bank-watcher" answered 503 on POST /tick', retryable: true };
  expect(await fire()).toEqual({ status: 'failed', error: 'App "bank-watcher" answered 503 on POST /tick', retryable: true });
});

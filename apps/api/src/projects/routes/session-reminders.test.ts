/**
 * POST /v1/projects/:projectId/sessions/:sessionId/reminders records who hears
 * when the reminder fails (KRTX-1742): the person who set it, or the person an
 * agent session acts for; never an API key. Driven through the real route;
 * access, agent authorization and the reminder store are stubbed.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realAccess from '../lib/access';
import * as realAgentAccess from '../lib/agent-access';
import * as realReminders from '../lib/session-reminders';
import * as realWatchers from '../lib/trigger-watchers';

const ACCOUNT_ID = '7a100000-0000-4000-a000-000000000001';
const PROJECT_ID = '7a200000-0000-4000-a000-000000000001';
const SESSION_ID = '7a300000-0000-4000-a000-000000000001';
const PERSON_ID = '7a400000-0000-4000-a000-000000000001';
const AGENT_USER_ID = '7a500000-0000-4000-a000-000000000001';

let credential: Record<string, unknown> = {};
let followed: Array<Record<string, unknown>> = [];

mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async (c: { get(key: string): unknown }) => ({
    userId: c.get('userId'),
    row: { projectId: PROJECT_ID, accountId: ACCOUNT_ID, metadata: { experimental: { reminders: true } } },
  }),
  assertProjectCapability: async () => undefined,
  loadVisibleSession: async () => ({ row: { sessionId: SESSION_ID, agentName: 'default', metadata: {} } }),
}));
mock.module('../lib/agent-access', () => ({
  ...realAgentAccess,
  resolveAndAuthorizeAgent: async () => 'default',
}));
mock.module('../lib/session-reminders', () => ({
  ...realReminders,
  countActiveSessionReminders: async () => 0,
  insertSessionReminderWithinCaps: async (input: { spec: { slug: string } }) => ({ row: { slug: input.spec.slug } }),
  serializeSessionReminder: (row: { slug: string }) => ({ id: row.slug }),
}));
mock.module('../lib/trigger-watchers', () => ({
  ...realWatchers,
  upsertTriggerWatcher: async (ref: Record<string, unknown>) => {
    followed.push(ref);
  },
}));

const { projectsApp } = await import('../lib/app');
projectsApp.use('*', async (c, next) => {
  for (const [key, value] of Object.entries(credential)) c.set(key as never, value as never);
  await next();
});
const { registerSessionRemindersRoutes } = await import('./session-reminders');
registerSessionRemindersRoutes();

async function createReminder(): Promise<{ status: number; id: string }> {
  const res = await projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/reminders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Did the deploy finish?', in: '30m' }),
  });
  const body = (await res.json()) as { id: string };
  return { status: res.status, id: body.id };
}

beforeEach(() => {
  followed = [];
});

describe('a new reminder', () => {
  test('is followed by the signed-in person who set it', async () => {
    credential = { userId: PERSON_ID, authType: 'supabase', sessionId: '7a600000-0000-4000-a000-000000000001' };
    const { status, id } = await createReminder();

    expect(status).toBe(201);
    expect(followed).toEqual([{ accountId: ACCOUNT_ID, projectId: PROJECT_ID, slug: id, userId: PERSON_ID }]);
  });

  test("set by an agent session, is followed by the person the agent acts for", async () => {
    credential = { userId: AGENT_USER_ID, authType: 'pat', sessionId: SESSION_ID, onBehalfOfUserId: PERSON_ID };
    const { status, id } = await createReminder();

    expect(status).toBe(201);
    expect(followed).toEqual([{ accountId: ACCOUNT_ID, projectId: PROJECT_ID, slug: id, userId: PERSON_ID }]);
  });

  test('set by an unattended agent session or an API key, is followed by nobody', async () => {
    credential = { userId: AGENT_USER_ID, authType: 'pat', sessionId: SESSION_ID, onBehalfOfUserId: null };
    expect((await createReminder()).status).toBe(201);
    credential = { userId: ACCOUNT_ID, authType: 'apiKey' };
    expect((await createReminder()).status).toBe(201);

    expect(followed).toEqual([]);
  });
});

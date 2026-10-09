/**
 * Who `POST /:projectId/turn-question` notifies (KRTX-1742 design §3.1).
 *
 * The question text goes into other people's inbox, phone and email, so only
 * the session's OWN sandbox credential fans it out. A person's token may still
 * store a question (the park-and-restore record) but never notifies: before,
 * a member's PAT could push any text, as "Kortix has a question", to another
 * member's phone. One notification per request id; the thread relay's result
 * says whether a Slack/Teams thread already showed it.
 *
 * Collaborators are mocked (the database, the store, the relay, the notifier):
 * this pins the route's branching. The recipient SQL runs in
 * `__tests__/integration-notification-recipients.test.ts`.
 * `mock.module` is process-global: run with `--isolate`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import * as realAccess from '../lib/access';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';

let sessionMetadata: Record<string, unknown> = {};
let inserted = true;
let relayOk = false;
const notified: Array<Record<string, unknown>> = [];
const contexts: Array<Record<string, unknown>> = [];

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (projection: Record<string, unknown> = {}) => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            'sandboxId' in projection
              ? [{ sandboxId: SESSION_ID, sessionId: SESSION_ID }]
              : [{ sessionId: SESSION_ID, accountId: ACCOUNT_ID, origin: 'user', metadata: sessionMetadata }],
        }),
      }),
    }),
  },
}));

mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({ row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID }, userId: USER_ID }),
}));

mock.module('../lib/pending-questions', () => ({
  recordPendingQuestion: async () => ({ inserted }),
  getOpenQuestion: async () => null,
  resolvePendingQuestion: async () => false,
  renderAnswerPrompt: () => '',
}));

mock.module('../../channels/turn-relay', () => ({
  relayTurnQuestion: async () => (relayOk ? { ok: true, answers: [['x']] } : { ok: false, error: 'no_channel' }),
}));

mock.module('../../channels/question-release', () => ({
  channelOfSessionMetadata: (metadata: Record<string, unknown>) =>
    metadata?.source === 'slack' ? 'slack' : null,
  releaseChannelQuestion: async () => 'released',
}));

mock.module('../lib/notification-recipients', () => ({
  askNotificationContext: async (session: Record<string, unknown>) => {
    contexts.push(session);
    return { prompterUserId: 'user-prompter', originClass: 'attended', isChild: false, triggerWatcherIds: [] };
  },
}));

mock.module('../../notifications/session-push', () => ({
  notifySessionEvent: async (event: Record<string, unknown>) => {
    notified.push(event);
  },
}));

const { projectsApp } = await import('../lib/app');
(await import('./turn-questions')).registerTurnQuestionsRoutes();

const sandboxCtx = { authType: 'pat', sessionId: SESSION_ID, sandboxId: SESSION_ID, accountId: ACCOUNT_ID };
const personCtx = { authType: 'pat', accountId: ACCOUNT_ID };

async function ask(ctx: Record<string, unknown>, requestId: string | null = 'que_1') {
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    for (const [key, value] of Object.entries(ctx)) c.set(key, value);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  const response = await app.request(`/v1/projects/${PROJECT_ID}/turn-question`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: SESSION_ID,
      ...(requestId ? { request_id: requestId } : {}),
      questions: [{ question: 'Which region?', options: [{ label: 'eu' }] }],
    }),
  });
  // The notification is fire-and-forget after the response is built.
  await new Promise((r) => setTimeout(r, 0));
  return response;
}

beforeEach(() => {
  sessionMetadata = {};
  inserted = true;
  relayOk = false;
  notified.length = 0;
  contexts.length = 0;
});

describe('POST /turn-question — who is notified', () => {
  test('the session`s own sandbox: one question notification with the running turn`s context', async () => {
    const response = await ask(sandboxCtx);
    expect(response.status).toBe(200);
    expect(contexts).toEqual([
      { sessionId: SESSION_ID, projectId: PROJECT_ID, accountId: ACCOUNT_ID, metadata: {}, origin: 'user' },
    ]);
    expect(notified).toEqual([
      {
        type: 'question',
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        question: 'Which region?',
        requestId: 'que_1',
        threadCarriesAsk: false,
        prompterUserId: 'user-prompter',
        originClass: 'attended',
        isChild: false,
        triggerWatcherIds: [],
      },
    ]);
  });

  test('a person`s token stores the question but notifies nobody', async () => {
    const response = await ask(personCtx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, persisted: true });
    expect(contexts).toEqual([]);
    expect(notified).toEqual([]);
  });

  test('a daemon retry of the same request id notifies nothing', async () => {
    inserted = false;
    await ask(sandboxCtx);
    expect(notified).toEqual([]);
  });

  test('a Slack thread that posted the question carries the ask', async () => {
    sessionMetadata = { source: 'slack' };
    relayOk = true;
    await ask(sandboxCtx);
    expect(notified[0]).toMatchObject({ threadCarriesAsk: true });
  });

  test('a Slack thread that could not post it does not', async () => {
    sessionMetadata = { source: 'slack' };
    await ask(sandboxCtx);
    expect(notified[0]).toMatchObject({ threadCarriesAsk: false });
  });

  test('a question without a runtime request id is deduped on the stored fallback id', async () => {
    await ask(sandboxCtx, null);
    expect(notified[0]).toMatchObject({ requestId: `q-${SESSION_ID}` });
  });
});

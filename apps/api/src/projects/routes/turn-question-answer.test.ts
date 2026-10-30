import { beforeEach, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import * as access from '../lib/access';
import * as pending from '../lib/pending-questions';

const projectId = '33333333-3333-4333-8333-333333333333';
const sessionId = '55555555-5555-4555-8555-555555555555';
let release: 'released' | 'already_answered' | 'unreachable' = 'released';
let claimed = false;
let replies: string[][][] = [];
let queued: string[] = [];

mock.module('../lib/access', () => ({
  ...access,
  loadProjectForUser: async () => ({ row: { accountId: projectId }, userId: projectId }),
  loadVisibleSession: async () => ({ row: {} }),
}));
mock.module('../lib/pending-questions', () => ({
  ...pending,
  getOpenQuestion: async () => claimed ? null : ({
    request_id: 'que_synthetic', questions: [{ question: 'What should this agent do?', header: 'Role', options: [] }],
  }),
  resolvePendingQuestion: async () => {
    if (claimed) return false;
    claimed = true;
    return true;
  },
}));
mock.module('../session-lifecycle/release-runtime-question', () => ({
  releaseRuntimeQuestion: async (_session: string, _request: string, answers: string[][]) => {
    replies.push(answers);
    return release;
  },
}));
const realSessionLifecycle = await import('../session-lifecycle');
mock.module('../session-lifecycle', () => ({
  ...realSessionLifecycle,
  deliverThroughQueue: async (input: { text: string }) => {
    queued.push(input.text);
    return 'queued';
  },
}));

const { projectsApp } = await import('../lib/app');
(await import('./turn-questions')).registerTurnQuestionsRoutes();
const app = new Hono();
app.route('/v1/projects', projectsApp);
function answer() {
  return app.request(`/v1/projects/${projectId}/sessions/${sessionId}/question`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers: [['Summarize synthetic reports']] }),
  });
}
beforeEach(() => { release = 'released'; claimed = false; replies = []; queued = []; });

test('answers a live blocking question without queueing a second turn', async () => {
  const response = await answer();
  expect(response.status).toBe(200);
  expect(replies).toEqual([[['Summarize synthetic reports']]]);
  expect(queued).toEqual([]);
  expect(await response.json()).toEqual({ ok: true, delivery: 'delivered' });
});

for (const outcome of ['already_answered', 'unreachable'] as const) {
  test(`a cold or unavailable runtime (${outcome}) keeps the durable follow-up`, async () => {
    release = outcome;
    const response = await answer();
    expect(response.status).toBe(200);
    expect(replies).toHaveLength(1);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toContain('Summarize synthetic reports');
    expect(await response.json()).toEqual({ ok: true, delivery: 'queued' });
  });
}

test('concurrent submissions release only the claimed answer', async () => {
  const responses = await Promise.all([answer(), answer()]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(replies).toHaveLength(1);
  expect(queued).toEqual([]);
});

test('a second submission cannot release or enqueue the answer twice', async () => {
  await answer();
  expect((await answer()).status).toBe(409);
  expect(replies).toHaveLength(1);
  expect(queued).toEqual([]);
});

/**
 * Integration test (real local PostgreSQL): a click on an agent question's
 * button in Slack, sent signed through the per-project interactivity route.
 *
 * Real: the route, its signature check and inbound scope (chat_installs), the
 * session and its chat thread, chat identities, IAM roles, the stored
 * question, the post through the turn relay, the press core, the turn row and
 * the lifecycle queue rows. Faked:
 * Slack's HTTP surface (a fetch stub records every Web API call and
 * response_url post), the install's secrets, the queue drain and the runtime
 * release.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  accountMembers,
  chatInstalls,
  chatPendingAuthMessages,
  chatThreads,
  chatTurnStreams,
  chatUserIdentities,
  projectMembers,
  projectSessions,
  sessionLifecycleCommands,
  sessionPendingQuestions,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import * as realInstallStore from '../channels/install-store';
import * as realDrain from '../projects/session-lifecycle/drain';
import { inflightCount } from '../shared/drain';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const SECRET = 'question-answer-signing-secret';
mock.module('../channels/install-store', () => ({
  ...realInstallStore,
  loadSlackTokenForProject: async () => 'xoxb-test',
  loadSlackSigningSecretForProject: async () => SECRET,
}));
// The queue row is the proof; nothing drains it into a sandbox here.
mock.module('../projects/session-lifecycle/drain', () => ({ ...realDrain, drainSessionLifecycleQueue: async () => {} }));
const releases: unknown[][] = [];
mock.module('../projects/session-lifecycle/release-runtime-question', () => ({
  releaseRuntimeQuestion: async (...args: unknown[]) => {
    releases.push(args);
    return 'released';
  },
}));

const slackCalls: Array<{ method: string; body: Record<string, any> }> = [];
const ephemeral: string[] = [];
let failUpdate = false;
/** The ts Slack gives a posted message. */
const POSTED_TS = '900.0001';
globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
  const href = String(url);
  const raw = String(init?.body ?? '');
  if (href.startsWith('https://hooks.slack.com/')) {
    ephemeral.push((JSON.parse(raw) as { text: string }).text);
    return new Response('ok');
  }
  const method = href.replace('https://slack.com/api/', '');
  slackCalls.push({ method, body: raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)) });
  if (method === 'chat.postMessage') return Response.json({ ok: true, ts: POSTED_TS });
  return Response.json(failUpdate && method === 'chat.update' ? { ok: false, error: 'cant_update_message' } : { ok: true });
}) as unknown as typeof fetch;

const created: unknown[] = [];
const { setSlackSessionLifecycleForTest } = await import('../channels/slack/session');
setSlackSessionLifecycleForTest({
  createSession: (async (input: unknown) => {
    created.push(input);
    throw new Error('a click must not start a session');
  }) as never,
});
(await import('../channels/slack/routes')).registerSlackWebhookRoutes();
const { slackWebhookApp } = await import('../channels/slack/app');
const { QUESTION_EARLIER, buildQuestionBlocks } = await import('../channels/slack/questions');
const { questionButtonData } = await import('../channels/core/question-token');
const { relayTurnQuestion } = await import('../channels/turn-relay');

const TEAM = 'T0QUESTION';
const CHANNEL = 'C0QUESTION';
const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const SLACK = { owner: 'U0OWNER', member: 'U0MEMBER', stranger: 'U0STRANGER' };
const QUESTIONS = [
  {
    header: 'Region',
    question: 'Which region?',
    options: [
      { label: 'eu-west', description: '' },
      { label: 'us-east', description: '' },
    ],
    multiple: false,
    custom: true,
  },
  {
    header: 'Confirm',
    question: 'Deploy now?',
    options: [
      { label: 'Yes', description: '' },
      { label: 'No', description: '' },
    ],
    multiple: false,
    custom: false,
  },
];
let project: SeededProject;
let n = 0;

/**
 * A Slack session whose thread shows `questions` in message `messageTs`. The
 * server released the question when it posted it (`answeredAt`), as for every
 * Slack question whose runtime was reachable.
 */
async function asked(opts: { questions?: typeof QUESTIONS; open?: boolean; metadata?: Record<string, unknown> } = {}) {
  const sessionId = crypto.randomUUID();
  const threadTs = `${++n}00.0001`;
  const messageTs = `${n}00.0002`;
  await db.insert(projectSessions).values({
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    createdBy: OWNER,
    metadata: { source: 'slack', slack: { team_id: TEAM, channel: CHANNEL, thread_ts: threadTs }, ...opts.metadata },
  });
  await db.insert(chatThreads).values({ projectId: project.project_id, platform: 'slack', workspaceId: TEAM, threadId: threadTs, sessionId });
  const [row] = await db
    .insert(sessionPendingQuestions)
    .values({
      accountId: project.account_id,
      projectId: project.project_id,
      sessionId,
      requestId: `que_${crypto.randomUUID()}`,
      questions: opts.questions ?? QUESTIONS,
      answeredAt: opts.open ? null : new Date().toISOString(),
    })
    .returning({ id: sessionPendingQuestions.id });
  return { sessionId, threadTs, messageTs, pendingId: row!.id };
}

function signed(body: string): RequestInit {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature },
    body,
  };
}

/** One click on the per-project interactivity route; resolves once its work is done. */
async function click(opts: {
  at: { threadTs: string; messageTs: string };
  user: string;
  value: string;
  actionId?: string;
  text?: string;
  blocks?: unknown[];
  trigger?: string | null;
}) {
  const payload = {
    type: 'block_actions',
    team: { id: TEAM },
    channel: { id: CHANNEL },
    user: { id: opts.user },
    ...(opts.trigger === null ? {} : { trigger_id: opts.trigger ?? `trig-${crypto.randomUUID()}` }),
    response_url: 'https://hooks.slack.com/actions/T0QUESTION/1/x',
    message: { ts: opts.at.messageTs, thread_ts: opts.at.threadTs, ...(opts.blocks ? { blocks: opts.blocks } : {}) },
    actions: [{ action_id: opts.actionId ?? 'qa_0_0', value: opts.value, text: { type: 'plain_text', text: opts.text ?? 'option' } }],
  };
  const res = await slackWebhookApp.request(
    `/${project.project_id}/interactivity`,
    signed(new URLSearchParams({ payload: JSON.stringify(payload) }).toString()),
  );
  expect(res.status).toBe(200);
  while (inflightCount() > 0) await Bun.sleep(5);
}

const followUps = (sessionId: string) =>
  db
    .select({ key: sessionLifecycleCommands.idempotencyKey, actor: sessionLifecycleCommands.actorUserId, payload: sessionLifecycleCommands.payload })
    .from(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.sessionId, sessionId))
    .orderBy(sessionLifecycleCommands.createdAt);
const calls = (method: string) => slackCalls.filter((c) => c.method === method).map((c) => c.body);
const actionBlocks = (blocks: Array<{ type: string; block_id?: string }>) => blocks.filter((b) => b.type === 'actions').map((b) => b.block_id);

beforeAll(async () => {
  project = await seedProject('slack-question-answer');
  await db.insert(chatInstalls).values({ platform: 'slack', workspaceId: TEAM, projectId: project.project_id });
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
  await insertIntoView(db, accountMembers, { userId: MEMBER, accountId: project.account_id, accountRole: 'member' });
  await insertIntoView(db, projectMembers, { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' });
  await db.insert(chatUserIdentities).values([
    { platform: 'slack', workspaceId: TEAM, platformUserId: SLACK.owner, userId: OWNER },
    { platform: 'slack', workspaceId: TEAM, platformUserId: SLACK.member, userId: MEMBER },
  ]);
});

beforeEach(() => {
  slackCalls.length = 0;
  ephemeral.length = 0;
  releases.length = 0;
  created.length = 0;
  failUpdate = false;
});

afterAll(async () => {
  await db.delete(chatUserIdentities).where(eq(chatUserIdentities.workspaceId, TEAM));
  await db.delete(chatPendingAuthMessages).where(eq(chatPendingAuthMessages.workspaceId, TEAM));
  await db.delete(chatTurnStreams).where(eq(chatTurnStreams.projectId, project.project_id));
  await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.projectId, project.project_id));
  await db.delete(sessionPendingQuestions).where(eq(sessionPendingQuestions.projectId, project.project_id));
  await db.delete(chatThreads).where(eq(chatThreads.projectId, project.project_id));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, project.project_id));
  await removeSeeded([project]);
});

test('a question the relay posts with its stored id: a click on the button Slack shows answers with the stored option', async () => {
  const q = await asked();
  await db.insert(chatTurnStreams).values({
    sessionId: q.sessionId,
    projectId: project.project_id,
    teamId: TEAM,
    channel: CHANNEL,
    triggerTs: q.threadTs,
    originatingEvent: {},
    expiresAt: new Date(Date.now() + 60_000),
  });

  expect((await relayTurnQuestion(q.sessionId, QUESTIONS, null, q.pendingId)).ok).toBe(true);
  const posted = calls('chat.postMessage').at(-1)!;
  expect(actionBlocks(posted.blocks)).toEqual(['kq0', 'kq1']);
  const button = posted.blocks.find((b: { block_id?: string }) => b.block_id === 'kq1').elements[1];
  expect(button).toMatchObject({ action_id: 'qa_1_1', value: questionButtonData(q.pendingId, 1, 1) });

  slackCalls.length = 0;
  await click({ at: { threadTs: q.threadTs, messageTs: POSTED_TS }, user: SLACK.owner, actionId: button.action_id, value: button.value, text: button.text.text, blocks: posted.blocks });
  const [row] = await followUps(q.sessionId);
  expect(row!.key).toMatch(new RegExp(`^slack:kq:${TEAM}:${CHANNEL}:${POSTED_TS}:trig-`));
  expect(row!.payload.text).toContain('You asked:\n> Deploy now?\n\nNo');
  const [update] = calls('chat.update');
  expect(update).toMatchObject({ channel: CHANNEL, ts: POSTED_TS });
  expect(actionBlocks(update!.blocks)).toEqual(['kq0']);
  expect(JSON.stringify(update!.blocks)).toContain(`✓ *No* — <@${SLACK.owner}>`);
  expect(created).toEqual([]);
});

test('two people click two questions of one message: each answer reaches the session under its own key, as its clicker', async () => {
  const q = await asked();
  const posted = buildQuestionBlocks(QUESTIONS, q.pendingId);

  await click({ at: q, user: SLACK.owner, value: questionButtonData(q.pendingId, 1), blocks: posted });
  const [first] = calls('chat.update');
  // The clicked question's buttons now say who answered what; the other keeps its buttons.
  expect(first).toMatchObject({ channel: CHANNEL, ts: q.messageTs });
  expect(actionBlocks(first!.blocks)).toEqual(['kq1']);
  expect(JSON.stringify(first!.blocks)).toContain(`✓ *us-east* — <@${SLACK.owner}>`);
  expect(JSON.stringify(first!.blocks)).toContain('Click an option');

  await click({ at: q, user: SLACK.member, actionId: 'qa_1_0', value: questionButtonData(q.pendingId, 0, 1), blocks: first!.blocks });
  const [, second] = calls('chat.update');
  expect(actionBlocks(second!.blocks)).toEqual([]);
  expect(JSON.stringify(second!.blocks)).toContain(`✓ *Yes* — <@${SLACK.member}>`);
  expect(JSON.stringify(second!.blocks)).not.toContain('Click an option');

  const rows = await followUps(q.sessionId);
  expect(rows.map((r) => r.key)).toEqual([
    expect.stringMatching(new RegExp(`^slack:kq:${TEAM}:${CHANNEL}:${q.messageTs}:trig-`)),
    expect.stringMatching(new RegExp(`^slack:kq:${TEAM}:${CHANNEL}:${q.messageTs}:trig-`)),
  ]);
  expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  expect(rows.map((r) => r.actor)).toEqual([OWNER, MEMBER]);
  expect(rows[0]!.payload.text).toContain('You asked:\n> Which region?\n\nus-east');
  expect(rows[1]!.payload.text).toContain('You asked:\n> Deploy now?\n\nYes');
  // The edit is the acknowledgement; the ⏳ goes on the question message once.
  expect(ephemeral).toEqual([]);
  expect(calls('reactions.add')).toEqual([expect.objectContaining({ channel: CHANNEL, timestamp: q.messageTs })]);
  expect(releases).toEqual([]);
  expect(created).toEqual([]);
});

test("the answer is the stored option, never the button's text; a value the question cannot take answers nothing", async () => {
  const q = await asked();
  const posted = buildQuestionBlocks(QUESTIONS, q.pendingId);

  await click({ at: q, user: SLACK.owner, value: questionButtonData(q.pendingId, 0), text: 'Delete production', blocks: posted });
  const [row] = await followUps(q.sessionId);
  expect(row!.payload.text).toContain('You asked:\n> Which region?\n\neu-west');
  expect(row!.payload.text).not.toContain('Delete production');

  slackCalls.length = 0;
  await click({ at: q, user: SLACK.owner, value: questionButtonData(q.pendingId, 5), blocks: posted });
  await click({ at: q, user: SLACK.owner, value: questionButtonData(crypto.randomUUID(), 0), blocks: posted });
  expect(await followUps(q.sessionId)).toHaveLength(1);
  for (const update of calls('chat.update')) {
    expect(actionBlocks(update.blocks)).toEqual([]);
    expect(JSON.stringify(update.blocks)).toContain(QUESTION_EARLIER);
  }
  expect(calls('chat.update')).toHaveLength(2);
});

test('a question still blocking the turn is answered there, with no follow-up', async () => {
  const q = await asked({ questions: [QUESTIONS[1]!], open: true });

  await click({ at: q, user: SLACK.owner, value: questionButtonData(q.pendingId, 1), blocks: buildQuestionBlocks([QUESTIONS[1]!], q.pendingId) });

  expect(releases).toEqual([[q.sessionId, expect.any(String), [['No']]]]);
  expect(await followUps(q.sessionId)).toEqual([]);
  expect(JSON.stringify(calls('chat.update')[0]!.blocks)).toContain(`✓ *No* — <@${SLACK.owner}>`);
  // The turn the release resumes has the click's turn to stream its steps and reply into.
  const turns = await db
    .select({ triggerTs: chatTurnStreams.triggerTs, finalized: chatTurnStreams.finalized })
    .from(chatTurnStreams)
    .where(eq(chatTurnStreams.sessionId, q.sessionId));
  expect(turns).toEqual([{ triggerTs: q.messageTs, finalized: false }]);
  expect(calls('reactions.add')).toEqual([expect.objectContaining({ channel: CHANNEL, timestamp: q.messageTs })]);
});

test("a click on a deleted session's question starts nothing: its turn is dropped and the message says why", async () => {
  const q = await asked({ metadata: { deletedAt: new Date().toISOString() } });

  await click({ at: q, user: SLACK.owner, value: questionButtonData(q.pendingId, 0), blocks: buildQuestionBlocks(QUESTIONS, q.pendingId) });

  expect(created).toEqual([]);
  expect(await followUps(q.sessionId)).toEqual([]);
  expect(await db.select().from(chatTurnStreams).where(eq(chatTurnStreams.sessionId, q.sessionId))).toEqual([]);
  expect(calls('reactions.remove')).toEqual([expect.objectContaining({ timestamp: q.messageTs, name: 'hourglass_flowing_sand' })]);
  const [thread] = await db.select({ sessionId: chatThreads.sessionId }).from(chatThreads).where(eq(chatThreads.threadId, q.threadTs));
  expect(thread!.sessionId).toBe(q.sessionId);
  const last = calls('chat.update').at(-1)!;
  expect(actionBlocks(last.blocks)).toEqual([]);
  expect(JSON.stringify(last.blocks)).toContain(QUESTION_EARLIER);
});

test("a click in a thread that moved to another session answers nothing there", async () => {
  const q = await asked();
  const other = await asked();
  await db.update(chatThreads).set({ sessionId: other.sessionId }).where(eq(chatThreads.threadId, q.threadTs));

  await click({ at: q, user: SLACK.owner, value: questionButtonData(q.pendingId, 0), blocks: buildQuestionBlocks(QUESTIONS, q.pendingId) });

  expect(await followUps(q.sessionId)).toEqual([]);
  expect(await followUps(other.sessionId)).toEqual([]);
  expect(calls('reactions.add')).toEqual([]);
  expect(created).toEqual([]);
  expect(JSON.stringify(calls('chat.update')[0]!.blocks)).toContain(QUESTION_EARLIER);
});

test('a button posted before (`qa_` with its label): each click has its own key, and a deleted session is never revived', async () => {
  const q = await asked();
  const legacy = JSON.stringify({ q: 'Which region?', a: 'us-east' });

  await click({ at: q, user: SLACK.owner, actionId: 'qa_0_1', value: legacy, trigger: 'trig-a' });
  await click({ at: q, user: SLACK.owner, actionId: 'qa_0_1', value: legacy, trigger: 'trig-b' });
  expect((await followUps(q.sessionId)).map((r) => r.key)).toEqual([
    `slack:qa:${TEAM}:${CHANNEL}:${q.messageTs}:trig-a`,
    `slack:qa:${TEAM}:${CHANNEL}:${q.messageTs}:trig-b`,
  ]);
  expect(ephemeral).toEqual(['On it — *us-east*.', 'On it — *us-east*.']);

  ephemeral.length = 0;
  await db
    .update(projectSessions)
    .set({ metadata: { source: 'slack', deletedAt: new Date().toISOString() } })
    .where(eq(projectSessions.sessionId, q.sessionId));
  await click({ at: q, user: SLACK.owner, actionId: 'qa_0_1', value: legacy, trigger: 'trig-c' });
  expect(created).toEqual([]);
  expect(await followUps(q.sessionId)).toHaveLength(2);
  expect(ephemeral).toEqual(['On it — *us-east*.', QUESTION_EARLIER]);
  expect(calls('chat.update')).toEqual([]);
});

test('an unlinked or refused clicker gets only the prompt or refusal, and nothing is kept to replay', async () => {
  const q = await asked();
  await click({ at: q, user: SLACK.stranger, value: questionButtonData(q.pendingId, 0), blocks: buildQuestionBlocks(QUESTIONS, q.pendingId) });
  expect(calls('chat.postEphemeral')).toEqual([expect.objectContaining({ user: SLACK.stranger, text: 'Kortix needs a linked Kortix account to continue.' })]);
  expect(await db.select().from(chatPendingAuthMessages).where(eq(chatPendingAuthMessages.platformUserId, SLACK.stranger))).toEqual([]);

  const ownerOnly = await asked({
    metadata: { slack: { team_id: TEAM, channel: CHANNEL, conversation_policy: 'owner_only' } },
  });
  await click({ at: ownerOnly, user: SLACK.member, value: questionButtonData(ownerOnly.pendingId, 0), blocks: buildQuestionBlocks(QUESTIONS, ownerOnly.pendingId) });
  expect(calls('chat.postEphemeral').at(-1)).toMatchObject({ user: SLACK.member, text: 'This Kortix session is owner-only.' });

  expect(await followUps(q.sessionId)).toEqual([]);
  expect(await followUps(ownerOnly.sessionId)).toEqual([]);
  expect(calls('chat.update')).toEqual([]);
  expect(ephemeral).toEqual([]);
});

test('a click with no blocks rebuilds the message from the stored question; one Slack will not update is acknowledged in an ephemeral', async () => {
  const q = await asked();
  await click({ at: q, user: SLACK.owner, value: questionButtonData(q.pendingId, 1) });
  const [rebuilt] = calls('chat.update');
  expect(actionBlocks(rebuilt!.blocks)).toEqual(['kq1']);
  expect(JSON.stringify(rebuilt!.blocks)).toContain(questionButtonData(q.pendingId, 0, 1));
  expect(JSON.stringify(rebuilt!.blocks)).toContain(`✓ *us-east* — <@${SLACK.owner}>`);

  failUpdate = true;
  await click({ at: q, user: SLACK.owner, actionId: 'qa_1_1', value: questionButtonData(q.pendingId, 1, 1), blocks: rebuilt!.blocks });
  expect(ephemeral).toEqual([`✓ *No* — <@${SLACK.owner}>`]);
  expect(await followUps(q.sessionId)).toHaveLength(2);
});

test('a click without a trigger id records nothing and asks for another click', async () => {
  const q = await asked();
  await click({ at: q, user: SLACK.owner, value: questionButtonData(q.pendingId, 0), trigger: null });
  expect(ephemeral).toEqual(["Couldn't record that click. Click the option again."]);
  expect(await followUps(q.sessionId)).toEqual([]);
  expect(slackCalls).toEqual([]);
});

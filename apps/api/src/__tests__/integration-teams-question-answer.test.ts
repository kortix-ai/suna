/**
 * Integration test (real local PostgreSQL): a tap or a form submit on an agent
 * question's card in Teams, sent as a Bot Framework invoke through the managed
 * webhook route with a locally signed token.
 *
 * Real: the route, its token check (a local JWKS served from
 * `MICROSOFT_BOT_OPENID_METADATA`), the session and its chat thread, chat
 * identities, IAM roles, the join policy, `/new`, the stored question, the
 * post through the turn relay, the press core, the turn row and the lifecycle
 * queue rows. Faked: the Bot
 * Framework HTTP surface (a fetch stub records every connector call), the
 * queue drain and the runtime release.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  accountMembers,
  chatChannelBindings,
  chatEventDedup,
  chatInstalls,
  chatPendingAuthMessages,
  chatThreadParticipants,
  chatThreads,
  chatTurnStreams,
  chatUserIdentities,
  projectMembers,
  projectSessions,
  sessionLifecycleCommands,
  sessionPendingQuestions,
} from '@kortix/db';
import { eq, like } from 'drizzle-orm';
import { config } from '../config';
import * as realDrain from '../projects/session-lifecycle/drain';
import { inflightCount } from '../shared/drain';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

// The queue row is the proof; nothing drains it into a sandbox here.
mock.module('../projects/session-lifecycle/drain', () => ({ ...realDrain, drainSessionLifecycleQueue: async () => {} }));
const releases: unknown[][] = [];
mock.module('../projects/session-lifecycle/release-runtime-question', () => ({
  releaseRuntimeQuestion: async (...args: unknown[]) => {
    releases.push(args);
    return 'released';
  },
}));

// The Bot Framework signs every inbound activity; here a local key does.
const APP_ID = 'question-app';
const SERVICE_URL = 'https://smba.trafficmanager.net/teams/';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'question-key', alg: 'RS256', use: 'sig' };
const jwks = Bun.serve({
  port: 0,
  fetch: (req): Response =>
    new URL(req.url).pathname === '/openid'
      ? Response.json({ jwks_uri: `http://127.0.0.1:${jwks.port}/keys` })
      : Response.json({ keys: [jwk] }),
});
Object.assign(config, {
  MICROSOFT_APP_ID: APP_ID,
  MICROSOFT_APP_PASSWORD: 'question-app-secret',
  MICROSOFT_BOT_OPENID_METADATA: `http://127.0.0.1:${jwks.port}/openid`,
  TEAMS_REQUIRE_USER_IDENTITY: true,
});
const token = () =>
  new SignJWT({ serviceurl: SERVICE_URL })
    .setProtectedHeader({ alg: 'RS256', kid: 'question-key' })
    .setIssuer('https://api.botframework.com')
    .setAudience(APP_ID)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

/** Every Bot Framework connector call: a POST posts a card (`id`), a PUT replaces one. */
const botCalls: Array<{ method: string; url: string; body: any; id: string }> = [];
let posted = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
  const href = String(url);
  if (href.startsWith('http://127.0.0.1')) return realFetch(href, init as RequestInit);
  if (href.startsWith('https://login.microsoftonline.com/')) return Response.json({ access_token: 'bot-token', expires_in: 3600 });
  const method = init?.method ?? 'GET';
  const id = method === 'POST' ? `posted-${++posted}` : decodeURIComponent(href.split('/').at(-1)!);
  botCalls.push({ method, url: href, body: init?.body ? JSON.parse(init.body) : undefined, id });
  return Response.json({ id });
}) as unknown as typeof fetch;

const created: unknown[] = [];
const { setTeamsSessionLifecycleForTest } = await import('../channels/teams/session');
setTeamsSessionLifecycleForTest({
  createSession: (async (input: unknown) => {
    created.push(input);
    throw new Error('a press must not start a session');
  }) as never,
});
(await import('../channels/teams/routes')).registerTeamsWebhookRoutes();
const { teamsWebhookApp } = await import('../channels/teams/app');
const { questionButtonData } = await import('../channels/core/question-token');
const { rememberQuestionMessage, rememberedQuestionRef } = await import('../channels/core/questions');
const { startFreshTeamsConversation } = await import('../channels/teams/fresh-start');
const { relayTurnQuestion } = await import('../channels/turn-relay');

const EARLIER = 'This question is from an earlier conversation.';
const TAP_AGAIN = "Couldn't record that. Tap the button again.";
const TENANT = 'tenant-question';
const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const AAD = { owner: 'aad-owner', member: 'aad-member', stranger: 'aad-stranger' };
const NAME: Record<string, string> = { 'aad-owner': 'Owner', 'aad-member': 'Member', 'aad-stranger': 'Stranger' };
const DEPLOY = {
  header: 'Confirm',
  question: 'Deploy now?',
  options: [
    { label: 'Yes', description: '' },
    { label: 'No', description: '' },
  ],
  multiple: false,
  custom: false,
};
const FORM = [
  {
    header: 'Regions',
    question: 'Which regions?',
    options: [
      { label: 'eu-west, primary', description: '' },
      { label: 'us-east', description: '' },
      { label: 'ap-south', description: '' },
    ],
    multiple: true,
    custom: false,
  },
  { header: 'Notes', question: 'Anything else?', options: [], multiple: false, custom: true },
];
let project: SeededProject;
let n = 0;

/**
 * A Teams group chat whose session asked `questions`. The server released the
 * question when it posted it (`answeredAt`), unless `open`.
 */
async function asked(opts: { questions?: unknown[]; open?: boolean; policy?: string; deleted?: boolean } = {}) {
  const sessionId = crypto.randomUUID();
  const convo = `19:question-${++n}@thread.v2`;
  await db.insert(projectSessions).values({
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    createdBy: OWNER,
    metadata: {
      source: 'teams',
      teams: { tenant_id: TENANT, conversation_id: convo, ...(opts.policy ? { conversation_policy: opts.policy } : {}) },
      ...(opts.deleted ? { deletedAt: new Date().toISOString() } : {}),
    },
  });
  await db.insert(chatThreads).values({ projectId: project.project_id, platform: 'teams', workspaceId: TENANT, threadId: convo, sessionId });
  const [row] = await db
    .insert(sessionPendingQuestions)
    .values({
      accountId: project.account_id,
      projectId: project.project_id,
      sessionId,
      requestId: `que_${crypto.randomUUID()}`,
      questions: opts.questions ?? [DEPLOY],
      answeredAt: opts.open ? null : new Date().toISOString(),
    })
    .returning({ id: sessionPendingQuestions.id });
  return { sessionId, convo, pendingId: row!.id };
}

/** One press, as Teams sends it; resolves once its work after the reply is done. */
async function press(opts: { convo: string; aad: string; data: Record<string, unknown>; form?: boolean; id?: string | null; card?: string }) {
  const id = opts.id === null ? undefined : (opts.id ?? `invoke-${crypto.randomUUID()}`);
  const verb = opts.form ? 'teams_form' : 'teams_answer';
  const activity = {
    type: 'invoke',
    name: 'adaptiveCard/action',
    channelId: 'msteams',
    ...(id ? { id } : {}),
    ...(opts.card ? { replyToId: opts.card } : {}),
    serviceUrl: SERVICE_URL,
    from: { id: `29:${opts.aad}`, aadObjectId: opts.aad, name: NAME[opts.aad] },
    recipient: { id: `28:${APP_ID}`, name: 'Kortix' },
    conversation: { id: opts.convo, tenantId: TENANT, conversationType: 'groupChat' },
    value: { action: { type: 'Action.Execute', verb, data: { verb, ...opts.data } } },
  };
  const res = await teamsWebhookApp.request('/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
    body: JSON.stringify(activity),
  });
  expect(res.status).toBe(200);
  const reply = (await res.json()) as { statusCode: number; type: string; value: any };
  while (inflightCount() > 0) await Bun.sleep(5);
  return { id, reply };
}

const followUps = (sessionId: string) =>
  db
    .select({ key: sessionLifecycleCommands.idempotencyKey, actor: sessionLifecycleCommands.actorUserId, payload: sessionLifecycleCommands.payload })
    .from(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.sessionId, sessionId))
    .orderBy(sessionLifecycleCommands.createdAt);
/** The text of a one-block notice card, or of the card a connector call carried. */
const cardText = (card: any) => card.body.map((b: { text: string }) => b.text).join('\n');
const cardUpdates = (activityId: string) =>
  botCalls.filter((c) => c.method === 'PUT' && c.url.endsWith(`/activities/${activityId}`)).map((c) => cardText(c.body.attachments[0].content));

/** Post `questions` through the turn relay into the live turn of `q`'s chat; the card Teams got, and its id. */
async function relayed(q: { sessionId: string; convo: string; pendingId: string }, questions: unknown[]) {
  await db.insert(chatTurnStreams).values({
    sessionId: q.sessionId,
    projectId: project.project_id,
    teamId: TENANT,
    channel: q.convo,
    triggerTs: `trigger-${q.sessionId}`,
    originatingEvent: {},
    channelRef: { platform: 'teams', serviceUrl: SERVICE_URL, conversationId: q.convo, botId: `28:${APP_ID}` },
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect((await relayTurnQuestion(q.sessionId, questions as never, null, q.pendingId)).ok).toBe(true);
  const posted = botCalls.filter((c) => c.method === 'POST').at(-1)!;
  const target = { platform: 'teams' as const, workspaceId: TENANT, threadId: q.convo, projectId: project.project_id };
  // A press that Teams sends without the card's id finds it by this.
  expect(await rememberedQuestionRef(target, q.pendingId)).toBe(posted.id);
  botCalls.length = 0;
  return { id: posted.id, card: posted.body.attachments[0].content };
}

beforeAll(async () => {
  project = await seedProject('teams-question-answer');
  await db.insert(chatInstalls).values({ platform: 'teams', workspaceId: TENANT, projectId: project.project_id });
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
  await insertIntoView(db, accountMembers, { userId: MEMBER, accountId: project.account_id, accountRole: 'member' });
  await insertIntoView(db, projectMembers, { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' });
  await db.insert(chatUserIdentities).values([
    { platform: 'teams', workspaceId: TENANT, platformUserId: AAD.owner, userId: OWNER },
    { platform: 'teams', workspaceId: TENANT, platformUserId: AAD.member, userId: MEMBER },
  ]);
});

beforeEach(() => {
  botCalls.length = 0;
  releases.length = 0;
  created.length = 0;
});

afterAll(async () => {
  jwks.stop(true);
  globalThis.fetch = realFetch;
  await db.delete(chatUserIdentities).where(eq(chatUserIdentities.workspaceId, TENANT));
  await db.delete(chatPendingAuthMessages).where(eq(chatPendingAuthMessages.workspaceId, TENANT));
  await db.delete(chatThreadParticipants).where(eq(chatThreadParticipants.workspaceId, TENANT));
  await db.delete(chatChannelBindings).where(eq(chatChannelBindings.workspaceId, TENANT));
  await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, `teams:%${TENANT}%`));
  await db.delete(chatTurnStreams).where(eq(chatTurnStreams.projectId, project.project_id));
  await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.projectId, project.project_id));
  await db.delete(sessionPendingQuestions).where(eq(sessionPendingQuestions.projectId, project.project_id));
  await db.delete(chatThreads).where(eq(chatThreads.projectId, project.project_id));
  await db.delete(chatInstalls).where(eq(chatInstalls.workspaceId, TENANT));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, project.project_id));
  await removeSeeded([project]);
});

test("two people tap one card: each gets the stored answer on the invoke, everyone's card loses its buttons, and each answer reaches the session under its own key, as its presser", async () => {
  const q = await asked();

  // The label on the action is not trusted: the stored option is the answer.
  const first = await press({ convo: q.convo, aad: AAD.owner, card: 'card-1', data: { answer: 'Delete production', question: 'Deploy now?', kq: questionButtonData(q.pendingId, 1) } });
  expect(first.reply.type).toBe('application/vnd.microsoft.card.adaptive');
  expect(first.reply.value.actions).toBeUndefined();
  expect(cardText(first.reply.value)).toBe('**Deploy now?**\n\n✅ Answered: No — Owner');
  expect(cardUpdates('card-1')).toEqual(['**Deploy now?**\n\n✅ Answered: No — Owner']);

  const second = await press({ convo: q.convo, aad: AAD.member, card: 'card-1', data: { answer: 'Yes', question: 'Deploy now?', kq: questionButtonData(q.pendingId, 0) } });
  expect(cardText(second.reply.value)).toBe('**Deploy now?**\n\n✅ Answered: Yes — Member');

  const rows = await followUps(q.sessionId);
  expect(rows.map((r) => r.key)).toEqual([`teams:${TENANT}:${q.convo}:kq:${first.id}`, `teams:${TENANT}:${q.convo}:kq:${second.id}`]);
  expect(rows.map((r) => r.actor)).toEqual([OWNER, MEMBER]);
  expect((rows[0]!.payload as { text: string }).text).toContain('You asked:\n> Deploy now?\n\nNo');
  expect((rows[0]!.payload as { text: string }).text).not.toContain('Delete production');
  expect((rows[1]!.payload as { text: string }).text).toContain('You asked:\n> Deploy now?\n\nYes');
  expect(releases).toEqual([]);
  expect(created).toEqual([]);
});

test('a card the relay posts with its stored id: a tap on it answers with the stored option, and the stored card is the one updated', async () => {
  const q = await asked();
  const { id, card } = await relayed(q, [DEPLOY]);
  expect(card.actions.map((a: { data: unknown }) => a.data)).toEqual([
    { verb: 'teams_answer', answer: 'Yes', question: 'Deploy now?', kq: questionButtonData(q.pendingId, 0) },
    { verb: 'teams_answer', answer: 'No', question: 'Deploy now?', kq: questionButtonData(q.pendingId, 1) },
  ]);

  const { id: invoke } = await press({ convo: q.convo, aad: AAD.owner, data: card.actions[1].data });
  expect(cardUpdates(id)).toEqual(['**Deploy now?**\n\n✅ Answered: No — Owner']);
  const [row] = await followUps(q.sessionId);
  expect(row!.key).toBe(`teams:${TENANT}:${q.convo}:kq:${invoke}`);
  expect((row!.payload as { text: string }).text).toContain('You asked:\n> Deploy now?\n\nNo');
  expect(created).toEqual([]);
});

test('a form the relay posts with its stored id: its submit answers each question with the stored options and its own text', async () => {
  const q = await asked({ questions: FORM });
  const { id, card } = await relayed(q, FORM);
  const inputs = card.body.filter((b: { type: string }) => b.type.startsWith('Input.'));
  expect(inputs.map((i: { id: string }) => i.id)).toEqual(['kq0', 'kq1.text']);
  expect(card.actions[0].data).toEqual({ verb: 'teams_form', fieldIds: 'kq0,kq1.text', kq: q.pendingId });

  // Teams sends each input's value beside the action's data: a multi-select joins its choices' values.
  const picked = inputs[0].choices.filter((c: { title: string }) => c.title !== 'us-east').map((c: { value: string }) => c.value);
  await press({ convo: q.convo, aad: AAD.owner, form: true, data: { ...card.actions[0].data, kq0: picked.join(','), 'kq1.text': 'ship it friday' } });
  const answered = '**Which regions?**\n\n**Anything else?**\n\n✅ Answered: eu-west, primary, ap-south, ship it friday — Owner';
  expect(cardUpdates(id)).toEqual([answered]);
  const [row] = await followUps(q.sessionId);
  expect((row!.payload as { text: string }).text).toContain('You asked:\n> Which regions?\neu-west, primary, ap-south\n\n> Anything else?\nship it friday');
});

test('a question still blocking the turn is answered there; the card kept at post time is the one updated', async () => {
  const q = await asked({ open: true });
  const target = { platform: 'teams' as const, workspaceId: TENANT, threadId: q.convo, projectId: project.project_id };
  await rememberQuestionMessage(target, 'card-7', q.pendingId);

  await press({ convo: q.convo, aad: AAD.owner, data: { answer: 'No', question: 'Deploy now?', kq: questionButtonData(q.pendingId, 1) } });

  expect(releases).toEqual([[q.sessionId, expect.stringMatching(/^que_/), [['No']]]]);
  expect(await followUps(q.sessionId)).toEqual([]);
  expect(cardUpdates('card-7')).toEqual(['**Deploy now?**\n\n✅ Answered: No — Owner']);
  expect(await rememberedQuestionRef(target, q.pendingId)).toBeNull();
});

test('a form answers by option index, a label with a comma and its own text included; an index the question lacks answers nothing', async () => {
  const q = await asked({ questions: FORM });

  const { reply } = await press({
    convo: q.convo,
    aad: AAD.owner,
    form: true,
    card: 'form-1',
    data: { kq: q.pendingId, fieldIds: 'kq0,kq1.text', kq0: '0,2', 'kq1.text': ' ship it friday ' },
  });
  const answered = '**Which regions?**\n\n**Anything else?**\n\n✅ Answered: eu-west, primary, ap-south, ship it friday — Owner';
  expect(cardText(reply.value)).toBe(answered);
  expect(cardUpdates('form-1')).toEqual([answered]);
  const [row] = await followUps(q.sessionId);
  expect((row!.payload as { text: string }).text).toContain('You asked:\n> Which regions?\neu-west, primary, ap-south\n\n> Anything else?\nship it friday');

  botCalls.length = 0;
  const stale = await press({ convo: q.convo, aad: AAD.owner, form: true, card: 'form-1', data: { kq: q.pendingId, kq0: '1,9' } });
  expect(cardText(stale.reply.value)).toBe(`**Which regions?**\n\n**Anything else?**\n\n${EARLIER}`);
  expect(cardUpdates('form-1')).toEqual([`**Which regions?**\n\n**Anything else?**\n\n${EARLIER}`]);
  expect(await followUps(q.sessionId)).toHaveLength(1);
});

test('after /new, a tap on the old card answers nothing and starts no session', async () => {
  const q = await asked();
  expect(
    await startFreshTeamsConversation({ tenantId: TENANT, conversationId: q.convo, scope: 'groupChat', teamsUserId: AAD.owner }),
  ).toEqual({ reset: true, previousSessionId: q.sessionId });

  const tap = await press({ convo: q.convo, aad: AAD.owner, card: 'card-1', data: { answer: 'Yes', question: 'Deploy now?', kq: questionButtonData(q.pendingId, 0) } });
  const legacy = await press({ convo: q.convo, aad: AAD.owner, data: { answer: 'Yes', question: 'Deploy now?' } });

  expect(cardText(tap.reply.value)).toBe(EARLIER);
  expect(cardText(legacy.reply.value)).toBe(EARLIER);
  expect(created).toEqual([]);
  expect(await followUps(q.sessionId)).toEqual([]);
  expect(await db.select().from(chatThreads).where(eq(chatThreads.threadId, q.convo))).toEqual([]);
});

test('a card posted before (`teams_answer` with its label) answers into the conversation’s session under its invoke key; a deleted session is never revived', async () => {
  const q = await asked();
  const { id } = await press({ convo: q.convo, aad: AAD.owner, data: { answer: 'Yes', question: 'Deploy now?' } });
  const [row] = await followUps(q.sessionId);
  expect(row!.key).toBe(`teams:${TENANT}:${q.convo}:${id}:answer`);
  expect((row!.payload as { text: string }).text).toContain('Answering your question "Deploy now?":\nYes');

  for (const kq of [false, true]) {
    const gone = await asked({ deleted: true });
    botCalls.length = 0;
    await press({
      convo: gone.convo,
      aad: AAD.owner,
      card: 'card-9',
      data: { answer: 'No', question: 'Deploy now?', ...(kq ? { kq: questionButtonData(gone.pendingId, 1) } : {}) },
    });
    expect(created).toEqual([]);
    expect(await followUps(gone.sessionId)).toEqual([]);
    // The live card the press opened says why nothing ran.
    const live = botCalls.find((c) => c.method === 'POST')!;
    expect(cardUpdates(live.id).at(-1)).toBe(EARLIER);
    if (kq) expect(cardUpdates('card-9')).toEqual(['**Deploy now?**\n\n✅ Answered: No — Owner', `**Deploy now?**\n\n${EARLIER}`]);
  }
});

test('a press without an invoke id records nothing and asks for another tap', async () => {
  const q = await asked({ questions: FORM });
  for (const opts of [
    { data: { answer: 'Yes', question: 'Deploy now?', kq: questionButtonData(q.pendingId, 0) } },
    { form: true, data: { kq: q.pendingId, kq0: '1' } },
    { form: true, data: { fieldIds: 'Which regions?', 'Which regions?': 'us-east' } },
  ]) {
    const { reply } = await press({ convo: q.convo, aad: AAD.owner, id: null, ...opts });
    expect(reply).toEqual({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: TAP_AGAIN });
  }
  expect(await followUps(q.sessionId)).toEqual([]);
  expect(botCalls).toEqual([]);
});

test('an unlinked or refused presser gets only the prompt or the refusal: the card keeps its buttons, and nothing is kept to replay', async () => {
  const q = await asked();
  const unlinked = await press({ convo: q.convo, aad: AAD.stranger, card: 'card-1', data: { answer: 'Yes', question: 'Deploy now?', kq: questionButtonData(q.pendingId, 0) } });
  expect(unlinked.reply.type).toBe('application/vnd.microsoft.activity.message');
  // The sign-in link goes to them alone.
  expect(botCalls.map((c) => `${c.method} ${c.url.replace(SERVICE_URL, '')}`)).toEqual([
    `POST v3/conversations/${encodeURIComponent(q.convo)}/activities?isTargetedActivity=true`,
  ]);
  expect(await db.select().from(chatPendingAuthMessages).where(eq(chatPendingAuthMessages.platformUserId, AAD.stranger))).toEqual([]);

  botCalls.length = 0;
  const ownerOnly = await asked({ policy: 'owner_only' });
  const refused = await press({ convo: ownerOnly.convo, aad: AAD.member, card: 'card-1', data: { answer: 'Yes', question: 'Deploy now?', kq: questionButtonData(ownerOnly.pendingId, 0) } });
  expect(refused.reply).toEqual({
    statusCode: 200,
    type: 'application/vnd.microsoft.activity.message',
    value: 'This Kortix session is owner-only. Start a new conversation if you want Kortix to work with you separately.',
  });
  expect(botCalls.map((c) => c.method)).toEqual(['POST']);
  expect(botCalls[0]!.url).toContain('isTargetedActivity=true');

  expect(await followUps(q.sessionId)).toEqual([]);
  expect(await followUps(ownerOnly.sessionId)).toEqual([]);
  expect(cardUpdates('card-1')).toEqual([]);
});

test('an unlinked presser of a card posted before gets only the prompt: the card keeps its inputs, and nothing is kept to replay', async () => {
  const q = await asked();
  for (const opts of [
    { data: { answer: 'Yes', question: 'Deploy now?' } },
    { form: true, data: { fieldIds: 'Which region?', 'Which region?': 'us-east' } },
  ]) {
    botCalls.length = 0;
    const { reply } = await press({ convo: q.convo, aad: AAD.stranger, card: 'card-1', ...opts });
    expect(reply).toEqual({
      statusCode: 200,
      type: 'application/vnd.microsoft.activity.message',
      value: 'Your answer was not taken. Follow the message I sent you, then tap again.',
    });
    expect(botCalls.map((c) => c.method)).toEqual(['POST']);
    expect(botCalls[0]!.url).toContain('isTargetedActivity=true');
  }
  expect(await db.select().from(chatPendingAuthMessages).where(eq(chatPendingAuthMessages.platformUserId, AAD.stranger))).toEqual([]);
  expect(await followUps(q.sessionId)).toEqual([]);
  expect(created).toEqual([]);
});

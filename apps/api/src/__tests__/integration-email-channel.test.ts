/**
 * Integration test (real local DB): a received email on the event inbox.
 * The Resend webhook stores the email (ids and headers, never a body) on the
 * integration event inbox before it acks, and only for a sender the inbox
 * allows. A consumer reads the body from Resend and routes the email; a failed
 * read retries, a crashed run is claimed again, and a run whose create already
 * started routes nothing twice. Email to a deleted workspace gets one "not
 * accepting" reply per thread (KRTX-1714). Mail in a thread of an inbox that
 * moved to this project, or was removed and added again, starts the thread
 * over instead of being dropped. Only Resend's HTTP API is stubbed;
 * the active project's lifecycle is a recorder that binds the thread through
 * the real post-create step.
 */
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  chatEventDedup,
  chatThreads,
  connectorConnections,
  connectors,
  jobQueue,
  projectSessionConnectorBindings,
  projectSessions,
  projects,
  sessionLifecycleCommands,
} from '@kortix/db';
import { and, eq, like, sql } from 'drizzle-orm';
import { resetChannelLifecycleForTest, setChannelLifecycleForTest } from '../channels/core/conversation';
import { emailWebhookApp } from '../channels/email/app';
import { registerEmailWebhookRoutes } from '../channels/email/routes';
import { emailMessageEvent, handleEmailEvent } from '../channels/email/session';
import type { ResendInboxEmailReceivedEvent } from '../channels/email/types';
import {
  insertEmailInboxAccount,
  loadEmailInboxAccountForInbox,
  normalizeSenderPolicy,
  releaseEmailInbox,
  reserveEmailInbox,
  revokeEmailInboxAccount,
} from '../channels/install-store';
import { applyPostCreateActions } from '../projects/session-lifecycle/create-session';
import { db } from '../shared/db';
import { claimJobs, runJobBatch } from '../shared/job-queue';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const RUN = crypto.randomUUID().slice(0, 8);
const REPLY = 'This address is not accepting email right now. No one will answer this message.';
const SIGNING_KEY = 'test-signing-key';
const QUEUE = 'integration.events.email';

/** Resend's API as seen by the suite: every call, and GET answers to fail. */
let calls: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
const failingGets = new Map<string, { status: number; times: number }>();
const originalFetch = globalThis.fetch;

function email(inbox: string, n: number, thread: string, opts: { type?: string; from?: string } = {}): ResendInboxEmailReceivedEvent {
  return {
    type: opts.type ?? 'inbox.email.received',
    created_at: '2026-10-27T10:00:00.000Z',
    data: {
      inbox_id: inbox,
      thread_id: `${inbox}-${thread}`,
      email_id: `eml-${inbox}-${n}`,
      from: opts.from ?? 'Sender <sender@example.test>',
      to: ['inbox@example.test'],
      subject: 'A question',
    },
  };
}

/** A Resend webhook delivery, Svix-signed with the inbox's secret. */
function deliver(event: ResendInboxEmailReceivedEvent) {
  const rawBody = JSON.stringify(event);
  const id = `msg_${event.data.email_id}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.from(SIGNING_KEY)).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  return emailWebhookApp.request('/resend', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` },
    body: rawBody,
  });
}

/** What POST /channels/email/inboxes leaves behind, minus the Resend calls. */
async function addInbox(project: SeededProject, inboxId: string, senderPolicy = normalizeSenderPolicy(null)) {
  const scope = { accountId: project.account_id, projectId: project.project_id };
  let [connector] = await db.select({ connectorId: connectors.connectorId }).from(connectors)
    .where(and(eq(connectors.projectId, project.project_id), eq(connectors.slug, 'kortix_email')));
  connector ??= (await db
    .insert(connectors)
    .values({ ...scope, slug: 'kortix_email', name: 'Email', providerType: 'channel', config: { platform: 'email' } })
    .returning({ connectorId: connectors.connectorId }))[0];
  await reserveEmailInbox({ projectId: project.project_id, inboxId, email: 'inbox@example.test', agentName: null });
  await insertEmailInboxAccount({
    ...scope,
    connectorId: connector!.connectorId,
    ownerType: 'project',
    ownerId: null,
    inboxId,
    email: 'inbox@example.test',
    displayName: 'Inbox',
    senderPolicy,
    agentName: null,
    managed: false,
    createdByKortix: false,
    webhookId: null,
    apiKey: 're_project_key',
    webhookSecret: `whsec_${Buffer.from(SIGNING_KEY).toString('base64')}`,
    createdBy: null,
  });
}

const replies = () => calls.filter((c) => c.method === 'POST');
const bodyReads = () => calls.filter((c) => c.method === 'GET');
const jobsOf = (inbox: string) =>
  db.select().from(jobQueue).where(and(eq(jobQueue.queue, QUEUE), like(jobQueue.jobKey, `email:${inbox}:%`)));
const rewind = (inbox: string) =>
  db.update(jobQueue).set({ runAt: sql`now()`, lockedUntil: null }).where(and(eq(jobQueue.queue, QUEUE), like(jobQueue.jobKey, `email:${inbox}:%`)));

beforeAll(() => {
  registerEmailWebhookRoutes();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes('api.resend.com')) return originalFetch(input, init);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
    const failing = [...failingGets].find(([emailId]) => url.endsWith(`/emails/${emailId}`));
    if (method === 'GET' && failing && failing[1].times > 0) {
      failing[1].times--;
      return new Response(JSON.stringify({ message: `Resend ${failing[1].status}` }), { status: failing[1].status });
    }
    // Retrieve Thread Email answers the body; the reply answers its id.
    const answer =
      method === 'GET'
        ? { id: 'eml', from: 'Sender <sender@example.test>', to: ['inbox@example.test'], subject: 'A question', text: 'Hello?' }
        : { id: 'reply-1' };
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  calls = [];
  failingGets.clear();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  resetChannelLifecycleForTest();
});

describe('email to a deleted workspace', () => {
  const INBOX = `inbox-archived-${RUN}`;
  let project: SeededProject;
  const run = (n: number, thread: string, type?: string) => {
    const event = emailMessageEvent(project.project_id, email(INBOX, n, thread, { type }));
    return event ? handleEmailEvent(event, { finalAttempt: true }) : Promise.resolve();
  };

  beforeAll(async () => {
    project = await seedProject('archived-email-reply', { metadata: { experimental: { email_channel: true } } });
    await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
    await addInbox(project, INBOX);
    // The workspace delete.
    await db.update(projects).set({ status: 'archived' }).where(eq(projects.projectId, project.project_id));
  }, 30_000);

  afterAll(async () => {
    await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, `%${INBOX}%`));
    await releaseEmailInbox(project.project_id, INBOX);
    await db.delete(connectorConnections).where(eq(connectorConnections.projectId, project.project_id));
    await db.delete(connectors).where(eq(connectors.projectId, project.project_id));
    await removeSeeded([project]);
  });

  test('the first email of a thread gets one reply, in the thread, with the inbox key', async () => {
    await run(1, 'a');

    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toEqual({
      url: expect.stringMatching(new RegExp(`/inboxes/${INBOX}/threads/${INBOX}-a/emails/eml-${INBOX}-1/reply$`)),
      method: 'POST',
      auth: 'Bearer re_project_key',
      body: { text: REPLY },
    });
    // The failed create freed the thread: the next email tries again at once.
    const claims = await db.select().from(chatEventDedup).where(like(chatEventDedup.eventId, `email:threadcreate:${INBOX}:%`));
    expect(claims).toHaveLength(0);
  });

  test('a later email in the same thread gets no second reply', async () => {
    await run(2, 'a');
    expect(replies()).toHaveLength(0);
  });

  test('a new thread gets its own reply', async () => {
    await run(3, 'b');
    expect(replies().map((c) => c.url)).toEqual([expect.stringContaining(`/emails/eml-${INBOX}-3/reply`)]);
  });

  test('an outbound email event is never stored or run', async () => {
    await run(4, 'c', 'inbox.email.sent');
    expect(calls).toHaveLength(0);
  });
});

describe('a received email: stored before the ack, then run', () => {
  const INBOX = `inbox-open-${RUN}`;
  const STRICT = `inbox-strict-${RUN}`;
  const GONE = `inbox-gone-${RUN}`;
  const READDED = `inbox-readded-${RUN}`;
  let project: SeededProject;
  const created: Array<Record<string, any>> = [];
  const delivered: Array<Record<string, any>> = [];
  /** Runs inside the next create, before it binds; a throw fails the create. */
  let duringCreate: ((input: Record<string, any>) => Promise<void>) | null = null;

  beforeAll(async () => {
    project = await seedProject('email-event-inbox', { metadata: { experimental: { email_channel: true } } });
    await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
    await addInbox(project, INBOX);
    await addInbox(project, STRICT, normalizeSenderPolicy({ mode: 'restricted', allowedEmails: ['approved@example.test'] }));
    await addInbox(project, GONE);
    setChannelLifecycleForTest({
      resolveProjectAutomationActor: async () => OWNER,
      createSession: (async (input: Record<string, any>) => {
        created.push(input);
        if (duringCreate) await duringCreate(input);
        const sessionId = crypto.randomUUID();
        await db.insert(projectSessions).values({
          sessionId,
          accountId: project.account_id,
          projectId: project.project_id,
          branchName: sessionId,
          createdBy: OWNER,
        });
        // The real post-create bind, which frees the thread's create claim.
        const bind = input.postCreate.filter((a: { type: string }) => a.type === 'bind_chat_thread');
        await applyPostCreateActions({ projectId: project.project_id, sessionId, actions: bind });
        return { status: 'created', sessionId };
      }) as never,
      deliverThroughQueue: (async (command: Record<string, any>) => {
        delivered.push(command);
        return 'queued';
      }) as never,
      sleep: async () => {},
    });
  }, 30_000);

  afterEach(() => {
    created.length = 0;
    delivered.length = 0;
    duringCreate = null;
  });

  afterAll(async () => {
    resetChannelLifecycleForTest();
    for (const inbox of [INBOX, STRICT, GONE, READDED]) {
      await db.delete(chatThreads).where(eq(chatThreads.workspaceId, inbox));
      await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, `%${inbox}%`));
      await db.delete(jobQueue).where(like(jobQueue.jobKey, `email:${inbox}:%`));
      await releaseEmailInbox(project.project_id, inbox);
    }
    await db.delete(projectSessions).where(eq(projectSessions.projectId, project.project_id));
    await db.delete(connectorConnections).where(eq(connectorConnections.projectId, project.project_id));
    await db.delete(connectors).where(eq(connectors.projectId, project.project_id));
    await removeSeeded([project]);
  });

  test('a signed email is stored once, acked, then run: one session bound to the thread, its claim freed', async () => {
    const event = email(INBOX, 1, 't1');
    const first = await deliver(event);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    // Resend sends it again: still one stored email.
    expect((await deliver(event)).status).toBe(200);
    const jobs = await jobsOf(INBOX);
    expect(jobs.map((j) => [j.jobKey, j.status])).toEqual([[`email:${INBOX}:eml-${INBOX}-1`, 'queued']]);
    expect(Object.keys((jobs[0]!.payload as { data: object }).data).sort()).toEqual(
      ['email_id', 'from', 'inbox_id', 'subject', 'thread_id', 'to'],
    );
    expect(bodyReads()).toHaveLength(0);

    expect(await runJobBatch()).toBe(1);
    expect((await jobsOf(INBOX)).map((j) => j.status)).toEqual(['done']);
    expect(bodyReads()).toHaveLength(1);
    expect(bodyReads()[0]!.auth).toBe('Bearer re_project_key');
    expect(created).toHaveLength(1);
    expect(created[0]!.idempotencyKey).toBe(`email:create:${INBOX}:${INBOX}-t1:eml-${INBOX}-1`);
    const [thread] = await db.select().from(chatThreads).where(and(eq(chatThreads.workspaceId, INBOX), eq(chatThreads.threadId, `${INBOX}-t1`)));
    expect(thread?.projectId).toBe(project.project_id);
    expect(await db.select().from(chatEventDedup).where(eq(chatEventDedup.eventId, `email:threadcreate:${INBOX}:${INBOX}-t1`))).toHaveLength(0);
  });

  test('a sender the inbox does not allow is acked as ignored and never stored', async () => {
    const stranger = await deliver(email(STRICT, 1, 's1'));
    expect(await stranger.json()).toEqual({ ok: true, ignored: true });
    expect(await jobsOf(STRICT)).toHaveLength(0);

    const allowed = await deliver(email(STRICT, 2, 's2', { from: 'Approved <approved@example.test>' }));
    expect(await allowed.json()).toEqual({ ok: true });
    expect(await jobsOf(STRICT)).toHaveLength(1);
    await runJobBatch();
    expect(created).toHaveLength(1);
  });

  test('a body read that fails is retried with backoff, then runs', async () => {
    await deliver(email(INBOX, 2, 't2'));
    failingGets.set(`eml-${INBOX}-2`, { status: 503, times: 1 });
    await runJobBatch();
    let [job] = await jobsOf(INBOX).then((jobs) => jobs.filter((j) => j.jobKey.endsWith('-2')));
    expect([job!.status, job!.attempts]).toEqual(['queued', 1]);
    expect(job!.lastError).toContain('Resend 503');
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(created).toHaveLength(0);

    await rewind(INBOX);
    await runJobBatch();
    [job] = await jobsOf(INBOX).then((jobs) => jobs.filter((j) => j.jobKey.endsWith('-2')));
    expect([job!.status, job!.attempts]).toEqual(['done', 2]);
    expect(created).toHaveLength(1);
  });

  test('a run whose replica died is claimed again and runs once', async () => {
    await deliver(email(INBOX, 3, 't3'));
    // A replica claims the email and dies before it settles.
    expect(await claimJobs([QUEUE], 1, 7 * 60_000)).toHaveLength(1);
    expect(await runJobBatch()).toBe(0);

    await rewind(INBOX);
    expect(await runJobBatch()).toBe(1);
    expect(created).toHaveLength(1);
    expect((await jobsOf(INBOX)).filter((j) => j.jobKey.endsWith('-3')).map((j) => j.status)).toEqual(['done']);
  });

  test('a retry of an email whose create the lifecycle took routes nothing twice', async () => {
    const event = email(INBOX, 4, 't4');
    await deliver(event);
    // The lifecycle wrote its create row and bound the thread; then a write threw.
    duringCreate = async (input) => {
      duringCreate = null;
      await db.insert(sessionLifecycleCommands).values({
        commandType: 'create_session',
        source: 'email',
        status: 'running',
        projectId: project.project_id,
        accountId: project.account_id,
        idempotencyKey: input.idempotencyKey,
      });
      const sessionId = crypto.randomUUID();
      await db.insert(projectSessions).values({ sessionId, accountId: project.account_id, projectId: project.project_id, branchName: sessionId, createdBy: OWNER });
      await applyPostCreateActions({ projectId: project.project_id, sessionId, actions: input.postCreate.slice(0, 1) });
      throw new Error('a write after the bind failed');
    };
    await runJobBatch();
    expect((await jobsOf(INBOX)).filter((j) => j.jobKey.endsWith('-4')).map((j) => [j.status, j.attempts])).toEqual([['queued', 1]]);

    await rewind(INBOX);
    await runJobBatch();
    expect((await jobsOf(INBOX)).filter((j) => j.jobKey.endsWith('-4')).map((j) => j.status)).toEqual(['done']);
    expect(created).toHaveLength(1);
    expect(delivered).toHaveLength(0);
  });

  test('an email whose body never reads is dead after its last attempt, with the reason', async () => {
    await deliver(email(INBOX, 5, 't5'));
    await db.update(jobQueue).set({ maxAttempts: 2 }).where(eq(jobQueue.jobKey, `email:${INBOX}:eml-${INBOX}-5`));
    failingGets.set(`eml-${INBOX}-5`, { status: 503, times: 99 });
    await runJobBatch();
    await rewind(INBOX);
    await runJobBatch();
    const [job] = (await jobsOf(INBOX)).filter((j) => j.jobKey.endsWith('-5'));
    expect([job!.status, job!.attempts]).toEqual(['dead', 2]);
    expect(job!.lastError).toContain('Resend 503');
    expect(created).toHaveLength(0);
  });

  test('an inbox removed after the ack drops its stored email without reading it', async () => {
    await deliver(email(GONE, 1, 'g1'));
    expect(await jobsOf(GONE)).toHaveLength(1);
    await revokeEmailInboxAccount((await loadEmailInboxAccountForInbox(project.project_id, GONE))!);
    calls = [];

    await runJobBatch();
    expect((await jobsOf(GONE)).map((j) => j.status)).toEqual(['done']);
    expect(bodyReads()).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  /** A session of `projectId` whose thread `thread` of `inbox` is bound to it. */
  async function threadWithSession(projectId: string, inbox: string, thread: string) {
    const sessionId = crypto.randomUUID();
    await db.insert(projectSessions).values({ sessionId, accountId: project.account_id, projectId, branchName: sessionId, createdBy: OWNER });
    await db.insert(chatThreads).values({ projectId, platform: 'email', workspaceId: inbox, threadId: `${inbox}-${thread}`, sessionId });
    return sessionId;
  }
  /** A second project of the suite's account; `removeSeeded` would delete the account too. */
  async function dropProject(projectId: string) {
    await db.delete(chatThreads).where(eq(chatThreads.projectId, projectId));
    await db.delete(projectSessions).where(eq(projectSessions.projectId, projectId));
    await db.delete(projects).where(eq(projects.projectId, projectId));
  }
  const threadOf = async (inbox: string, thread: string) =>
    (await db.select().from(chatThreads).where(and(eq(chatThreads.workspaceId, inbox), eq(chatThreads.threadId, `${inbox}-${thread}`))))[0];
  const runEmail = (inbox: string, n: number, thread: string) =>
    handleEmailEvent(emailMessageEvent(project.project_id, email(inbox, n, thread))!, { finalAttempt: true });

  test('mail in a thread of an inbox that moved here starts the thread over here', async () => {
    const from = await seedProject('email-moved-from', { accountId: project.account_id });
    try {
      const old = await threadWithSession(from.project_id, INBOX, 'm1');
      await runEmail(INBOX, 11, 'm1');
      expect(delivered).toHaveLength(0);
      expect(created).toHaveLength(1);
      expect(created[0]!.postCreate[1].text).toStartWith('NOTE: This email thread had an earlier conversation');
      const thread = await threadOf(INBOX, 'm1');
      expect(thread?.projectId).toBe(project.project_id);
      expect(thread?.sessionId).not.toBe(old);
    } finally {
      await dropProject(from.project_id);
    }
  });

  test('while the old project still holds the inbox, the email is refused and its thread kept', async () => {
    const from = await seedProject('email-held-by-two', { accountId: project.account_id });
    try {
      const old = await threadWithSession(from.project_id, INBOX, 'm2');
      await reserveEmailInbox({ projectId: from.project_id, inboxId: INBOX, email: 'inbox@example.test', agentName: null });
      await runEmail(INBOX, 12, 'm2');
      expect(created).toHaveLength(0);
      expect(delivered).toHaveLength(0);
      expect((await threadOf(INBOX, 'm2'))?.sessionId).toBe(old);
    } finally {
      await releaseEmailInbox(from.project_id, INBOX);
      await dropProject(from.project_id);
    }
  });

  test('mail in a thread of an inbox removed and added again starts over, on the new account', async () => {
    await addInbox(project, READDED);
    const first = (await loadEmailInboxAccountForInbox(project.project_id, READDED))!;
    const old = await threadWithSession(project.project_id, READDED, 'r1');
    await db.insert(projectSessionConnectorBindings).values({
      sessionId: old,
      accountId: project.account_id,
      projectId: project.project_id,
      connectorAlias: 'kortix_email',
      connectorId: first.connectorId,
      connectionId: first.connectionId,
      source: 'default',
      createdBy: null,
    });
    await revokeEmailInboxAccount(first);
    await addInbox(project, READDED);

    await runEmail(READDED, 1, 'r1');
    expect(delivered).toHaveLength(0);
    expect(created).toHaveLength(1);
    expect(created[0]!.postCreate[1].text).toStartWith('NOTE: This email thread had an earlier conversation');
    const second = (await loadEmailInboxAccountForInbox(project.project_id, READDED))!;
    expect(second.connectionId).not.toBe(first.connectionId);
    expect(created[0]!.body.connector_bindings).toEqual({ email: { connection_id: second.connectionId } });
    expect((await threadOf(READDED, 'r1'))?.sessionId).not.toBe(old);
  });
});

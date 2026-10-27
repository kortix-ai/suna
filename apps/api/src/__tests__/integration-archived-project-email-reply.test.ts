/**
 * Integration test (real local DB): email to a deleted workspace's inbox gets
 * an answer (KRTX-1714). The delete keeps the Resend inbox until the purge,
 * so mail still arrives, and no session can start (`project_archived`). The
 * sender heard nothing. Only Resend's HTTP API is stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, chatEventDedup, connectorConnections, connectors, projects } from '@kortix/db';
import { eq, like } from 'drizzle-orm';
import { insertEmailInboxAccount, normalizeSenderPolicy, releaseEmailInbox, reserveEmailInbox } from '../channels/install-store';
import { dispatchResendEmailEvent } from '../channels/email/session';
import type { ResendInboxEmailReceivedEvent } from '../channels/email/types';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const INBOX = `inbox-${crypto.randomUUID()}`;
const REPLY = 'This address is not accepting email right now. No one will answer this message.';

let project: SeededProject;
let calls: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
const originalFetch = globalThis.fetch;

function email(n: number, thread: string, type = 'inbox.email.received'): ResendInboxEmailReceivedEvent {
  return {
    type,
    data: {
      inbox_id: INBOX,
      thread_id: `${INBOX}-${thread}`,
      email_id: `eml-${INBOX}-${n}`,
      from: 'Sender <sender@example.test>',
      to: ['inbox@example.test'],
      subject: 'A question',
    },
  };
}

const replies = () => calls.filter((c) => c.method === 'POST');
const threadCreateClaims = () =>
  db.select().from(chatEventDedup).where(like(chatEventDedup.eventId, `email:threadcreate:${INBOX}:%`));

beforeAll(async () => {
  project = await seedProject('archived-email-reply');
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
  // What POST /channels/email/inboxes leaves behind, minus the Resend calls:
  // the inbox claim and the inbox's account on `kortix_email`.
  const scope = { accountId: project.account_id, projectId: project.project_id };
  const [connector] = await db
    .insert(connectors)
    .values({ ...scope, slug: 'kortix_email', name: 'Email', providerType: 'channel', config: { platform: 'email' } })
    .returning({ connectorId: connectors.connectorId });
  await reserveEmailInbox({ projectId: project.project_id, inboxId: INBOX, email: 'inbox@example.test', agentName: null });
  await insertEmailInboxAccount({
    ...scope,
    connectorId: connector!.connectorId,
    ownerType: 'project',
    ownerId: null,
    inboxId: INBOX,
    email: 'inbox@example.test',
    displayName: 'Inbox',
    senderPolicy: normalizeSenderPolicy(null),
    agentName: null,
    managed: false,
    createdByKortix: true,
    webhookId: null,
    apiKey: 're_project_key',
    webhookSecret: null,
    createdBy: null,
  });
  // The workspace delete.
  await db.update(projects).set({ status: 'archived' }).where(eq(projects.projectId, project.project_id));

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes('api.resend.com')) return originalFetch(input, init);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
    // Retrieve Thread Email answers the body; the reply answers its id.
    const answer =
      method === 'GET'
        ? { id: 'eml', from: 'Sender <sender@example.test>', to: ['inbox@example.test'], subject: 'A question', text: 'Hello?' }
        : { id: 'reply-1' };
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
}, 30_000);

afterEach(() => {
  calls = [];
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (!project) return;
  await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, `%${INBOX}%`));
  await releaseEmailInbox(project.project_id, INBOX);
  await db.delete(connectorConnections).where(eq(connectorConnections.projectId, project.project_id));
  await db.delete(connectors).where(eq(connectors.projectId, project.project_id));
  await removeSeeded([project]);
});

describe('email to a deleted workspace', () => {
  test('the first email of a thread gets one reply, in the thread, with the inbox key', async () => {
    await dispatchResendEmailEvent(email(1, 'a'));

    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toEqual({
      url: expect.stringMatching(new RegExp(`/inboxes/${INBOX}/threads/${INBOX}-a/emails/eml-${INBOX}-1/reply$`)),
      method: 'POST',
      auth: 'Bearer re_project_key',
      body: { text: REPLY },
    });
    // The failed create freed the thread: the next email tries again at once.
    expect(await threadCreateClaims()).toHaveLength(0);
  });

  test('a later email in the same thread gets no second reply', async () => {
    await dispatchResendEmailEvent(email(2, 'a'));
    expect(replies()).toHaveLength(0);
  });

  test('a new thread gets its own reply', async () => {
    await dispatchResendEmailEvent(email(3, 'b'));
    expect(replies().map((c) => c.url)).toEqual([expect.stringContaining(`/emails/eml-${INBOX}-3/reply`)]);
  });

  test('an outbound email event gets no reply', async () => {
    await dispatchResendEmailEvent(email(4, 'c', 'inbox.email.sent'));
    expect(calls).toHaveLength(0);
  });
});

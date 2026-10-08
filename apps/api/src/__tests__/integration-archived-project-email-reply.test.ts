/**
 * Integration test (real local DB): email to a deleted workspace's inbox gets
 * an answer (KRTX-1714). The delete keeps the AgentMail inbox until the purge,
 * so mail still arrives, and no session can start (`project_archived`). The
 * sender heard nothing. Only AgentMail's HTTP API is stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, chatEventDedup, projects } from '@kortix/db';
import { eq, like } from 'drizzle-orm';
import { deleteAgentMailInstall, saveAgentMailInstall } from '../channels/install-store';
import { dispatchAgentMailEvent } from '../channels/email/session';
import type { AgentMailMessageReceivedEvent } from '../channels/email/types';
import { reconcileChannelConnectors } from '../connectors/sync';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const INBOX = `inbox-${crypto.randomUUID()}`;
const REPLY = 'This address is not accepting email right now. No one will answer this message.';

let project: SeededProject;
let calls: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
const originalFetch = globalThis.fetch;

function email(
  n: number,
  thread: string,
  eventType: AgentMailMessageReceivedEvent['event_type'] = 'message.received',
): AgentMailMessageReceivedEvent {
  return {
    type: 'event',
    event_type: eventType,
    event_id: `evt-${INBOX}-${n}`,
    message: {
      inbox_id: INBOX,
      thread_id: `${INBOX}-${thread}`,
      message_id: `msg-${INBOX}-${n}`,
      from: 'Sender <sender@example.test>',
      to: ['inbox@example.test'],
      subject: 'A question',
      text: 'Hello?',
    },
  };
}

/** Five minutes later: the thread-create claim of the first message expired. */
async function expireThreadCreateClaims() {
  await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, `email:threadcreate:${INBOX}:%`));
}

beforeAll(async () => {
  project = await seedProject('archived-email-reply');
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
  // What POST /channels/email/connect stores, minus the AgentMail calls.
  await saveAgentMailInstall({
    projectId: project.project_id,
    connectionSlug: 'kortix_email',
    inboxId: INBOX,
    email: 'inbox@example.test',
    displayName: 'Inbox',
    apiKey: 'agentmail-project-key',
  });
  await reconcileChannelConnectors(project.project_id);
  // The workspace delete.
  await db.update(projects).set({ status: 'archived' }).where(eq(projects.projectId, project.project_id));

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes('agentmail')) return originalFetch(input, init);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      auth: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({ message_id: 'reply-1', thread_id: 'thread' }), { status: 200 });
  }) as typeof fetch;
}, 30_000);

afterEach(() => {
  calls = [];
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (!project) return;
  await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, `%${INBOX}%`));
  await deleteAgentMailInstall(project.project_id, 'kortix_email');
  await removeSeeded([project]);
});

describe('email to a deleted workspace', () => {
  test('the first email of a thread gets one reply, in the thread, with the inbox key', async () => {
    await dispatchAgentMailEvent(email(1, 'a'));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      url: expect.stringMatching(new RegExp(`/inboxes/${INBOX}/messages/msg-${INBOX}-1/reply$`)),
      method: 'POST',
      auth: 'Bearer agentmail-project-key',
      body: { text: REPLY },
    });
  });

  test('a later email in the same thread gets no second reply', async () => {
    await expireThreadCreateClaims();
    await dispatchAgentMailEvent(email(2, 'a'));
    expect(calls).toHaveLength(0);
  });

  test('a new thread gets its own reply', async () => {
    await dispatchAgentMailEvent(email(3, 'b'));
    expect(calls.map((c) => c.url)).toEqual([expect.stringContaining(`/messages/msg-${INBOX}-3/reply`)]);
  });

  test('an unauthenticated email gets no reply: its From may be forged', async () => {
    await dispatchAgentMailEvent(email(4, 'c', 'message.received.unauthenticated'));
    expect(calls).toHaveLength(0);
  });
});

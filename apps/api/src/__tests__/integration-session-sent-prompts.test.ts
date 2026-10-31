/**
 * Integration test (real PostgreSQL, real routes): `GET .../prompts` `sent`, the prompts a
 * runtime accepted that the session log does not hold yet (`listSentPrompts`).
 *
 * A consumed inbox row left `prompts` at delivery, and the log holds a prompt only after the
 * box journals it; a client that missed the live frame drew the session without the user's
 * message until the turn ended. A session create's `initial_prompt` was in neither place.
 * `sent` lists both under the id the log will hold them, until the log holds that id.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fromV1, type SessionLogJournalRequest, type V1Row } from '@kortix/api-contract/session-log';
import { accountMembers, projectSessions, sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { ingestSessionLogJournal } = await import('../projects/session-log-ingest');

const OWNER = crypto.randomUUID();
const ROOT = 'ses_sentpromptsroot0000001';
const REV = 1_791_681_474_704_000;
const INITIAL_ID = 'msg_00000000000aInitialPrompt01';
const SENT_ID = 'msg_00000000000bAcceptedPrompt1';

let project: SeededProject;
let session = '';
let token = '';

const sent = async () => {
  const res = await app.request(`/v1/projects/${project.project_id}/sessions/${session}/prompts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { prompts: unknown[]; sent: Array<{ message_id: string; prompt_id: string | null; text: string; attachments: unknown[] }> };
  return body;
};

/** The box journals one user message per id, as pi does at a turn end. */
async function journal(ids: string[], tombstones: string[] = []) {
  const created = Date.now();
  const rows = ids.map((id, i) => ({
    runtime_session_id: ROOT,
    info: { id, sessionID: ROOT, role: 'user', time: { created: created + i } },
    parts: [{ id: `${id}-p`, sessionID: ROOT, messageID: id, type: 'text', text: `text of ${id}` }],
  }));
  const log = fromV1({ session_id: session, root_id: ROOT, rows: rows as unknown as V1Row[] }, { harness: 'pi' });
  const producer = { harness: 'pi', harness_version: '1.4.0', adapter_version: '1.0.0' };
  const { threads, ...patch } = log;
  const batch: SessionLogJournalRequest = {
    generation: 0,
    session: patch,
    threads: threads.map(({ messages: _m, ...t }) => t),
    puts: threads.flatMap((t) => t.messages.map((m, i) => ({ rev: REV + i, message: { ...m, producer } }))),
    tombstones: tombstones.map((message_id) => ({ message_id, rev: REV + 100 })),
  };
  const outcome = await ingestSessionLogJournal({ sessionId: session, projectId: project.project_id, accountId: project.account_id }, batch);
  expect(outcome.status).toBe(200);
}

beforeAll(async () => {
  project = await seedProject('session-sent-prompts');
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: project.account_id, accountRole: 'owner' });
  session = await seedSession(project, OWNER);
  token = (await createAccountToken({ accountId: project.account_id, userId: OWNER, name: 'session-sent-prompts' })).secretKey;
  // A create with `initial_prompt`: the text on the session, the id on the turn the box claims.
  await db
    .update(projectSessions)
    .set({ metadata: { initial_prompt: 'first words', first_prompt: 'first words' } })
    .where(eq(projectSessions.sessionId, session));
  await db.insert(sessionSandboxes).values({
    sandboxId: session,
    sessionId: session,
    accountId: project.account_id,
    projectId: project.project_id,
    status: 'provisioning',
    config: {},
    metadata: { activeTurns: { 'turn-initial': { token: 'turn-initial', state: 'delivering', messageId: INITIAL_ID, startedAtMs: Date.now() } } },
  });
});

afterAll(async () => {
  await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.sessionId, session));
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.accountId, project.account_id));
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${project.account_id}`);
  await removeSeeded([project]);
});

describe('GET .../prompts sent', () => {
  test('a booting session lists its initial_prompt under the id the box will claim', async () => {
    const body = await sent();
    expect(body.prompts).toEqual([]);
    expect(body.sent.map((p) => [p.message_id, p.prompt_id, p.text])).toEqual([[INITIAL_ID, null, 'first words']]);
  });

  test('a consumed inbox row stays listed, with its files, until the log holds its id; then both leave', async () => {
    await db.insert(sessionLifecycleCommands).values({
      commandType: 'continue_session',
      source: 'user',
      status: 'succeeded',
      projectId: project.project_id,
      sessionId: session,
      accountId: project.account_id,
      actorUserId: OWNER,
      idempotencyKey: `prompt:${session}:client-1`,
      payload: {
        clientMessageId: 'client-1',
        wireMessageId: 'msg_00000000000cClientMinted01',
        text: 'second words',
        parts: [{ type: 'text', text: 'second words' }, { type: 'file', filename: 'plan.pdf', mime: 'application/pdf', url: 'data:,' }],
      },
      result: { status: 'delivered', forwarded_message_id: SENT_ID },
    });
    const before = await sent();
    expect(before.prompts).toEqual([]);
    expect(before.sent.map((p) => [p.message_id, p.text])).toEqual([
      [INITIAL_ID, 'first words'],
      [SENT_ID, 'second words'],
    ]);
    expect(before.sent[1]!.attachments).toEqual([{ filename: 'plan.pdf', mime: 'application/pdf' }]);
    // The id the client drew it under, so a client pairs its optimistic copy with the log's.
    expect((before.sent[1] as { wire_message_id?: string | null }).wire_message_id).toBe('msg_00000000000cClientMinted01');
    expect((before.sent[0] as { wire_message_id?: string | null }).wire_message_id).toBeNull();

    await journal([INITIAL_ID]);
    expect((await sent()).sent.map((p) => p.message_id)).toEqual([SENT_ID]);

    // A tombstone counts as held: a prompt the user rewound away does not come back.
    await journal([INITIAL_ID, SENT_ID], [SENT_ID]);
    expect((await sent()).sent).toEqual([]);
  });
});

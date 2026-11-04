/**
 * Integration test (real local DB, real routes): `POST /spaces/:spaceId/posts`,
 * an agent posting into a space for the person its session works for.
 *
 * - A thread of #eng posts a top-level message into #eng: a new thread whose
 *   top message is the agent's (`chat_root_text`, `chat_root_author`), and a
 *   mentioned member gets one `question` notification that opens it.
 * - A post into an existing thread is a cross-session message delivered
 *   `noReply` (no turn of that thread's agent), or as a prompt with `ask`.
 * - Refused: a person's token (403 `session_only`), a private channel the
 *   session cannot see (404), another person's DM (404), the person's own DM
 *   from a session other members may prompt (403 `not_the_persons_chat`), a
 *   thread of another space (404).
 * - A mention of someone who may not see the space notifies nobody; a name
 *   that is no project member is no mention.
 *
 * Faked: `createSession` (it clones the project repo and provisions a box).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { accountMembers, accounts, notifications, projectMembers, projectSessions, projectSpaceMembers, projectSpaces, projects, sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const realLifecycle = await import('../projects/session-lifecycle');
mock.module('../projects/session-lifecycle', () => ({
  ...realLifecycle,
  createSession: async (input: { project: { projectId: string; accountId: string }; userId: string; body: { agent_name: string; space_id: string }; metadata: Record<string, unknown>; visibility: 'private' | 'project' }) => {
    const sessionId = crypto.randomUUID();
    await db.insert(projectSessions).values({
      sessionId,
      accountId: input.project.accountId,
      projectId: input.project.projectId,
      branchName: sessionId,
      agentName: input.body.agent_name,
      createdBy: input.userId,
      spaceId: input.body.space_id,
      visibility: input.visibility,
      metadata: input.metadata,
    });
    return { sessionId };
  },
}));
const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const PRIYA = crypto.randomUUID();
const SAM = crypto.randomUUID();
const ENG = crypto.randomUUID();
const SECRET = crypto.randomUUID();
const OPS = crypto.randomUUID();
const PRIYA_DM = crypto.randomUUID();
const SAM_DM = crypto.randomUUID();
/** Priya's thread in #eng (project-visible): it posts. */
const PRIYA_ENG = crypto.randomUUID();
/** Sam's thread in #eng: a post goes into it. */
const SAM_ENG = crypto.randomUUID();
/** Priya's thread in the private #secret (Sam is not a member). */
const PRIYA_SECRET = crypto.randomUUID();
/** A thread of #ops. */
const OPS_THREAD = crypto.randomUUID();
/** Priya's private session in no space. */
const PRIYA_NO_SPACE = crypto.randomUUID();
const USERS = [PRIYA, SAM] as const;
const minted: string[] = [];
const keys: Record<string, string> = {};
const email = (id: string) => `${id.slice(0, 8)}@example.test`;

async function mint(userId: string, sessionId?: string): Promise<string> {
  const t = await createAccountToken({ accountId: ACCOUNT, userId, projectId: PROJECT, name: 'space-posts-test', agentGrant: null as any, ...(sessionId ? { sessionId } : {}) });
  minted.push(t.tokenId);
  return t.secretKey;
}

async function post(secret: string, spaceId: string, body: Record<string, unknown>) {
  const res = await app.request(`/v1/projects/${PROJECT}/spaces/${spaceId}/posts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const notificationsFor = (userId: string, sessionId: string) =>
  db.select({ kind: notifications.kind, title: notifications.title }).from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.sessionId, sessionId)));

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'space-posts' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'Posts', repoUrl: 'https://example.test/p.git', metadata: { experimental: { chat: true } } });
  for (const id of USERS) {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
      values (${id}::uuid, ${email(id)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{}'::jsonb)`);
  }
  await insertIntoView(db, accountMembers, USERS.map((userId) => ({ userId, accountId: ACCOUNT, accountRole: 'member' as const, isSuperAdmin: false })));
  await insertIntoView(db, projectMembers, USERS.map((userId) => ({ accountId: ACCOUNT, projectId: PROJECT, userId, projectRole: 'member' as const })));
  await db.insert(projectSpaces).values([
    { spaceId: ENG, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: `eng-${ENG.slice(0, 6)}`, name: 'eng', createdBy: PRIYA },
    { spaceId: SECRET, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: `secret-${SECRET.slice(0, 6)}`, name: 'secret', createdBy: PRIYA, visibility: 'private' },
    { spaceId: OPS, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: `ops-${OPS.slice(0, 6)}`, name: 'ops', createdBy: SAM },
    { spaceId: PRIYA_DM, accountId: ACCOUNT, projectId: PROJECT, kind: 'dm', name: 'mykortix', dmUserId: PRIYA, dmAgentName: 'mykortix', createdBy: PRIYA },
    { spaceId: SAM_DM, accountId: ACCOUNT, projectId: PROJECT, kind: 'dm', name: 'mykortix', dmUserId: SAM, dmAgentName: 'mykortix', createdBy: SAM },
  ]);
  await db.insert(projectSpaceMembers).values([
    { spaceId: ENG, userId: PRIYA, addedBy: PRIYA },
    { spaceId: ENG, userId: SAM, addedBy: PRIYA },
    { spaceId: SECRET, userId: PRIYA, addedBy: PRIYA },
    { spaceId: OPS, userId: SAM, addedBy: SAM },
  ]);
  const base = { accountId: ACCOUNT, projectId: PROJECT, agentName: 'researcher', metadata: {} } as const;
  const thread = (sessionId: string, createdBy: string, spaceId: string | null, visibility: 'project' | 'private') => ({ ...base, sessionId, branchName: sessionId, createdBy, spaceId, visibility });
  await db.insert(projectSessions).values([
    thread(PRIYA_ENG, PRIYA, ENG, 'project'),
    thread(SAM_ENG, SAM, ENG, 'project'),
    thread(PRIYA_SECRET, PRIYA, SECRET, 'project'),
    thread(OPS_THREAD, SAM, OPS, 'project'),
    thread(PRIYA_NO_SPACE, PRIYA, null, 'private'),
  ]);
  await db.insert(sessionSandboxes).values(
    [PRIYA_ENG, PRIYA_SECRET, PRIYA_NO_SPACE].map((sessionId) => ({
      sandboxId: crypto.randomUUID(), sessionId, accountId: ACCOUNT, projectId: PROJECT, externalId: `sp-${sessionId.slice(0, 8)}`, status: 'active' as const,
    })),
  );
  keys.priya = await mint(PRIYA);
  keys.priyaEng = await mint(PRIYA, PRIYA_ENG);
  keys.priyaSecret = await mint(PRIYA, PRIYA_SECRET);
  keys.priyaNoSpace = await mint(PRIYA, PRIYA_NO_SPACE);
});

afterAll(async () => {
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  for (const id of USERS) await db.execute(sql`delete from auth.users where id = ${id}::uuid`);
});

describe('an agent posts into a space for its person', () => {
  test('a top-level post in #eng: a new thread with the agent’s message, and the mentioned member is notified once', async () => {
    const samToken = email(SAM).split('@')[0];
    const res = await post(keys.priyaEng!, ENG, { text: `The weather check is done. @${samToken}, the report is in Files.` });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'thread', notified: [SAM], mentions: [{ token: samToken, kind: 'person' }] });
    const [row] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, res.body.session_id));
    expect(row).toMatchObject({ spaceId: ENG, createdBy: PRIYA, visibility: 'project', agentName: 'mykortix' });
    expect(row!.metadata).toMatchObject({ chat_root_text: expect.stringContaining('weather check is done'), chat_root_author: 'researcher' });
    const rows = await notificationsFor(SAM, res.body.session_id);
    expect(rows).toEqual([{ kind: 'question', title: 'researcher mentioned you in #' + `eng-${ENG.slice(0, 6)}` }]);
  });

  test('a post into an existing thread is a message there; without ask no turn runs, with ask the thread’s agent answers', async () => {
    const quiet = await post(keys.priyaEng!, ENG, { text: 'FYI: the draft is in Files.', thread_id: SAM_ENG });
    expect(quiet.status).toBe(201);
    expect(quiet.body).toMatchObject({ kind: 'reply', session_id: SAM_ENG });
    const asked = await post(keys.priyaEng!, ENG, { text: 'Can you review the draft?', thread_id: SAM_ENG, ask: true });
    expect(asked.status).toBe(201);
    const rows = await db.select({ payload: sessionLifecycleCommands.payload }).from(sessionLifecycleCommands)
      .where(and(eq(sessionLifecycleCommands.sessionId, SAM_ENG), sql`${sessionLifecycleCommands.idempotencyKey} like 'peer:%'`));
    const byText = (needle: string) => rows.find((r) => String((r.payload as any).text).includes(needle))!.payload as any;
    expect(byText('FYI: the draft').noReply).toBe(true);
    expect(byText('Can you review').noReply).toBeUndefined();
  });

  test('refused: a person’s own token, a private channel the session cannot see, another person’s DM, a thread of another space', async () => {
    expect((await post(keys.priya!, ENG, { text: 'hi' })).body.code).toBe('session_only');
    const secret = await post(keys.priyaEng!, SECRET, { text: 'hi' });
    expect([secret.status, secret.body.code]).toEqual([404, 'space_not_found']);
    const otherDm = await post(keys.priyaNoSpace!, SAM_DM, { text: 'hi' });
    expect([otherDm.status, otherDm.body.code]).toEqual([404, 'space_not_found']);
    const elsewhere = await post(keys.priyaEng!, ENG, { text: 'hi', thread_id: OPS_THREAD });
    expect([elsewhere.status, elsewhere.body.code]).toEqual([404, 'thread_not_found']);
  });

  test('the person’s own DM: only from a private session that works only for them', async () => {
    const shared = await post(keys.priyaEng!, PRIYA_DM, { text: 'from a channel thread' });
    expect([shared.status, shared.body.code]).toEqual([403, 'not_the_persons_chat']);
    const own = await post(keys.priyaNoSpace!, PRIYA_DM, { text: 'Your nightly report is ready.' });
    expect(own.status).toBe(201);
    const [row] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, own.body.session_id));
    expect(row).toMatchObject({ spaceId: PRIYA_DM, createdBy: PRIYA, visibility: 'private' });
  });

  test('a mention of someone who may not see the space notifies nobody; a non-member name is no mention', async () => {
    const samToken = email(SAM).split('@')[0];
    const res = await post(keys.priyaSecret!, SECRET, { text: `@${samToken} and @nobody-here, look at this.` });
    expect(res.status).toBe(201);
    // Sam is not in #secret: no mention, no notification.
    expect(res.body.notified).toEqual([]);
    expect(res.body.mentions).toEqual([]);
    expect(await notificationsFor(SAM, res.body.session_id)).toEqual([]);
  });
});

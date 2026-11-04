/**
 * Integration test (real local DB, real routes): the chat (flag `chat`)
 * keeps one person's private chat and private threads to that person.
 *
 * - `POST /chat/threads` (Kortix starts a thread in the person's chat): a
 *   session whose prompts may come from other members (a channel thread, a
 *   shared DM session) gets 403 `not_the_persons_chat` and writes nothing. A
 *   private session in the person's own DM, or in no space, still posts.
 * - The thread board (`chatThreadBoardTurn`) lists only threads both the
 *   thread's person and the prompter may open: a private thread of another
 *   member in the same channel is never on it.
 *
 * Faked: `createSession` (it clones the project repo and provisions a box).
 * The fake records what the route asked for and writes the row, so the read
 * back proves the person and space of the new thread.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { accountMembers, accounts, projectMembers, projectSessions, projectSpaceMembers, projectSpaces, projects, sessionSandboxes } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const realLifecycle = await import('../projects/session-lifecycle');
mock.module('../projects/session-lifecycle', () => ({
  ...realLifecycle,
  createSession: async (input: { project: { projectId: string; accountId: string }; userId: string; body: { agent_name: string; space_id: string }; metadata: Record<string, unknown>; visibility: 'private' }) => {
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
const { chatThreadBoardTurn } = await import('../projects/lib/chat-threads');
const { createAccountToken } = await import('../repositories/account-tokens');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const PRIYA = crypto.randomUUID();
const SAM = crypto.randomUUID();
const ENG = crypto.randomUUID();
const PRIYA_DM = crypto.randomUUID();
/** Priya's thread in #eng: project-visible, so Sam may prompt it. */
const PRIYA_ENG = crypto.randomUUID();
/** Priya's private thread in #eng. */
const PRIYA_ENG_PRIVATE = crypto.randomUUID();
/** Sam's private thread in #eng. */
const SAM_ENG_PRIVATE = crypto.randomUUID();
/** Sam's project-visible thread in #eng. */
const SAM_ENG_SHARED = crypto.randomUUID();
/** Priya's private thread in her DM with My Kortix. */
const PRIYA_DM_THREAD = crypto.randomUUID();
/** Priya's DM thread, shared with the project. */
const PRIYA_DM_SHARED = crypto.randomUUID();
/** Priya's private session in no space. */
const PRIYA_NO_SPACE = crypto.randomUUID();
const USERS = [PRIYA, SAM] as const;
const minted: string[] = [];
const keys: Record<string, string> = {};

async function mint(userId: string, sessionId: string): Promise<string> {
  const t = await createAccountToken({
    accountId: ACCOUNT,
    userId,
    projectId: PROJECT,
    name: 'chat-threads-test',
    agentGrant: null as any,
    sessionId,
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

async function post(secret: string, text: string) {
  const res = await app.request(`/v1/projects/${PROJECT}/chat/threads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Sessions Kortix started (`chat_root_text`) with this text. */
async function postedWith(text: string) {
  return db
    .select({ sessionId: projectSessions.sessionId, spaceId: projectSessions.spaceId, createdBy: projectSessions.createdBy })
    .from(projectSessions)
    .where(and(eq(projectSessions.projectId, PROJECT), sql`${projectSessions.metadata}->>'chat_root_text' = ${text}`));
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'chat-threads' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'Chat threads',
    repoUrl: 'https://example.test/c.git',
    metadata: { experimental: { chat: true } },
  });
  for (const id of USERS) {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
      values (${id}::uuid, ${`${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{}'::jsonb)`);
  }
  await insertIntoView(
    db,
    accountMembers,
    USERS.map((userId) => ({ userId, accountId: ACCOUNT, accountRole: 'member' as const, isSuperAdmin: false })),
  );
  await insertIntoView(
    db,
    projectMembers,
    USERS.map((userId) => ({ accountId: ACCOUNT, projectId: PROJECT, userId, projectRole: 'member' as const })),
  );
  await db.insert(projectSpaces).values([
    { spaceId: ENG, accountId: ACCOUNT, projectId: PROJECT, kind: 'channel', slug: `eng-${ENG.slice(0, 6)}`, name: 'eng', createdBy: PRIYA },
    { spaceId: PRIYA_DM, accountId: ACCOUNT, projectId: PROJECT, kind: 'dm', name: 'mykortix', dmUserId: PRIYA, dmAgentName: 'mykortix', createdBy: PRIYA },
  ]);
  await db.insert(projectSpaceMembers).values([
    { spaceId: ENG, userId: PRIYA, addedBy: PRIYA },
    { spaceId: ENG, userId: SAM, addedBy: PRIYA },
  ]);
  const base = { accountId: ACCOUNT, projectId: PROJECT, agentName: 'mykortix' } as const;
  const thread = (sessionId: string, createdBy: string, spaceId: string | null, visibility: 'project' | 'private', name: string) => ({
    ...base,
    sessionId,
    branchName: sessionId,
    createdBy,
    spaceId,
    visibility,
    metadata: { name },
  });
  await db.insert(projectSessions).values([
    thread(PRIYA_ENG, PRIYA, ENG, 'project', 'Priya launch plan'),
    thread(PRIYA_ENG_PRIVATE, PRIYA, ENG, 'private', 'Priya private notes'),
    thread(SAM_ENG_PRIVATE, SAM, ENG, 'private', 'Sam salary review'),
    thread(SAM_ENG_SHARED, SAM, ENG, 'project', 'Sam deploy checklist'),
    thread(PRIYA_DM_THREAD, PRIYA, PRIYA_DM, 'private', 'Priya DM thread'),
    thread(PRIYA_DM_SHARED, PRIYA, PRIYA_DM, 'project', 'Priya shared DM thread'),
    thread(PRIYA_NO_SPACE, PRIYA, null, 'private', 'Priya no-space session'),
  ]);
  // A session credential is valid only while its sandbox is live.
  const live = [PRIYA_ENG, PRIYA_DM_THREAD, PRIYA_DM_SHARED, PRIYA_NO_SPACE];
  await db.insert(sessionSandboxes).values(
    live.map((sessionId) => ({
      sandboxId: crypto.randomUUID(),
      sessionId,
      accountId: ACCOUNT,
      projectId: PROJECT,
      externalId: `ct-${sessionId.slice(0, 8)}`,
      status: 'active' as const,
    })),
  );
  keys.priyaEng = await mint(PRIYA, PRIYA_ENG);
  keys.priyaDm = await mint(PRIYA, PRIYA_DM_THREAD);
  keys.priyaDmShared = await mint(PRIYA, PRIYA_DM_SHARED);
  keys.priyaNoSpace = await mint(PRIYA, PRIYA_NO_SPACE);
});

afterAll(async () => {
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  for (const id of USERS) await db.execute(sql`delete from auth.users where id = ${id}::uuid`);
});

describe('POST /chat/threads', () => {
  test('a channel thread (any member may prompt it) gets 403 and writes nothing into the person’s chat', async () => {
    const text = `Injected by a channel member ${crypto.randomUUID()}`;
    const res = await post(keys.priyaEng!, text);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_the_persons_chat');
    expect(await postedWith(text)).toEqual([]);
  });

  test('a DM session shared with the project gets 403 and writes nothing', async () => {
    const text = `Injected through a shared DM session ${crypto.randomUUID()}`;
    const res = await post(keys.priyaDmShared!, text);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_the_persons_chat');
    expect(await postedWith(text)).toEqual([]);
  });

  test('a private session in the person’s own DM posts: a new thread in that DM, for that person', async () => {
    const text = `Your nightly report is ready ${crypto.randomUUID()}`;
    const res = await post(keys.priyaDm!, text);
    expect(res.status).toBe(201);
    const rows = await postedWith(text);
    expect(rows).toEqual([{ sessionId: res.body.session_id, spaceId: PRIYA_DM, createdBy: PRIYA }]);
  });

  test('a private session in no space posts to the person’s DM', async () => {
    const text = `Something I noticed ${crypto.randomUUID()}`;
    const res = await post(keys.priyaNoSpace!, text);
    expect(res.status).toBe(201);
    const rows = await postedWith(text);
    expect(rows).toEqual([{ sessionId: res.body.session_id, spaceId: PRIYA_DM, createdBy: PRIYA }]);
  });
});

describe('the thread board', () => {
  test('the thread’s person sees their own and project threads; another member’s private thread is not on it', async () => {
    const board = (await chatThreadBoardTurn(PROJECT, PRIYA_ENG, PRIYA))!;
    expect(board).toContain('<board>');
    expect(board).toContain('"Sam deploy checklist"');
    expect(board).toContain('"Priya private notes"');
    expect(board).not.toContain('Sam salary review');
    expect(board).not.toContain(SAM_ENG_PRIVATE);
  });

  test('another member prompting a shared thread: neither person’s private threads are on it', async () => {
    const board = (await chatThreadBoardTurn(PROJECT, PRIYA_ENG, SAM))!;
    expect(board).toContain('"Sam deploy checklist"');
    expect(board).not.toContain('Priya private notes');
    expect(board).not.toContain('Sam salary review');
  });
});

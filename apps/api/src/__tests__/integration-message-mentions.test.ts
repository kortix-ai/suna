/**
 * Integration test (real local DB): `notifyMessageMentions`, a person's own
 * message in a channel thread that @mentions people (the web's `@` menu writes
 * `@<email>` or `@<display-name>`).
 *
 * - A mentioned member who may see the thread gets one `question`
 *   notification, titled with the author and the channel.
 * - A mentioned project member outside a private channel gets nothing.
 * - The author mentioning themself gets nothing.
 * - The same message again (a retried turn) writes no second notification.
 * - A thread in no channel (the person's own space) notifies nobody.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, notifications, projectMembers, projectSessions, projectSpaceMembers, projectSpaces, projects } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const { notifyMessageMentions } = await import('../projects/lib/space-posts');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const PRIYA = crypto.randomUUID();
const SAM = crypto.randomUUID();
const LEE = crypto.randomUUID();
const ENG = crypto.randomUUID();
const SECRET = crypto.randomUUID();
const PRIYA_DM = crypto.randomUUID();
/** Priya's thread in #eng (project-visible). */
const ENG_THREAD = crypto.randomUUID();
/** Priya's thread in the private #secret (Sam is not a member). */
const SECRET_THREAD = crypto.randomUUID();
/** Priya's thread in her own space. */
const DM_THREAD = crypto.randomUUID();
const USERS = [PRIYA, SAM, LEE] as const;
const email = (id: string) => `${id.slice(0, 8)}@example.test`;

const notificationsFor = (userId: string, sessionId: string) =>
  db.select({ kind: notifications.kind, title: notifications.title }).from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.sessionId, sessionId)));

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'message-mentions' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'Mentions', repoUrl: 'https://example.test/m.git', metadata: { experimental: { chat: true } } });
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
    { spaceId: PRIYA_DM, accountId: ACCOUNT, projectId: PROJECT, kind: 'dm', name: 'mykortix', dmUserId: PRIYA, dmAgentName: 'mykortix', createdBy: PRIYA },
  ]);
  await db.insert(projectSpaceMembers).values([
    { spaceId: ENG, userId: PRIYA, addedBy: PRIYA },
    { spaceId: ENG, userId: SAM, addedBy: PRIYA },
    { spaceId: SECRET, userId: PRIYA, addedBy: PRIYA },
  ]);
  const base = { accountId: ACCOUNT, projectId: PROJECT, agentName: 'mykortix', metadata: {} } as const;
  await db.insert(projectSessions).values([
    { ...base, sessionId: ENG_THREAD, branchName: ENG_THREAD, createdBy: PRIYA, spaceId: ENG, visibility: 'project' },
    { ...base, sessionId: SECRET_THREAD, branchName: SECRET_THREAD, createdBy: PRIYA, spaceId: SECRET, visibility: 'project' },
    { ...base, sessionId: DM_THREAD, branchName: DM_THREAD, createdBy: PRIYA, spaceId: PRIYA_DM, visibility: 'private' },
  ]);
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  for (const id of USERS) await db.execute(sql`delete from auth.users where id = ${id}::uuid`);
});

describe("a person's message mentions people", () => {
  test('a mentioned member of the channel gets one notification; the author mentioning themself gets none', async () => {
    const notified = await notifyMessageMentions({
      projectId: PROJECT,
      sessionId: ENG_THREAD,
      authorId: PRIYA,
      text: `@${email(SAM)} can you review this? cc @${email(PRIYA)}`,
      messageKey: 'msg-1',
    });
    expect(notified).toEqual([SAM]);
    const author = email(PRIYA).split('@')[0];
    expect(await notificationsFor(SAM, ENG_THREAD)).toEqual([{ kind: 'question', title: `${author} mentioned you in #eng-${ENG.slice(0, 6)}` }]);
    expect(await notificationsFor(PRIYA, ENG_THREAD)).toEqual([]);
  });

  test('the same message again (a retried turn) writes no second notification', async () => {
    await notifyMessageMentions({ projectId: PROJECT, sessionId: ENG_THREAD, authorId: PRIYA, text: `@${email(SAM)} can you review this?`, messageKey: 'msg-1' });
    expect(await notificationsFor(SAM, ENG_THREAD)).toHaveLength(1);
  });

  test('a project member outside a private channel is not notified', async () => {
    const notified = await notifyMessageMentions({
      projectId: PROJECT,
      sessionId: SECRET_THREAD,
      authorId: PRIYA,
      text: `@${email(SAM)} and @${email(LEE)} look at this`,
      messageKey: 'msg-2',
    });
    expect(notified).toEqual([]);
    expect(await notificationsFor(SAM, SECRET_THREAD)).toEqual([]);
    expect(await notificationsFor(LEE, SECRET_THREAD)).toEqual([]);
  });

  test("a thread in the person's own space notifies nobody", async () => {
    expect(await notifyMessageMentions({ projectId: PROJECT, sessionId: DM_THREAD, authorId: PRIYA, text: `@${email(SAM)} hi`, messageKey: 'msg-3' })).toEqual([]);
    expect(await notificationsFor(SAM, DM_THREAD)).toEqual([]);
  });
});

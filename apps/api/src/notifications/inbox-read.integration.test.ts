// Reading the notification inbox on PostgreSQL (KRTX-1742): a row shows only
// while its reader may still open what it names (share, project role, account
// membership, MFA step-up, tombstone, trigger read); the session title is the
// live one; the unread count covers the newest 100 unread rows after the
// filter; pages walk back by notification id; marking read never reaches
// another user's rows. Real: the account and project roles, the IAM project
// list rule, the session grants.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, notifications, projectMembers, projectSessions } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { setSessionSharing } from '../connectors/share';
import { clearAuthorizeCaches } from '../iam/authorize';
import { db } from '../shared/db';
import { deleteFromView, insertIntoView } from '../__tests__/helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from '../__tests__/helpers/integration-fixtures';
import {
  filterVisibleNotificationRows,
  INBOX_PAGE_SCAN_BATCHES,
  INBOX_UNREAD_SCAN,
  listInbox,
  markInboxRead,
  markSessionNotificationsRead,
  unreadCount,
} from './inbox-read';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const OWNER = crypto.randomUUID();
const CREATOR = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const ACCOUNT_ONLY = crypto.randomUUID();
const users = [OWNER, CREATOR, MEMBER, ACCOUNT_ONLY];

let project: SeededProject;

async function seedRow(userId: string, values: Partial<typeof notifications.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(notifications)
    .values({
      userId,
      accountId: project.account_id,
      projectId: project.project_id,
      kind: 'turn_done',
      title: 'Stored title',
      ...values,
    })
    .returning({ id: notifications.notificationId });
  return row!.id;
}

async function projectSession(createdBy: string, metadata: Record<string, unknown> = {}): Promise<string> {
  const sessionId = await seedSession(project, createdBy);
  await db.update(projectSessions).set({ visibility: 'project', metadata }).where(eq(projectSessions.sessionId, sessionId));
  return sessionId;
}

async function readAtOf(id: string): Promise<Date | null> {
  const [row] = await db.select({ readAt: notifications.readAt }).from(notifications).where(eq(notifications.notificationId, id));
  return row?.readAt ?? null;
}

withDb('notification inbox read', () => {
  beforeAll(async () => {
    project = await seedProject(`inbox-${crypto.randomUUID().slice(0, 8)}`);
    const user = (id: string) =>
      sql`(${id}::uuid, ${`inbox-${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`;
    await db.execute(sql`
      INSERT INTO auth.users (id, email, instance_id, aud, role)
      VALUES ${sql.join(users.map(user), sql`, `)}`);
    await insertIntoView(db, accountMembers, [
      { userId: OWNER, accountId: project.account_id, accountRole: 'owner' },
      { userId: CREATOR, accountId: project.account_id, accountRole: 'member' },
      { userId: MEMBER, accountId: project.account_id, accountRole: 'member' },
      { userId: ACCOUNT_ONLY, accountId: project.account_id, accountRole: 'member' },
    ]);
    await insertIntoView(db, projectMembers, [
      { accountId: project.account_id, projectId: project.project_id, userId: CREATOR, projectRole: 'member' },
      { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' },
    ]);
  }, 20_000);

  // Each test starts from an empty inbox, even after a failed one.
  beforeEach(async () => {
    await db.delete(notifications).where(eq(notifications.accountId, project.account_id));
  });

  afterAll(async () => {
    if (!project) return;
    await db.delete(notifications).where(eq(notifications.accountId, project.account_id));
    await removeSeeded([project]);
    await db.execute(sql`DELETE FROM auth.users WHERE id IN (${sql.join(users.map((id) => sql`${id}::uuid`), sql`, `)})`);
  });

  test('a revoked share hides the row from the list and the unread count', async () => {
    const sessionId = await seedSession(project, CREATOR);
    await setSessionSharing(sessionId, { mode: 'members', memberIds: [MEMBER] });
    const id = await seedRow(MEMBER, { sessionId, kind: 'shared' });

    const shared = await listInbox(MEMBER, { limit: 20 });
    expect(shared.notifications.map((n) => n.id)).toContain(id);
    const before = shared.unread_count;

    await setSessionSharing(sessionId, { mode: 'private', ownerId: CREATOR });
    const revoked = await listInbox(MEMBER, { limit: 20 });
    expect(revoked.notifications.map((n) => n.id)).not.toContain(id);
    expect(revoked.unread_count).toBe(before - 1);
  });

  test('a lost project role hides the row; the creator keeps seeing theirs', async () => {
    const sessionId = await projectSession(CREATOR);
    const memberRow = await seedRow(MEMBER, { sessionId });
    const outsiderRow = await seedRow(ACCOUNT_ONLY, { sessionId });
    const creatorRow = await seedRow(CREATOR, { sessionId });

    expect((await listInbox(MEMBER, { limit: 20 })).notifications.map((n) => n.id)).toEqual([memberRow]);
    // Account member with no project role: never visible.
    expect((await listInbox(ACCOUNT_ONLY, { limit: 20 })).notifications.map((n) => n.id)).not.toContain(outsiderRow);

    await deleteFromView(db, projectMembers, and(eq(projectMembers.projectId, project.project_id), eq(projectMembers.userId, MEMBER)));
    clearAuthorizeCaches();
    try {
      expect((await listInbox(MEMBER, { limit: 20 })).notifications).toEqual([]);
      expect(await unreadCount(MEMBER)).toBe(0);
      expect((await listInbox(CREATOR, { limit: 20 })).notifications.map((n) => n.id)).toEqual([creatorRow]);
    } finally {
      await insertIntoView(db, projectMembers, [
        { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' },
      ]);
      clearAuthorizeCaches();
    }
  });

  test('a member removed from the account no longer sees the account\'s rows', async () => {
    const sessionId = await projectSession(CREATOR);
    const id = await seedRow(MEMBER, { sessionId });
    expect((await listInbox(MEMBER, { limit: 20 })).notifications.map((n) => n.id)).toEqual([id]);

    await deleteFromView(db, projectMembers, and(eq(projectMembers.projectId, project.project_id), eq(projectMembers.userId, MEMBER)));
    await deleteFromView(db, accountMembers, and(eq(accountMembers.accountId, project.account_id), eq(accountMembers.userId, MEMBER)));
    clearAuthorizeCaches();
    try {
      expect((await listInbox(MEMBER, { limit: 20 })).notifications).toEqual([]);
    } finally {
      await insertIntoView(db, accountMembers, [{ userId: MEMBER, accountId: project.account_id, accountRole: 'member' }]);
      await insertIntoView(db, projectMembers, [
        { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' },
      ]);
      clearAuthorizeCaches();
    }
  });

  test('an MFA-required account hides its rows from an aal1 sign-in and shows them at aal2', async () => {
    const sessionId = await projectSession(CREATOR);
    const id = await seedRow(MEMBER, { sessionId });
    await db.update(accounts).set({ mfaRequired: true }).where(eq(accounts.accountId, project.account_id));
    clearAuthorizeCaches();
    try {
      expect((await listInbox(MEMBER, { limit: 20 }, { mfaAal: 'aal1' })).notifications).toEqual([]);
      expect(await unreadCount(MEMBER, { mfaAal: 'aal1' })).toBe(0);
      expect((await listInbox(MEMBER, { limit: 20 }, { mfaAal: 'aal2' })).notifications.map((n) => n.id)).toEqual([id]);
      // A personal token has no second factor to step up with; the digest is not a sign-in.
      expect((await listInbox(MEMBER, { limit: 20 }, { iamTokenId: 'token-1', mfaAal: 'aal1' })).notifications).toHaveLength(1);
      const [row] = await db.select().from(notifications).where(eq(notifications.notificationId, id));
      expect(await filterVisibleNotificationRows(MEMBER, [row!], { skipMfaGate: true })).toHaveLength(1);
    } finally {
      await db.update(accounts).set({ mfaRequired: false }).where(eq(accounts.accountId, project.account_id));
      clearAuthorizeCaches();
    }
  });

  test('a deleted (tombstoned) session hides its row', async () => {
    const live = await projectSession(CREATOR);
    const gone = await projectSession(CREATOR, { deletedAt: '2026-10-09T10:00:00.000Z' });
    const liveRow = await seedRow(MEMBER, { sessionId: live });
    await seedRow(MEMBER, { sessionId: gone });

    expect((await listInbox(MEMBER, { limit: 20 })).notifications.map((n) => n.id)).toEqual([liveRow]);
  });

  test('an automation row needs trigger read on its project', async () => {
    const memberRow = await seedRow(MEMBER, { kind: 'automation_failed', triggerSlug: 'nightly', title: 'Nightly report' });
    const outsiderRow = await seedRow(ACCOUNT_ONLY, { kind: 'automation_failed', triggerSlug: 'nightly', title: 'Nightly report' });

    const page = await listInbox(MEMBER, { limit: 20 });
    expect(page.notifications).toEqual([
      expect.objectContaining({
        id: memberRow,
        kind: 'automation_failed',
        title: 'Nightly report',
        trigger_slug: 'nightly',
        session_id: null,
        url: `/projects/${project.project_id}/customize/triggers?notification=${memberRow}`,
      }),
    ]);
    expect((await listInbox(ACCOUNT_ONLY, { limit: 20 })).notifications.map((n) => n.id)).not.toContain(outsiderRow);
  });

  test('a session row shows the live session title, the project name and its open URL', async () => {
    const renamed = await projectSession(CREATOR, { name: 'Generated name', custom_name: '  Renamed by hand ' });
    const untitled = await projectSession(CREATOR);
    const renamedRow = await seedRow(MEMBER, { sessionId: renamed, title: 'Title at write time', body: 'Detail', actorUserId: CREATOR });
    const untitledRow = await seedRow(MEMBER, { sessionId: untitled, title: 'Title at write time' });

    const page = await listInbox(MEMBER, { limit: 20 });
    const byId = new Map(page.notifications.map((n) => [n.id, n]));
    expect(byId.get(renamedRow)).toMatchObject({
      title: 'Renamed by hand',
      body: 'Detail',
      project_id: project.project_id,
      project_name: expect.stringMatching(/^inbox-/),
      session_id: renamed,
      actor_user_id: CREATOR,
      read: false,
      url: `/projects/${project.project_id}/sessions/${renamed}?notification=${renamedRow}`,
    });
    expect(byId.get(untitledRow)?.title).toBe('Title at write time');
    expect(Number.isNaN(Date.parse(byId.get(renamedRow)!.created_at))).toBe(false);
  });

  test(`the unread count covers the newest ${INBOX_UNREAD_SCAN} unread rows after the filter`, async () => {
    const live = await projectSession(CREATOR);
    const gone = await projectSession(CREATOR, { deletedAt: '2026-10-09T10:00:00.000Z' });
    await db.insert(notifications).values(
      Array.from({ length: INBOX_UNREAD_SCAN + 1 }, () => ({
        userId: MEMBER,
        accountId: project.account_id,
        projectId: project.project_id,
        sessionId: live,
        kind: 'turn_done',
        title: 'Bulk',
      })),
    );
    // The newest unread row is hidden: the scan takes 100 rows, 99 of them visible.
    await seedRow(MEMBER, { sessionId: gone });
    // A read row never counts.
    const readRow = await seedRow(MEMBER, { sessionId: live });
    await markInboxRead(MEMBER, { ids: [readRow] });

    expect(await unreadCount(MEMBER)).toBe(INBOX_UNREAD_SCAN - 1);
    expect((await listInbox(MEMBER, { limit: 5 })).unread_count).toBe(INBOX_UNREAD_SCAN - 1);
  });

  // KRTX-1742 review: the access filter ran after LIMIT, so a deleted busy
  // session filled the bell's only page with hidden rows: an empty list under
  // an unread badge, and the older visible rows out of reach.
  test('hidden rows newer than a full page do not empty it: the page reads older batches', async () => {
    const live = await projectSession(CREATOR);
    const gone = await projectSession(CREATOR, { deletedAt: '2026-10-09T10:00:00.000Z' });
    const liveRows: string[] = [];
    for (let i = 0; i < 3; i++) liveRows.push(await seedRow(MEMBER, { sessionId: live }));
    const bulk = (n: number) =>
      Array.from({ length: n }, () => ({
        userId: MEMBER,
        accountId: project.account_id,
        projectId: project.project_id,
        sessionId: gone,
        kind: 'turn_done',
        title: 'Hidden',
      }));
    await db.insert(notifications).values(bulk(60));

    const page = await listInbox(MEMBER, { limit: 50 });
    expect(page.notifications.map((n) => n.id)).toEqual([...liveRows].reverse());
    expect(page.unread_count).toBe(3);
    expect(page.next_before).toBeNull();

    // A scan stops after its batches: a short page still points further back.
    await db.insert(notifications).values(bulk(INBOX_PAGE_SCAN_BATCHES * 10));
    const capped = await listInbox(MEMBER, { limit: 10 });
    expect(capped.notifications).toEqual([]);
    expect(capped.next_before).not.toBeNull();
    const rest = await listInbox(MEMBER, { limit: 10, before: capped.next_before });
    expect(rest.notifications).toEqual([]);
    expect(rest.next_before).not.toBeNull();
    // No gap: the walk reaches the visible rows, then ends.
    const last = await listInbox(MEMBER, { limit: 10, before: rest.next_before });
    expect(last.notifications.map((n) => n.id)).toEqual([...liveRows].reverse());
    expect(last.next_before).toBeNull();
  });

  test('pages walk back by notification id with no gap and no repeat', async () => {
    const sessionId = await projectSession(CREATOR);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seedRow(MEMBER, { sessionId, title: `Row ${i}` }));
    const newestFirst = [...ids].sort().reverse();

    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const page = await listInbox(MEMBER, { limit: 2, before });
      expect(page.notifications.length).toBeLessThanOrEqual(2);
      seen.push(...page.notifications.map((n) => n.id));
      before = page.next_before;
      pages += 1;
    } while (before && pages < 10);

    expect(seen).toEqual(newestFirst);
    expect(pages).toBe(3);
  });

  test('marking read touches only the caller\'s rows: by ids, by session, and all', async () => {
    const first = await projectSession(CREATOR);
    const second = await projectSession(CREATOR);
    const creatorRow = await seedRow(CREATOR, { sessionId: first });
    const a = await seedRow(MEMBER, { sessionId: first });
    const b = await seedRow(MEMBER, { sessionId: first });
    const c = await seedRow(MEMBER, { sessionId: second });
    const d = await seedRow(MEMBER, { sessionId: second });

    // Another user's id: nothing changes (no IDOR), and the answer leaks nothing.
    expect(await markInboxRead(MEMBER, { ids: [creatorRow] })).toEqual({ updated: 0, unread_count: 4 });
    expect(await readAtOf(creatorRow)).toBeNull();

    expect(await markInboxRead(MEMBER, { ids: [a, creatorRow] })).toEqual({ updated: 1, unread_count: 3 });
    expect(await markInboxRead(MEMBER, { sessionId: second })).toEqual({ updated: 2, unread_count: 1 });
    expect(await readAtOf(c)).not.toBeNull();
    expect(await readAtOf(b)).toBeNull();
    expect(await markInboxRead(MEMBER, { all: true })).toEqual({ updated: 1, unread_count: 0 });
    expect(await readAtOf(b)).not.toBeNull();
    expect(await readAtOf(d)).not.toBeNull();
    expect(await readAtOf(creatorRow)).toBeNull();

    const page = await listInbox(MEMBER, { limit: 20 });
    expect(page.notifications.every((n) => n.read)).toBe(true);
  });

  test('opening a session marks only that user\'s rows of that session read', async () => {
    const opened = await projectSession(CREATOR);
    const other = await projectSession(CREATOR);
    const mine = await seedRow(MEMBER, { sessionId: opened });
    const elsewhere = await seedRow(MEMBER, { sessionId: other });
    const theirs = await seedRow(CREATOR, { sessionId: opened });

    expect(await markSessionNotificationsRead(MEMBER, opened)).toBe(1);
    expect(await readAtOf(mine)).not.toBeNull();
    expect(await readAtOf(elsewhere)).toBeNull();
    expect(await readAtOf(theirs)).toBeNull();
    expect(await markSessionNotificationsRead(MEMBER, opened)).toBe(0);
  });
});

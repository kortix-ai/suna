import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, artifactComments, artifactCommentThreads, artifacts, drives, notifications, projectMembers, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { notifyArtifactComment } from '../artifacts/comment-notifications';
import { insertIntoView } from '../__tests__/helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from '../__tests__/helpers/integration-fixtures';
import { clearAuthorizeCaches } from '../iam/authorize';
import { config } from '../config';
import { db } from '../shared/db';
import { isNotificationEmailAvailable } from './email-delivery';
import { filterVisibleNotificationRows, hiddenNotificationKinds, listInbox } from './inbox-read';

const enabled = { experimental: { artifacts: true, artifact_comments: true, notification_center: false } };
const originalStorageKey = config.PLATINUM_API_KEY;

describe.skipIf(!process.env.TEST_DATABASE_URL)('Artifact comment notifications', () => {
  const seeded: SeededProject[] = [];
  const users: string[] = [];
  let project: SeededProject;
  let owner: string;
  let member: string;
  let artifactId: string;
  let threadId: string;
  let rootId: string;

  async function comment(userId: string, mentions: NonNullable<(typeof artifactComments.$inferInsert)['mentions']> = []) {
    const [row] = await db.insert(artifactComments).values({ threadId, authorUserId: userId, body: 'Synthetic feedback must stay in the comment store.', mentions })
      .returning({ id: artifactComments.commentId });
    return row!.id;
  }
  const stored = () => db.select().from(notifications).where(eq(notifications.artifactId, artifactId));
  const notify = (commentId = rootId) => notifyArtifactComment({ artifactId, commentId });

  beforeEach(async () => {
    config.PLATINUM_API_KEY = 'unit-artifact-notification-storage';
    owner = crypto.randomUUID();
    member = crypto.randomUUID();
    users.push(owner, member);
    project = await seedProject(`artifact-notice-${crypto.randomUUID().slice(0, 8)}`, { metadata: enabled });
    seeded.push(project);
    for (const id of [owner, member]) await db.execute(sql`INSERT INTO auth.users (id,email,instance_id,aud,role)
      VALUES (${id}::uuid,${`artifact-notice-${id}@example.test`},'00000000-0000-0000-0000-000000000000','authenticated','authenticated')`);
    await insertIntoView(db, accountMembers, [
      { userId: owner, accountId: project.account_id, accountRole: 'owner' },
      { userId: member, accountId: project.account_id, accountRole: 'member' },
    ]);
    await insertIntoView(db, projectMembers, [
      { accountId: project.account_id, projectId: project.project_id, userId: member, projectRole: 'member' },
    ]);
    const [drive] = await db.insert(drives).values({ accountId: project.account_id, projectId: project.project_id, kind: 'project',
      name: 'Notification test Files', platinumVolumeName: `artifact-notice-${crypto.randomUUID()}` }).returning();
    const [artifact] = await db.insert(artifacts).values({ accountId: project.account_id, projectId: project.project_id, driveId: drive!.driveId,
      root: 'report.md', entry: 'report.md', folder: false, title: 'Synthetic forecast', type: 'doc', createdByUserId: owner,
      visibility: 'private', sharedWithUserIds: [member] }).returning();
    artifactId = artifact!.artifactId;
    const [thread] = await db.insert(artifactCommentThreads).values({ artifactId, projectId: project.project_id,
      anchor: { type: 'none', version: 'saved-version' }, anchorVersion: 'saved-version', createdByUserId: owner }).returning();
    threadId = thread!.threadId;
    rootId = await comment(owner, [{ kind: 'user', user_id: member }]);
    clearAuthorizeCaches();
  });
  afterAll(async () => {
    config.PLATINUM_API_KEY = originalStorageKey;
    await removeSeeded(seeded);
    for (const id of users) await db.execute(sql`DELETE FROM auth.users WHERE id=${id}::uuid`);
  });

  test('a mention creates one bell row, push/digest preferences and a thread link; the author gets none', async () => {
    await notify();
    await notify();
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: member, kind: 'artifact_comment', artifactId, artifactThreadId: threadId,
      dedupeKey: `artifact-comments:${threadId}:${rootId}` });
    expect(rows[0]!.body).not.toContain('Synthetic feedback must stay');
    expect(rows[0]!.emailDueAt !== null).toBe(isNotificationEmailAvailable());
    const inbox = await listInbox(member, { limit: 20 });
    expect(inbox.notifications).toHaveLength(1);
    expect(inbox.notifications[0]).toMatchObject({ artifact_id: artifactId, artifact_thread_id: threadId });
    expect(inbox.notifications[0]!.url).toBe(`/projects/${project.project_id}/artifacts/${artifactId}?thread=${threadId}&notification=${rows[0]!.notificationId}`);
    expect((await listInbox(owner, { limit: 20 })).notifications).toEqual([]);
    expect(await hiddenNotificationKinds(member)).not.toContain('artifact_comment');
  });

  test('a reply reaches human participants, including a deleted-comment author, and excludes its author', async () => {
    const prior = await comment(member);
    await db.update(artifactComments).set({ deletedAt: new Date(), body: '' }).where(eq(artifactComments.commentId, prior));
    const reply = await comment(owner);
    await notify(reply);
    expect((await stored()).map((row) => row.userId)).toEqual([member]);
  });

  test('an agent question reaches its human launcher and mentioned people', async () => {
    const sessionId = await seedSession(project, owner);
    await db.update(artifactComments).set({ authorUserId: null, authorSessionId: sessionId }).where(eq(artifactComments.commentId, rootId));
    await notify();
    expect((await stored()).map((row) => row.userId).sort()).toEqual([owner, member].sort());
  });

  test('a deleted thread root cancels its pending reply notification', async () => {
    const reply = await comment(member);
    await db.update(artifactComments).set({ deletedAt: new Date(), body: '', mentions: [] }).where(eq(artifactComments.commentId, rootId));
    await notify(reply);
    expect(await stored()).toEqual([]);
  });

  test('view loss before delivery suppresses the row; later loss hides stored rows from inbox and digest', async () => {
    await db.update(artifacts).set({ sharedWithUserIds: [] }).where(eq(artifacts.artifactId, artifactId));
    await notify();
    expect(await stored()).toEqual([]);
    await db.update(artifacts).set({ sharedWithUserIds: [member] }).where(eq(artifacts.artifactId, artifactId));
    await notify();
    const rows = await stored();
    expect(rows).toHaveLength(1);
    await db.update(artifacts).set({ sharedWithUserIds: [] }).where(eq(artifacts.artifactId, artifactId));
    expect((await listInbox(member, { limit: 20 })).notifications).toEqual([]);
    expect(await filterVisibleNotificationRows(member, rows, { skipMfaGate: true })).toEqual([]);
    await db.delete(artifacts).where(eq(artifacts.artifactId, artifactId));
    expect(await stored()).toEqual([]);
  });

  test('the comment flag gates only Artifact rows; notification_center continues to gate session rows', async () => {
    await notify();
    const sessionId = await seedSession(project, owner);
    await db.insert(notifications).values({ userId: owner, accountId: project.account_id, projectId: project.project_id,
      sessionId, kind: 'turn_done', title: 'Synthetic session' });
    expect((await listInbox(owner, { limit: 20 })).notifications).toEqual([]);
    await db.update(projects).set({ metadata: { experimental: { artifacts: true, artifact_comments: false, notification_center: true } } })
      .where(eq(projects.projectId, project.project_id));
    expect((await listInbox(member, { limit: 20 })).notifications).toEqual([]);
    expect((await listInbox(owner, { limit: 20 })).notifications.map((row) => row.kind)).toEqual(['turn_done']);
    expect(await hiddenNotificationKinds(member)).toContain('artifact_comment');
    await notify(await comment(owner, [{ kind: 'user', user_id: member }]));
    expect(await stored()).toHaveLength(1);
  });
});

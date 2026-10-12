/**
 * Integration test (real local DB): "shared with you" (KRTX-1742 design §3.2,
 * acceptance 5). The PUT sharing route captures the grants before it replaces
 * them, applies the change, then calls `notifySessionShared`. This runs the
 * same two steps: `setSessionSharing`, then the emission with the prior grants.
 *
 * Only the people a members share NEWLY names get a row: members of the
 * account and members of the account's groups, minus the earlier grantees,
 * the sharer and the creator, minus anyone who cannot open the session after
 * the change. One row per person per session per UTC day.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountGroupMembers,
  accountGroups,
  accountMembers,
  notifications,
  projectMembers,
  projectSessionGrants,
  projectSessions,
} from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { loadSessionGrants, setSessionSharing, type SharingIntent } from '../connectors/share';
import { deliver, liveNotifierDeps } from '../notifications/notifier';
import { notifySessionShared } from '../projects/lib/notification-recipients';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const SHARER = crypto.randomUUID(); // creates the sessions and shares them
const NEW_MEMBER = crypto.randomUUID();
const EARLIER_MEMBER = crypto.randomUUID();
const GROUPED = crypto.randomUUID(); // in REVIEWERS
const ACCOUNT_ONLY = crypto.randomUUID(); // in the account, not the project
const MANAGER = crypto.randomUUID(); // shares a session someone else created
const NOT_A_MEMBER = crypto.randomUUID(); // a valid uuid in no account
const users = [SHARER, NEW_MEMBER, EARLIER_MEMBER, GROUPED, ACCOUNT_ONLY, MANAGER];
const REVIEWERS = crypto.randomUUID();
const TODAY = new Date('2026-10-09T15:30:00.000Z');

let project: SeededProject;
const pushed: string[] = [];
const send = (input: Parameters<typeof deliver>[0]) =>
  deliver(
    input,
    liveNotifierDeps({
      pushEnabled: true,
      listDevices: async () => [],
      sendExpo: async () => {},
      sendWebPush: async ({ userId }) => {
        pushed.push(userId);
        return { sent: 1 };
      },
      sendEmailNow: async () => 'sent',
    }),
  );

beforeAll(async () => {
  project = await seedProject('notify-share');
  const user = (id: string, name: string | null) =>
    sql`(${id}::uuid, ${`share-${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${JSON.stringify(name ? { name } : {})}::jsonb)`;
  await db.execute(sql`
    INSERT INTO auth.users (id, email, instance_id, aud, role, raw_user_meta_data)
    VALUES ${sql.join(
      users.map((id) => user(id, id === SHARER ? 'Avery Example' : null)),
      sql`, `,
    )}`);
  await insertIntoView(
    db,
    accountMembers,
    users.map((userId) => ({ userId, accountId: project.account_id, accountRole: 'member' as const })),
  );
  await insertIntoView(db, projectMembers, [
    ...[SHARER, NEW_MEMBER, EARLIER_MEMBER, GROUPED].map((userId) => ({
      accountId: project.account_id,
      projectId: project.project_id,
      userId,
      projectRole: 'member' as const,
    })),
    { accountId: project.account_id, projectId: project.project_id, userId: MANAGER, projectRole: 'manager' },
  ]);
  await db.insert(accountGroups).values({ groupId: REVIEWERS, accountId: project.account_id, name: 'Reviewers' });
  await db.insert(accountGroupMembers).values({ groupId: REVIEWERS, userId: GROUPED });
}, 30_000);

afterAll(async () => {
  if (!project) return;
  await db.delete(accountGroups).where(eq(accountGroups.groupId, REVIEWERS));
  await removeSeeded([project]);
  await db.execute(sql`DELETE FROM auth.users WHERE id IN (${sql.join(users.map((id) => sql`${id}::uuid`), sql`, `)})`);
});

async function seedSession(
  grants: Array<{ principalType: 'member' | 'group'; principalId: string }> = [],
  createdBy = SHARER,
  visibility: 'private' | 'project' | 'restricted' = grants.length ? 'restricted' : 'private',
) {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    createdBy,
    visibility,
    metadata: { name: 'Quarterly report' },
  });
  if (grants.length) await db.insert(projectSessionGrants).values(grants.map((g) => ({ sessionId, ...g })));
  return sessionId;
}

/** What the PUT sharing route runs: capture, replace, emit. */
async function share(sessionId: string, intent: SharingIntent, sharerId = SHARER, now = TODAY, creatorId: string | null = SHARER) {
  const priorGrants = (await loadSessionGrants([sessionId])).get(sessionId) ?? [];
  const [prior] = await db
    .select({ visibility: projectSessions.visibility })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId));
  await setSessionSharing(sessionId, intent);
  return notifySessionShared(
    {
      accountId: project.account_id,
      projectId: project.project_id,
      sessionId,
      sharerId,
      creatorId,
      priorGrants,
      priorVisibility: prior!.visibility,
      intent,
      now,
    },
    send,
  );
}

async function sharedRows(sessionId: string) {
  return db
    .select({
      userId: notifications.userId,
      kind: notifications.kind,
      title: notifications.title,
      body: notifications.body,
      actorUserId: notifications.actorUserId,
      dedupeKey: notifications.dedupeKey,
    })
    .from(notifications)
    .where(and(eq(notifications.sessionId, sessionId), eq(notifications.kind, 'shared')));
}

const sorted = (ids: string[]) => [...ids].sort();

describe('shared with you', () => {
  test('only the newly named members who may open the session get a row', async () => {
    const sessionId = await seedSession([{ principalType: 'member', principalId: EARLIER_MEMBER }]);
    const told = await share(sessionId, {
      mode: 'members',
      memberIds: [NEW_MEMBER, EARLIER_MEMBER, NOT_A_MEMBER, ACCOUNT_ONLY, SHARER],
      groupIds: [REVIEWERS],
    });

    expect(sorted(told)).toEqual(sorted([NEW_MEMBER, GROUPED]));
    const rows = await sharedRows(sessionId);
    expect(sorted(rows.map((row) => row.userId))).toEqual(sorted([NEW_MEMBER, GROUPED]));
    for (const row of rows) {
      expect(row).toMatchObject({
        title: 'Quarterly report',
        body: 'Avery Example shared a session with you',
        actorUserId: SHARER,
        dedupeKey: `shared:${sessionId}:2026-10-09`,
      });
    }
    expect(sorted(pushed.splice(0))).toEqual(sorted([NEW_MEMBER, GROUPED]));
  });

  test('a member already in a shared group is not told again', async () => {
    const sessionId = await seedSession([{ principalType: 'group', principalId: REVIEWERS }]);
    expect(await share(sessionId, { mode: 'members', memberIds: [NEW_MEMBER], groupIds: [REVIEWERS] })).toEqual([NEW_MEMBER]);
  });

  test('the same session shared again the same day writes no second row', async () => {
    const sessionId = await seedSession();
    expect(await share(sessionId, { mode: 'members', memberIds: [NEW_MEMBER] })).toEqual([NEW_MEMBER]);
    expect(await share(sessionId, { mode: 'private', ownerId: SHARER })).toEqual([]);
    // Newly named again by the diff, but the day's row already exists.
    await share(sessionId, { mode: 'members', memberIds: [NEW_MEMBER] });
    expect(await sharedRows(sessionId)).toHaveLength(1);
    // The next UTC day is a new row.
    await share(sessionId, { mode: 'private', ownerId: SHARER });
    await share(sessionId, { mode: 'members', memberIds: [NEW_MEMBER] }, SHARER, new Date('2026-10-10T00:00:01.000Z'));
    expect(await sharedRows(sessionId)).toHaveLength(2);
  });

  // KRTX-1742 review: narrowing took access away and told the people who kept it.
  test('a project-visible session narrowed to named members tells nobody: they could open it already', async () => {
    const sessionId = await seedSession([], SHARER, 'project');
    expect(await share(sessionId, { mode: 'members', memberIds: [NEW_MEMBER, EARLIER_MEMBER], groupIds: [REVIEWERS] })).toEqual([]);
    expect(await sharedRows(sessionId)).toEqual([]);
  });

  test('a project-wide or private share tells nobody', async () => {
    const sessionId = await seedSession();
    expect(await share(sessionId, { mode: 'project' })).toEqual([]);
    expect(await share(sessionId, { mode: 'private', ownerId: SHARER })).toEqual([]);
    expect(await sharedRows(sessionId)).toEqual([]);
  });

  test('a share of someone else`s session does not tell its creator; an unnamed sharer reads as a teammate', async () => {
    const sessionId = await seedSession([], EARLIER_MEMBER);
    const told = await share(sessionId, { mode: 'members', memberIds: [EARLIER_MEMBER, NEW_MEMBER] }, MANAGER, TODAY, EARLIER_MEMBER);
    expect(told).toEqual([NEW_MEMBER]);
    expect((await sharedRows(sessionId))[0]).toMatchObject({
      body: 'A teammate shared a session with you',
      actorUserId: MANAGER,
    });
  });

  test('the grants the share wrote are the ones the session now has', async () => {
    const sessionId = await seedSession();
    await share(sessionId, { mode: 'members', memberIds: [NEW_MEMBER], groupIds: [REVIEWERS] });
    const [row] = await db.select({ visibility: projectSessions.visibility }).from(projectSessions).where(eq(projectSessions.sessionId, sessionId));
    expect(row!.visibility).toBe('restricted');
    expect((await loadSessionGrants([sessionId])).get(sessionId)).toHaveLength(2);
  });
});

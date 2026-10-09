// Notification offboarding on PostgreSQL (KRTX-1742). Inbox, watcher,
// preference and Web Push rows key a person by user id with no foreign key,
// so each exit path deletes or moves them itself:
//   - member removal, leave, SCIM deprovision: that account's rows only;
//   - identity reconcile (SSO JIT / SCIM merge): the source's rows move;
//   - account erasure: every row of the person, in every account;
//   - device sign-out: that sign-in's Web Push subscriptions.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { notificationPreferences, notificationWatchers, notifications, triggerWatchers, webPushSubscriptions } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { reconcileAccountIdentities } from '../iam/account-identity';
import { signOutDevice } from '../repositories/auth-devices';
import { db } from '../shared/db';
import { removeSeeded, seedProject, seedSession, type SeededProject } from '../__tests__/helpers/integration-fixtures';
import { deleteMemberNotificationData, deleteUserNotificationData } from './cleanup';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

interface Footprint {
  inbox: number;
  sessionWatchers: number;
  triggerWatchers: number;
}

withDb('notification offboarding', () => {
  const seeded: SeededProject[] = [];
  let team: SeededProject;
  let other: SeededProject;
  let teamSession: string;
  let otherSession: string;
  let person: string;
  let teammate: string;

  /** One inbox row, one session watcher and one trigger watcher for `userId` in `project`. */
  async function seedFootprint(userId: string, project: SeededProject, sessionId: string, dedupeKey: string | null = null) {
    await db.insert(notifications).values({
      userId,
      accountId: project.account_id,
      projectId: project.project_id,
      sessionId,
      kind: 'shared',
      title: 'A shared session',
      dedupeKey,
    });
    await db.insert(notificationWatchers).values({ projectId: project.project_id, sessionId, userId, muted: true });
    await db.insert(triggerWatchers).values({ projectId: project.project_id, slug: 'nightly', userId });
  }

  async function footprint(userId: string, project: SeededProject): Promise<Footprint> {
    const count = async (query: Promise<unknown[]>) => (await query).length;
    return {
      inbox: await count(db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.accountId, project.account_id)))),
      sessionWatchers: await count(db.select().from(notificationWatchers).where(and(eq(notificationWatchers.userId, userId), eq(notificationWatchers.projectId, project.project_id)))),
      triggerWatchers: await count(db.select().from(triggerWatchers).where(and(eq(triggerWatchers.userId, userId), eq(triggerWatchers.projectId, project.project_id)))),
    };
  }

  const ONE: Footprint = { inbox: 1, sessionWatchers: 1, triggerWatchers: 1 };
  const NONE: Footprint = { inbox: 0, sessionWatchers: 0, triggerWatchers: 0 };

  beforeEach(async () => {
    person = crypto.randomUUID();
    teammate = crypto.randomUUID();
    team = await seedProject(`offboard-team-${crypto.randomUUID().slice(0, 8)}`);
    other = await seedProject(`offboard-other-${crypto.randomUUID().slice(0, 8)}`);
    seeded.push(team, other);
    teamSession = await seedSession(team, teammate);
    otherSession = await seedSession(other, person);
    await seedFootprint(person, team, teamSession);
    await seedFootprint(person, other, otherSession);
    await seedFootprint(teammate, team, teamSession);
  });

  afterAll(async () => {
    await removeSeeded(seeded);
  });

  test('removal, leave and SCIM deprovision drop the member\'s rows of that account only', async () => {
    await deleteMemberNotificationData(team.account_id, person);

    expect(await footprint(person, team)).toEqual(NONE);
    expect(await footprint(person, other)).toEqual(ONE);
    expect(await footprint(teammate, team)).toEqual(ONE);
  });

  test('an identity reconcile moves the source\'s rows to the target; the target\'s own rows win', async () => {
    const target = crypto.randomUUID();
    // The target already holds the same shared row and a watch on the same session.
    await db.insert(notifications).values({
      userId: target,
      accountId: team.account_id,
      projectId: team.project_id,
      sessionId: teamSession,
      kind: 'shared',
      title: 'Already here',
      dedupeKey: `shared:${teamSession}:2026-10-09`,
    });
    await db.insert(notifications).values({
      userId: person,
      accountId: team.account_id,
      projectId: team.project_id,
      sessionId: teamSession,
      kind: 'shared',
      title: 'Duplicate of the target row',
      dedupeKey: `shared:${teamSession}:2026-10-09`,
    });
    await db.insert(notificationWatchers).values({ projectId: team.project_id, sessionId: teamSession, userId: target, muted: false });

    await reconcileAccountIdentities(team.account_id, [person], target);

    expect(await footprint(person, team)).toEqual(NONE);
    expect(await footprint(target, team)).toEqual({ inbox: 2, sessionWatchers: 1, triggerWatchers: 1 });
    const titles = (await db.select({ title: notifications.title }).from(notifications).where(eq(notifications.userId, target)))
      .map((row) => row.title)
      .sort();
    expect(titles).toEqual(['A shared session', 'Already here']);
    const [watch] = await db.select().from(notificationWatchers).where(and(eq(notificationWatchers.userId, target), eq(notificationWatchers.sessionId, teamSession)));
    expect(watch?.muted).toBe(false);
    // Another account's rows are not part of this account's reconcile.
    expect(await footprint(person, other)).toEqual(ONE);
  });

  test('account erasure drops every row of the person, preferences and browser subscriptions included', async () => {
    await db.insert(notificationPreferences).values([{ userId: person }, { userId: teammate }]);
    await db.insert(webPushSubscriptions).values([
      { endpoint: `https://fcm.googleapis.com/fcm/send/${person}`, userId: person, p256dh: 'p', auth: 'a', authSessionId: crypto.randomUUID(), aal: 'aal1' },
      { endpoint: `https://fcm.googleapis.com/fcm/send/${teammate}`, userId: teammate, p256dh: 'p', auth: 'a', authSessionId: crypto.randomUUID(), aal: 'aal1' },
    ]);

    await deleteUserNotificationData(person);

    expect(await footprint(person, team)).toEqual(NONE);
    expect(await footprint(person, other)).toEqual(NONE);
    expect(await footprint(teammate, team)).toEqual(ONE);
    expect(await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, person))).toEqual([]);
    expect(await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, teammate))).toHaveLength(1);
    expect(await db.select().from(webPushSubscriptions).where(eq(webPushSubscriptions.userId, person))).toEqual([]);
    expect(await db.select().from(webPushSubscriptions).where(eq(webPushSubscriptions.userId, teammate))).toHaveLength(1);
  });

  test('a device sign-out drops the Web Push subscriptions that sign-in registered', async () => {
    const signedOut = crypto.randomUUID();
    const stillIn = crypto.randomUUID();
    await db.execute(sql`
      INSERT INTO auth.users (id, email, instance_id, aud, role)
      VALUES (${person}::uuid, ${`offboard-${person.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
    await db.execute(sql`INSERT INTO auth.sessions (id, user_id) VALUES (${signedOut}::uuid, ${person}::uuid), (${stillIn}::uuid, ${person}::uuid)`);
    await db.insert(webPushSubscriptions).values([
      { endpoint: `https://fcm.googleapis.com/fcm/send/${signedOut}`, userId: person, p256dh: 'p', auth: 'a', authSessionId: signedOut, aal: 'aal1' },
      { endpoint: `https://fcm.googleapis.com/fcm/send/${stillIn}`, userId: person, p256dh: 'p', auth: 'a', authSessionId: stillIn, aal: 'aal1' },
    ]);
    try {
      expect(await signOutDevice(person, signedOut)).toBe(true);
      const left = await db.select({ authSessionId: webPushSubscriptions.authSessionId }).from(webPushSubscriptions).where(eq(webPushSubscriptions.userId, person));
      expect(left).toEqual([{ authSessionId: stillIn }]);
      // Another user's sign-out request for this sign-in changes nothing.
      expect(await signOutDevice(teammate, stillIn)).toBe(false);
      expect(await db.select().from(webPushSubscriptions).where(eq(webPushSubscriptions.userId, person))).toHaveLength(1);
    } finally {
      await db.delete(webPushSubscriptions).where(eq(webPushSubscriptions.userId, person));
      await db.execute(sql`DELETE FROM auth.sessions WHERE user_id = ${person}::uuid`);
      await db.execute(sql`DELETE FROM auth.users WHERE id = ${person}::uuid`);
    }
  });
});

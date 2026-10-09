/**
 * Integration test (real local DB): a session notification reaches only people
 * who may still open the SESSION (KRTX-1722, made session-level by KRTX-1742).
 * KRTX-1722 stopped a member removed from the project but kept in the account
 * from getting session titles and the agent's questions. Its check was the
 * project only, so it also approved the account owner for another member's
 * PRIVATE session, which the owner cannot open. Both cases are pinned here
 * through `notifySessionEvent`, with only the senders injected.
 * Real: the account and project roles, session visibility, the inbox write.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, notifications, projectMembers } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { clearAuthorizeCaches } from '../iam/authorize';
import { liveNotifierDeps } from '../notifications/notifier';
import { notifySessionEvent } from '../notifications/session-push';
import { db } from '../shared/db';
import { deleteFromView, insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const ACCOUNT_ONLY = crypto.randomUUID();
const STRANGER = crypto.randomUUID();
const users = [OWNER, MEMBER, ACCOUNT_ONLY, STRANGER];

let project: SeededProject;
let privateSession: string;

const deps = () =>
  liveNotifierDeps({
    pushEnabled: true,
    listDevices: async () => [],
    sendExpo: async () => {},
    sendWebPush: async () => ({ sent: 0 }),
    sendEmailNow: async () => 'sent',
  });

/** Tell exactly `recipients` that a turn of the member's private session ended. */
function notify(recipients: string[], turnMessageId: string) {
  return notifySessionEvent(
    { type: 'completion', sessionId: privateSession, projectId: project.project_id, turnMessageId, recipients },
    deps(),
  );
}

async function rowCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: notifications.notificationId })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.sessionId, privateSession)));
  return rows.length;
}

beforeAll(async () => {
  project = await seedProject('push-recipients');
  const user = (id: string) =>
    sql`(${id}::uuid, ${`push-${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`;
  await db.execute(sql`
    INSERT INTO auth.users (id, email, instance_id, aud, role)
    VALUES ${user(OWNER)}, ${user(MEMBER)}, ${user(ACCOUNT_ONLY)}, ${user(STRANGER)}`);
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: project.account_id, accountRole: 'owner' },
    { userId: MEMBER, accountId: project.account_id, accountRole: 'member' },
    { userId: ACCOUNT_ONLY, accountId: project.account_id, accountRole: 'member' },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: project.account_id, projectId: project.project_id, userId: MEMBER, projectRole: 'member' },
  ]);
  privateSession = await seedSession(project, MEMBER);
}, 20_000);

afterAll(async () => {
  if (!project) return;
  await removeSeeded([project]);
  await db.execute(sql`DELETE FROM auth.users WHERE id IN (${sql.join(users.map((id) => sql`${id}::uuid`), sql`, `)})`);
});

describe('who may be told about a session', () => {
  test('the creator, a member of the project: yes', async () => {
    expect(await notify([MEMBER], 'msg_1')).toEqual({ reason: 'delivered', recipients: [MEMBER] });
    expect(await rowCount(MEMBER)).toBe(1);
  });

  test('the account owner, for a member`s private session: no (KRTX-1742)', async () => {
    expect(await notify([OWNER], 'msg_2')).toEqual({ reason: 'no_access', recipients: [] });
    expect(await rowCount(OWNER)).toBe(0);
  });

  test('an account member who is not in the project, and a stranger: no', async () => {
    expect(await notify([ACCOUNT_ONLY, STRANGER, MEMBER], 'msg_3')).toEqual({ reason: 'delivered', recipients: [MEMBER] });
    expect(await rowCount(ACCOUNT_ONLY)).toBe(0);
    expect(await rowCount(STRANGER)).toBe(0);
  });

  test('the creator removed from the project but kept in the account: no (KRTX-1722)', async () => {
    const before = await rowCount(MEMBER);
    await deleteFromView(
      db,
      projectMembers,
      and(eq(projectMembers.projectId, project.project_id), eq(projectMembers.userId, MEMBER)),
    );
    clearAuthorizeCaches();
    expect(await notify([MEMBER], 'msg_4')).toEqual({ reason: 'no_access', recipients: [] });
    expect(await rowCount(MEMBER)).toBe(before);
  });
});

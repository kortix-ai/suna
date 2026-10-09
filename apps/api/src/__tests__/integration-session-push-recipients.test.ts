/**
 * Integration test (real local DB): who a session notification may reach.
 *
 * Flag on (`notification_center`): only people who may still open the
 * SESSION (KRTX-1722, made session-level by KRTX-1742). KRTX-1722 stopped a
 * member removed from the project but kept in the account from getting
 * session titles and the agent's questions. Its check was the project only,
 * so it also approved the account owner for another member's PRIVATE session,
 * which the owner cannot open. Both cases are pinned here through
 * `notifySessionEvent`, with only the senders injected.
 *
 * Flag off (the default): the pre-KRTX-1742 contract. The creator's phones
 * get the Expo push, the check is the project only (`mayReceiveSessionPush`),
 * any live tab holds the push back, and no inbox row is written.
 *
 * Real: the flag read, the account and project roles, session visibility,
 * presence leases, device tokens, the inbox write.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, notifications, projectMembers, pushDeviceTokens, sessionPresenceLeases } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { clearAuthorizeCaches } from '../iam/authorize';
import type { ExpoPushMessage } from '../notifications/expo-push';
import { liveNotifierDeps } from '../notifications/notifier';
import { notifySessionEvent } from '../notifications/session-push';
import { mayReceiveSessionPush } from '../notifications/session-push-legacy';
import { db } from '../shared/db';
import { deleteFromView, insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const ACCOUNT_ONLY = crypto.randomUUID();
const STRANGER = crypto.randomUUID();
const users = [OWNER, MEMBER, ACCOUNT_ONLY, STRANGER];

const FLAG_ON = { experimental: { notification_center: true } };

let project: SeededProject;
/** The same account, the flag left at its default (off). */
let legacy: SeededProject;
let privateSession: string;
let legacySession: string;

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
    { notifierDeps: deps() },
  );
}

async function rowCount(userId: string, sessionId = privateSession): Promise<number> {
  const rows = await db
    .select({ id: notifications.notificationId })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.sessionId, sessionId)));
  return rows.length;
}

const token = (userId: string) => `ExponentPushToken[${userId}]`;

/** A turn end on the flag-off project, with the Expo sender captured. */
async function legacyEnd(extra: { recipients?: string[] } = {}) {
  const sent: ExpoPushMessage[] = [];
  let contextLookups = 0;
  const outcome = await notifySessionEvent(
    { type: 'completion', sessionId: legacySession, projectId: legacy.project_id, turnMessageId: 'msg_legacy', ...extra },
    {
      context: async () => {
        contextLookups += 1;
        return { prompterUserId: OWNER };
      },
      legacyDeps: {
        enabled: true,
        send: async (messages) => {
          sent.push(...messages);
          return { tickets: [], removedTokens: [], failedMessages: 0 };
        },
      },
    },
  );
  return { outcome, sent, contextLookups };
}

beforeAll(async () => {
  project = await seedProject('push-recipients', { metadata: FLAG_ON });
  legacy = await seedProject('push-recipients-legacy', { accountId: project.account_id });
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
    { accountId: legacy.account_id, projectId: legacy.project_id, userId: MEMBER, projectRole: 'member' },
  ]);
  await db.insert(pushDeviceTokens).values(users.map((userId) => ({ token: token(userId), userId, platform: 'ios' })));
  privateSession = await seedSession(project, MEMBER);
  legacySession = await seedSession(legacy, MEMBER);
}, 20_000);

afterAll(async () => {
  if (!project) return;
  await db.delete(pushDeviceTokens).where(inArray(pushDeviceTokens.userId, users));
  await removeSeeded(legacy ? [project, legacy] : [project]);
  await db.execute(sql`DELETE FROM auth.users WHERE id IN (${sql.join(users.map((id) => sql`${id}::uuid`), sql`, `)})`);
});

// Flag-off cases first: the flag-on block below removes MEMBER from `project`.
describe('flag off: the pre-KRTX-1742 creator-only push', () => {
  test('the creator`s phone gets the old payload; no context lookup, no inbox row', async () => {
    const { outcome, sent, contextLookups } = await legacyEnd();
    expect(outcome).toMatchObject({ sent: 1, reason: 'sent' });
    expect(contextLookups).toBe(0);
    expect(sent.map((m) => [m.to, m.body, m.data])).toEqual([
      [token(MEMBER), 'Session complete. Tap to see the result.', { type: 'completion', projectId: legacy.project_id, sessionId: legacySession }],
    ]);
    expect(await rowCount(MEMBER, legacySession)).toBe(0);
    expect(await rowCount(OWNER, legacySession)).toBe(0);
  });

  // KRTX-1742 made this session-level; the flag-off path keeps the project rule.
  test('a named account owner passes the project check, even for a member`s private session', async () => {
    const { outcome, sent } = await legacyEnd({ recipients: [OWNER] });
    expect(outcome).toMatchObject({ sent: 1, reason: 'sent' });
    expect(sent.map((m) => m.to)).toEqual([token(OWNER)]);
  });

  test('any live tab of the creator holds the push back, alerting or not', async () => {
    await db.insert(sessionPresenceLeases).values({
      userId: MEMBER,
      sessionId: legacySession,
      tabId: crypto.randomUUID(),
      expiresAt: sql`now() + interval '90 seconds'`,
      alerts: false,
    });
    const { outcome, sent } = await legacyEnd();
    expect(outcome).toEqual({ sent: 0, reason: 'present' });
    expect(sent).toEqual([]);
    await db.delete(sessionPresenceLeases).where(eq(sessionPresenceLeases.sessionId, legacySession));
  });
});

describe('flag off: who may receive a session push (mayReceiveSessionPush, KRTX-1722)', () => {
  const target = () => ({
    createdBy: MEMBER,
    title: 'A session title',
    accountId: legacy.account_id,
    projectId: legacy.project_id,
  });

  test('the account owner and a member of the project: yes', async () => {
    expect(await mayReceiveSessionPush(OWNER, target())).toBe(true);
    expect(await mayReceiveSessionPush(MEMBER, target())).toBe(true);
  });

  test('an account member who is not in the project, and a stranger: no', async () => {
    expect(await mayReceiveSessionPush(ACCOUNT_ONLY, target())).toBe(false);
    expect(await mayReceiveSessionPush(STRANGER, target())).toBe(false);
  });

  test('a session with no project or account on record: no', async () => {
    expect(await mayReceiveSessionPush(OWNER, { ...target(), projectId: null })).toBe(false);
    expect(await mayReceiveSessionPush(OWNER, { ...target(), accountId: null })).toBe(false);
  });

  test('the creator removed from the project but kept in the account: no', async () => {
    await deleteFromView(
      db,
      projectMembers,
      and(eq(projectMembers.projectId, legacy.project_id), eq(projectMembers.userId, MEMBER)),
    );
    clearAuthorizeCaches();
    expect(await mayReceiveSessionPush(MEMBER, target())).toBe(false);
    const { outcome, sent } = await legacyEnd();
    expect(outcome).toEqual({ sent: 0, reason: 'no_access' });
    expect(sent).toEqual([]);
  });
});

describe('flag on: who may be told about a session', () => {
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

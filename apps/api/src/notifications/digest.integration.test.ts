// The notification worker on PostgreSQL (KRTX-1742): the email digest of
// unread rows (one email per user per hour, ALL due rows claimed, 10 listed
// plus "and N more", answered questions and rows the user can no longer see
// dropped but stamped, never a permission ask) and the 90-day retention sweep.
// A row of a project with the `notification_center` flag off is never mailed.
// Real: the inbox rows, pending questions, auth emails and the rendering.
// Captured: the email transport.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, notifications, sessionPendingQuestions } from '@kortix/db';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { NotificationKindName } from '@kortix/shared/notification-kinds';
import type { EmailMessage, EmailSendResult } from '../lib/email/types';
import { db } from '../shared/db';
import { insertIntoView } from '../__tests__/helpers/compat-views';
import { removeSeeded, seedProject, seedSession, type SeededProject } from '../__tests__/helpers/integration-fixtures';
import { runNotificationDigestTick, sweepExpiredNotifications, type DigestDeps } from './digest';
import { DIGEST_EMAIL_CATEGORY, setNotificationEmailSenderForTest } from './email-delivery';
import { deliver, liveNotifierDeps } from './notifier';
import { absoluteAppUrl } from './notification-email';
import { updateNotificationPreferences } from './preferences';

const seeded: SeededProject[] = [];
const users: string[] = [];
let sent: EmailMessage[] = [];
let answer: EmailSendResult = { ok: true, provider: 'mailpit', status: 200 };

/** The digest with email available and every row still visible, unless a test says otherwise. */
const everyRowVisible: Partial<DigestDeps> = { emailAvailable: () => true, filterVisible: async (_userId, rows) => rows };

async function userWithEmail(): Promise<{ userId: string; email: string }> {
  const userId = crypto.randomUUID();
  const email = `digest-${userId.slice(0, 8)}@example.test`;
  users.push(userId);
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role)
    values (${userId}::uuid, ${email}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
  return { userId, email };
}

interface RowSpec {
  kind?: NotificationKindName;
  sessionId?: string | null;
  title?: string;
  body?: string;
  emailDueAt?: SQL | null;
  emailedAt?: SQL | null;
  readAt?: SQL | null;
  createdAt?: SQL;
}

async function row(userId: string, project: SeededProject, spec: RowSpec = {}): Promise<string> {
  const [inserted] = await db
    .insert(notifications)
    .values({
      userId,
      accountId: project.account_id,
      projectId: project.project_id,
      sessionId: spec.sessionId ?? null,
      kind: spec.kind ?? 'turn_error',
      title: spec.title ?? 'A session',
      body: spec.body ?? '',
      emailDueAt: spec.emailDueAt === undefined ? sql`now() - interval '1 minute'` : spec.emailDueAt,
      emailedAt: spec.emailedAt ?? null,
      readAt: spec.readAt ?? null,
      ...(spec.createdAt ? { createdAt: spec.createdAt } : {}),
    })
    .returning({ id: notifications.notificationId });
  return inserted!.id;
}

async function stateOf(ids: string[]) {
  const rows = await db.select().from(notifications).where(inArray(notifications.notificationId, ids));
  return new Map(rows.map((r) => [r.notificationId, r]));
}

async function question(project: SeededProject, sessionId: string, answered: boolean): Promise<void> {
  await db.insert(sessionPendingQuestions).values({
    accountId: project.account_id,
    projectId: project.project_id,
    sessionId,
    requestId: `q-${crypto.randomUUID()}`,
    questions: [{ question: 'Which region?' }],
    answeredAt: answered ? sql`now()` as unknown as string : null,
  });
}

setNotificationEmailSenderForTest(async (message) => {
  sent.push(message);
  return answer;
});

afterAll(async () => {
  setNotificationEmailSenderForTest(null);
  await db.delete(sessionPendingQuestions).where(inArray(sessionPendingQuestions.projectId, seeded.map((p) => p.project_id)));
  for (const userId of users) {
    await db.delete(notifications).where(eq(notifications.userId, userId));
    await db.execute(sql`delete from auth.users where id = ${userId}::uuid`);
  }
  await removeSeeded(seeded);
});

let project: SeededProject;

beforeEach(async () => {
  sent = [];
  answer = { ok: true, provider: 'mailpit', status: 200 };
  // One digest tick reads every user with due rows: start each test from a clean inbox.
  await db.update(notifications).set({ emailedAt: sql`now() - interval '1 day'` }).where(sql`${notifications.emailedAt} IS NULL`);
  project = await seedProject(`digest-${crypto.randomUUID().slice(0, 8)}`, { metadata: { experimental: { notification_center: true } } });
  seeded.push(project);
});

describe('the email digest', () => {
  test('a deployment that cannot send email claims nothing and sends nothing', async () => {
    const { userId } = await userWithEmail();
    const id = await row(userId, project);

    expect(await runNotificationDigestTick({ ...everyRowVisible, emailAvailable: () => false }))
      .toEqual({ users: 0, sent: 0, claimed: 0, dropped: 0 });
    expect(sent).toEqual([]);
    expect((await stateOf([id])).get(id)!.emailedAt).toBeNull();
  });

  test('a row due for over a day is no longer due, even while email is off; a fresh one stays due', async () => {
    const { userId } = await userWithEmail();
    const stale = await row(userId, project, { emailDueAt: sql`now() - interval '2 days'` });
    const fresh = await row(userId, project);

    await runNotificationDigestTick({ ...everyRowVisible, emailAvailable: () => false });
    const state = await stateOf([stale, fresh]);
    expect(state.get(stale)!.emailDueAt).toBeNull();
    expect(state.get(fresh)!.emailDueAt).not.toBeNull();
    expect(sent).toEqual([]);
  });

  test('ALL due unread rows are claimed into ONE email listing the 10 newest and "And 2 more."', async () => {
    const { userId, email } = await userWithEmail();
    const sessionId = await seedSession(project, userId);
    const due: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      due.push(await row(userId, project, {
        kind: (['turn_error', 'question', 'shared'] as const)[i % 3],
        sessionId,
        title: `Row ${i}`,
        createdAt: sql`now() - make_interval(mins => ${20 + i})`,
      }));
    }
    const notYet = await row(userId, project, { emailDueAt: sql`now() + interval '10 minutes'` });
    const read = await row(userId, project, { readAt: sql`now()` });

    const result = await runNotificationDigestTick(everyRowVisible);

    expect(result).toEqual({ users: 1, sent: 1, claimed: 12, dropped: 0 });
    expect(sent).toHaveLength(1);
    const [message] = sent;
    expect(message!.to).toEqual([email]);
    expect(message!.category).toBe(DIGEST_EMAIL_CATEGORY);
    expect(message!.subject).toBe('Review 12 unread notifications in Kortix');
    for (let i = 0; i < 10; i += 1) expect(message!.text).toContain(`Row ${i}\n`);
    expect(message!.text).not.toContain('Row 10');
    expect(message!.text).not.toContain('Row 11');
    expect(message!.text).toContain('And 2 more.');
    expect(message!.text).toContain(absoluteAppUrl(`/projects/${project.project_id}/sessions/${sessionId}?notification=${due[0]}`));

    const state = await stateOf([...due, notYet, read]);
    for (const id of due) expect(state.get(id)!.emailedAt).not.toBeNull();
    expect(state.get(notYet)!.emailedAt).toBeNull();
    // Read before its digest was due: never emailed, and out of the due index.
    expect(state.get(read)).toMatchObject({ emailedAt: null, emailDueAt: null });

    expect(await runNotificationDigestTick(everyRowVisible)).toMatchObject({ claimed: 0, sent: 0 });
    expect(sent).toHaveLength(1);
  });

  test('a user gets at most one digest per 60 minutes', async () => {
    const { userId } = await userWithEmail();
    const earlier = await row(userId, project, { emailedAt: sql`now() - interval '30 minutes'` });
    const fresh = await row(userId, project, { title: 'Fresh row' });

    expect(await runNotificationDigestTick(everyRowVisible)).toMatchObject({ users: 0, sent: 0 });
    expect((await stateOf([fresh])).get(fresh)!.emailedAt).toBeNull();

    await db.update(notifications).set({ emailedAt: sql`now() - interval '61 minutes'` }).where(eq(notifications.notificationId, earlier));
    expect(await runNotificationDigestTick(everyRowVisible)).toMatchObject({ users: 1, sent: 1, claimed: 1 });
    expect(sent.map((m) => m.subject)).toEqual(['Review 1 unread notification in Kortix']);
  });

  test('a question already answered is dropped but stamped; an open one is listed', async () => {
    const { userId } = await userWithEmail();
    const answeredSession = await seedSession(project, userId);
    const openSession = await seedSession(project, userId);
    await question(project, answeredSession, true);
    await question(project, openSession, false);
    const stale = await row(userId, project, { kind: 'question', sessionId: answeredSession, title: 'Answered already', body: 'Which region?' });
    const open = await row(userId, project, { kind: 'question', sessionId: openSession, title: 'Still asking', body: 'Which bucket?' });

    expect(await runNotificationDigestTick(everyRowVisible)).toEqual({ users: 1, sent: 1, claimed: 2, dropped: 1 });
    expect(sent[0]!.text).toContain('Question waiting: Still asking\nWhich bucket?');
    expect(sent[0]!.text).not.toContain('Answered already');
    const state = await stateOf([stale, open]);
    expect(state.get(stale)!.emailedAt).not.toBeNull();
    expect(state.get(open)!.emailedAt).not.toBeNull();
  });

  test('a row the user can no longer see is dropped but stamped; with nothing left, no email', async () => {
    const { userId } = await userWithEmail();
    const hidden = await row(userId, project, { title: 'Revoked share' });
    const deps: Partial<DigestDeps> = {
      ...everyRowVisible,
      filterVisible: async (_userId, rows) => rows.filter((r) => r.notificationId !== hidden),
    };

    expect(await runNotificationDigestTick(deps)).toEqual({ users: 1, sent: 0, claimed: 1, dropped: 1 });
    expect(sent).toEqual([]);
    expect((await stateOf([hidden])).get(hidden)!.emailedAt).not.toBeNull();
    expect(await runNotificationDigestTick(deps)).toMatchObject({ claimed: 0 });
  });

  test('the live access filter keeps a row about the user\'s own session in their own account', async () => {
    const { userId } = await userWithEmail();
    await insertIntoView(db, accountMembers, { userId, accountId: project.account_id, accountRole: 'owner' });
    const sessionId = await seedSession(project, userId);
    await row(userId, project, { sessionId, title: 'My own session' });

    expect(await runNotificationDigestTick({ emailAvailable: () => true })).toMatchObject({ sent: 1, dropped: 0 });
    expect(sent[0]!.text).toContain('Session failed: My own session');
  });

  test('the live access filter drops a row of a project with the notification_center flag off: stamped, no email', async () => {
    const { userId } = await userWithEmail();
    const flagOff = await seedProject(`digest-off-${crypto.randomUUID().slice(0, 8)}`);
    seeded.push(flagOff);
    await insertIntoView(db, accountMembers, { userId, accountId: flagOff.account_id, accountRole: 'owner' });
    const sessionId = await seedSession(flagOff, userId);
    const id = await row(userId, flagOff, { sessionId, title: 'My own session' });

    expect(await runNotificationDigestTick({ emailAvailable: () => true })).toEqual({ users: 1, sent: 0, claimed: 1, dropped: 1 });
    expect(sent).toEqual([]);
    expect((await stateOf([id])).get(id)!.emailedAt).not.toBeNull();
  });

  test('a permission ask is never digested, even with permission email turned on', async () => {
    const { userId } = await userWithEmail();
    await updateNotificationPreferences(userId, { kinds: { permission: { email: true } } });
    const [record] = await deliver(
      { kind: 'permission', accountId: project.account_id, projectId: project.project_id, sessionId: crypto.randomUUID(), title: 'S', recipients: [userId] },
      liveNotifierDeps({ pushEnabled: false }),
    );
    expect((await stateOf([record!.notificationId!])).get(record!.notificationId!)!.emailDueAt).toBeNull();

    // A permission or automation row that carries a due time anyway is claimed, not mailed.
    const permission = await row(userId, project, { kind: 'permission' });
    const automation = await row(userId, project, { kind: 'automation_failed' });
    expect(await runNotificationDigestTick(everyRowVisible)).toEqual({ users: 1, sent: 0, claimed: 2, dropped: 2 });
    expect(sent).toEqual([]);
    const state = await stateOf([permission, automation]);
    expect(state.get(permission)!.emailedAt).not.toBeNull();
    expect(state.get(automation)!.emailedAt).not.toBeNull();
  });

  test('a failed send leaves the rows stamped: no retry storm', async () => {
    const { userId } = await userWithEmail();
    const id = await row(userId, project);
    answer = { ok: false, provider: 'ses', status: 500, error: 'provider down' };

    expect(await runNotificationDigestTick(everyRowVisible)).toEqual({ users: 1, sent: 0, claimed: 1, dropped: 0 });
    expect(sent).toHaveLength(1);
    expect((await stateOf([id])).get(id)!.emailedAt).not.toBeNull();
  });
});

describe('retention', () => {
  test('rows older than 90 days are deleted in batches of 1,000; younger rows stay', async () => {
    const { userId } = await userWithEmail();
    await db.execute(sql`
      insert into kortix.notifications (user_id, account_id, kind, title, created_at)
      select ${userId}::uuid, ${project.account_id}::uuid, 'turn_done', 'old', now() - interval '91 days'
      from generate_series(1, 1001)`);
    const recent = await row(userId, project, { emailDueAt: null, createdAt: sql`now() - interval '89 days'` });

    expect(await sweepExpiredNotifications()).toBe(1001);
    const left = await db.select({ id: notifications.notificationId }).from(notifications).where(eq(notifications.userId, userId));
    expect(left.map((r) => r.id)).toEqual([recent]);
    expect(await sweepExpiredNotifications()).toBe(0);
  });
});

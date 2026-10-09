// The notification fan-out on PostgreSQL (KRTX-1742): one inbox row per
// recipient, dedupe per recipient, read on arrival for a recipient who has the
// session open, push held back only by a tab that alerts, digest due time from
// the preferences, immediate email for automation kinds, and the kill switch
// stopping sends but never rows. The three senders are captured; every query
// runs against the real database.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { notificationPreferences, notifications, sessionPresenceLeases } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { NOTIFICATION_DIGEST_DELAY_MS } from '@kortix/shared/notification-kinds';
import { db } from '../shared/db';
import { removeSeeded, seedProject, seedSession, type SeededProject } from '../__tests__/helpers/integration-fixtures';
import type { PushDeviceTokenRow } from './device-tokens';
import type { ExpoPushMessage } from './expo-push';
import { deliver, liveNotifierDeps, type NotifierDeps } from './notifier';
import { loadEffectivePreferences, updateNotificationPreferences } from './preferences';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const NOW = new Date('2026-10-09T12:00:00.000Z');

function device(userId: string): PushDeviceTokenRow {
  return {
    token: `ExponentPushToken[${userId}]`,
    userId,
    platform: 'ios',
    provider: 'expo',
    enabled: true,
    onCompletion: true,
    onError: true,
    onQuestion: true,
    onPermission: true,
    playSound: true,
    authSessionId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

interface Captured {
  expo: ExpoPushMessage[];
  webPush: string[];
  email: string[];
}

function harness(overrides: Partial<NotifierDeps> = {}): { deps: NotifierDeps; sent: Captured } {
  const sent: Captured = { expo: [], webPush: [], email: [] };
  const deps = liveNotifierDeps({
    pushEnabled: true,
    listDevices: async (userId) => [device(userId)],
    sendExpo: async (messages) => { sent.expo.push(...messages); },
    sendWebPush: async ({ userId }) => { sent.webPush.push(userId); return { sent: 1 }; },
    emailAvailable: () => true,
    sendEmailNow: async ({ userId }) => { sent.email.push(userId); return 'sent'; },
    now: () => NOW,
    ...overrides,
  });
  return { deps, sent };
}

async function rowsOf(userId: string) {
  return db.select().from(notifications).where(eq(notifications.userId, userId));
}

withDb('notification fan-out', () => {
  const seeded: SeededProject[] = [];
  let project: SeededProject;
  let sessionId: string;
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    alice = crypto.randomUUID();
    bob = crypto.randomUUID();
    project = await seedProject(`notify-${crypto.randomUUID().slice(0, 8)}`);
    seeded.push(project);
    sessionId = await seedSession(project, alice);
  });

  afterAll(async () => {
    await removeSeeded(seeded);
  });

  test('every recipient gets one unread row and one push on each channel', async () => {
    const { deps, sent } = harness();
    const records = await deliver({
      kind: 'turn_done',
      accountId: project.account_id,
      projectId: project.project_id,
      sessionId,
      title: 'Refactor the billing page',
      recipients: [alice, bob, alice],
    }, deps);

    expect(records.map((r) => r.userId).sort()).toEqual([alice, bob].sort());
    for (const userId of [alice, bob]) {
      const [row] = await rowsOf(userId);
      expect(row).toMatchObject({ kind: 'turn_done', title: 'Refactor the billing page', sessionId, readAt: null, emailDueAt: null });
    }
    expect(sent.expo.map((m) => m.to).sort()).toEqual([`ExponentPushToken[${alice}]`, `ExponentPushToken[${bob}]`].sort());
    expect(sent.expo[0]).toMatchObject({ body: 'Session complete. Tap to see the result.' });
    expect(sent.expo[0]!.data).toMatchObject({ kind: 'turn_done', type: 'completion', sessionId });
    expect(String(sent.expo[0]!.data.url)).toContain(`/projects/${project.project_id}/sessions/${sessionId}?notification=`);
    expect(sent.webPush.sort()).toEqual([alice, bob].sort());
    expect(sent.email).toEqual([]);
  });

  test('a repeat with the same dedupe key writes and sends nothing', async () => {
    const { deps, sent } = harness();
    const input = {
      kind: 'shared' as const,
      accountId: project.account_id,
      projectId: project.project_id,
      sessionId,
      title: 'Quarterly report',
      dedupeKey: `shared:${sessionId}:2026-10-09`,
      recipients: [bob],
    };
    await deliver(input, deps);
    const second = await deliver(input, deps);

    expect(second[0]!.notificationId).toBeNull();
    expect(await rowsOf(bob)).toHaveLength(1);
    expect(sent.expo).toHaveLength(1);
  });

  test('a tab that alerts holds back the push; a tab that does not still gets it, and both rows arrive read', async () => {
    await db.insert(sessionPresenceLeases).values([
      { userId: alice, sessionId, tabId: crypto.randomUUID(), expiresAt: sql`now() + interval '90 seconds'`, alerts: true },
      { userId: bob, sessionId, tabId: crypto.randomUUID(), expiresAt: sql`now() + interval '90 seconds'`, alerts: false },
    ]);
    const { deps, sent } = harness();
    await deliver({ kind: 'turn_done', accountId: project.account_id, projectId: project.project_id, sessionId, title: 'Open session', recipients: [alice, bob] }, deps);

    expect(sent.expo.map((m) => m.to)).toEqual([`ExponentPushToken[${bob}]`]);
    expect(sent.webPush).toEqual([bob]);
    expect((await rowsOf(alice))[0]!.readAt).not.toBeNull();
    expect((await rowsOf(bob))[0]!.readAt).not.toBeNull();
  });

  test('an expired lease is not presence', async () => {
    await db.insert(sessionPresenceLeases).values({
      userId: alice, sessionId, tabId: crypto.randomUUID(), expiresAt: sql`now() - interval '1 second'`, alerts: true,
    });
    const { deps, sent } = harness();
    await deliver({ kind: 'turn_done', accountId: project.account_id, projectId: project.project_id, sessionId, title: 'S', recipients: [alice] }, deps);

    expect(sent.expo).toHaveLength(1);
    expect((await rowsOf(alice))[0]!.readAt).toBeNull();
  });

  test('the kill switch stops sends but still writes the row', async () => {
    const { deps, sent } = harness({ pushEnabled: false });
    await deliver({ kind: 'question', accountId: project.account_id, projectId: project.project_id, sessionId, title: 'S', body: 'Which region?', recipients: [alice] }, deps);

    expect(await rowsOf(alice)).toHaveLength(1);
    expect(sent.expo).toEqual([]);
    expect(sent.webPush).toEqual([]);
  });

  test('a question with email on gets a digest due time; push off sends no push', async () => {
    await updateNotificationPreferences(alice, { kinds: { question: { push: false } } });
    const { deps, sent } = harness();
    await deliver({ kind: 'question', accountId: project.account_id, projectId: project.project_id, sessionId, title: 'S', body: 'Which region?', recipients: [alice] }, deps);

    const [row] = await rowsOf(alice);
    expect(row!.body).toBe('Which region?');
    expect(row!.emailDueAt?.getTime()).toBe(NOW.getTime() + NOTIFICATION_DIGEST_DELAY_MS);
    expect(sent.expo).toEqual([]);
    expect(sent.email).toEqual([]);
  });

  test('turn_done and permission never get a digest due time by default', async () => {
    const { deps } = harness();
    await deliver({ kind: 'permission', accountId: project.account_id, projectId: project.project_id, sessionId, title: 'S', recipients: [alice] }, deps);
    await deliver({ kind: 'turn_done', accountId: project.account_id, projectId: project.project_id, sessionId, title: 'S', recipients: [alice] }, deps);

    expect((await rowsOf(alice)).map((r) => r.emailDueAt)).toEqual([null, null]);
  });

  test('an automation failure is emailed at once and stamped', async () => {
    const { deps, sent } = harness();
    await deliver({
      kind: 'automation_failed',
      accountId: project.account_id,
      projectId: project.project_id,
      triggerSlug: 'nightly-report',
      title: 'Nightly report',
      body: 'Insufficient credits',
      recipients: [alice],
    }, deps);

    const [row] = await rowsOf(alice);
    expect(sent.email).toEqual([alice]);
    expect(row!.emailedAt).not.toBeNull();
    expect(row!.emailDueAt).toBeNull();
    expect(sent.expo[0]).toMatchObject({ body: 'Failing: Insufficient credits' });
    expect(String(sent.expo[0]!.data.url)).toContain(`/projects/${project.project_id}/customize/triggers?notification=`);
  });

  test('no email is attempted when the deployment cannot send email', async () => {
    const { deps, sent } = harness({ emailAvailable: () => false });
    await deliver({ kind: 'automation_failed', accountId: project.account_id, projectId: project.project_id, triggerSlug: 't', title: 'T', recipients: [alice] }, deps);

    expect(sent.email).toEqual([]);
    expect((await rowsOf(alice))[0]!.emailedAt).toBeNull();
  });
});

withDb('notification preferences', () => {
  test('a user with no record gets the defaults', async () => {
    const user = crypto.randomUUID();
    const prefs = (await loadEffectivePreferences([user])).get(user)!;
    expect(prefs.turn_done).toEqual({ push: true, email: false });
    expect(prefs.automation_failed).toEqual({ push: true, email: true });
  });

  test('saves merge per kind and per channel', async () => {
    const user = crypto.randomUUID();
    await updateNotificationPreferences(user, { kinds: { question: { email: false } } });
    await updateNotificationPreferences(user, { kinds: { question: { push: false }, shared: { email: false } } });
    const prefs = await updateNotificationPreferences(user, { kinds: { turn_done: { push: false } } });

    expect(prefs.question).toEqual({ push: false, email: false });
    expect(prefs.shared).toEqual({ push: true, email: false });
    expect(prefs.turn_done).toEqual({ push: false, email: false });
    const [row] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, user));
    expect(row!.settings).toEqual({
      kinds: { question: { push: false, email: false }, shared: { email: false }, turn_done: { push: false } },
    });
  });

  test('unknown kinds and non-boolean values are dropped', async () => {
    const user = crypto.randomUUID();
    const prefs = await updateNotificationPreferences(user, {
      kinds: { question: { push: 'no' as unknown as boolean }, bogus: { push: false } } as never,
    });
    expect(prefs.question).toEqual({ push: true, email: true });
    const [row] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, user));
    expect(row!.settings).toEqual({ kinds: {} });
  });
});

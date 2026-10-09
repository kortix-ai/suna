/**
 * Integration test (real local DB): who a session event reaches (KRTX-1742
 * design §3.1). Each case runs the path the relays run: resolve the context
 * in projects/ (the prompter from the prompt rows or the running turn, the
 * origin class, the trigger watchers), then `notifySessionEvent` computes the
 * set, checks access and calls `deliver`. Only the three senders are injected;
 * the prompt, watcher, access, presence, preference and inbox queries are real.
 *
 * Acceptance 1: B prompts in A's session → B and A each get a row.
 * Acceptance 6: an email- or Slack-origin turn end → no row for the owner who
 * stands in as its creator; the same seed from the web → a row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  notifications,
  projectMembers,
  projectSessions,
  pushDeviceTokens,
  sessionLifecycleCommands,
  sessionPresenceLeases,
  sessionSandboxes,
  triggerWatchers,
} from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ExpoPushMessage } from '../notifications/expo-push';
import { liveNotifierDeps, type NotifierDeps } from '../notifications/notifier';
import { createPermissionPushGate } from '../notifications/permission-push';
import { notifySessionEvent, type SessionPushEvent } from '../notifications/session-push';
import { setSessionWatch } from '../notifications/watchers';
import {
  askNotificationContext,
  personPrompterOf,
  runningTurnPrompter,
  turnEndNotificationContext,
} from '../projects/lib/notification-recipients';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID(); // account owner: the stand-in creator of channel sessions
const A = crypto.randomUUID(); // project member, creates the session
const B = crypto.randomUUID(); // project member, prompts it
const C = crypto.randomUUID(); // project member, follows it explicitly
const W = crypto.randomUUID(); // project member, follows the trigger
const OUTSIDER = crypto.randomUUID(); // account member without the project
const SERVICE_ACCOUNT = crypto.randomUUID(); // a trigger session's creator
const users = [OWNER, A, B, C, W, OUTSIDER];

let project: SeededProject;

interface Sent {
  expo: ExpoPushMessage[];
  webPush: string[];
}
let sent: Sent;
let deps: NotifierDeps;

beforeAll(async () => {
  project = await seedProject('notify-recipients');
  const user = (id: string) =>
    sql`(${id}::uuid, ${`recipients-${id.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`;
  await db.execute(sql`
    INSERT INTO auth.users (id, email, instance_id, aud, role)
    VALUES ${sql.join(users.map(user), sql`, `)}`);
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: project.account_id, accountRole: 'owner' },
    ...[A, B, C, W, OUTSIDER].map((userId) => ({ userId, accountId: project.account_id, accountRole: 'member' as const })),
  ]);
  await insertIntoView(
    db,
    projectMembers,
    [A, B, C, W].map((userId) => ({
      accountId: project.account_id,
      projectId: project.project_id,
      userId,
      projectRole: 'member' as const,
    })),
  );
  await db.insert(pushDeviceTokens).values(
    users.map((userId) => ({ token: `ExponentPushToken[${userId}]`, userId, platform: 'ios' })),
  );
}, 30_000);

afterAll(async () => {
  if (!project) return;
  await db.delete(pushDeviceTokens).where(inArray(pushDeviceTokens.userId, users));
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.projectId, project.project_id));
  await removeSeeded([project]);
  await db.execute(sql`DELETE FROM auth.users WHERE id IN (${sql.join(users.map((id) => sql`${id}::uuid`), sql`, `)})`);
});

beforeEach(() => {
  sent = { expo: [], webPush: [] };
  deps = liveNotifierDeps({
    pushEnabled: true,
    sendExpo: async (messages) => {
      sent.expo.push(...messages);
    },
    sendWebPush: async ({ userId }) => {
      sent.webPush.push(userId);
      return { sent: 1 };
    },
    sendEmailNow: async () => 'sent',
  });
});

/** A visibility-'project' session, so every project member may open it. */
async function seedSession(options: {
  createdBy?: string;
  metadata?: Record<string, unknown>;
  origin?: 'user' | 'trigger' | 'schedule' | 'backend' | 'system';
} = {}): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    branchName: `session/${sessionId}`,
    createdBy: options.createdBy ?? A,
    visibility: 'project',
    origin: options.origin ?? 'user',
    metadata: { name: 'Refactor the billing page', source: 'ui', ...options.metadata },
  });
  return sessionId;
}

/** The `continue_session` row POST /prompts writes for a person's prompt. */
async function seedPrompt(
  sessionId: string,
  actorUserId: string,
  messageId: string,
  payload: Record<string, unknown> = { bindTurnIdentity: true },
): Promise<void> {
  await db.insert(sessionLifecycleCommands).values({
    commandType: 'continue_session',
    source: 'ui',
    status: 'succeeded',
    projectId: project.project_id,
    accountId: project.account_id,
    sessionId,
    actorUserId,
    payload: { clientMessageId: messageId, wireMessageId: messageId, ...payload },
    result: { status: 'forwarded', forwarded_message_id: messageId },
  });
}

/** The session's sandbox with one running turn for `messageId`. */
async function seedRunningTurn(sessionId: string, messageId: string): Promise<void> {
  await db.insert(sessionSandboxes).values({
    sandboxId: crypto.randomUUID(),
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    status: 'active',
    metadata: {
      activeTurns: {
        t1: { token: 't1', state: 'active', messageId, runtimeSessionId: 'ses_root', startedAtMs: Date.now() },
      },
    },
  });
}

async function sessionRef(sessionId: string) {
  const [row] = await db
    .select({ metadata: projectSessions.metadata, origin: projectSessions.origin })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId));
  return { sessionId, projectId: project.project_id, accountId: project.account_id, metadata: row!.metadata, origin: row!.origin };
}

/** What `publishTurnEnd` runs for a closed turn end. */
async function endTurn(sessionId: string, messageId: string, extra: Partial<SessionPushEvent> = {}) {
  const context = await turnEndNotificationContext(await sessionRef(sessionId), messageId);
  return notifySessionEvent(
    { type: 'completion', sessionId, projectId: project.project_id, turnMessageId: messageId, ...context, ...extra },
    deps,
  );
}

/** What POST /turn-question runs for a newly stored question. */
async function askQuestion(sessionId: string, requestId: string, extra: Partial<SessionPushEvent> = {}) {
  const context = await askNotificationContext(await sessionRef(sessionId));
  return notifySessionEvent(
    { type: 'question', sessionId, projectId: project.project_id, question: 'Which region?', requestId, ...context, ...extra },
    deps,
  );
}

async function rowsFor(sessionId: string) {
  return db
    .select({
      userId: notifications.userId,
      kind: notifications.kind,
      body: notifications.body,
      actorUserId: notifications.actorUserId,
      readAt: notifications.readAt,
    })
    .from(notifications)
    .where(eq(notifications.sessionId, sessionId));
}

async function recipientsOf(sessionId: string): Promise<string[]> {
  return (await rowsFor(sessionId)).map((row) => row.userId).sort();
}

const pushedTo = () => sent.expo.map((m) => m.to).sort();
const token = (userId: string) => `ExponentPushToken[${userId}]`;
const sorted = (ids: string[]) => [...ids].sort();

describe('the person who prompted a turn', () => {
  test('is the actor of the newest prompt row the message id names, when it bound a person', async () => {
    const sessionId = await seedSession();
    await seedPrompt(sessionId, B, 'msg_b');
    expect(await personPrompterOf(sessionId, project.account_id, 'msg_b')).toBe(B);
    expect(await personPrompterOf(sessionId, project.account_id, 'msg_unknown')).toBeNull();
    expect(await personPrompterOf(sessionId, project.account_id, null)).toBeNull();
  });

  test('is found under the id a redelivery used', async () => {
    const sessionId = await seedSession();
    await db.insert(sessionLifecycleCommands).values({
      commandType: 'continue_session',
      source: 'ui',
      status: 'succeeded',
      projectId: project.project_id,
      accountId: project.account_id,
      sessionId,
      actorUserId: C,
      payload: { clientMessageId: 'msg_first', wireMessageId: 'msg_first', bindTurnIdentity: true, redeliveredMessageIds: ['msg_again'] },
      result: { status: 'forwarded', forwarded_message_id: 'msg_again' },
    });
    expect(await personPrompterOf(sessionId, project.account_id, 'msg_again')).toBe(C);
  });

  test('is nobody for an unbound prompt, an agent-session prompt, or an API key standing in for the account', async () => {
    const sessionId = await seedSession();
    await seedPrompt(sessionId, B, 'msg_trigger', { bindTurnIdentity: false });
    await seedPrompt(sessionId, B, 'msg_agent', { bindTurnIdentity: true, authorSessionId: crypto.randomUUID() });
    await seedPrompt(sessionId, project.account_id, 'msg_api_key');
    for (const id of ['msg_trigger', 'msg_agent', 'msg_api_key']) {
      expect(await personPrompterOf(sessionId, project.account_id, id)).toBeNull();
    }
  });

  test('of the running turn is read from the sandbox`s newest live turn', async () => {
    const sessionId = await seedSession();
    await seedPrompt(sessionId, B, 'msg_running');
    expect(await runningTurnPrompter(sessionId, project.account_id)).toBeNull();
    await seedRunningTurn(sessionId, 'msg_running');
    expect(await runningTurnPrompter(sessionId, project.account_id)).toBe(B);
  });
});

describe('turn end (turn_done / turn_error)', () => {
  test('acceptance 1: B prompts in A`s session → B and A each get one unread row and a push', async () => {
    const sessionId = await seedSession();
    await seedPrompt(sessionId, B, 'msg_1');
    const outcome = await endTurn(sessionId, 'msg_1');

    expect(outcome.reason).toBe('delivered');
    expect(await recipientsOf(sessionId)).toEqual(sorted([A, B]));
    for (const row of await rowsFor(sessionId)) {
      expect(row).toMatchObject({ kind: 'turn_done', actorUserId: B, readAt: null });
    }
    expect(pushedTo()).toEqual(sorted([token(A), token(B)]));
    expect(sorted(sent.webPush)).toEqual(sorted([A, B]));

    // The relay is retried: one row per person per turn.
    await endTurn(sessionId, 'msg_1');
    expect(await recipientsOf(sessionId)).toEqual(sorted([A, B]));
  });

  test('a turn error carries its message', async () => {
    const sessionId = await seedSession();
    await seedPrompt(sessionId, B, 'msg_err');
    await endTurn(sessionId, 'msg_err', { type: 'error', errorMessage: 'Payment Required: Insufficient credits.' });
    const rows = await rowsFor(sessionId);
    expect(rows.map((row) => row.userId).sort()).toEqual(sorted([A, B]));
    expect(rows[0]).toMatchObject({ kind: 'turn_error', body: 'Payment Required: Insufficient credits.' });
  });

  test('an explicit watcher is told; a muted creator and a muted prompter are not', async () => {
    const sessionId = await seedSession();
    await seedPrompt(sessionId, B, 'msg_w');
    await setSessionWatch(project.project_id, sessionId, C, true);
    await setSessionWatch(project.project_id, sessionId, A, false);
    await endTurn(sessionId, 'msg_w');
    expect(await recipientsOf(sessionId)).toEqual(sorted([B, C]));

    const other = await seedSession();
    await seedPrompt(other, B, 'msg_m');
    await setSessionWatch(project.project_id, other, B, false);
    await endTurn(other, 'msg_m');
    expect(await recipientsOf(other)).toEqual([A]);
  });

  test('a watcher who may not open the session is not told', async () => {
    const sessionId = await seedSession();
    await setSessionWatch(project.project_id, sessionId, OUTSIDER, true);
    await endTurn(sessionId, 'msg_none');
    expect(await recipientsOf(sessionId)).toEqual([A]);
  });

  test('a tab that alerts holds back the push; every present user`s row arrives read', async () => {
    const sessionId = await seedSession();
    await seedPrompt(sessionId, B, 'msg_p');
    await db.insert(sessionPresenceLeases).values([
      { userId: A, sessionId, tabId: crypto.randomUUID(), expiresAt: sql`now() + interval '90 seconds'`, alerts: true },
      { userId: B, sessionId, tabId: crypto.randomUUID(), expiresAt: sql`now() + interval '90 seconds'`, alerts: false },
    ]);
    await endTurn(sessionId, 'msg_p');
    expect(pushedTo()).toEqual([token(B)]);
    expect(sent.webPush).toEqual([B]);
    for (const row of await rowsFor(sessionId)) expect(row.readAt).not.toBeNull();
  });

  test('acceptance 6: an email-origin turn end → no row for the owner who created it', async () => {
    const sessionId = await seedSession({ createdBy: OWNER, metadata: { source: 'email', email: { thread_id: 't1' } } });
    expect((await endTurn(sessionId, 'msg_email')).reason).toBe('no_recipient');
    expect(await recipientsOf(sessionId)).toEqual([]);
    expect(sent.expo).toEqual([]);
  });

  test('acceptance 6: a Slack-origin turn end → no row for the owner; the web prompter gets the row without a push', async () => {
    const sessionId = await seedSession({ createdBy: OWNER, metadata: { source: 'slack', slack: { channel: 'C1' } } });
    await seedPrompt(sessionId, B, 'msg_slack');
    await endTurn(sessionId, 'msg_slack');
    expect(await recipientsOf(sessionId)).toEqual([B]);
    expect(sent.expo).toEqual([]);
    expect(sent.webPush).toEqual([]);
  });

  test('acceptance 6 positive control: the same seed from the web → the owner gets the row', async () => {
    const sessionId = await seedSession({ createdBy: OWNER, metadata: { source: 'ui' } });
    await endTurn(sessionId, 'msg_web');
    expect(await recipientsOf(sessionId)).toEqual([OWNER]);
    expect(pushedTo()).toEqual([token(OWNER)]);
  });

  test('an unattended turn end reaches only its person prompter, never the trigger watchers', async () => {
    const metadata = { trigger_kind: 'git', trigger_slug: 'nightly-end', source: 'trigger:cron' };
    const sessionId = await seedSession({ createdBy: SERVICE_ACCOUNT, origin: 'schedule', metadata });
    await db.insert(triggerWatchers).values({ projectId: project.project_id, slug: 'nightly-end', userId: W });
    expect((await endTurn(sessionId, 'msg_cron')).reason).toBe('no_recipient');
    await seedPrompt(sessionId, B, 'msg_followup');
    await endTurn(sessionId, 'msg_followup');
    expect(await recipientsOf(sessionId)).toEqual([B]);
    expect(pushedTo()).toEqual([token(B)]);
  });

  test('a child session turn end reaches nobody', async () => {
    const parent = await seedSession();
    const sessionId = await seedSession({ metadata: { spawned_by_session: parent, source: 'agent' } });
    await seedPrompt(sessionId, B, 'msg_child');
    expect((await endTurn(sessionId, 'msg_child')).reason).toBe('no_recipient');
    expect(await recipientsOf(sessionId)).toEqual([]);
  });
});

describe('asks (question / permission)', () => {
  test('an attended question reaches the running turn`s prompter and the watchers, once per request id', async () => {
    const sessionId = await seedSession();
    await seedPrompt(sessionId, B, 'msg_q');
    await seedRunningTurn(sessionId, 'msg_q');
    await askQuestion(sessionId, 'que_1');
    await askQuestion(sessionId, 'que_1');

    const rows = await rowsFor(sessionId);
    expect(rows.map((row) => row.userId).sort()).toEqual(sorted([A, B]));
    expect(rows[0]).toMatchObject({ kind: 'question', body: 'Which region?' });
    expect(sent.expo.map((m) => m.body)).toEqual(['Kortix has a question: Which region?', 'Kortix has a question: Which region?']);
  });

  test('a muted creator gets no question; the prompter still does', async () => {
    const sessionId = await seedSession();
    await seedPrompt(sessionId, B, 'msg_qm');
    await seedRunningTurn(sessionId, 'msg_qm');
    await setSessionWatch(project.project_id, sessionId, A, false);
    await askQuestion(sessionId, 'que_m');
    expect(await recipientsOf(sessionId)).toEqual([B]);
  });

  test('an email-origin question reaches the watchers with a push: the thread cannot carry it', async () => {
    const sessionId = await seedSession({ createdBy: OWNER, metadata: { source: 'email', email: { thread_id: 't2' } } });
    await askQuestion(sessionId, 'que_email');
    expect(await recipientsOf(sessionId)).toEqual([OWNER]);
    expect(pushedTo()).toEqual([token(OWNER)]);
  });

  test('a Slack question the thread posted reaches only the prompter, without a push', async () => {
    const sessionId = await seedSession({ createdBy: OWNER, metadata: { source: 'slack', slack: { channel: 'C2' } } });
    await seedPrompt(sessionId, B, 'msg_sq');
    await seedRunningTurn(sessionId, 'msg_sq');
    await askQuestion(sessionId, 'que_slack', { threadCarriesAsk: true });
    expect(await recipientsOf(sessionId)).toEqual([B]);
    expect(sent.expo).toEqual([]);
  });

  test('a Slack question the thread could not post reaches the watchers too, with a push', async () => {
    const sessionId = await seedSession({ createdBy: OWNER, metadata: { source: 'slack', slack: { channel: 'C3' } } });
    await askQuestion(sessionId, 'que_slack_failed', { threadCarriesAsk: false });
    expect(await recipientsOf(sessionId)).toEqual([OWNER]);
    expect(pushedTo()).toEqual([token(OWNER)]);
  });

  test('an unattended question reaches the trigger`s watchers, not the session`s creator', async () => {
    const metadata = { trigger_kind: 'git', trigger_slug: 'nightly-ask', source: 'trigger:cron' };
    const sessionId = await seedSession({ createdBy: SERVICE_ACCOUNT, origin: 'schedule', metadata });
    await db.insert(triggerWatchers).values({ projectId: project.project_id, slug: 'nightly-ask', userId: W });
    await askQuestion(sessionId, 'que_cron');
    expect(await recipientsOf(sessionId)).toEqual([W]);
  });

  test('a child session ask reaches the person who launched the coordinator', async () => {
    const parent = await seedSession();
    const sessionId = await seedSession({ metadata: { spawned_by_session: parent, source: 'agent' } });
    await askQuestion(sessionId, 'que_child');
    expect(await recipientsOf(sessionId)).toEqual([A]);
  });

  test('a permission relayed twice with one request id writes one row per recipient', async () => {
    const sessionId = await seedSession();
    await seedPrompt(sessionId, B, 'msg_perm');
    await seedRunningTurn(sessionId, 'msg_perm');
    const gate = createPermissionPushGate({ notify: (event) => notifySessionEvent(event, deps) });
    const request = {
      sessionId,
      projectId: project.project_id,
      requestId: 'per_1',
      context: async () => askNotificationContext(await sessionRef(sessionId)),
    };
    expect(await gate.notify(request)).toBe(true);
    expect(await gate.notify(request)).toBe(false);
    for (let i = 0; i < 50 && (await rowsFor(sessionId)).length < 2; i++) await Bun.sleep(20);

    const rows = await rowsFor(sessionId);
    expect(rows.map((row) => row.userId).sort()).toEqual(sorted([A, B]));
    expect(rows.every((row) => row.kind === 'permission')).toBe(true);
    const permissionRows = await db
      .select({ id: notifications.notificationId })
      .from(notifications)
      .where(and(eq(notifications.sessionId, sessionId), eq(notifications.kind, 'permission')));
    expect(permissionRows).toHaveLength(2);
  });
});

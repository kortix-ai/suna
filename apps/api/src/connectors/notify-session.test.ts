/**
 * The notification must fire for a STOPPED session.
 *
 * It did not, and that made the feature a no-op in its own common case: the
 * agent mints a connect link, posts it, and its turn ends — so the session is
 * `stopped` long before the human finishes Google. Measured on dev, the connect
 * landed at 18:15:32 against a session that stopped at 18:15:12, and the
 * `running` check dropped the follow-up. Dev holds 3455 stopped sessions to 1
 * running, so gating on `running` is gating on never.
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

const enqueued: Array<Record<string, unknown>> = [];
let sessionRow: Record<string, unknown> | undefined;

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (sessionRow ? [sessionRow] : []) }) }),
    }),
  },
}));

mock.module('../projects/session-lifecycle', () => ({
  enqueueContinueSessionCommand: async (input: Record<string, unknown>) => {
    enqueued.push(input);
    return { row: {}, deduped: false };
  },
  drainSessionLifecycleQueue: async () => ({}),
}));

const { notifyConnectorSession, connectorConnectedPrompt } = await import('./notify-session');

beforeEach(() => {
  enqueued.length = 0;
  sessionRow = { status: 'stopped', accountId: 'acct-1', metadata: {} };
});
afterEach(() => { sessionRow = undefined; });

test('a STOPPED session is still told its connector landed', async () => {
  await notifyConnectorSession('session-1', 'project-1', 'user-1', 'gmail', 'gmail');
  expect(enqueued).toHaveLength(1);
  expect(enqueued[0]).toMatchObject({
    source: 'system:connector-connected',
    sessionId: 'session-1',
    projectId: 'project-1',
    accountId: 'acct-1',
  });
  expect(enqueued[0].text).toBe(connectorConnectedPrompt('gmail', 'gmail'));
  // De-duped in the database, not by hoping one caller wins: the browser poll
  // and the server-side completion watch both legitimately see the same connect.
  expect(enqueued[0].idempotencyKey).toBe('connector-connected:session-1:gmail');
});

test('the notice is an inbox prompt the queue lists and a running turn reads at its next step', async () => {
  await notifyConnectorSession('session-1', 'project-1', 'user-1', 'gmail', 'gmail');
  // `inboxScope` lists only rows with a clientMessageId; an automation row was
  // invisible in the queue and waited out the whole turn.
  expect(enqueued[0]).toMatchObject({
    clientMessageId: 'connector-connected:gmail',
    placement: 'composer',
    delivery: 'steer',
    remintOnDelivery: true,
    actorUserId: 'user-1',
  });
  // Steer admission requires a wire id (`admitInboxPrompt`).
  expect(enqueued[0].wireMessageId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

test('a running session is told too', async () => {
  sessionRow = { status: 'running', accountId: 'acct-1', metadata: {} };
  await notifyConnectorSession('session-1', 'project-1', 'user-1', 'gmail', 'gmail');
  expect(enqueued).toHaveLength(1);
});

test('a DELETED session is skipped — there is no agent left to tell', async () => {
  sessionRow = { status: 'stopped', accountId: 'acct-1', metadata: { deletedAt: '2026-08-25T00:00:00Z' } };
  await notifyConnectorSession('session-1', 'project-1', 'user-1', 'gmail', 'gmail');
  expect(enqueued).toHaveLength(0);
});

test('a named account is told by name, once per account, so a second account is not deduped away', async () => {
  const account = { connectionId: 'conn-2', label: "Dad's Gmail" };
  await notifyConnectorSession('session-1', 'project-1', 'user-1', 'gmail', 'gmail', account);
  expect(enqueued).toHaveLength(1);
  expect(enqueued[0].text).toBe(connectorConnectedPrompt('gmail', 'gmail', account));
  expect(enqueued[0].text).toContain('--account "Dad\'s Gmail"');
  expect(enqueued[0].idempotencyKey).toBe('connector-connected:session-1:gmail:conn-2');
  expect(enqueued[0].clientMessageId).toBe('connector-connected:gmail:conn-2');
});

test('the account name is one shell word however it is spelled', () => {
  // A member names the account; the agent may paste the command as written.
  // Inside double quotes a shell still expands \, ", $ and backticks.
  const text = connectorConnectedPrompt('gmail', 'gmail', {
    connectionId: 'conn-3',
    label: 'a\\b"c$(rm -rf ~)`id`',
  });
  expect(text).toContain('--account "a\\\\b\\"c\\$(rm -rf ~)\\`id\\`"');
});

test('an unknown session is skipped', async () => {
  sessionRow = undefined;
  await notifyConnectorSession('nope', 'project-1', 'user-1', 'gmail', 'gmail');
  expect(enqueued).toHaveLength(0);
});

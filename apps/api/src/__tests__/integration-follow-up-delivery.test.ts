/**
 * Integration test (real local PostgreSQL): a follow-up from a channel or an
 * API route goes through the durable queue (`deliverThroughQueue`).
 *
 * The drain runs for real against a stopped session with no sandbox, so the
 * delivery itself ends `pending` and the row stays queued for a retry. That is
 * the case these producers used to lose: a direct `continueSession` call that
 * came back `pending` was gone once the call returned.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { deliverThroughQueue } from '../projects/session-lifecycle/follow-up-delivery';
import { claimDueLifecycleCommands, enqueueContinueSessionCommand, markCommandFailed } from '../projects/session-lifecycle/store';
import { db } from '../shared/db';

const SESSION_ID = crypto.randomUUID();
const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();

type Rows = Array<Record<string, any>>;
const rowsOf = (result: unknown): Rows => ((result as { rows?: Rows }).rows ?? result) as Rows;

async function commands(): Promise<Rows> {
  return rowsOf(await db.execute(sql`
    SELECT command_id, idempotency_key, source, status, payload, last_error
      FROM kortix.session_lifecycle_commands
     WHERE session_id = ${SESSION_ID}
     ORDER BY created_at`));
}

async function sessionStatus(): Promise<string> {
  return rowsOf(await db.execute(sql`
    SELECT status FROM kortix.project_sessions WHERE session_id = ${SESSION_ID}`))[0].status;
}

// No prompt author and no automation actor on the account: delivery ends
// `pending` at once instead of waiting 5 min for a box this test never boots.
const reply = (key: string) => ({
  source: 'slack' as const,
  sessionId: SESSION_ID,
  text: 'also check the logs',
  userId: null,
  idempotencyKey: key,
});

beforeAll(async () => {
  await db.execute(sql`
    INSERT INTO kortix.accounts (account_id, name) VALUES (${ACCOUNT_ID}::uuid, 'follow-up-it')`);
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
    VALUES (${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid, 'follow-up-it', 'https://example.invalid/r.git')`);
  await db.execute(sql`
    INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, status)
    VALUES (${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid, 'br-follow-up-it', 'stopped')`);
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM kortix.session_lifecycle_commands WHERE session_id = ${SESSION_ID}`);
  await db.execute(sql`
    UPDATE kortix.project_sessions SET status = 'stopped', metadata = '{}'::jsonb
     WHERE session_id = ${SESSION_ID}`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM kortix.session_lifecycle_commands WHERE session_id = ${SESSION_ID}`);
  await db.execute(sql`DELETE FROM kortix.project_sessions WHERE session_id = ${SESSION_ID}`);
  await db.execute(sql`DELETE FROM kortix.projects WHERE project_id = ${PROJECT_ID}::uuid`);
  await db.execute(sql`DELETE FROM kortix.accounts WHERE account_id = ${ACCOUNT_ID}::uuid`);
});

describe('a follow-up delivered through the queue', () => {
  test('is one durable row under the producer key, still queued when the box is not up', async () => {
    expect(await deliverThroughQueue(reply('slack:T1:C1:1700000000.000100'))).toBe('queued');
    const [row] = await commands();
    expect(row.idempotency_key).toBe('slack:T1:C1:1700000000.000100');
    expect(row.source).toBe('slack');
    expect(row.status).toBe('queued');
    expect(row.payload.directFollowUp).toBe(true);
    expect(row.payload.text).toBe('also check the logs');
  });

  test('a redelivered webhook with the same key sends nothing twice', async () => {
    await deliverThroughQueue(reply('slack:T1:C1:1700000000.000200'));
    await deliverThroughQueue(reply('slack:T1:C1:1700000000.000200'));
    expect(await commands()).toHaveLength(1);
  });

  test('a deleted session answers no-session and enqueues nothing', async () => {
    await db.execute(sql`
      UPDATE kortix.project_sessions SET metadata = '{"deletedAt": "2026-10-06T00:00:00Z"}'::jsonb
       WHERE session_id = ${SESSION_ID}`);
    expect(await deliverThroughQueue(reply('slack:T1:C1:1700000000.000300'))).toBe('no-session');
    expect(await commands()).toHaveLength(0);
  });

  test('another project\'s session answers no-session', async () => {
    expect(await deliverThroughQueue({ ...reply('k-foreign'), projectId: crypto.randomUUID() })).toBe('no-session');
    expect(await commands()).toHaveLength(0);
  });

  test('a parked session answers failed and enqueues nothing', async () => {
    await db.execute(sql`UPDATE kortix.project_sessions SET status = 'failed' WHERE session_id = ${SESSION_ID}`);
    expect(await deliverThroughQueue(reply('slack:T1:C1:1700000000.000400'))).toBe('failed');
    expect(await commands()).toHaveLength(0);
  });
});

describe('a dead-lettered follow-up', () => {
  async function deadLetter(key: string) {
    const [claimed] = await claimDueLifecycleCommands({
      workerId: 'drain-it', limit: 1, idempotencyKey: key, now: new Date(Date.now() + 3_600_000),
    });
    await markCommandFailed(claimed, 'the session refused it', { retryable: false, attempts: claimed.attempts, sessionId: SESSION_ID });
  }

  test('does not park the session, as the direct call never did', async () => {
    await deliverThroughQueue(reply('slack:T1:C1:1700000000.000500'));
    await deadLetter('slack:T1:C1:1700000000.000500');
    expect((await commands())[0].status).toBe('dead_lettered');
    expect(await sessionStatus()).toBe('stopped');
  });

  test('a trigger row still parks it, so a reuse trigger aims at a fresh session', async () => {
    await enqueueContinueSessionCommand({
      source: 'trigger:cron', projectId: PROJECT_ID, accountId: ACCOUNT_ID, sessionId: SESSION_ID,
      actorUserId: USER_ID, text: 'nightly run', idempotencyKey: 'trigger-it-1',
    });
    await deadLetter('trigger-it-1');
    expect(await sessionStatus()).toBe('failed');
  });
});

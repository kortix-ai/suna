/**
 * Integration test (real local PostgreSQL): a cancel that races the drain wakes
 * on the command's settle — a NOTIFY the database trigger sends when the row
 * leaves `running`, from whichever replica wrote it — instead of polling every
 * 400 ms. A second `postgres` client stands in for the other replica.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sessionLifecycleCommands } from '@kortix/db';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { config } from '../lib/config';
import { cancelForwardedPrompt } from '../projects/session-lifecycle/cancel-forwarded';
import { db } from '../lib/db';
import {
  LIFECYCLE_COMMAND_SETTLED_CHANNEL,
  startConfigBaseMoveBroadcast,
  stopConfigBaseMoveBroadcast,
  waitForLifecycleCommandSettle,
} from '../lib/pg-broadcast';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

let project: SeededProject;
let sessionId: string;
let otherReplica: postgres.Sql;

beforeAll(async () => {
  expect(await startConfigBaseMoveBroadcast()).toBe(true);
  otherReplica = postgres(config.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  project = await seedProject('settle-wake');
  sessionId = await seedSession(project, crypto.randomUUID());
});

afterAll(async () => {
  await stopConfigBaseMoveBroadcast();
  await otherReplica.end({ timeout: 2 }).catch(() => {});
  await removeSeeded([project]);
});

async function runningPrompt(): Promise<string> {
  const [row] = await db
    .insert(sessionLifecycleCommands)
    .values({
      commandType: 'continue_session',
      source: 'test',
      status: 'running',
      projectId: project.project_id,
      sessionId,
      accountId: project.account_id,
      payload: { clientMessageId: `msg_${crypto.randomUUID()}` },
    })
    .returning({ commandId: sessionLifecycleCommands.commandId });
  return row!.commandId;
}

// async: a postgres.js query runs only once awaited.
async function settleFromOtherReplica(commandId: string, status: string): Promise<void> {
  await otherReplica`UPDATE kortix.session_lifecycle_commands SET status = ${status} WHERE command_id = ${commandId}`;
}

test('leaving running notifies; staying running or another transition does not', async () => {
  const commandId = await runningPrompt();
  const heard: string[] = [];
  await otherReplica.listen(LIFECYCLE_COMMAND_SETTLED_CHANNEL, (payload) => heard.push(payload));

  await otherReplica`UPDATE kortix.session_lifecycle_commands SET attempts = attempts + 1 WHERE command_id = ${commandId}`;
  await settleFromOtherReplica(commandId, 'queued');
  await settleFromOtherReplica(commandId, 'succeeded'); // queued → succeeded: not a settle out of running
  await Bun.sleep(300);
  expect(heard).toEqual([commandId]);
});

test('a waiter wakes on the settle, not on its timeout', async () => {
  const commandId = await runningPrompt();
  const started = Date.now();
  const settle = waitForLifecycleCommandSettle(commandId, 10_000);
  setTimeout(() => void settleFromOtherReplica(commandId, 'queued'), 50);
  await settle.done;
  expect(Date.now() - started).toBeLessThan(1_000);
});

test('a cancel racing the drain answers as soon as the row falls back to the queue', async () => {
  const commandId = await runningPrompt();
  setTimeout(() => void settleFromOtherReplica(commandId, 'queued'), 50);
  const started = Date.now();
  expect(await cancelForwardedPrompt(sessionId, commandId)).toEqual({ outcome: 'not_forwarded' });
  // The 400 ms poll answered no sooner than its first re-read at 400 ms.
  expect(Date.now() - started).toBeLessThan(350);
});

test('a row that never settles is unreachable after the 3.2 s budget', async () => {
  const commandId = await runningPrompt();
  const started = Date.now();
  expect(await cancelForwardedPrompt(sessionId, commandId)).toEqual({ outcome: 'unreachable' });
  expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);
  await db.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.commandId, commandId));
}, 10_000);

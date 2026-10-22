/**
 * Integration test (real local PostgreSQL): a lifecycle command that becomes
 * due NOTIFYs every replica with its due time, so the drain wakes on the write
 * instead of polling (R9.2). One trigger covers every writer.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { sessionLifecycleCommands } from '@kortix/db';
import postgres from 'postgres';
import { config } from '../config';
import { db } from '../shared/db';
import {
  LIFECYCLE_COMMAND_DUE_CHANNEL,
  onLifecycleCommandDue,
  startConfigBaseMoveBroadcast,
  stopConfigBaseMoveBroadcast,
} from '../shared/pg-broadcast';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

let project: SeededProject;
let sessionId: string;
let listener: postgres.Sql;
let heard: string[] = [];

beforeAll(async () => {
  listener = postgres(config.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  await listener.listen(LIFECYCLE_COMMAND_DUE_CHANNEL, (payload) => heard.push(payload));
  project = await seedProject('due-notify');
  sessionId = await seedSession(project, crypto.randomUUID());
});

beforeEach(() => {
  heard = [];
});

afterAll(async () => {
  await listener.end({ timeout: 2 }).catch(() => {});
  await removeSeeded([project]);
});

async function insert(values: Partial<typeof sessionLifecycleCommands.$inferInsert>): Promise<string> {
  const [row] = await db
    .insert(sessionLifecycleCommands)
    .values({
      commandType: 'continue_session',
      source: 'test',
      projectId: project.project_id,
      sessionId,
      accountId: project.account_id,
      ...values,
    })
    .returning({ commandId: sessionLifecycleCommands.commandId });
  return row!.commandId;
}

async function settle(): Promise<void> {
  await Bun.sleep(300);
}

test('an enqueued row notifies its due time in epoch ms', async () => {
  const due = new Date(Date.now() + 2_000);
  await insert({ status: 'queued', availableAt: due, payload: { clientMessageId: 'q_due' } });
  await settle();
  expect(heard).toEqual([String(due.getTime())]);
});

test('a requeue out of running notifies; a write that changes nothing due does not', async () => {
  const commandId = await insert({ status: 'running', payload: { clientMessageId: 'q_requeue' } });
  await db.execute(`UPDATE kortix.session_lifecycle_commands SET attempts = attempts + 1 WHERE command_id = '${commandId}'`);
  await settle();
  expect(heard).toEqual([]);

  await db.execute(`UPDATE kortix.session_lifecycle_commands SET status = 'queued' WHERE command_id = '${commandId}'`);
  await settle();
  expect(heard).toHaveLength(1);

  await db.execute(`UPDATE kortix.session_lifecycle_commands SET attempts = attempts + 1, result = result || '{"admission_reason":"turn_active"}' WHERE command_id = '${commandId}'`);
  await settle();
  expect(heard).toHaveLength(1);
});

test('a held inbox prompt does not notify until its hold is lifted', async () => {
  const commandId = await insert({ status: 'queued', result: { held: true }, payload: { clientMessageId: 'q_held' } });
  await settle();
  expect(heard).toEqual([]);

  await db.execute(`UPDATE kortix.session_lifecycle_commands SET result = result - 'held' WHERE command_id = '${commandId}'`);
  await settle();
  expect(heard).toHaveLength(1);
});

test('a held automation row still notifies: its hold ends at its due time', async () => {
  await insert({ status: 'queued', result: { held: true }, payload: { text: 'scheduled' } });
  await settle();
  expect(heard).toHaveLength(1);
});

test('the API listener hands the due time to the drain', async () => {
  const wakes: number[] = [];
  expect(await startConfigBaseMoveBroadcast()).toBe(true);
  onLifecycleCommandDue((dueAtMs) => wakes.push(dueAtMs));
  try {
    const due = new Date(Date.now() + 1_000);
    await insert({ status: 'queued', availableAt: due, payload: { clientMessageId: 'q_api' } });
    await settle();
    expect(wakes).toEqual([due.getTime()]);
  } finally {
    onLifecycleCommandDue(null);
    await stopConfigBaseMoveBroadcast();
  }
});

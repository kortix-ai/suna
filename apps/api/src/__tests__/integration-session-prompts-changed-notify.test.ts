/**
 * Integration test (real local PostgreSQL): a write of a session's inbox row
 * NOTIFYs every replica with the session id, and a replica that watches the
 * session publishes the new queue at once (R10.2). One trigger covers every
 * writer; an UPDATE no client can see stays silent.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { sessionLifecycleCommands } from '@kortix/db';
import postgres from 'postgres';
import { config } from '../config';
import { db } from '../shared/db';
import {
  SESSION_PROMPTS_CHANGED_CHANNEL,
  startConfigBaseMoveBroadcast,
  stopConfigBaseMoveBroadcast,
} from '../shared/pg-broadcast';
import { acquireControlReconciler } from '../projects/lib/session-control-reconciler';
import { subscribeControlEvents, type ControlEvent } from '../projects/lib/session-control-events';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

let project: SeededProject;
let sessionId: string;
let listener: postgres.Sql;
let heard: string[] = [];

beforeAll(async () => {
  listener = postgres(config.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  await listener.listen(SESSION_PROMPTS_CHANGED_CHANNEL, (payload) => heard.push(payload));
  project = await seedProject('prompts-changed');
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

test('an insert, a visible update and a delete each notify the session id', async () => {
  const commandId = await insert({ status: 'queued', payload: { clientMessageId: 'q_changed' } });
  await settle();
  expect(heard).toEqual([sessionId]);

  await db.execute(`UPDATE kortix.session_lifecycle_commands SET status = 'running', attempts = attempts + 1 WHERE command_id = '${commandId}'`);
  await settle();
  expect(heard).toEqual([sessionId, sessionId]);

  await db.execute(`DELETE FROM kortix.session_lifecycle_commands WHERE command_id = '${commandId}'`);
  await settle();
  expect(heard).toEqual([sessionId, sessionId, sessionId]);
});

test('a lease renewal or an updated_at touch does not notify', async () => {
  const commandId = await insert({ status: 'running', payload: { clientMessageId: 'q_lease' } });
  await settle();
  heard = [];
  await db.execute(
    `UPDATE kortix.session_lifecycle_commands SET locked_by = 'replica-a', locked_until = now() + interval '30 seconds', updated_at = now() WHERE command_id = '${commandId}'`,
  );
  await settle();
  expect(heard).toEqual([]);
});

test('a row of another command type does not notify', async () => {
  await insert({ commandType: 'stop_session', status: 'queued' });
  await settle();
  expect(heard).toEqual([]);
});

test('a replica that watches the session publishes the queue on the write', async () => {
  expect(await startConfigBaseMoveBroadcast()).toBe(true);
  const handle = acquireControlReconciler(sessionId, project.project_id);
  const frames: ControlEvent[] = [];
  const sub = subscribeControlEvents(sessionId, {}, (event) => {
    if (event.type === 'kortix.control.queue') frames.push(event);
  });
  try {
    await handle.ready();
    await settle();
    frames.length = 0;
    // Far inside the 5 s reconcile cadence: only the NOTIFY can explain a frame.
    await insert({ status: 'queued', payload: { clientMessageId: 'q_frame', text: 'synthetic' } });
    await settle();
    const ids = frames.map(
      (frame) =>
        (frame.payload as { prompts: Array<{ client_message_id?: string }> }).prompts.map(
          (prompt) => prompt.client_message_id,
        ),
    );
    expect(ids.at(-1)).toContain('q_frame');
  } finally {
    sub.unsubscribe();
    handle.release();
    await stopConfigBaseMoveBroadcast();
  }
});

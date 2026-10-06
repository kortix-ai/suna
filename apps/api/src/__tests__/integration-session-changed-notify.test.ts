/**
 * Integration test (real local PostgreSQL): a client-visible write of a
 * session's box row or title NOTIFYs every replica with the session id
 * (R5.1/R5.2, migration 20261006182246238). A stream waiting for a stopped box
 * wakes on it, and a replica that watches the session publishes the new turn
 * state at once. A deadline renewal or an unrelated metadata key stays silent.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { sessionSandboxes } from '@kortix/db';
import postgres from 'postgres';
import { config } from '../config';
import { db } from '../shared/db';
import {
  SESSION_CHANGED_CHANNEL,
  startConfigBaseMoveBroadcast,
  stopConfigBaseMoveBroadcast,
  waitForSessionChange,
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
  await listener.listen(SESSION_CHANGED_CHANNEL, (payload) => heard.push(payload));
  project = await seedProject('session-changed');
  sessionId = await seedSession(project, crypto.randomUUID());
  await db.insert(sessionSandboxes).values({
    sandboxId: crypto.randomUUID(),
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    externalId: 'box-synthetic',
    status: 'stopped',
    metadata: {},
  });
});

beforeEach(async () => {
  await settle();
  heard = [];
});

afterAll(async () => {
  await listener.end({ timeout: 2 }).catch(() => {});
  await removeSeeded([project]);
});

async function settle(): Promise<void> {
  await Bun.sleep(300);
}

function updateBox(set: string): Promise<unknown> {
  return db.execute(`UPDATE kortix.session_sandboxes SET ${set} WHERE session_id = '${sessionId}'`);
}

test('a status change and a live-turn change each notify the session id', async () => {
  await updateBox(`status = 'active'`);
  await settle();
  expect(heard).toEqual([sessionId]);

  await updateBox(
    `metadata = metadata || '{"activeTurns":{"t_synthetic":{"token":"t_synthetic","state":"delivering"}}}'::jsonb`,
  );
  await settle();
  expect(heard).toEqual([sessionId, sessionId]);
});

test('a wake progress write notifies', async () => {
  await updateBox(`metadata = metadata || '{"runtimeWakeProviderStatus":"starting"}'::jsonb`);
  await settle();
  expect(heard).toEqual([sessionId]);
});

test('a deadline renewal, an updated_at touch or an unrelated key does not notify', async () => {
  await updateBox(`deadline_at = now() + interval '10 minutes', updated_at = now()`);
  await updateBox(`metadata = metadata || '{"lastProbeAt":"2026-10-06T00:00:00Z"}'::jsonb`);
  await settle();
  expect(heard).toEqual([]);
});

test('a title write notifies; a write that keeps the title does not', async () => {
  await db.execute(
    `UPDATE kortix.project_sessions SET metadata = coalesce(metadata, '{}'::jsonb) || '{"name":"Synthetic title"}'::jsonb WHERE session_id = '${sessionId}'`,
  );
  await settle();
  expect(heard).toEqual([sessionId]);
  heard = [];
  await db.execute(`UPDATE kortix.project_sessions SET updated_at = now() WHERE session_id = '${sessionId}'`);
  await settle();
  expect(heard).toEqual([]);
});

test('a stream waiting for the box wakes on the write, not on its backstop', async () => {
  expect(await startConfigBaseMoveBroadcast()).toBe(true);
  try {
    const abort = new AbortController();
    const startedAt = Date.now();
    const woke = waitForSessionChange(sessionId, 60_000, abort.signal);
    await Bun.sleep(50);
    await updateBox(`status = 'stopped'`);
    await woke;
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  } finally {
    await stopConfigBaseMoveBroadcast();
  }
});

test('a replica that watches the session publishes the turn on the write', async () => {
  await updateBox(`status = 'active', metadata = '{}'::jsonb`);
  expect(await startConfigBaseMoveBroadcast()).toBe(true);
  const handle = acquireControlReconciler(sessionId, project.project_id);
  const frames: ControlEvent[] = [];
  const sub = subscribeControlEvents(sessionId, {}, (event) => {
    if (event.type === 'kortix.control.turn') frames.push(event);
  });
  try {
    await handle.ready();
    await settle();
    frames.length = 0;
    // Far inside the 5 s reconcile cadence: only the NOTIFY can explain a frame.
    await updateBox(
      `metadata = '{"activeTurns":{"t_frame":{"token":"t_frame","state":"delivering","startedAtMs":1}}}'::jsonb`,
    );
    await settle();
    const tokens = frames.map((frame) =>
      (frame.payload as { turns: Array<{ turn_token: string }> }).turns.map((turn) => turn.turn_token),
    );
    expect(tokens.at(-1)).toContain('t_frame');
  } finally {
    sub.unsubscribe();
    handle.release();
    await stopConfigBaseMoveBroadcast();
  }
});

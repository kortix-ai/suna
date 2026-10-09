/**
 * Integration test (real local DB): a presence renewal keeps the lease, and
 * extends the computer's deadline only for a person who may start the session,
 * by the idle grace (KRTX-1729).
 *
 * Before: every renewal of a visible tab's lease granted 30 minutes, for any
 * viewer, every 30 s. A tab left visible overnight kept the box up until its
 * 24 h cap.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { PgClient } from './helpers/pg-client';

const { db } = await import('../shared/db');
const { renewSessionPresence } = await import('../projects/lib/session-presence');
const { idleGraceMs } = await import('../projects/sandbox-deadline');

const SANDBOX_ID = crypto.randomUUID();
const SESSION_ID = `presence-it-${SANDBOX_ID}`;
const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const TAB_ID = crypto.randomUUID();

type Rows = { rows?: Array<Record<string, unknown>> } & Array<Record<string, unknown>>;
const first = (r: unknown) => ((r as Rows).rows ?? (r as Rows))[0];

/** Seconds until the box is due to stop, computed by Postgres. */
async function secondsLeft(): Promise<number> {
  const r = await db.execute(sql`
    SELECT round(extract(epoch from (deadline_at - now())))::int AS secs
      FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
  return Number(first(r).secs);
}

async function leaseSecondsLeft(): Promise<number | null> {
  const r = await db.execute(sql`
    SELECT round(extract(epoch from (expires_at - clock_timestamp())))::int AS secs
      FROM kortix.session_presence_leases
     WHERE user_id = ${USER_ID}::uuid AND session_id = ${SESSION_ID} AND tab_id = ${TAB_ID}::uuid`);
  const row = first(r);
  return row ? Number(row.secs) : null;
}

beforeAll(async () => {
  await db.execute(sql`INSERT INTO kortix.accounts (account_id, name) VALUES (${ACCOUNT_ID}::uuid, 'presence-it')`);
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
    VALUES (${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid, 'presence-it', 'https://example.invalid/r.git')`);
  await db.execute(sql`
    INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, status)
    VALUES (${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid, ${`br-${SANDBOX_ID}`}, 'running')`);
  await db.execute(sql`
    INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status, external_id)
    VALUES (${SANDBOX_ID}::uuid, ${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid, 'active', ${`ext-${SANDBOX_ID}`})`);
});

beforeEach(async () => {
  // A turn ended a while ago: one minute left on the box.
  await db.execute(sql`
    UPDATE kortix.session_sandboxes SET deadline_at = now() + interval '1 minute'
     WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
  await db.execute(sql`DELETE FROM kortix.session_presence_leases WHERE session_id = ${SESSION_ID}`);
  await db.execute(sql`
    INSERT INTO kortix.session_presence_leases (user_id, session_id, tab_id, expires_at)
    VALUES (${USER_ID}::uuid, ${SESSION_ID}, ${TAB_ID}::uuid, clock_timestamp() + interval '10 seconds')`);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM kortix.session_presence_leases WHERE session_id = ${SESSION_ID}`).catch(() => undefined);
  await db
    .execute(sql`
      UPDATE kortix.project_sessions
         SET metadata = coalesce(metadata, '{}'::jsonb) || '{"deletedAt":"now"}'::jsonb
       WHERE session_id = ${SESSION_ID}`)
    .catch(() => undefined);
  await db.execute(sql`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`).catch(() => undefined);
  await db.execute(sql`DELETE FROM kortix.project_sessions WHERE session_id = ${SESSION_ID}`).catch(() => undefined);
  await db.execute(sql`DELETE FROM kortix.projects WHERE project_id = ${PROJECT_ID}::uuid`).catch(() => undefined);
  await db.execute(sql`DELETE FROM kortix.accounts WHERE account_id = ${ACCOUNT_ID}::uuid`).catch(() => undefined);
});

describe('renewSessionPresence', () => {
  test('a person who may start the session keeps the box for the idle grace, not 30 minutes', async () => {
    expect(await renewSessionPresence(USER_ID, SESSION_ID, TAB_ID, { extendDeadline: true })).toBe(true);
    const secs = await secondsLeft();
    expect(Math.abs(secs - idleGraceMs() / 1000)).toBeLessThanOrEqual(5);
    expect(await leaseSecondsLeft()).toBeGreaterThan(60);
  });

  test('a viewer who may not start the session keeps the lease and leaves the deadline alone', async () => {
    expect(await renewSessionPresence(USER_ID, SESSION_ID, TAB_ID, { extendDeadline: false })).toBe(true);
    expect(await secondsLeft()).toBeLessThanOrEqual(60);
    expect(await leaseSecondsLeft()).toBeGreaterThan(60);
  });

  test('a tab with no lease (idle, or hidden) renews nothing and extends nothing', async () => {
    await db.execute(sql`DELETE FROM kortix.session_presence_leases WHERE session_id = ${SESSION_ID}`);
    expect(await renewSessionPresence(USER_ID, SESSION_ID, TAB_ID, { extendDeadline: true })).toBe(false);
    expect(await secondsLeft()).toBeLessThanOrEqual(60);
  });
});

/** A provider run that started `hours` ago. The anchor trigger pins `active_since`;
 *  bypass it here on the superuser fixture client — the API's own role may not
 *  SET session_replication_role (the audit-reconciliation suites do the same). */
async function runStartedHoursAgo(hours: number) {
  const client = new PgClient({ connectionString: process.env.TEST_DATABASE_SUPERUSER_URL ?? process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`SET session_replication_role = 'replica'`);
    try {
      await client.query(
        `UPDATE kortix.session_sandboxes SET active_since = now() - make_interval(hours => $1)
          WHERE sandbox_id = $2::uuid`,
        [hours, SANDBOX_ID],
      );
    } finally {
      await client.query(`SET session_replication_role = 'origin'`);
    }
  } finally {
    await client.end();
  }
}

/** The session's latest turn ended `minutes` ago (or none, with null). */
async function lastTurnEndedMinutesAgo(minutes: number | null) {
  await db.execute(sql`DELETE FROM kortix.session_turns WHERE session_id = ${SESSION_ID}`);
  if (minutes === null) return;
  await db.execute(sql`
    INSERT INTO kortix.session_turns (turn_token, session_id, sandbox_id, project_id, account_id, started_at, ended_at)
    VALUES (${`presence-turn-${SANDBOX_ID}`}, ${SESSION_ID}, ${SANDBOX_ID}::uuid, ${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid,
            now() - make_interval(mins => ${minutes + 5}), now() - make_interval(mins => ${minutes}))`);
}

// KRTX-1729: a client that reports "present" for every visible tab (clients
// before the input check do) must not keep a box up all night. Presence alone
// keeps it at most 2 h past the run's latest turn.
describe('presence alone keeps a box at most 2 h past its latest turn', () => {
  beforeAll(async () => {
    await runStartedHoursAgo(5);
  });
  afterAll(async () => {
    await lastTurnEndedMinutesAgo(null);
  });

  test('a turn that ended 30 min ago: the idle grace, as before', async () => {
    await lastTurnEndedMinutesAgo(30);
    await renewSessionPresence(USER_ID, SESSION_ID, TAB_ID, { extendDeadline: true });
    expect(Math.abs((await secondsLeft()) - idleGraceMs() / 1000)).toBeLessThanOrEqual(5);
  });

  test('a turn that ended 1 h 50 min ago: only up to the cap, 10 min from now', async () => {
    await lastTurnEndedMinutesAgo(110);
    await renewSessionPresence(USER_ID, SESSION_ID, TAB_ID, { extendDeadline: true });
    const secs = await secondsLeft();
    expect(Math.abs(secs - 600)).toBeLessThanOrEqual(5);
    expect(secs).toBeLessThan(idleGraceMs() / 1000);
  });

  test('a turn that ended 3 h ago: presence extends nothing, and the lease still renews', async () => {
    await lastTurnEndedMinutesAgo(180);
    expect(await renewSessionPresence(USER_ID, SESSION_ID, TAB_ID, { extendDeadline: true })).toBe(true);
    expect(await secondsLeft()).toBeLessThanOrEqual(60);
    expect(await leaseSecondsLeft()).toBeGreaterThan(60);
  });

  test('no turn at all in a run that started 5 h ago: presence extends nothing', async () => {
    await lastTurnEndedMinutesAgo(null);
    await renewSessionPresence(USER_ID, SESSION_ID, TAB_ID, { extendDeadline: true });
    expect(await secondsLeft()).toBeLessThanOrEqual(60);
  });
});

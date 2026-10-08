/**
 * Integration test (real local DB): a turn that waits on a person's answer or
 * approval stops renewing its box (KRTX-1739). Before, the daemon answered
 * `turn_in_flight: true` for such a turn and every reaper pass granted four
 * more hours, until the 24 h ceiling.
 *
 * Real: the turn record and its ledger row (beginSandboxTurn + acceptSandboxTurn),
 * the session origin, every deadline write, the turn clear, the stop claim and
 * applyStoppedState. Stubbed: the provider VM API and the two daemon reads (the
 * turn probe and `/kortix/runtime/state`), because this suite has no box.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';

const stops: string[] = [];
// Spread the real module: only `getProvider` is stubbed.
const realProviders = await import('../platform/providers');
mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    getStatus: async () => 'running',
    renewLifecycle: async () => {},
    stop: async (externalId: string) => {
      stops.push(externalId);
    },
  }),
}));

const { db } = await import('../shared/db');
const { acceptSandboxTurn, beginSandboxTurn } = await import('../projects/sandbox-turn-lifecycle');
const { reapAndReconcileSandboxes } = await import('../projects/sandbox-reaper');

const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();
const MIN = 60_000;

interface Box {
  sandboxId: string;
  sessionId: string;
  externalId: string;
  token: string;
  runtimeSessionId: string;
}
const boxes: Box[] = [];
/** What `/kortix/runtime/state` says each runtime conversation waits on. */
const waiting: Record<string, 'permission' | 'question'> = {};

type Rows = { rows?: Array<Record<string, unknown>> } & Array<Record<string, unknown>>;
const first = (r: unknown) => ((r as Rows).rows ?? (r as Rows))[0];

/** A box with a turn the control plane started ten minutes ago and the runtime accepted. */
async function seedBox(origin: 'user' | 'trigger'): Promise<Box> {
  const sandboxId = crypto.randomUUID();
  const box: Box = {
    sandboxId,
    sessionId: `waiting-turn-${sandboxId}`,
    externalId: `ext-${sandboxId}`,
    token: `tok-${sandboxId}`,
    runtimeSessionId: `ses-${sandboxId}`,
  };
  await db.execute(sql`
    INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, status, origin)
    VALUES (${box.sessionId}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid, ${`br-${sandboxId}`}, 'running',
            ${origin}::kortix.project_session_origin)`);
  await db.execute(sql`
    INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status, external_id)
    VALUES (${sandboxId}::uuid, ${box.sessionId}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid, 'active', ${box.externalId})`);
  const identity = { runtimeSessionId: box.runtimeSessionId, messageId: `msg-${sandboxId}` };
  await beginSandboxTurn({ sandboxId }, { token: box.token, ...identity }, undefined, Date.now() - 10 * MIN);
  expect(await acceptSandboxTurn({ sandboxId }, box.token, identity)).toBe(true);
  boxes.push(box);
  return box;
}

/** One real reaper pass over this box, with the daemon saying the turn runs. */
function pass(box: Box) {
  return reapAndReconcileSandboxes(
    new Date(),
    {
      observeSandboxTurn: async () => ({
        observation: 'active',
        endReason: null,
        daemonAnswered: true,
        orphanedPrompt: false,
      }),
      observeTurnWaiting: async (_externalId: string, runtimeSessionId: string) =>
        waiting[runtimeSessionId] ?? null,
    },
    { sandboxIds: [box.sandboxId] },
  );
}

async function minutesLeft(box: Box): Promise<number> {
  const r = await db.execute(sql`
    SELECT round(extract(epoch from (deadline_at - now())) / 60)::int AS mins
      FROM kortix.session_sandboxes WHERE sandbox_id = ${box.sandboxId}::uuid`);
  return Number(first(r).mins);
}

async function setMinutesLeft(box: Box, minutes: number): Promise<void> {
  await db.execute(sql`
    UPDATE kortix.session_sandboxes SET deadline_at = now() + make_interval(secs => ${minutes * 60})
     WHERE sandbox_id = ${box.sandboxId}::uuid`);
}

async function hasTurnRecord(box: Box): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT (metadata->'activeTurns'->${box.token}) IS NOT NULL AS has
      FROM kortix.session_sandboxes WHERE sandbox_id = ${box.sandboxId}::uuid`);
  return first(r).has === true;
}

async function ledgerOf(box: Box) {
  const r = await db.execute(sql`
    SELECT t.state, t.end_reason, t.end_error->>'name' AS cause, s.status AS sandbox
      FROM kortix.session_turns t
      JOIN kortix.session_sandboxes s ON s.sandbox_id = t.sandbox_id
     WHERE t.turn_token = ${box.token}`);
  return first(r) as { state: string; end_reason: string | null; cause: string | null; sandbox: string };
}

beforeAll(async () => {
  await db.execute(sql`
    INSERT INTO kortix.accounts (account_id, name) VALUES (${ACCOUNT_ID}::uuid, 'waiting-turn-it')`);
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
    VALUES (${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid, 'waiting-turn-it', 'https://example.invalid/r.git')`);
});

afterAll(async () => {
  for (const box of boxes) {
    await db
      .execute(sql`UPDATE kortix.project_sessions
                      SET metadata = coalesce(metadata, '{}'::jsonb) || '{"deletedAt":"now"}'::jsonb
                    WHERE session_id = ${box.sessionId}`)
      .catch(() => undefined);
    await db.execute(sql`DELETE FROM kortix.session_turns WHERE sandbox_id = ${box.sandboxId}::uuid`).catch(() => undefined);
    await db.execute(sql`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = ${box.sandboxId}::uuid`).catch(() => undefined);
    await db.execute(sql`DELETE FROM kortix.project_sessions WHERE session_id = ${box.sessionId}`).catch(() => undefined);
  }
  await db.execute(sql`DELETE FROM kortix.projects WHERE project_id = ${PROJECT_ID}::uuid`).catch(() => undefined);
  await db.execute(sql`DELETE FROM kortix.accounts WHERE account_id = ${ACCOUNT_ID}::uuid`).catch(() => undefined);
});

describe('a turn that waits on a person', () => {
  test('a trigger run on a permission ask: the box keeps 15 minutes, not four hours', async () => {
    const box = await seedBox('trigger');
    expect(await minutesLeft(box)).toBe(240);
    waiting[box.runtimeSessionId] = 'permission';

    await pass(box);
    expect(await minutesLeft(box)).toBe(15);
    expect(await hasTurnRecord(box)).toBe(true);

    // A later pass keeps the first anchor: the write is LEAST-only.
    await setMinutesLeft(box, 9);
    await pass(box);
    expect(await minutesLeft(box)).toBe(9);
    expect(stops).not.toContain(box.externalId);
  });

  test('past that deadline and still waiting: the turn ends failed with the cause, and the box stops', async () => {
    const box = await seedBox('trigger');
    waiting[box.runtimeSessionId] = 'permission';
    await db.execute(sql`
      UPDATE kortix.session_sandboxes SET deadline_at = now() - interval '1 second'
       WHERE sandbox_id = ${box.sandboxId}::uuid`);

    await pass(box);

    expect(await hasTurnRecord(box)).toBe(false);
    expect(await ledgerOf(box)).toEqual({
      state: 'ended',
      end_reason: 'failed',
      cause: 'TurnAwaitingInput',
      sandbox: 'stopped',
    });
    expect(stops).toContain(box.externalId);
  });

  test("a person's session on a question: the box keeps two hours", async () => {
    const box = await seedBox('user');
    waiting[box.runtimeSessionId] = 'question';

    await pass(box);

    expect(await minutesLeft(box)).toBe(120);
    expect(await hasTurnRecord(box)).toBe(true);
  });

  test('a turn that does not wait renews the four-hour grant, as before', async () => {
    const box = await seedBox('trigger');
    await setMinutesLeft(box, 30);

    await pass(box);

    expect(await minutesLeft(box)).toBe(240);
    expect(await hasTurnRecord(box)).toBe(true);
  });
});

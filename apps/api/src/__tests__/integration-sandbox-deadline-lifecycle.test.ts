/**
 * Integration test (real local DB): the WHOLE lifetime rule, end to end, with
 * only the external VM API stubbed.
 *
 * This is the live proof that a box actually dies. Every deadline value here is
 * computed by Postgres from the real trigger, the real constraint and the real
 * SQL in sandbox-deadline.ts; the reaper that judges the row is the real
 * `reapAndReconcileSandboxes`; and the stop that closes it out is the real
 * `applyStoppedState`, which settles the compute meter against the still-active
 * row before flipping either status. Only the provider lifecycle calls are
 * stubbed, because this suite cannot own somebody else's hypervisor.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';

const stops: string[] = [];
const renewals: string[] = [];
// Spread the real module: only `getProvider` is stubbed, so every other export
// (error classes the transitive importers need) stays exactly as shipped.
const realProviders = await import('../platform/providers');
mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    getStatus: async () => 'running',
    renewLifecycle: async (externalId: string) => {
      renewals.push(externalId);
    },
    stop: async (externalId: string) => {
      stops.push(externalId);
    },
  }),
}));

const { db } = await import('../shared/db');
const { extendSandboxDeadline, shortenSandboxDeadline } = await import(
  '../projects/sandbox-deadline'
);
const { reapAndReconcileSandboxes } = await import('../projects/sandbox-reaper');

const SANDBOX_ID = crypto.randomUUID();
const SESSION_ID = `deadline-lifecycle-${SANDBOX_ID}`;
const EXTERNAL_ID = `ext-${SANDBOX_ID}`;
const ACCOUNT_ID = crypto.randomUUID();
const PROJECT_ID = crypto.randomUUID();

/** drizzle's execute() is untyped; both drivers surface rows the same way. */
type Rows = { rows?: Array<Record<string, unknown>> } & Array<Record<string, unknown>>;
const first = (r: unknown) => ((r as Rows).rows ?? (r as Rows))[0];

/** Minutes until this box is due to be stopped, straight from the row. */
async function minutesLeft(): Promise<number> {
  const r = await db.execute(sql`
    SELECT round(extract(epoch from (deadline_at - now())) / 60)::int AS mins
      FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`);
  return Number(first(r).mins);
}

async function statusOf(): Promise<{ sandbox: string; session: string }> {
  const r = await db.execute(sql`
    SELECT s.status AS sandbox, p.status AS session
      FROM kortix.session_sandboxes s
      JOIN kortix.project_sessions p ON p.session_id = s.session_id
     WHERE s.sandbox_id = ${SANDBOX_ID}::uuid`);
  return first(r) as { sandbox: string; session: string };
}

beforeAll(async () => {
  await db.execute(sql`
    INSERT INTO kortix.accounts (account_id, name) VALUES (${ACCOUNT_ID}::uuid, 'deadline-it')`);
  await db.execute(sql`
    INSERT INTO kortix.projects (project_id, account_id, name, repo_url)
    VALUES (${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid, 'deadline-it', 'https://example.invalid/r.git')`);
  await db.execute(sql`
    INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, status)
    VALUES (${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid, ${`br-${SANDBOX_ID}`}, 'running')`);
  await db.execute(sql`
    INSERT INTO kortix.session_sandboxes
      (sandbox_id, session_id, account_id, project_id, status, external_id)
    VALUES (${SANDBOX_ID}::uuid, ${SESSION_ID}, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid,
            'active', ${EXTERNAL_ID})`);
  // The reaper is a PLATFORM sweep: it judges every active row, including any
  // left lying around by local dev. Park those for the duration (a live
  // deadline makes the sweep skip them) so this test cannot mutate a
  // developer's other work, and restore them afterwards.
  await db.execute(sql`
    UPDATE kortix.session_sandboxes
       SET deadline_at = LEAST(active_since + interval '24 hours', now() + interval '1 hour')
     WHERE status = 'active' AND sandbox_id <> ${SANDBOX_ID}::uuid`);
});

afterAll(async () => {
  // Hand the parked rows back to the reaper.
  await db
    .execute(
      sql`
      UPDATE kortix.session_sandboxes SET deadline_at = now()
       WHERE status = 'active' AND sandbox_id <> ${SANDBOX_ID}::uuid`,
    )
    .catch(() => undefined);
  // The identity guard refuses to delete an established sandbox unless its
  // session is tombstoned, so tombstone it first.
  await db
    .execute(
      sql`
      UPDATE kortix.project_sessions
         SET metadata = coalesce(metadata, '{}'::jsonb) || '{"deletedAt":"now"}'::jsonb
       WHERE session_id = ${SESSION_ID}`,
    )
    .catch(() => undefined);
  await db
    .execute(sql`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = ${SANDBOX_ID}::uuid`)
    .catch(() => undefined);
  await db
    .execute(sql`DELETE FROM kortix.project_sessions WHERE session_id = ${SESSION_ID}`)
    .catch(() => undefined);
  await db
    .execute(sql`DELETE FROM kortix.projects WHERE project_id = ${PROJECT_ID}::uuid`)
    .catch(() => undefined);
  await db
    .execute(sql`DELETE FROM kortix.accounts WHERE account_id = ${ACCOUNT_ID}::uuid`)
    .catch(() => undefined);
});

describe('a sandbox lifetime, start to death', () => {
  test('1. a fresh box gets the 15-minute boot floor from the trigger', async () => {
    expect(await minutesLeft()).toBe(15);
  });

  test('2. a control-plane-OBSERVED turn start buys the full 4h grant', async () => {
    await extendSandboxDeadline({ externalId: EXTERNAL_ID });

    expect(await minutesLeft()).toBe(240);
  });

  test('3. the sandbox-reported turn end pulls it in to the 15-minute idle tail', async () => {
    await shortenSandboxDeadline(SESSION_ID);

    expect(await minutesLeft()).toBe(15);
  });

  // THE INVARIANT, live: a sandbox-reported signal may only SHORTEN. Replaying
  // the turn end — the thing a wedged box does forever — buys nothing.
  test('4. replaying the sandbox report cannot buy the box more life', async () => {
    await shortenSandboxDeadline(SESSION_ID);
    await shortenSandboxDeadline(SESSION_ID);

    expect(await minutesLeft()).toBe(15);
  });

  test('5. an unexpired box SURVIVES a real reaper pass', async () => {
    await reapAndReconcileSandboxes(new Date());

    expect(stops).toEqual([]);
    expect(renewals).toContain(EXTERNAL_ID);
    expect((await statusOf()).sandbox).toBe('active');
  });

  test('6. past its deadline, the REAL reaper stops it and closes the session', async () => {
    await db.execute(sql`
      UPDATE kortix.session_sandboxes SET deadline_at = now() - interval '1 second'
       WHERE sandbox_id = ${SANDBOX_ID}::uuid`);

    await reapAndReconcileSandboxes(new Date());

    // The box, not just the row: provider.stop() was actually issued.
    expect(stops).toEqual([EXTERNAL_ID]);
    // applyStoppedState flips BOTH in one transaction — no window where the box
    // is parked but the session still claims to be running.
    expect(await statusOf()).toEqual({
      sandbox: 'stopped',
      session: 'stopped',
    });
  });

  // 264h -> at most 4h even in the worst case, and 15 min in the normal one.
  test('7. a stopped box cannot be healed back by passive traffic', async () => {
    const { markSandboxUsed } = await import('../sandbox-proxy/backend');
    await markSandboxUsed(EXTERNAL_ID);

    // The heal is gated on `deadline_at > now()`, and a reaper-stopped box has
    // an expired deadline BY CONSTRUCTION. This is the 1,597-phantom-active-row
    // resurrection bug, closed by a predicate instead of a metadata flag.
    expect((await statusOf()).sandbox).toBe('stopped');
  });
});

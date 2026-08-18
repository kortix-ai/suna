/**
 * Integration test (real local DB): the schema-level lifecycle anchor.
 *
 * This is the ONLY guard in the design, deliberately. An earlier attempt used a
 * source-code scanner to forbid TypeScript from writing `deadlineAt` outside
 * one module; a one-line indirection defeated it —
 *   db.update(x).set({ deadlineAt })              -> caught
 *   const p = { deadlineAt }; db.update(x).set(p)  -> invisible
 * The BEFORE trigger cannot be routed around by application code. The former
 * 24-hour CHECK was removed because it stopped verified active OpenCode turns.
 * Idle lifetime remains controlled by `deadline_at` and the reaper.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';

const HOUR_MS = 3_600_000;
const created: string[] = [];

async function seed(status: 'active' | 'provisioning' | 'stopped', deadline?: string) {
  const sandboxId = crypto.randomUUID();
  created.push(sandboxId);
  await db.execute(sql`
    INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status
      ${deadline ? sql`, deadline_at` : sql``})
    VALUES (${sandboxId}::uuid, ${`deadline-it-${sandboxId}`}, ${crypto.randomUUID()}::uuid,
            ${crypto.randomUUID()}::uuid, ${status}
      ${deadline ? sql`, ${deadline}::timestamptz` : sql``})`);
  return sandboxId;
}

/** drizzle's execute() is untyped; both drivers surface rows the same way. */
type Rows = { rows?: Array<Record<string, unknown>> } & Array<Record<string, unknown>>;

async function read(sandboxId: string) {
  const rows = await db.execute(sql`
    SELECT active_since, deadline_at,
           extract(epoch from (deadline_at - active_since)) AS span_s,
           extract(epoch from (now() - active_since))       AS age_s
      FROM kortix.session_sandboxes WHERE sandbox_id = ${sandboxId}::uuid`);
  return ((rows as Rows).rows ?? (rows as Rows))[0];
}

afterAll(async () => {
  for (const id of created) {
    await db
      .execute(sql`DELETE FROM kortix.session_sandboxes WHERE sandbox_id = ${id}::uuid`)
      .catch(() => undefined);
  }
});

describe('the anchor trigger', () => {
  // A row is normally born `provisioning` and flipped to `active` when the
  // provider returns. A floor applied only to active inserts would leave every
  // in-flight provision expired from birth.
  test('a bare INSERT is anchored and gets the 15-minute boot floor', async () => {
    const row = await read(await seed('provisioning'));

    expect(Number(row.span_s)).toBeCloseTo(15 * 60, 0);
    expect(Number(row.age_s)).toBeLessThan(30);
  });

  test('the boot floor exceeds the runtime-readiness wait, so a cold boot is not killed', async () => {
    const row = await read(await seed('provisioning'));
    // READY_DEADLINE_MS is 5 minutes; the floor must clear it plus slack, or a
    // cold-booting trigger session dies on the same clock that waits for it.
    expect(Number(row.span_s)).toBeGreaterThan(5 * 60);
  });

  test('an unwitnessed stopped -> active transition applies the 15-minute boot floor', async () => {
    const id = await seed('stopped', new Date(Date.now() - HOUR_MS).toISOString());
    // A stale, already-expired deadline carried while the box was parked would
    // otherwise present to a user as "Start does nothing".
    await db.execute(
      sql`UPDATE kortix.session_sandboxes SET status = 'active' WHERE sandbox_id = ${id}::uuid`,
    );
    const row = await read(id);

    expect(Number(row.age_s)).toBeLessThan(30);
    expect(Number(row.span_s)).toBeCloseTo(15 * 60, 0);
  });

  // I1 — the load-bearing immutability. Carried forward silently rather than
  // raised, because an ORM whole-object UPDATE that re-sends the column is not
  // a bug and must not 500 a hot path. What matters is that it cannot MOVE.
  test('active_since is IMMUTABLE while status = active', async () => {
    const id = await seed('active');
    const before = (await read(id)).active_since;

    await db.execute(sql`
      UPDATE kortix.session_sandboxes
         SET active_since = now() + interval '10 hours'
       WHERE sandbox_id = ${id}::uuid`);

    expect((await read(id)).active_since).toEqual(before);
  });
});

describe('deadlines beyond 24 hours', () => {
  test('a verified active turn may extend the deadline beyond the former cap', async () => {
    const id = await seed('active');
    await db.execute(sql`
      UPDATE kortix.session_sandboxes
         SET metadata = jsonb_set(
               coalesce(metadata, '{}'::jsonb),
               '{activeTurns,turn-token}',
               '{"token":"turn-token","state":"active"}'::jsonb,
               true),
             deadline_at = active_since + interval '25 hours'
       WHERE sandbox_id = ${id}::uuid`);

    expect(Number((await read(id)).span_s)).toBe(25 * 3600);
  });
});

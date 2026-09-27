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
const rows = (result: unknown) => (result as Rows).rows ?? (result as Rows);

async function read(sandboxId: string) {
  const rows = await db.execute(sql`
    SELECT active_since, deadline_at,
           extract(epoch from (deadline_at - active_since)) AS span_s,
           extract(epoch from (now() - active_since))       AS age_s
      FROM kortix.session_sandboxes WHERE sandbox_id = ${sandboxId}::uuid`);
  return ((rows as Rows).rows ?? (rows as Rows))[0] as Record<string, unknown>;
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

  // A witnessed park (active -> stopped) stamps `stretchParkedAt`. The resume
  // then starts a NEW provider run: `active_since` moves to the resume, and a
  // stale, already-expired deadline carried while the box was parked gets the
  // boot floor instead of presenting to a user as "Start does nothing".
  test('a resume after a witnessed park re-anchors the run and applies the 15-minute boot floor', async () => {
    const id = await seed('active');
    const parkedRunStart = new Date((await read(id)).active_since as string | Date).getTime();
    await db.execute(sql`
      UPDATE kortix.session_sandboxes
         SET status = 'stopped', deadline_at = now() - interval '1 hour'
       WHERE sandbox_id = ${id}::uuid`);
    await db.execute(sql`SELECT pg_sleep(0.02)`);

    await db.execute(
      sql`UPDATE kortix.session_sandboxes SET status = 'active' WHERE sandbox_id = ${id}::uuid`,
    );
    const row = await read(id);
    const [meta] = rows(
      await db.execute(sql`
        SELECT metadata FROM kortix.session_sandboxes WHERE sandbox_id = ${id}::uuid`),
    );

    expect(new Date(row.active_since as string | Date).getTime()).toBeGreaterThan(parkedRunStart);
    expect(Number(row.span_s)).toBeCloseTo(15 * 60, 0);
    expect(meta.metadata).toMatchObject({ deadlineGrant: 'boot_floor' });
    expect(meta.metadata).not.toHaveProperty('stretchParkedAt');
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
  // Turn gating lives in the writers (sandbox-deadline.ts); the schema itself
  // holds no wall-clock cap since 20260817150000000 dropped the CHECK.
  test('the schema accepts a deadline past active_since + 24h (no wall-clock cap)', async () => {
    const id = await seed('active');
    await db.execute(sql`
      UPDATE kortix.session_sandboxes
         SET deadline_at = active_since + interval '25 hours'
       WHERE sandbox_id = ${id}::uuid`);

    expect(Number((await read(id)).span_s)).toBe(25 * 3600);
  });
});

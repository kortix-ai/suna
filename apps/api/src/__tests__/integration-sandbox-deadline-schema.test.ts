/**
 * Integration test (real local DB): the schema-level guarantee behind bounded
 * sandbox lifetime.
 *
 * This is the ONLY guard in the design, deliberately. An earlier attempt used a
 * source-code scanner to forbid TypeScript from writing `deadlineAt` outside
 * one module; a one-line indirection defeated it —
 *   db.update(x).set({ deadlineAt })              -> caught
 *   const p = { deadlineAt }; db.update(x).set(p)  -> invisible
 * A guard ordinary Drizzle bypasses is worse than none, because it manufactures
 * false confidence. A BEFORE trigger and a CHECK constraint cannot be routed
 * around by any application code, including code that has not been written yet
 * — which is exactly what these tests assert.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';

const HOUR_MS = 3_600_000;
const created: string[] = [];

/** Drizzle wraps driver errors in a DrizzleQueryError, so the real PostgresError
 *  (and its SQLSTATE) lives on `cause`. 23514 = check_violation. Asserting the
 *  CODE and the CONSTRAINT NAME — not a message substring — is what makes these
 *  tests about the constraint itself rather than about Postgres's wording. */
function pgError(err: unknown): { code?: string; constraint?: string } {
  type PgLike = { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
  for (let e = err as PgLike, depth = 0; e && depth < 5; e = e.cause as PgLike, depth++) {
    if (e.code) return { code: e.code, constraint: e.constraint_name ?? e.constraint };
  }
  return {};
}

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
  test('a bare INSERT is anchored and gets the 20-minute boot floor', async () => {
    const row = await read(await seed('provisioning'));

    expect(Number(row.span_s)).toBeCloseTo(20 * 60, 0);
    expect(Number(row.age_s)).toBeLessThan(30);
  });

  test('the boot floor exceeds the runtime-readiness wait, so a cold boot is not killed', async () => {
    const row = await read(await seed('provisioning'));
    // READY_DEADLINE_MS is 5 minutes; the floor must clear it plus slack, or a
    // cold-booting trigger session dies on the same clock that waits for it.
    expect(Number(row.span_s)).toBeGreaterThan(5 * 60);
  });

  test('every non-active -> active transition re-anchors AND re-floors', async () => {
    const id = await seed('stopped', new Date(Date.now() - HOUR_MS).toISOString());
    // A stale, already-expired deadline carried while the box was parked would
    // otherwise present to a user as "Start does nothing".
    await db.execute(
      sql`UPDATE kortix.session_sandboxes SET status = 'active' WHERE sandbox_id = ${id}::uuid`,
    );
    const row = await read(id);

    expect(Number(row.age_s)).toBeLessThan(30);
    expect(Number(row.span_s)).toBeCloseTo(20 * 60, 0);
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

describe('the 24h cap — unbypassable by application code', () => {
  test('a direct UPDATE past the cap raises 23514', async () => {
    const id = await seed('active');

    const err = await db
      .execute(sql`
        UPDATE kortix.session_sandboxes
           SET deadline_at = active_since + interval '25 hours'
         WHERE sandbox_id = ${id}::uuid`)
      .then(() => null)
      .catch((e) => e);

    expect(pgError(err).code).toBe('23514');
    expect(pgError(err).constraint).toBe('session_sandboxes_deadline_within_cap');
  });

  // THE ATTACK THE TRIGGER EXISTS FOR: widen the ceiling by sliding its left
  // operand forward in the SAME statement. The trigger restores the real
  // anchor, so the CHECK still sees it and refuses.
  test('sliding the anchor forward while widening does NOT buy more life', async () => {
    const id = await seed('active');

    const err = await db
      .execute(sql`
        UPDATE kortix.session_sandboxes
           SET active_since = now() + interval '10 hours',
               deadline_at  = now() + interval '30 hours'
         WHERE sandbox_id = ${id}::uuid`)
      .then(() => null)
      .catch((e) => e);

    expect(pgError(err).code).toBe('23514');
    expect(pgError(err).constraint).toBe('session_sandboxes_deadline_within_cap');
  });

  test('an INSERT that states a deadline beyond the cap is refused outright', async () => {
    const err = await seed('active', new Date(Date.now() + 25 * HOUR_MS).toISOString())
      .then(() => null)
      .catch((e) => e);

    expect(pgError(err).code).toBe('23514');
    expect(pgError(err).constraint).toBe('session_sandboxes_deadline_within_cap');
  });

  test('a write INSIDE the cap is accepted, so the constraint is not just "deny all"', async () => {
    const id = await seed('active');

    await db.execute(sql`
      UPDATE kortix.session_sandboxes
         SET deadline_at = active_since + interval '23 hours'
       WHERE sandbox_id = ${id}::uuid`);

    expect(Number((await read(id)).span_s)).toBe(23 * 3600);
  });
});

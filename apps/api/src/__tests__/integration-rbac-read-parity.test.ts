/**
 * The read side of the canonical model, proved two ways.
 *
 * 1. PARITY. Every read model rebuilt on `role_assignments` returns the same
 *    rows as the query it replaced, on the same database, over the verdict
 *    harness's fixture (which writes ONLY the legacy tables and lets the
 *    dual-write mirror triggers populate the canonical one). 0 diffs required.
 *
 * 2. THE ONE DELIBERATE DIFFERENCE. None of the legacy queries filtered
 *    `expires_at`, so a lapsed grant kept showing up on the Members page as
 *    live access and kept counting towards the effective role — while the
 *    engine had already stopped honouring it. The canonical projections filter,
 *    exactly as the engine does. That is asserted here rather than normalized
 *    away, because it is the behaviour change this refactor is making.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db, hasDatabase } from '../shared/db';
import { dropParityFixture, seedParityFixture, type ParityFixture } from '../iam/parity-harness';
import { runReadParity } from '../iam/read-parity';
import { projectRoleGrants } from '../iam/read-models';

const HAS_DB = hasDatabase;
let fixture: ParityFixture | null = null;
let memberIds: string[] = [];

beforeAll(async () => {
  if (!HAS_DB) return;
  fixture = await seedParityFixture();
  const res = await db.execute(
    sql`select user_id::text as user_id from kortix.account_members where account_id = ${fixture.accountId}::uuid`,
  );
  const rows = (res as unknown as { rows?: Array<{ user_id: string }> }).rows ??
    (res as unknown as Array<{ user_id: string }>);
  memberIds = rows.map((r) => r.user_id);
});

afterAll(async () => {
  if (fixture) await dropParityFixture(fixture.accountId);
});

describe('rbac read-model parity', () => {
  test('every read model returns the same rows from role_assignments', async () => {
    if (!HAS_DB || !fixture) return;
    const result = await runReadParity({
      accountId: fixture.accountId,
      projectIds: [fixture.projectId, fixture.otherProjectId],
      userIds: memberIds,
    });
    if (result.diffs.length > 0) {
      console.error(JSON.stringify(result.diffs.slice(0, 10), null, 2));
    }
    expect(result.diffs).toEqual([]);
    // A fixture that compared nothing would pass vacuously.
    expect(result.compared).toBeGreaterThan(0);
  });

  test('an expired grant is a legacy row but NOT canonical access', async () => {
    if (!HAS_DB || !fixture) return;
    // The fixture seeds one project_members row whose expires_at is an hour in
    // the past. The legacy table still has it…
    const legacy = await db.execute(sql`
      select count(*)::int as n from kortix.project_members
       where project_id = ${fixture.projectId}::uuid and expires_at < now()
    `);
    const legacyRows = (legacy as unknown as { rows?: Array<{ n: number }> }).rows ??
      (legacy as unknown as Array<{ n: number }>);
    expect(Number(legacyRows[0]!.n)).toBe(1);

    // …and the canonical projection does not list it, because the engine does
    // not honour it either.
    const canonical = await projectRoleGrants({
      accountId: fixture.accountId,
      projectId: fixture.projectId,
    });
    const expiredHolders = canonical.filter((g) => g.expiresAt && g.expiresAt.getTime() < Date.now());
    expect(expiredHolders).toEqual([]);
  });
});

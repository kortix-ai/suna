/**
 * VERDICT PARITY: the canonical engine (`iam/authorize.ts`) must decide exactly
 * what the engine it replaces (`iam/engine-v2.ts`) decides — same verdict, same
 * reason — for every principal shape, every credential, every action in the
 * catalog, and every object shape.
 *
 * This is the gate spec §5 puts in front of the cutover: 100% match, and any
 * mismatch printed as its (principal, credential, action, object) triple rather
 * than smoothed over. The ONE normalisation applied is the three-to-one allow
 * reason collapse documented on `normalizeOldReason`, which is a spec decision
 * (§2.2), not a fudge — every DENIAL reason is compared byte-for-byte because
 * the 403 wording is keyed on it.
 *
 * The grid is ~14 principals × up to 4 credentials × 75 actions × 5 objects.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db, hasDatabase } from '../shared/db';
import {
  dropParityFixture,
  runParity,
  seedParityFixture,
  type ParityFixture,
  type ParityResult,
} from '../iam/parity-harness';

let fixture: ParityFixture | null = null;
let result: ParityResult | null = null;
let reachable = false;

/**
 * The default (hermetic) lane sets DATABASE_URL to an unreachable placeholder
 * (`scripts/test.env`), so `hasDatabase` alone is not the question — this file
 * is named `parity-*`, not `integration-*`, and therefore runs in BOTH lanes.
 * Probe the connection and skip rather than spend the lane's timeout failing to
 * connect. `bash scripts/test.sh integration` is where it actually runs.
 */
async function databaseReachable(): Promise<boolean> {
  if (!hasDatabase) return false;
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

// The whole grid runs in the hook so the assertion below is a pure comparison.
// The 10-minute ceiling is generous on purpose: under `bun test`, ttl-memo is
// disabled (NODE_ENV=test), so every one of the ~200k principal/role lookups
// this grid makes is a real query — which is exactly the point, the harness
// must compare the ENGINES, not two warm caches.
beforeAll(async () => {
  reachable = await databaseReachable();
  if (!reachable) return;
  fixture = await seedParityFixture();
  result = await runParity(fixture, { concurrency: 24 });
}, 600_000);

afterAll(async () => {
  if (fixture) await dropParityFixture(fixture.accountId);
});

test('the canonical engine and engine-v2 agree on every triple', () => {
  if (!reachable) {
    console.warn('[parity] no reachable database — skipping (run `bash scripts/test.sh integration`)');
    return;
  }
  const r = result!;
  // Printed so the count is visible in CI output even on a pass: "0 mismatches"
  // is only meaningful next to the number of triples it covered.
  console.log(`[parity] ${r.total} triple(s) compared, ${r.mismatches.length} mismatch(es)`);
  if (r.mismatches.length > 0) {
    for (const m of r.mismatches.slice(0, 40)) {
      console.error(
        `[parity] ${m.principal} | ${m.credential} | ${m.action} | ${m.object}` +
          `  old=${m.old.allowed ? 'allow' : 'deny'}:${m.old.reason}` +
          `  new=${m.next.allowed ? 'allow' : 'deny'}:${m.next.reason}`,
      );
    }
  }
  expect(r.mismatches).toEqual([]);
  // A grid that silently shrank to nothing would also report 0 mismatches.
  expect(r.total).toBeGreaterThan(3000);
}, 600_000);

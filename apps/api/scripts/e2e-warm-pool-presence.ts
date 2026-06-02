/**
 * Live e2e for warm-pool PRESENCE gating: a pool is held only while a user is
 * present, and reaped when they leave.
 *
 *   cd apps/api && KORTIX_URL=<tunnel> BENCH_PROJECT_ID=<uuid> \
 *     KORTIX_WARM_POOL_ENABLED=true \
 *     bun --env-file=.env run scripts/e2e-warm-pool-presence.ts
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { projects, projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../src/shared/db';
import { getProvider } from '../src/platform/providers';
import { notePoolPresence, reconcileWarmPool, resolveWarmConfig } from '../src/platform/services/warm-pool';

const PID = process.env.BENCH_PROJECT_ID || '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c: boolean, m: string) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) failed++; };

const poolRows = () => db.select().from(sessionSandboxes)
  .where(and(eq(sessionSandboxes.projectId, PID), isNotNull(sessionSandboxes.poolState)));

async function destroy() {
  const rows = await poolRows();
  for (const r of rows) {
    try { if (r.externalId) await getProvider(r.provider as any).remove(r.externalId); } catch {}
    await db.delete(projectSessions).where(eq(projectSessions.sessionId, r.sessionId)).catch(() => {});
    await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, r.sandboxId)).catch(() => {});
  }
}

async function main() {
  if (!PID) throw new Error('set BENCH_PROJECT_ID');
  console.log(`\n[e2e] warm-pool presence  project=${PID}\n`);
  try {
    await destroy();
    // clear any stale presence
    await db.update(projects).set({ metadata: sql`(${projects.metadata} - 'warm_pool_seen_at')` }).where(eq(projects.projectId, PID));

    // 1. presence → seen_at written + a box spawned (refill is fire-and-forget,
    //    so poll for the row to appear).
    console.log('[e2e] notePoolPresence (user arrives)…');
    notePoolPresence(PID);
    let boxes = await poolRows();
    const tSpawn = Date.now();
    while (boxes.length === 0 && Date.now() - tSpawn < 20_000) { await sleep(1000); boxes = await poolRows(); }
    const [p] = await db.select({ m: projects.metadata }).from(projects).where(eq(projects.projectId, PID)).limit(1);
    const seenAt = (p?.m as any)?.warm_pool_seen_at;
    ok(!!seenAt, `warm_pool_seen_at written (${seenAt ? String(seenAt).slice(0, 19) : 'MISSING'})`);
    ok(boxes.length >= 1, `presence kicked a spawn (${boxes.length} box in ${((Date.now() - tSpawn) / 1000).toFixed(1)}s)`);
    ok(resolveWarmConfig(p?.m).enabled, 'project warm config resolves enabled');
    if (boxes.length === 0) throw new Error('no box spawned from presence');

    // 2. wait for parked
    const W = boxes[0]?.sandboxId;
    const t0 = Date.now();
    while (Date.now() - t0 < 200_000) {
      const [r] = await db.select({ s: sessionSandboxes.poolState }).from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, W)).limit(1);
      if (r?.s === 'parked') break;
      if (r?.s === 'reap') break;
      await sleep(2000);
    }

    // 3. reconcile with FRESH presence → box kept
    console.log('[e2e] reconcile with fresh presence → keep…');
    const r1 = await reconcileWarmPool();
    boxes = await poolRows();
    ok(boxes.length >= 1, `present project keeps its pool (${boxes.length} box, reaped=${r1.reaped})`);

    // 4. presence goes STALE → reconcile reaps the pool (user left)
    console.log('[e2e] set presence stale (user left) → reconcile should reap…');
    await db.update(projects)
      .set({ metadata: sql`jsonb_set(${projects.metadata}, '{warm_pool_seen_at}', to_jsonb((now() - interval '2 hours')))` })
      .where(eq(projects.projectId, PID));
    const r2 = await reconcileWarmPool();
    boxes = await poolRows();
    ok(boxes.length === 0, `absent project's pool reaped (left=${boxes.length}, reaped=${r2.reaped})`);
  } finally {
    console.log('\n[e2e] cleanup…');
    await destroy();
    await db.update(projects).set({ metadata: sql`(${projects.metadata} - 'warm_pool_seen_at')` }).where(eq(projects.projectId, PID)).catch(() => {});
  }
  console.log(`\n[e2e] ${failed === 0 ? '✅ ALL PASSED' : `❌ ${failed} FAILED`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`\n[e2e] ERROR: ${e?.message || e}\n`); process.exit(1); });

/**
 * Live e2e for the warm sandbox pool. Drives the REAL engine against real
 * Daytona + DB: spawn → park → claim (via the actual createProjectSession path)
 * → assert instant + correct, then assert pool-miss falls back to cold.
 *
 *   cd apps/api && KORTIX_URL=<tunnel> BENCH_PROJECT_ID=<uuid> \
 *     KORTIX_WARM_POOL_ENABLED=true KORTIX_WARM_POOL_ACTIVE_DAYS=99999 \
 *     bun --env-file=.env run scripts/e2e-warm-pool.ts
 *
 * Cleans up every sandbox it creates. Requires the local API (:PORT) running so
 * the in-box readiness probe can route through its proxy.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { accountMembers, projects, projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../src/shared/db';
import { config } from '../src/config';
import { getProvider } from '../src/platform/providers';
import { refillProjectPool, claimWarmSandbox, warmPoolEnabled } from '../src/platform/services/warm-pool';
import { createProjectSession } from '../src/projects';

const PID = process.env.BENCH_PROJECT_ID || '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond: boolean, msg: string) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failed++; };

async function poolRows(projectId: string) {
  return db.select().from(sessionSandboxes)
    .where(and(eq(sessionSandboxes.projectId, projectId), isNotNull(sessionSandboxes.poolState)));
}

async function destroy(projectId: string) {
  // Remove every pool box + anything created during this test for the project.
  const rows = await db.select().from(sessionSandboxes)
    .where(and(eq(sessionSandboxes.projectId, projectId), inArray(sessionSandboxes.status, ['provisioning', 'active', 'error', 'stopped'])));
  for (const r of rows) {
    const isTest = !!r.poolState || (r.metadata as any)?.warmPool || createdSessionIds.has(r.sandboxId);
    if (!isTest) continue;
    try { if (r.externalId) await getProvider(r.provider as any).remove(r.externalId); } catch {}
    await db.delete(projectSessions).where(eq(projectSessions.sessionId, r.sessionId)).catch(() => {});
    await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, r.sandboxId)).catch(() => {});
  }
}

const createdSessionIds = new Set<string>();

async function main() {
  if (!PID) throw new Error('set BENCH_PROJECT_ID');
  console.log(`\n[e2e] warm-pool  project=${PID}  flag=${warmPoolEnabled()}  apiPort=${config.PORT}\n`);
  ok(warmPoolEnabled(), 'KORTIX_WARM_POOL_ENABLED is on');

  const [project] = await db.select().from(projects).where(eq(projects.projectId, PID)).limit(1);
  if (!project) throw new Error('project not found');
  const [owner] = await db.select().from(accountMembers)
    .where(and(eq(accountMembers.accountId, project.accountId), eq(accountMembers.accountRole, 'owner'))).limit(1);
  if (!owner) throw new Error('no owner');

  try {
    console.log('[e2e] cleaning any pre-existing pool boxes…');
    await destroy(PID);

    // ── 1. spawn a warm box ──────────────────────────────────────────────────
    console.log('[e2e] refillProjectPool → spawning a warm sandbox…');
    await refillProjectPool(PID);
    let booting = await poolRows(PID);
    ok(booting.length >= 1, `spawned a pool box (state=${booting[0]?.poolState})`);
    const W = booting[0]?.sandboxId;
    if (!W) throw new Error('no warm box spawned');
    booting.forEach((r) => createdSessionIds.add(r.sandboxId));

    // ── 2. wait until parked (runtimeReady) ─────────────────────────────────
    console.log(`[e2e] waiting for ${W.slice(0, 8)} to reach parked…`);
    const t0 = Date.now();
    let parked = false;
    while (Date.now() - t0 < 300_000) {
      const [row] = await db.select({ p: sessionSandboxes.poolState, s: sessionSandboxes.status })
        .from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, W)).limit(1);
      if (row?.p === 'parked') { parked = true; break; }
      if (row?.p === 'reap' || row?.s === 'error') break;
      await sleep(2000);
    }
    ok(parked, `box parked in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (!parked) throw new Error('box never parked');

    // ── 3. claim via the real createProjectSession path ─────────────────────
    console.log('[e2e] createProjectSession (no prompt) → should claim the warm box…');
    const tClaim = Date.now();
    const res = await createProjectSession({ project: project as any, userId: owner.userId, body: {} });
    const claimMs = Date.now() - tClaim;
    createdSessionIds.add(res.row?.sessionId ?? '');
    ok(!res.error, `create returned a session (${claimMs}ms)${res.error ? ' err=' + JSON.stringify(res.error.body) : ''}`);
    ok(res.row?.sessionId === W, `session id == warm box id (${res.row?.sessionId?.slice(0, 8)} vs ${W.slice(0, 8)})`);
    ok((res.row?.metadata as any)?.warm_pool_claimed === true, 'session flagged warm_pool_claimed');
    ok(claimMs < 3000, `claim was fast (${claimMs}ms < 3000)`);

    // ── 4. state after claim ────────────────────────────────────────────────
    const [claimed] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, W)).limit(1);
    ok(claimed?.poolState === null, `pool_state cleared on claim (=${claimed?.poolState})`);
    ok(claimed?.status === 'active', `claimed box still active (=${claimed?.status})`);
    const [psRow] = await db.select().from(projectSessions).where(eq(projectSessions.sessionId, W)).limit(1);
    ok(!!psRow, 'project_sessions row exists for the claimed session');

    // ── 5. pool-miss → null (cold fallback at the engine level) ──────────────
    console.log('[e2e] second claim with the pool drained → should miss…');
    // The post-claim refill may have started a new box (booting, not parked yet),
    // so an immediate claim must still miss (only parked boxes are claimable).
    const miss = await claimWarmSandbox({ projectId: PID, userId: owner.userId });
    ok(miss === null, `claim miss returns null (got ${miss ? miss.sandboxId.slice(0, 8) : 'null'})`);

    // ── 6. reactive refill kicked a replacement ─────────────────────────────
    await sleep(1500);
    const after = await poolRows(PID);
    after.forEach((r) => createdSessionIds.add(r.sandboxId));
    ok(after.length >= 1, `pool refilled after claim (${after.length} box booting/parked)`);

  } finally {
    console.log('\n[e2e] cleanup…');
    await destroy(PID);
  }

  console.log(`\n[e2e] ${failed === 0 ? '✅ ALL PASSED' : `❌ ${failed} FAILED`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`\n[e2e] ERROR: ${e?.message || e}\n`); process.exit(1); });

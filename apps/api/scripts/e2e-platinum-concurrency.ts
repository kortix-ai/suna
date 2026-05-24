/**
 * Concurrency + leak verification.
 *
 * Provisions N sessions in parallel, awaits all of them to reach
 * status='active' or 'error', then tears them down concurrently. Asserts:
 *   - all sessions reach 'active' (zero spurious failures)
 *   - all DB rows show distinct Platinum sandbox IDs (no aliasing)
 *   - after cleanup, the org's "running sandboxes" count returns to 0
 */

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { accounts, projects, sessionSandboxes } from '@kortix/db';
import { db } from '../src/shared/db';
import { provisionSessionSandbox } from '../src/platform/services/session-sandbox';
import { getProvider } from '../src/platform/providers';
import { config } from '../src/config';

const N = 5;

async function countOrgRunning(): Promise<number> {
  const res = await fetch(`${config.PLATINUM_API_URL}/v1/sandboxes?state=running`, {
    headers: { authorization: `Bearer ${config.PLATINUM_API_KEY}` },
  });
  const j = await res.json() as any;
  return Array.isArray(j) ? j.length : (j.rows?.length ?? 0);
}

async function seedAccountAndProject(): Promise<{ accountId: string; projectId: string }> {
  const accountId = randomUUID(), projectId = randomUUID();
  await db.insert(accounts).values({ accountId, name: `conc-${accountId.slice(0,8)}`, personalAccount: true });
  await db.insert(projects).values({
    projectId, accountId, name: `conc-${projectId.slice(0,8)}`,
    repoUrl: `https://example.invalid/conc/${projectId}.git`, defaultBranch: 'main', manifestPath: 'kortix.toml',
  });
  return { accountId, projectId };
}

async function main() {
  const baseRunning = await countOrgRunning();
  console.log(`baseline running sandboxes in org: ${baseRunning}`);

  console.log(`→ launching ${N} sessions in parallel`);
  const launched = await Promise.all(
    Array.from({ length: N }, async () => {
      const { accountId, projectId } = await seedAccountAndProject();
      const sandboxId = randomUUID(), userId = randomUUID();
      const { row } = await provisionSessionSandbox({
        sandboxId, accountId, projectId, userId,
        provider: 'platinum',
        gitProject: { projectId, repoUrl: `https://example.invalid/conc/${projectId}.git`, defaultBranch: 'main', manifestPath: 'kortix.toml' },
      });
      return { sandboxId, accountId, projectId, initialStatus: row.status };
    }),
  );
  console.log(`✓ ${launched.length} sessions inserted, statuses: ${launched.map(l => l.initialStatus).join(',')}`);

  console.log(`→ polling all for terminal status (90s budget)`);
  const deadline = Date.now() + 90_000;
  const finalRows = new Map<string, typeof sessionSandboxes.$inferSelect>();
  while (Date.now() < deadline && finalRows.size < N) {
    for (const l of launched) {
      if (finalRows.has(l.sandboxId)) continue;
      const [r] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, l.sandboxId)).limit(1);
      if (r && (r.status === 'active' || r.status === 'error')) finalRows.set(l.sandboxId, r);
    }
    if (finalRows.size < N) await new Promise((res) => setTimeout(res, 1000));
  }
  if (finalRows.size < N) {
    throw new Error(`${N - finalRows.size}/${N} sessions never reached terminal status`);
  }

  const actives  = [...finalRows.values()].filter((r) => r.status === 'active');
  const errors   = [...finalRows.values()].filter((r) => r.status === 'error');
  const externals = new Set(actives.map((r) => r.externalId!).filter(Boolean));
  console.log(`  active: ${actives.length}   error: ${errors.length}   distinct externals: ${externals.size}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`  ERROR row ${e.sandboxId}: ${JSON.stringify(e.metadata).slice(0,200)}`);
    throw new Error(`${errors.length} sessions failed`);
  }
  if (externals.size !== actives.length) {
    throw new Error(`externalId collision: ${externals.size} distinct vs ${actives.length} active`);
  }

  // Teardown: remove all Platinum sandboxes + DB rows, in parallel.
  console.log('→ teardown (parallel remove)');
  await Promise.all(actives.map(async (r) => {
    try { await getProvider('platinum').remove(r.externalId!); } catch (e) { console.warn(`remove ${r.externalId}: ${e}`); }
  }));
  await Promise.all(launched.map((l) => Promise.all([
    db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, l.sandboxId)).catch(() => {}),
    db.delete(projects).where(eq(projects.projectId, l.projectId)).catch(() => {}),
    db.delete(accounts).where(eq(accounts.accountId, l.accountId)).catch(() => {}),
  ])));

  // Wait for Platinum to register the stops (deletes flip to 'stopping' first).
  await new Promise((r) => setTimeout(r, 3000));
  const afterRunning = await countOrgRunning();
  console.log(`final running sandboxes in org: ${afterRunning} (baseline was ${baseRunning})`);
  if (afterRunning > baseRunning) {
    throw new Error(`LEAK: ${afterRunning - baseRunning} sandboxes still running after cleanup`);
  }

  console.log('\nPLATINUM CONCURRENCY: PASS');
}

main().catch((e) => { console.error('\nPLATINUM CONCURRENCY: FAIL'); console.error(e); process.exit(1); });

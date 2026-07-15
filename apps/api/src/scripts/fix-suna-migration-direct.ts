/**
 * Drive ONE stuck Suna migration to completion locally, OUT of band — without
 * the lease/worker. The prod migration worker only ever grabs rows whose status
 * is 'planned'|'running' (acquireLease), so by keeping the row 'failed' until the
 * very end and never calling driveSunaMigration, the worker never races us.
 *
 * Reuses the committed, FIXED phase functions (extract → repo → push → db) with a
 * tiny in-memory context: checkpoint is in-memory, heartbeat is a no-op, and we
 * stamp the row 'completed' atomically only once the project + sessions exist.
 *
 * Usage:
 *   dotenvx run -f .env.prod --quiet -- \
 *   bun run src/scripts/fix-suna-migration-direct.ts --account-id <uuid> [--limit 25]
 */
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { sunaAccountMigrations } from '@kortix/db';
import { db } from '../shared/db';
import { extractStep, repoStep, pushStep, dbStep } from '../projects/suna-migration/suna-migration-phases';
import { latestSunaMigration, type SunaMigrationContext } from '../projects/suna-migration/suna-migration-runner';

function arg(flag: string): string | undefined {
  const i = Bun.argv.indexOf(flag);
  return i >= 0 ? Bun.argv[i + 1] : Bun.argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

const accountId = arg('--account-id');
const limit = Number(arg('--limit') ?? 25);
if (!accountId) { console.error('--account-id <uuid> required'); process.exit(2); }

async function main() {
  const row = await latestSunaMigration(db, accountId!);
  if (!row) { console.error(`no migration row for account ${accountId}`); process.exit(1); }
  console.log(`\n▸ direct-drive migration ${row.migrationId} (account ${accountId}) — current: ${row.status}/${row.phase}\n`);

  const progress: Record<string, unknown> = {};
  const ctx: SunaMigrationContext = {
    database: db,
    migrationId: row.migrationId,
    runId: row.runId,
    accountId: accountId!,
    plan: { limit, offset: 0 },
    progress,
    checkpoint: async (patch) => { Object.assign(progress, patch); },
    heartbeat: async () => {},
    log: (m, e) => console.log(`  [${new Date().toISOString()}] ${m}`, e ? JSON.stringify(e) : ''),
  };

  console.log('— extract —'); await extractStep(ctx);

  // Capture his COMPLETE /workspace (every file, including >50MB artifacts the
  // repo push will strip) so he can be handed the full set separately.
  const bundleDir = join(tmpdir(), `suna-mig-${row.migrationId}`);
  const archive = arg('--archive') ?? join(tmpdir(), `suna-files-${accountId}.tar.gz`);
  const t = Bun.spawnSync(['tar', 'czf', archive, '-C', bundleDir, 'legacy']);
  if (t.exitCode === 0) console.log(`  ✓ full files archive: ${archive} (${(statSync(archive).size / 1048576).toFixed(1)}MB)`);
  else console.error('  ✗ archive failed:', new TextDecoder().decode(t.stderr).slice(0, 200));

  console.log('— repo —');    await repoStep(ctx);
  console.log('— push —');    await pushStep(ctx);
  console.log('— db —');      await dbStep(ctx);

  await db.update(sunaAccountMigrations).set({
    status: 'completed', phase: 'done', error: null, attempts: 0,
    projectId: (progress.project_id as string) ?? null,
    progress, heartbeatAt: null,
    appliedAt: row.appliedAt ?? new Date(), verifiedAt: new Date(), updatedAt: new Date(),
  }).where(eq(sunaAccountMigrations.migrationId, row.migrationId));

  console.log(`\n✓ completed — project_id ${progress.project_id}, ${(progress.sessions as unknown[])?.length ?? 0} sessions.\n`);
}

await main();
process.exit(0);

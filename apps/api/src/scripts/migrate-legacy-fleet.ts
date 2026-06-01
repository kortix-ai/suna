/**
 * Bulk-migrate the legacy JustAVPS fleet through the DURABLE migration runner
 * (the same path the /projects "Migrate" button uses: extract -> repo -> push ->
 * db, managed-GitHub repo + Supabase-Storage chat archive).
 *
 * Eligibility (matches the lazy/UI path): provider = 'justavps' AND status =
 * 'active', with no in-flight or already-completed migration. A previously
 * FAILED machine is re-attempted (a fresh run row is created).
 *
 * The runner is itself a queue: each migration row is leased, checkpointed and
 * resumable, so this script is safe to re-run — completed machines are skipped,
 * failed ones retried. We drive a bounded worker POOL so a batch doesn't hammer
 * the JustAVPS API / GitHub repo-creation limits / Daytona all at once.
 *
 * SAFE BY DEFAULT: a bare run is a dry-run (prints the eligible set + plan).
 * Pass --execute to actually migrate. Start small with --execute --limit 5.
 *
 *   bun run src/scripts/migrate-legacy-fleet.ts                       # dry-run, all eligible
 *   bun run src/scripts/migrate-legacy-fleet.ts --execute --limit 5   # migrate first 5
 *   bun run src/scripts/migrate-legacy-fleet.ts --execute             # migrate the whole fleet
 *   bun run src/scripts/migrate-legacy-fleet.ts --execute --concurrency 4
 *   bun run src/scripts/migrate-legacy-fleet.ts --execute --account-id UUID
 *
 * Flags: --execute | --limit N | --concurrency N (default 8) | --account-id UUID
 *        --sandbox-id UUID (one machine) | --max-passes N (drive retries, default 8)
 */
import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import { legacySandboxMigrations, sandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { startMigration, driveMigration } from '../projects/legacy-migration-runner';

// Statuses that occupy the per-sandbox unique slot — a machine with any of these
// is already in-flight or done, so it's not eligible. (Mirrors the partial
// unique index idx_legacy_sandbox_migrations_active_sandbox.)
const OCCUPIED_STATUSES = ['planned', 'running', 'applied', 'verified', 'completed'];

function flag(name: string): string | undefined {
  const i = Bun.argv.indexOf(`--${name}`);
  if (i >= 0) return Bun.argv[i + 1];
  const pref = Bun.argv.find((a) => a.startsWith(`--${name}=`));
  return pref ? pref.slice(name.length + 3) : undefined;
}
const has = (name: string) => Bun.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EXECUTE = has('execute');
const LIMIT = flag('limit') ? Number(flag('limit')) : undefined;
const CONCURRENCY = Math.max(1, Number(flag('concurrency') ?? 8));
const MAX_PASSES = Math.max(1, Number(flag('max-passes') ?? 8));
const ACCOUNT_ID = flag('account-id');
const SANDBOX_ID = flag('sandbox-id');

if (LIMIT !== undefined && (!Number.isFinite(LIMIT) || LIMIT <= 0)) {
  throw new Error('--limit must be a positive number');
}

type Eligible = { sandboxId: string; name: string | null; accountId: string };
type Result = Eligible & { status: string; phase?: string | null; projectId?: string | null; error?: string | null };

async function findEligible(): Promise<Eligible[]> {
  const conds = [
    eq(sandboxes.provider, 'justavps' as never),
    eq(sandboxes.status, 'active' as never),
    notExists(
      db
        .select({ one: sql`1` })
        .from(legacySandboxMigrations)
        .where(and(
          eq(legacySandboxMigrations.sandboxId, sandboxes.sandboxId),
          inArray(legacySandboxMigrations.status, OCCUPIED_STATUSES),
        )),
    ),
  ];
  if (ACCOUNT_ID) conds.push(eq(sandboxes.accountId, ACCOUNT_ID));
  if (SANDBOX_ID) conds.push(eq(sandboxes.sandboxId, SANDBOX_ID));

  const rows = await db
    .select({ sandboxId: sandboxes.sandboxId, name: sandboxes.name, accountId: sandboxes.accountId })
    .from(sandboxes)
    .where(and(...conds))
    .orderBy(sandboxes.createdAt);
  return LIMIT ? rows.slice(0, LIMIT) : rows;
}

async function migrateOne(m: Eligible): Promise<Result> {
  try {
    const { migration } = await startMigration({
      database: db,
      sandboxId: m.sandboxId,
      accountId: m.accountId,
      autoDrive: false, // the pool drives it synchronously below
    });
    let row = migration;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      await driveMigration(db, migration.migrationId);
      [row] = await db
        .select()
        .from(legacySandboxMigrations)
        .where(eq(legacySandboxMigrations.migrationId, migration.migrationId))
        .limit(1);
      if (row.status === 'completed' || row.status === 'failed') break;
      await sleep(1500); // gentle gap between retries of the same machine
    }
    return { ...m, status: row.status ?? 'unknown', phase: row.phase, projectId: row.projectId, error: row.error };
  } catch (err) {
    return { ...m, status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

async function pool<T>(items: T[], n: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const idx = next++;
        if (idx >= items.length) break;
        await fn(items[idx]!, idx);
      }
    }),
  );
}

// ── main ─────────────────────────────────────────────────────────────────────
const eligible = await findEligible();
console.log(`\nEligible machines (justavps + active, not already migrating): ${eligible.length}`);
console.log(`Plan: concurrency=${CONCURRENCY} max-passes=${MAX_PASSES}${LIMIT ? ` limit=${LIMIT}` : ''}${ACCOUNT_ID ? ` account=${ACCOUNT_ID}` : ''}${SANDBOX_ID ? ` sandbox=${SANDBOX_ID}` : ''}\n`);

if (!EXECUTE) {
  console.log('DRY-RUN (pass --execute to migrate). First 30:');
  for (const m of eligible.slice(0, 30)) console.log(`  ${m.sandboxId}  ${m.name ?? ''}`);
  if (eligible.length > 30) console.log(`  … and ${eligible.length - 30} more`);
  console.log('\nNothing migrated.');
  process.exit(0);
}

if (eligible.length === 0) {
  console.log('Nothing eligible to migrate.');
  process.exit(0);
}

const results: Result[] = [];
let done = 0;
await pool(eligible, CONCURRENCY, async (m) => {
  const r = await migrateOne(m);
  results.push(r);
  done += 1;
  const tag = r.status === 'completed' ? '✓' : r.status === 'failed' || r.status === 'error' ? '✗' : '…';
  console.log(`[${done}/${eligible.length}] ${tag} ${r.name ?? r.sandboxId} → ${r.status}${r.phase && r.status !== 'completed' ? ` (${r.phase})` : ''}${r.error ? `: ${r.error}` : ''}`);
});

// ── summary ──────────────────────────────────────────────────────────────────
const by = (s: string) => results.filter((r) => r.status === s).length;
const completed = by('completed');
const failures = results.filter((r) => r.status !== 'completed');
console.log(`\n=== Summary ===`);
console.log(`completed: ${completed}/${results.length}   failed: ${by('failed')}   error: ${by('error')}   other: ${results.length - completed - by('failed') - by('error')}`);
if (failures.length) {
  console.log(`\nNeeds attention (re-run the script to retry; the runner resumes from the last good phase):`);
  for (const r of failures) console.log(`  ✗ ${r.name ?? r.sandboxId}  status=${r.status} phase=${r.phase ?? '-'}  ${r.error ?? ''}`);
}
process.exit(failures.length > 0 ? 1 : 0);

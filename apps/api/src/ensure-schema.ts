/**
 * Local-dev schema convenience: delegates to packages/db/scripts/migrate.ts.
 *
 * Tracking lives in `kortix_migrations.pgmigrations` (node-pg-migrate); each
 * file is applied once, transactionally. ONLY local dev auto-applies at
 * boot. Every deployed env (incl. preview branches sharing the dev DB) is
 * warn-only — deployed migrations run from the deploy pipeline BEFORE the new
 * code serves traffic (see scripts/deploy-zero-downtime.sh step 2.5).
 */

import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { config } from './config';
import { db } from './shared/db';

export async function ensureSchema(): Promise<void> {
  if (!config.DATABASE_URL) {
    console.log('[schema] No DATABASE_URL configured — skipping');
    return;
  }

  const isLocalDev = process.env.KORTIX_LOCAL_DEV === '1' || process.env.ENV_MODE === 'local';

  // Only LOCAL development auto-applies at boot — its database is private to the
  // developer. Every DEPLOYED environment must NOT migrate from app boot, even
  // dev: preview branches SHARE the dev database, so a booting preview pod would
  // apply its (possibly un-merged) migrations to the schema every other preview
  // depends on, and concurrent pods would race a half-applied state. Deployed
  // migrations run once, in the CI/CD pipeline, before the new code serves
  // traffic. At boot we only surface drift loudly — we never mutate the DB.
  if (!isLocalDev || process.env.KORTIX_SKIP_ENSURE_SCHEMA === '1') {
    const reason =
      process.env.KORTIX_SKIP_ENSURE_SCHEMA === '1'
        ? 'KORTIX_SKIP_ENSURE_SCHEMA=1'
        : `deployed env (INTERNAL_KORTIX_ENV=${config.INTERNAL_KORTIX_ENV})`;
    console.log(
      `[schema] ${reason} — not auto-applying (migrations are managed by the deploy pipeline). Checking for drift...`,
    );
    await warnIfCriticalTablesMissing();
    return;
  }

  const dbPkgRoot = join(import.meta.dir, '../../../packages/db');
  const migratorPath = join(dbPkgRoot, 'scripts', 'migrate.ts');

  console.log('[schema] Local dev — applying pending migrations via migrate.ts...');
  const bunBin = process.execPath;
  const proc = Bun.spawn([bunBin, migratorPath, 'up'], {
    cwd: dbPkgRoot,
    env: {
      ...process.env,
      DATABASE_URL: config.DATABASE_URL,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(
      `[schema] migrate up failed (exit ${exitCode}) — the application may misbehave until the operator fixes it.`,
    );
    return;
  }
  console.log('[schema] Migrations complete.');
}

/**
 * Drift probe on every deployed boot (warn-only — the deploy pipeline owns
 * migrations). It runs on the SHARED request pool (`./shared/db`), not its own
 * client: the rolling-deployment ceiling counts every pool a boot can open,
 * and a transient probe client would cost one extra connection per starting
 * task (the KRTX-2020 raise spends exactly that headroom on the pool itself).
 *
 * It probes a small set of IAM-critical tables and logs a single grouped
 * warning if any are missing, so "I forgot to apply migration N" surfaces
 * before the first 500 hits a route.
 */
async function warnIfCriticalTablesMissing(): Promise<void> {
  if (!config.DATABASE_URL) return;
  // Critical tables for IAM + auth + vault paths. Keep this list
  // small and stable — extending it for every new migration would be
  // noise. We check only tables in the `kortix` schema (no tuple
  // joins, no driver-specific helpers) so the query stays portable.
  const required = [
    'account_groups',
    'account_group_members',
    'account_members',
    'accounts',
    'audit_events',
    'project_group_grants',
    'project_members',
    'project_secrets',
    'projects',
  ];
  try {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'kortix'
        AND table_name IN (${sql.join(
          required.map((table) => sql`${table}`),
          sql`, `,
        )})
    `);
    const present = new Set(
      Array.from(rows as unknown as Array<{ table_name: string }>).map((r) => r.table_name),
    );
    const missing = required.filter((n) => !present.has(n));
    if (missing.length > 0) {
      console.warn('[schema] ⚠ critical tables are missing:');
      for (const m of missing) console.warn(`[schema]   • kortix.${m}`);
      console.warn('[schema] Run `pnpm migrate` or remove the env flag to auto-apply.');
    }
  } catch (err) {
    console.warn('[schema] could not verify table presence:', (err as Error).message ?? err);
  }
}

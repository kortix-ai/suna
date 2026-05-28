/**
 * Dev-mode schema convenience: delegates to packages/db/scripts/migrate.ts.
 *
 * Tracking lives in `kortix_migrations.applied` (see migration 094); each
 * file is applied once, transactionally, with a sha256 fingerprint. No-op in
 * prod — prod migrations run from the deploy pipeline BEFORE the new code
 * serves traffic (see scripts/deploy-zero-downtime.sh step 2.5).
 */

import { join } from 'node:path';
import { config } from './config';
import postgres from 'postgres';

export async function ensureSchema(): Promise<void> {
  if (!config.DATABASE_URL) {
    console.log('[schema] No DATABASE_URL configured — skipping');
    return;
  }

  if (process.env.KORTIX_SKIP_ENSURE_SCHEMA === '1') {
    console.log('[schema] KORTIX_SKIP_ENSURE_SCHEMA=1 — skipping');
    // Still probe the critical IAM surface so a stale dev DB shows up
    // as a loud warning instead of opaque 500s on first request. Names
    // listed here are the tables the IAM engine + auth middleware
    // touch on every request — if they're missing, nothing in IAM
    // works. We don't FAIL; the operator opted into skipping migrations.
    await warnIfCriticalTablesMissing();
    return;
  }

  // Production: schema managed externally (CI/CD migrations)
  if (config.INTERNAL_KORTIX_ENV === 'prod') {
    console.log('[schema] Production mode — skipping auto-push (managed externally)');
    return;
  }

  const dbPkgRoot = join(import.meta.dir, '../../../packages/db');
  const migratorPath = join(dbPkgRoot, 'scripts', 'migrate.ts');

  console.log('[schema] Applying pending migrations via migrate.ts...');
  const bunBin = process.execPath;
  const proc = Bun.spawn(
    [bunBin, migratorPath, 'up'],
    {
      cwd: dbPkgRoot,
      env: {
        ...process.env,
        DATABASE_URL: config.DATABASE_URL,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`[schema] migrate up failed (exit ${exitCode}) — the application may misbehave until the operator fixes it.`);
    return;
  }
  console.log('[schema] Migrations complete.');
}

/**
 * When KORTIX_SKIP_ENSURE_SCHEMA=1 is set, probe a small set of
 * IAM-critical tables and log a single grouped warning if any are
 * missing. Operators usually set the flag to manage migrations
 * out-of-band; this helps them spot "I forgot to apply migration N"
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
  const db = postgres(config.DATABASE_URL, { max: 1 });
  try {
    const rows = (await db`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'kortix' AND table_name IN ${db(required)}
    `) as Array<{ table_name: string }>;
    const present = new Set(rows.map((r) => r.table_name));
    const missing = required.filter((n) => !present.has(n));
    if (missing.length > 0) {
      console.warn(
        '[schema] ⚠ KORTIX_SKIP_ENSURE_SCHEMA=1 but critical tables are missing:',
      );
      for (const m of missing) console.warn(`[schema]   • kortix.${m}`);
      console.warn(
        '[schema] Run `bun run --cwd packages/db db:migrate:up` or remove the env flag to auto-apply.',
      );
    }
  } catch (err) {
    console.warn(
      '[schema] could not verify table presence:',
      (err as Error).message ?? err,
    );
  } finally {
    await db.end();
  }
}


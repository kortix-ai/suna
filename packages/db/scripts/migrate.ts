#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const DRIZZLE_DIR = join(import.meta.dir, '..', 'drizzle');
const DRIZZLE_CONFIG = join(import.meta.dir, '..', 'drizzle.config.ts');
const TRACKING_TABLE = 'kortix_migrations.applied';
const ADVISORY_LOCK_KEY = 8472193847; // arbitrary but stable

interface MigrationFile {
  version: string;
  name: string;
  path: string;
  content: string;
  checksum: string;
  noTransaction: boolean;
}

function fmtUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url.replace(/:[^:@/]+@/, ':***@');
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function splitUpDown(content: string): { up: string; down: string | null } {
  const lines = content.split('\n');
  const dividerIdx = lines.findIndex((l) => /^--\s*migrate:down\b/i.test(l.trim()));
  if (dividerIdx < 0) return { up: content, down: null };
  const up = lines.slice(0, dividerIdx).join('\n');
  const down = lines.slice(dividerIdx + 1).join('\n').trim();
  return { up, down: down.length > 0 ? down : null };
}

function listMigrationFiles(dir: string): MigrationFile[] {
  if (!existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((f) => {
    const path = join(dir, f);
    const content = readFileSync(path, 'utf-8');
    const version = f.replace(/\.sql$/, '');
    const us = version.indexOf('_');
    const name = us >= 0 ? version.slice(us + 1) : version;
    const firstLine = content.split('\n', 1)[0]?.trim() ?? '';
    const noTransaction = /^--\s*migrate:no-transaction\b/i.test(firstLine);
    return { version, name, path, content, checksum: sha256(content), noTransaction };
  });
}

/**
 * Resolve the DB URL. Order:
 *   1. --target=NAME flag → reads `${NAME_UPPER}_DB_URL` from apps/api/.env
 *      (e.g. --target=staging → STAGING_DB_URL). Secrets never go through the
 *      shell.
 *   2. The shell env (DATABASE_URL=... migrate up) — prod deploy path
 *   3. apps/api/.env DATABASE_URL — local dev default
 */
function getDbUrl(): string {
  const argv = process.argv.slice(2);
  const targetArg = argv.find((a) => a.startsWith('--target='));
  const dotenvPath = join(import.meta.dir, '..', '..', '..', 'apps', 'api', '.env');

  if (targetArg) {
    const target = targetArg.slice('--target='.length).toUpperCase();
    const key = target === 'LOCAL' ? 'DATABASE_URL' : `${target}_DB_URL`;
    const v = readEnvKey(dotenvPath, key);
    if (!v) {
      console.error(`--target=${target.toLowerCase()} requested but ${key} is not set in apps/api/.env.`);
      process.exit(1);
    }
    return v;
  }
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const fromEnv = readEnvKey(dotenvPath, 'DATABASE_URL');
  if (fromEnv) return fromEnv;
  console.error('No DB URL resolved. Set $DATABASE_URL or DATABASE_URL in apps/api/.env, or pass --target=<name>.');
  process.exit(1);
}

function readEnvKey(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf-8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!line.startsWith(`${key}=`)) continue;
    let v = line.slice(key.length + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function newMigration(slug: string) {
  if (!slug || !/^[a-z0-9_]+$/.test(slug)) {
    console.error('slug must match /^[a-z0-9_]+$/, e.g. add_user_table');
    process.exit(1);
  }
  const d = new Date();
  const stamp =
    d.getUTCFullYear().toString() +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds());
  const filename = `${stamp}_${slug}.sql`;
  const fullPath = join(MIGRATIONS_DIR, filename);
  if (existsSync(fullPath)) {
    console.error(`Migration already exists: ${filename}`);
    process.exit(1);
  }
  const template = `-- ${slug}
--
-- Add a one-line summary of the change.
-- Directives (each must be on a line by itself):
--   -- migrate:no-transaction   (first line; for CREATE INDEX CONCURRENTLY etc.)
--   -- migrate:down             (divider; everything below = rollback SQL)

-- TODO: forward SQL


-- migrate:down
-- TODO: rollback SQL (or delete this section if rollback isn't supported)
`;
  writeFileSync(fullPath, template);
  console.log(`Created: packages/db/migrations/${filename}`);
}

async function status() {
  const url = getDbUrl();
  console.log(`DB: ${fmtUrl(url)}\n`);
  const sql = postgres(url, { max: 1 });
  try {
    const trackingExists = await trackingTableExists(sql);
    if (!trackingExists) {
      const files = listMigrationFiles(MIGRATIONS_DIR);
      console.log(`kortix_migrations.applied does not exist — tracking has never been initialized on this DB.`);
      console.log(`Repo has ${files.length} migration file(s); none are recorded as applied here.`);
      console.log(`Run \`bun packages/db/scripts/backfill-tracking.ts --target=<env>\` to initialize.`);
      return;
    }
    const files = listMigrationFiles(MIGRATIONS_DIR);
    const applied = await readApplied(sql);
    const appliedMap = new Map(applied.map((a) => [a.version, a]));

    let nApplied = 0;
    let nPending = 0;
    let nMismatch = 0;
    const lines: string[] = [];
    for (const f of files) {
      const a = appliedMap.get(f.version);
      if (!a) {
        nPending++;
        lines.push(`  pending     ${f.version}`);
      } else if (a.checksum !== f.checksum) {
        nMismatch++;
        lines.push(`  MISMATCH    ${f.version}  applied checksum ${a.checksum.slice(0, 8)} != file checksum ${f.checksum.slice(0, 8)}`);
      } else {
        nApplied++;
        lines.push(`  applied     ${f.version}  at ${a.applied_at.toISOString()}`);
      }
    }
    const orphans = applied.filter((a) => !files.some((f) => f.version === a.version));
    for (const o of orphans) {
      lines.push(`  orphan      ${o.version}  (applied to DB but no file in repo)`);
    }
    for (const l of lines) console.log(l);
    console.log(`\napplied=${nApplied}  pending=${nPending}  mismatch=${nMismatch}  orphans=${orphans.length}`);
    if (nMismatch > 0 || orphans.length > 0) process.exitCode = 2;
  } finally {
    await sql.end();
  }
}

async function up(opts: { dryRun: boolean; allowEmptyTracking: boolean }) {
  const url = getDbUrl();
  console.log(`DB: ${fmtUrl(url)}  dry-run=${opts.dryRun}\n`);
  const sql = postgres(url, { max: 1 });
  try {
    await ensureTrackingTable(sql);
    await assertNotBootstrappingPopulatedDb(sql, opts);
    const got = (await sql`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS got`) as Array<{ got: boolean }>;
    if (!got[0]?.got) {
      console.error('Could not acquire advisory lock — another migrator is running.');
      process.exit(1);
    }
    try {
      const files = listMigrationFiles(MIGRATIONS_DIR);
      const applied = await readApplied(sql);
      const appliedVers = new Set(applied.map((a) => a.version));
      const pending = files.filter((f) => !appliedVers.has(f.version));

      if (pending.length === 0) {
        console.log('No pending migrations.');
        return;
      }
      console.log(`${pending.length} pending migration(s):`);
      for (const p of pending) console.log(`  ${p.version}  (${p.content.length} bytes, txn=${!p.noTransaction})`);

      if (opts.dryRun) {
        console.log('\n[dry-run] No changes applied.');
        return;
      }

      for (const m of pending) {
        const start = Date.now();
        console.log(`\napplying ${m.version} ...`);
        try {
          const { up: upSql } = splitUpDown(m.content);
          if (m.noTransaction) {
            await sql.unsafe(upSql);
            await recordApplied(sql, m, Date.now() - start);
          } else {
            await sql.begin(async (tx) => {
              await tx.unsafe(upSql);
              await tx`
                INSERT INTO kortix_migrations.applied (version, name, checksum, execution_ms)
                VALUES (${m.version}, ${m.name}, ${m.checksum}, ${Date.now() - start})
              `;
            });
          }
          console.log(`  ✓ ${m.version}  (${Date.now() - start}ms)`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  ✗ ${m.version}: ${msg}`);
          if (m.noTransaction) {
            // mark dirty so the operator knows the DB is half-migrated
            await sql`
              INSERT INTO kortix_migrations.applied (version, name, checksum, execution_ms, dirty)
              VALUES (${m.version}, ${m.name}, ${m.checksum}, ${Date.now() - start}, true)
              ON CONFLICT (version) DO UPDATE SET dirty = true
            `.catch(() => {});
          }
          throw err;
        }
      }
      console.log(`\n✓ ${pending.length} migration(s) applied.`);
    } finally {
      await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
    }
  } finally {
    await sql.end();
  }
}

/**
 * Roll back the most recently applied migration. Requires the file to contain
 * a `-- migrate:down` section with the rollback SQL.
 *
 *   -- forward SQL
 *   ALTER TABLE foo ADD COLUMN bar text;
 *
 *   -- migrate:down
 *   ALTER TABLE foo DROP COLUMN IF EXISTS bar;
 *
 * Refuses if:
 *   - The file has no `-- migrate:down` section (no implicit rollback)
 *   - The file is missing from disk (can't know what to undo)
 *
 * Use --steps=N to roll back N migrations (in reverse order).
 *
 * IMPORTANT: rolling back in production is risky. Most schema changes are not
 * losslessly reversible. Prefer writing a NEW forward migration that undoes
 * the change. `down` is primarily a dev convenience.
 */
async function down(opts: { steps: number; dryRun: boolean }) {
  const url = getDbUrl();
  console.log(`DB: ${fmtUrl(url)}  dry-run=${opts.dryRun}  steps=${opts.steps}\n`);
  const sql = postgres(url, { max: 1 });
  try {
    await ensureTrackingTable(sql);
    const got = (await sql`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS got`) as Array<{ got: boolean }>;
    if (!got[0]?.got) {
      console.error('Could not acquire advisory lock — another migrator is running.');
      process.exit(1);
    }
    try {
      const recent = (await sql`
        SELECT version, name FROM kortix_migrations.applied
        ORDER BY version DESC LIMIT ${opts.steps}
      `) as Array<{ version: string; name: string }>;
      if (recent.length === 0) {
        console.log('Nothing to roll back — tracking table is empty.');
        return;
      }

      const fileByVersion = new Map(listMigrationFiles(MIGRATIONS_DIR).map((f) => [f.version, f]));
      const plan: Array<{ version: string; name: string; downSql: string; noTransaction: boolean }> = [];
      for (const r of recent) {
        const file = fileByVersion.get(r.version);
        if (!file) {
          console.error(`Refusing: file missing for ${r.version}.`);
          process.exit(1);
        }
        const { down: downSql } = splitUpDown(file.content);
        if (!downSql) {
          console.error(
            `Refusing: ${r.version} has no \`-- migrate:down\` section.\n` +
            `Either edit the file to add one, or write a NEW forward migration that undoes the change.`,
          );
          process.exit(1);
        }
        plan.push({ version: r.version, name: r.name, downSql, noTransaction: file.noTransaction });
      }

      console.log(`Will roll back ${plan.length} migration(s) in reverse order:`);
      for (const p of plan) console.log(`  ${p.version}  (${p.downSql.length} bytes, txn=${!p.noTransaction})`);
      if (opts.dryRun) {
        console.log('\n[dry-run] No changes applied.');
        return;
      }

      for (const p of plan) {
        const start = Date.now();
        console.log(`\nrolling back ${p.version} ...`);
        if (p.noTransaction) {
          await sql.unsafe(p.downSql);
          await sql`DELETE FROM kortix_migrations.applied WHERE version = ${p.version}`;
        } else {
          await sql.begin(async (tx) => {
            await tx.unsafe(p.downSql);
            await tx`DELETE FROM kortix_migrations.applied WHERE version = ${p.version}`;
          });
        }
        console.log(`  ✓ ${p.version}  (${Date.now() - start}ms)`);
      }
      console.log(`\n✓ ${plan.length} migration(s) rolled back.`);
    } finally {
      await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
    }
  } finally {
    await sql.end();
  }
}

async function verify() {
  const url = getDbUrl();
  console.log(`DB: ${fmtUrl(url)}\n`);
  const sql = postgres(url, { max: 1 });
  try {
    const trackingExists = await trackingTableExists(sql);
    if (!trackingExists) {
      console.log(`kortix_migrations.applied does not exist — nothing to verify.`);
      return;
    }
    const files = listMigrationFiles(MIGRATIONS_DIR);
    const applied = await readApplied(sql);
    const fileByVersion = new Map(files.map((f) => [f.version, f]));
    let bad = 0;
    for (const a of applied) {
      const f = fileByVersion.get(a.version);
      if (!f) {
        console.log(`  orphan      ${a.version}  (applied but no file)`);
        bad++;
      } else if (f.checksum !== a.checksum) {
        console.log(`  MISMATCH    ${a.version}  file content differs from what was applied`);
        bad++;
      } else if (a.dirty) {
        console.log(`  DIRTY       ${a.version}  marked dirty from a failed apply`);
        bad++;
      } else {
        console.log(`  ok          ${a.version}`);
      }
    }
    if (bad > 0) {
      console.log(`\n${bad} issue(s) found.`);
      process.exitCode = 2;
    } else {
      console.log(`\nAll ${applied.length} applied migration(s) verified.`);
    }
  } finally {
    await sql.end();
  }
}

/**
 * Refuse to start applying migrations against a DB that already has a populated
 * `kortix` schema if our tracking table is empty. That combination almost
 * certainly means we're about to re-apply migrations to data that was set up
 * via a different mechanism — at least one of which has unguarded DELETE
 * statements that would destroy real rows. Operator must explicitly opt in
 * via `--allow-empty-tracking` (after running backfill-tracking.ts).
 */
async function assertNotBootstrappingPopulatedDb(
  sql: postgres.Sql,
  opts: { allowEmptyTracking: boolean },
): Promise<void> {
  const trackedRows = (await sql`SELECT count(*)::int AS n FROM kortix_migrations.applied`) as Array<{ n: number }>;
  if ((trackedRows[0]?.n ?? 0) > 0) return;

  const existing = (await sql`
    SELECT count(*)::int AS n
    FROM information_schema.tables
    WHERE table_schema = 'kortix'
  `) as Array<{ n: number }>;
  const kortixTableCount = existing[0]?.n ?? 0;
  if (kortixTableCount === 0) return;

  if (opts.allowEmptyTracking) {
    console.warn(
      `[migrate] WARNING: kortix_migrations.applied is empty but kortix schema already has ${kortixTableCount} table(s). ` +
      `Proceeding because --allow-empty-tracking was passed. This is a foot-gun — only do this when you've manually verified ` +
      `every pending migration is safe to re-run against the current schema state.`,
    );
    return;
  }

  console.error(
    `[migrate] REFUSING to run.\n\n` +
    `  kortix_migrations.applied: empty (0 rows)\n` +
    `  kortix schema:             populated (${kortixTableCount} existing table(s))\n\n` +
    `This combination would re-execute every migration file against an already-populated\n` +
    `database, including statements like:\n` +
    `  DELETE FROM kortix.chat_channel_bindings;\n` +
    `  DELETE FROM kortix.project_secrets WHERE scope <> 'runtime';\n` +
    `which would destroy real rows.\n\n` +
    `Resolution:\n` +
    `  1. Inspect the DB to confirm which migrations already match its state.\n` +
    `  2. Run: bun packages/db/scripts/backfill-tracking.ts  (marks all files as applied without running them)\n` +
    `  3. Re-run \`migrate up\` — it will be a no-op until you author new migrations.\n` +
    `\n` +
    `If you've already verified this is safe and want to override, pass --allow-empty-tracking.\n`,
  );
  process.exit(1);
}

async function trackingTableExists(sql: postgres.Sql): Promise<boolean> {
  const rows = (await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'kortix_migrations' AND table_name = 'applied'
    ) AS exists
  `) as Array<{ exists: boolean }>;
  return rows[0]?.exists === true;
}

async function ensureTrackingTable(sql: postgres.Sql) {
  await sql`CREATE SCHEMA IF NOT EXISTS kortix_migrations`;
  await sql`
    CREATE TABLE IF NOT EXISTS kortix_migrations.applied (
      version       TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      checksum      TEXT NOT NULL,
      applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by    TEXT NOT NULL DEFAULT current_user,
      execution_ms  INTEGER NOT NULL DEFAULT 0,
      dirty         BOOLEAN NOT NULL DEFAULT false
    )
  `;
}

interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
  applied_by: string;
  execution_ms: number;
  dirty: boolean;
}

async function readApplied(sql: postgres.Sql): Promise<AppliedRow[]> {
  const rows = (await sql`
    SELECT version, name, checksum, applied_at, applied_by, execution_ms, dirty
    FROM ${sql(TRACKING_TABLE)}
    ORDER BY version
  `) as unknown as AppliedRow[];
  return rows;
}

async function recordApplied(sql: postgres.Sql, m: MigrationFile, executionMs: number) {
  await sql`
    INSERT INTO kortix_migrations.applied (version, name, checksum, execution_ms)
    VALUES (${m.version}, ${m.name}, ${m.checksum}, ${executionMs})
  `;
}

/**
 * Auto-generate a migration from the diff between `kortix.ts` and drizzle's
 * baseline snapshot in `packages/db/drizzle/meta/`. This is the standard
 * workflow: edit kortix.ts, run `db:migrate:generate <slug>`, review the
 * produced SQL, commit both the .sql file AND the updated drizzle/ snapshot.
 *
 * Process:
 *   1. Pre-flight: drizzle/meta/ must exist (baseline must be committed)
 *   2. Run `drizzle-kit generate --name <slug>` — produces `drizzle/NNNN_<slug>.sql`
 *      plus an updated snapshot in `drizzle/meta/`
 *   3. If diff is empty (no schema changes), abort and clean up
 *   4. Otherwise: rename `drizzle/NNNN_<slug>.sql` → `packages/db/migrations/YYYYMMDDHHMMSS_<slug>.sql`
 *
 * For hand-written SQL (RLS policies, custom Postgres functions, data
 * migrations) use `migrate.ts new <slug>` instead.
 */
function generateMigration(slug: string) {
  if (!slug || !/^[a-z0-9_]+$/.test(slug)) {
    console.error('slug must match /^[a-z0-9_]+$/, e.g. add_user_table');
    process.exit(1);
  }
  if (!existsSync(join(DRIZZLE_DIR, 'meta'))) {
    console.error(
      `Drizzle snapshot missing at ${DRIZZLE_DIR}/meta/. ` +
      `Run \`bunx drizzle-kit generate --config drizzle.config.ts --name baseline\` ` +
      `to seed it from the current schema, then delete the produced SQL (keeping meta/).`,
    );
    process.exit(1);
  }

  const beforeFiles = new Set(
    existsSync(DRIZZLE_DIR) ? readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith('.sql')) : [],
  );

  const result = spawnSync(
    'bunx',
    ['drizzle-kit', 'generate', '--config', DRIZZLE_CONFIG, '--name', slug],
    {
      cwd: join(import.meta.dir, '..'),
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' },
    },
  );
  if (result.status !== 0) {
    console.error(`drizzle-kit generate failed (exit ${result.status}).`);
    process.exit(result.status ?? 1);
  }

  const afterFiles = new Set(readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith('.sql')));
  const newFiles = [...afterFiles].filter((f) => !beforeFiles.has(f));
  if (newFiles.length === 0) {
    console.log('\nNo schema changes detected — kortix.ts matches the current snapshot.');
    console.log('If you wanted a hand-written migration (RLS, functions, data), use:');
    console.log('  bun run --cwd packages/db db:migrate:new ' + slug);
    return;
  }
  if (newFiles.length > 1) {
    console.error(`Expected one new SQL file, got ${newFiles.length}: ${newFiles.join(', ')}`);
    process.exit(1);
  }

  const drizzleSqlPath = join(DRIZZLE_DIR, newFiles[0]);
  const d = new Date();
  const stamp =
    d.getUTCFullYear().toString() +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds());
  const targetName = `${stamp}_${slug}.sql`;
  const targetPath = join(MIGRATIONS_DIR, targetName);
  if (existsSync(targetPath)) {
    console.error(`Target already exists: ${targetPath}`);
    process.exit(1);
  }
  renameSync(drizzleSqlPath, targetPath);
  console.log(`\nGenerated: packages/db/migrations/${targetName}`);
  console.log(`Drizzle snapshot updated. Commit BOTH the new .sql AND packages/db/drizzle/ changes.`);
  console.log(`Review the SQL before applying — drizzle-kit's output is sometimes ugly.`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'new':
      newMigration(rest[0] ?? '');
      return;
    case 'generate':
      generateMigration(rest[0] ?? '');
      return;
    case 'status':
      await status();
      return;
    case 'up':
      await up({
        dryRun: rest.includes('--dry-run'),
        allowEmptyTracking: rest.includes('--allow-empty-tracking'),
      });
      return;
    case 'down': {
      const stepsArg = rest.find((a) => a.startsWith('--steps='));
      const steps = stepsArg ? Math.max(1, parseInt(stepsArg.slice('--steps='.length), 10) || 1) : 1;
      await down({ steps, dryRun: rest.includes('--dry-run') });
      return;
    }
    case 'verify':
      await verify();
      return;
    default:
      console.error(`Unknown command: ${cmd ?? '(none)'}`);
      console.error('Usage: migrate.ts <new|status|up|verify> [args]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

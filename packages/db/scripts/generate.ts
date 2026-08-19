#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
/**
 * Thin handoff: drizzle-kit generates the SQL from kortix.ts; node-pg-migrate
 * applies it. This script is the only glue between the two — it runs
 * `drizzle-kit generate`, then renames the produced file into migrations/ with
 * a node-pg-migrate-native 17-digit UTC timestamp (YYYYMMDDHHMMSSmmm).
 *
 *   bun scripts/generate.ts add_widget_table
 *
 * Review the SQL, then commit BOTH the new migrations/<ts>_slug.sql AND the
 * updated drizzle/ snapshot. node-pg-migrate applies it (`pnpm migrate`).
 *
 * For hand-written SQL (RLS, functions, data) use instead:
 *   node-pg-migrate create <slug> -m migrations -j sql --migration-filename-format utc
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DB_ROOT = join(import.meta.dir, '..');
const DRIZZLE_DIR = join(DB_ROOT, 'drizzle');
const MIGRATIONS_DIR = join(DB_ROOT, 'migrations');

function utcStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    d.getUTCFullYear().toString() +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) +
    p(d.getUTCMilliseconds(), 3)
  );
}

/**
 * The house-rules safety header, prepended to drizzle's raw output.
 *
 * `migrate:create` has pre-filled this since the zero-downtime policy landed,
 * but `migrate:generate` did not — it renamed drizzle's file through unchanged.
 * So every GENERATED migration was born failing squawk's
 * `require-timeout-settings`, and only passed if the author happened to paste
 * the header in by hand. One that didn't (20260805030712000_enterprise_
 * entitled_flag.sql) merged red and then failed the lint on every unrelated PR
 * afterwards, because the gate's exemption list is a fixed snapshot.
 *
 * Kept deliberately in sync with the `-- SAFETY HEADER` block in
 * create-migration.ts; scripts/generate.test.ts asserts the timeouts match.
 */
function safetyHeader(name: string): string {
  return `-- Migration: ${name}
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEW THE GENERATED SQL BELOW. drizzle-kit writes it from the diff between
-- kortix.ts and the snapshot; it knows the target shape, not how to reach it
-- without downtime. Check the same list \`migrate:create\` prints:
--   [ ] Bare NOT NULL added to an existing populated table (needs a backfill first).
--   [ ] Plain CREATE INDEX / DROP INDEX on an EXISTING table -- move it to
--       \`pnpm migrate:create <slug> --concurrent\`; it blocks writes here.
--   [ ] New FK/constraint on an existing table -- add NOT VALID, VALIDATE after.
--   [ ] A DROP/RENAME/ALTER ... TYPE the generator proposed from a STALE
--       snapshot. Delete anything already applied by an earlier migration.
--   [ ] Any DROP/RENAME/ALTER ... TYPE/DROP NOT NULL needs the enforced line:
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

`;
}

const slug = process.argv[2] ?? '';
if (!/^[a-z0-9_]+$/.test(slug)) {
  console.error('Usage: bun scripts/generate.ts <slug>   (slug matches /^[a-z0-9_]+$/)');
  process.exit(1);
}

const before = new Set(
  existsSync(DRIZZLE_DIR) ? readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith('.sql')) : [],
);
const res = spawnSync(
  'bunx',
  ['drizzle-kit', 'generate', '--config', join(DB_ROOT, 'drizzle.config.ts'), '--name', slug],
  {
    cwd: DB_ROOT,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' },
  },
);
if (res.status !== 0) process.exit(res.status ?? 1);

const created = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith('.sql') && !before.has(f));
if (created.length === 0) {
  console.log('\nNo schema changes detected — kortix.ts matches the snapshot. Nothing generated.');
  console.log(
    `For hand-written SQL: node-pg-migrate create ${slug} -m migrations -j sql --migration-filename-format utc`,
  );
  process.exit(0);
}
if (created.length > 1) {
  console.error(`Expected one new SQL file, got ${created.length}: ${created.join(', ')}`);
  process.exit(1);
}

const target = `${utcStamp()}_${slug}.sql`;
const targetPath = join(MIGRATIONS_DIR, target);
renameSync(join(DRIZZLE_DIR, created[0]), targetPath);
writeFileSync(targetPath, safetyHeader(slug) + readFileSync(targetPath, 'utf8'));
console.log(`\nGenerated: packages/db/migrations/${target}`);
console.log('Review the SQL, then commit it AND the updated packages/db/drizzle/ snapshot.');
console.log('Apply with: pnpm migrate');

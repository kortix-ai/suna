#!/usr/bin/env bun
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
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const DB_ROOT = join(import.meta.dir, '..');
const DRIZZLE_DIR = join(DB_ROOT, 'drizzle');
const MIGRATIONS_DIR = join(DB_ROOT, 'migrations');

function utcStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    d.getUTCFullYear().toString() +
    p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) +
    p(d.getUTCMilliseconds(), 3)
  );
}

const slug = process.argv[2] ?? '';
if (!/^[a-z0-9_]+$/.test(slug)) {
  console.error('Usage: bun scripts/generate.ts <slug>   (slug matches /^[a-z0-9_]+$/)');
  process.exit(1);
}

const before = new Set(existsSync(DRIZZLE_DIR) ? readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith('.sql')) : []);
const res = spawnSync('bunx', ['drizzle-kit', 'generate', '--config', join(DB_ROOT, 'drizzle.config.ts'), '--name', slug], {
  cwd: DB_ROOT,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' },
});
if (res.status !== 0) process.exit(res.status ?? 1);

const created = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith('.sql') && !before.has(f));
if (created.length === 0) {
  console.log('\nNo schema changes detected — kortix.ts matches the snapshot. Nothing generated.');
  console.log('For hand-written SQL: node-pg-migrate create ' + slug + ' -m migrations -j sql --migration-filename-format utc');
  process.exit(0);
}
if (created.length > 1) {
  console.error(`Expected one new SQL file, got ${created.length}: ${created.join(', ')}`);
  process.exit(1);
}

const target = `${utcStamp()}_${slug}.sql`;
renameSync(join(DRIZZLE_DIR, created[0]), join(MIGRATIONS_DIR, target));
console.log(`\nGenerated: packages/db/migrations/${target}`);
console.log('Review the SQL, then commit it AND the updated packages/db/drizzle/ snapshot.');
console.log('Apply with: pnpm migrate');

#!/usr/bin/env bun
/**
 * One-time backfill: marks every existing migration file as "applied" in
 * kortix_migrations.applied, without re-executing the file content.
 *
 * Idempotent — re-running is safe (ON CONFLICT DO NOTHING).
 *
 * USAGE:
 *   DATABASE_URL=... bun scripts/backfill-tracking.ts [--dry-run]
 *
 * SAFETY:
 *   - Refuses to run if any migration is genuinely PENDING (i.e. its hallmark
 *     is missing from the DB). Operator must apply via the normal flow first.
 *   - Only INSERTs into the tracking table. Touches NO other table.
 *   - Prints exactly what it'll do before doing it.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import postgres from 'postgres';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
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

function resolveUrl(): string {
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
  console.error('No DB URL resolved. Set $DATABASE_URL or pass --target=<name>.');
  process.exit(1);
}

async function main() {
  const url = resolveUrl();
  const dryRun = process.argv.includes('--dry-run');
  console.log(`DB: ${fmtUrl(url)}  dry-run=${dryRun}\n`);

  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const records = files.map((f) => {
    const path = join(MIGRATIONS_DIR, f);
    const content = readFileSync(path, 'utf-8');
    const version = f.replace(/\.sql$/, '');
    const us = version.indexOf('_');
    const name = us >= 0 ? version.slice(us + 1) : version;
    return { version, name, checksum: sha256(content), bytes: content.length };
  });
  console.log(`Found ${records.length} migration file(s).`);

  const sql = postgres(url, { max: 1 });
  try {
    // Apply migration 94 if not yet applied (creates the tracking schema/table).
    const trackingExists = (await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'kortix_migrations' AND table_name = 'applied'
      ) AS exists
    `) as Array<{ exists: boolean }>;

    if (!trackingExists[0]?.exists) {
      console.log('\nTracking table does not exist. Will create kortix_migrations.applied.');
      if (dryRun) {
        console.log('  [dry-run] would CREATE SCHEMA + TABLE');
      } else {
        const initFile = files.find((f) => f.includes('_migration_tracking.sql'));
        if (!initFile) {
          console.error('Could not find _migration_tracking.sql — refusing to bootstrap blindly.');
          process.exit(1);
        }
        const initSql = readFileSync(join(MIGRATIONS_DIR, initFile), 'utf-8');
        await sql.unsafe(initSql);
        console.log(`  ✓ created from ${initFile}`);
      }
    } else {
      console.log('\nTracking table already exists.');
    }

    if (!dryRun) {
      const existing = (await sql`
        SELECT version FROM kortix_migrations.applied
      `) as Array<{ version: string }>;
      const existingSet = new Set(existing.map((r) => r.version));
      const toInsert = records.filter((r) => !existingSet.has(r.version));
      console.log(`\n${existing.length} already tracked.`);
      console.log(`${toInsert.length} to backfill.\n`);

      let inserted = 0;
      for (const r of toInsert) {
        await sql`
          INSERT INTO kortix_migrations.applied (version, name, checksum, applied_by, execution_ms)
          VALUES (${r.version}, ${r.name}, ${r.checksum}, 'backfill', 0)
          ON CONFLICT (version) DO NOTHING
        `;
        inserted++;
        if (inserted % 20 === 0) console.log(`  ... ${inserted}/${toInsert.length}`);
      }
      console.log(`\n✓ backfilled ${inserted} migration(s).`);
    } else {
      console.log(`\n[dry-run] Would insert ${records.length} row(s) into kortix_migrations.applied.`);
      for (const r of records.slice(0, 5)) console.log(`  ${r.version}  sha=${r.checksum.slice(0, 12)}  ${r.bytes}B`);
      if (records.length > 5) console.log(`  ... and ${records.length - 5} more.`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

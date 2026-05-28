#!/usr/bin/env bun
/**
 * One-time normalization: rename every legacy `00000000000NNN_*.sql` migration
 * file to `YYYYMMDDHHMMSS_*.sql` with synthetic timestamps that preserve sort
 * order. Updates kortix_migrations.applied.version rows to match.
 *
 *   --dry-run   prints the plan, no changes
 *   --apply     renames files AND updates tracking rows in one transaction
 *
 * Generates timestamps starting 2024-01-01 00:00:00 UTC and incrementing one
 * second per file in current sort order. With 96 files that's 96 seconds —
 * comfortably under any conceivable max. The 3 duplicate-prefix collisions
 * (00000000000079_*, 080_*, 088_*) get distinct timestamps automatically.
 *
 * Files matching the NEW pattern already are left alone (no double-rename).
 */

import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const BASE_DATE_UTC = Date.UTC(2024, 0, 1, 0, 0, 0); // 2024-01-01 00:00:00 UTC

const TIMESTAMP_PATTERN = /^\d{14}_/;
const LEGACY_PATTERN = /^\d{14}_/; // 00000000000NNN_ is also 14 digits — same pattern
// We tell them apart by content: timestamps start with year ≥ 2024
function isAlreadyTimestamped(version: string): boolean {
  const m = version.match(/^(\d{14})/);
  if (!m) return false;
  const year = parseInt(m[1].slice(0, 4), 10);
  return year >= 2024 && year <= 2100;
}

function fmtTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
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

function buildManifest(): Array<{ oldVersion: string; newVersion: string; oldFile: string; newFile: string }> {
  if (!existsSync(MIGRATIONS_DIR)) throw new Error(`Migrations dir not found: ${MIGRATIONS_DIR}`);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const manifest: Array<{ oldVersion: string; newVersion: string; oldFile: string; newFile: string }> = [];
  let nextSec = 0;
  for (const f of files) {
    const oldVersion = f.replace(/\.sql$/, '');
    if (isAlreadyTimestamped(oldVersion)) {
      nextSec++;
      continue;
    }
    const us = oldVersion.indexOf('_');
    const slug = us >= 0 ? oldVersion.slice(us + 1) : oldVersion;
    const stamp = fmtTimestamp(BASE_DATE_UTC + nextSec * 1000);
    const newVersion = `${stamp}_${slug}`;
    manifest.push({
      oldVersion,
      newVersion,
      oldFile: f,
      newFile: `${newVersion}.sql`,
    });
    nextSec++;
  }
  return manifest;
}

async function main() {
  const dryRun = !process.argv.includes('--apply');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required (we need to update the tracking table).');
    process.exit(1);
  }
  console.log(`DB: ${fmtUrl(url)}  ${dryRun ? '[dry-run]' : '[APPLY]'}\n`);

  const manifest = buildManifest();
  console.log(`Rename plan (${manifest.length} file(s)):`);
  for (const m of manifest.slice(0, 5)) console.log(`  ${m.oldFile}  →  ${m.newFile}`);
  if (manifest.length > 10) console.log(`  ... ${manifest.length - 10} more ...`);
  for (const m of manifest.slice(-5)) console.log(`  ${m.oldFile}  →  ${m.newFile}`);

  // Sanity: all new versions must be unique
  const news = new Set(manifest.map((m) => m.newVersion));
  if (news.size !== manifest.length) {
    console.error('FATAL: duplicate new versions in manifest — refusing to proceed.');
    process.exit(1);
  }
  // Sanity: each new version must NOT collide with files we're leaving alone
  const allExisting = new Set(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, '')));
  const renaming = new Set(manifest.map((m) => m.oldVersion));
  for (const m of manifest) {
    if (allExisting.has(m.newVersion) && !renaming.has(m.newVersion)) {
      console.error(`FATAL: ${m.newVersion} would collide with an existing un-renamed file.`);
      process.exit(1);
    }
  }
  console.log('\nSanity checks: passed.');

  if (dryRun) {
    console.log('\n[dry-run] No changes made. Re-run with --apply to execute.');
    return;
  }

  // Verify all old versions exist in the tracking table (so we know our rename is consistent)
  const sql = postgres(url, { max: 1 });
  try {
    const tracked = (await sql`SELECT version FROM kortix_migrations.applied`) as Array<{ version: string }>;
    const trackedSet = new Set(tracked.map((r) => r.version));
    const missingInTracking = manifest.filter((m) => !trackedSet.has(m.oldVersion));
    if (missingInTracking.length > 0) {
      console.error(`FATAL: ${missingInTracking.length} migrations are not in kortix_migrations.applied. Run backfill-tracking.ts first.`);
      for (const m of missingInTracking.slice(0, 5)) console.error(`  ${m.oldVersion}`);
      process.exit(1);
    }

    // DB updates first (atomic in one transaction), THEN rename files. If the
    // DB update fails, the files are still in their old names and we can retry.
    // If file renames fail mid-way, the DB already reflects the new state — we
    // log loudly and the operator can repair.
    console.log('\nUpdating tracking table (one transaction)...');
    await sql.begin(async (tx) => {
      for (const m of manifest) {
        await tx`UPDATE kortix_migrations.applied SET version = ${m.newVersion} WHERE version = ${m.oldVersion}`;
      }
    });
    console.log(`  ✓ updated ${manifest.length} row(s).`);

    console.log('\nRenaming files...');
    let renamed = 0;
    for (const m of manifest) {
      const from = join(MIGRATIONS_DIR, m.oldFile);
      const to = join(MIGRATIONS_DIR, m.newFile);
      renameSync(from, to);
      renamed++;
    }
    console.log(`  ✓ renamed ${renamed} file(s).`);

    console.log('\nDone.');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

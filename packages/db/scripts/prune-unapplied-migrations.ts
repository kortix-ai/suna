#!/usr/bin/env bun
/**
 * Delete the migration files a live database has not applied, so a canonical
 * database built from the remaining files holds only what that live ledger
 * records. Then verify-live-schema.ts fails only for an object an applied
 * migration created and live lacks.
 *
 * Without this, every migration merged to dev and not yet released shows as
 * "missing on prod" between releases.
 *
 * Run it only on a throwaway CI checkout: it deletes files.
 *
 *   bun scripts/prune-unapplied-migrations.ts --live <url> [--dir <migrations dir>]
 *
 * An empty ledger (no ledger table) prunes nothing, as in pendingMigrations.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readDatabase } from './catalog';

/** Pure: migration files (`<name>.sql` or `<name>.ts`) whose name is absent from `ledger`. */
export function unappliedMigrationFiles(files: readonly string[], ledger: readonly string[]): string[] {
  if (ledger.length === 0) return [];
  const applied = new Set(ledger);
  return files.filter((f) => /\.(sql|ts)$/.test(f) && !applied.has(f.replace(/\.(sql|ts)$/, '')));
}

if (import.meta.main) {
  const flag = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const live = flag('--live') ?? process.env.LIVE_DB_URL;
  const dir = flag('--dir') ?? join(import.meta.dir, '..', 'migrations');
  if (!live) {
    console.error('Usage: bun scripts/prune-unapplied-migrations.ts --live <url> [--dir <dir>]');
    process.exit(2);
  }
  const { ledger } = await readDatabase(live);
  const pruned = unappliedMigrationFiles(readdirSync(dir), ledger);
  for (const f of pruned) rmSync(join(dir, f));
  console.log(`Pruned ${pruned.length} migration(s) the live ledger (${ledger.length} rows) has not applied.`);
}

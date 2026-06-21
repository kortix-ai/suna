#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Thin adapter around node-pg-migrate's programmatic `runner()`.
 *
 * Why not the node-pg-migrate CLI directly? Our deploy runtime is bun-only
 * (oven/bun:slim, no node binary), and the CLI bin does optional `tryImport()`s
 * (dotenv/config/ts-node/…) that bun's resolver rejects differently than node's.
 * The library `runner()` has none of that — it's the same battle-tested engine
 * the CLI wraps. ALL migration logic (advisory lock, the pgmigrations tracking
 * table, per-migration transactions, dry-run, fake) is node-pg-migrate's.
 *
 *   bun scripts/migrate.ts up                 apply pending
 *   bun scripts/migrate.ts status             list pending (dry-run, no writes)
 *   bun scripts/migrate.ts down [--count=N]   roll back N (default 1)
 *   bun scripts/migrate.ts fake               mark pending as applied without running (baseline)
 *
 * DB URL: $DATABASE_URL, or --target=<env> (reads <ENV>_DB_URL / DATABASE_URL
 * from apps/api/.env so secrets never go through the shell).
 */
import { runner } from 'node-pg-migrate';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const DOTENV = join(import.meta.dir, '..', '..', '..', 'apps', 'api', '.env');

function readEnvKey(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  for (const raw of readFileSync(path, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.startsWith(`${key}=`)) continue;
    let v = line.slice(key.length + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    return v;
  }
  return null;
}

function resolveUrl(argv: string[]): string {
  const target = argv.find((a) => a.startsWith('--target='))?.slice('--target='.length);
  if (target) {
    const key =
      target.toUpperCase() === 'LOCAL' ? 'DATABASE_URL' : `${target.toUpperCase()}_DB_URL`;
    const v = readEnvKey(DOTENV, key);
    if (!v) {
      console.error(`--target=${target}: ${key} not set in apps/api/.env`);
      process.exit(1);
    }
    return v;
  }
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  console.error('No DB URL. Set $DATABASE_URL or pass --target=<env>.');
  process.exit(1);
}

const fmtUrl = (u: string) => {
  try {
    const x = new URL(u);
    if (x.password) x.password = '***';
    return x.toString();
  } catch {
    return u.replace(/:[^:@/]+@/, ':***@');
  }
};

async function main() {
  const [cmd = 'up', ...rest] = process.argv.slice(2);
  const databaseUrl = resolveUrl(rest);
  const countArg = rest.find((a) => a.startsWith('--count='))?.slice('--count='.length);

  const base = {
    databaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    migrationsSchema: 'kortix_migrations',
    createMigrationsSchema: true,
    checkOrder: true,
    singleTransaction: true,
    verbose: false,
    logger: console,
  } as const;

  console.log(`node-pg-migrate ${cmd}  DB: ${fmtUrl(databaseUrl)}`);

  switch (cmd) {
    case 'up':
      await runner({ ...base, direction: 'up', count: Number.POSITIVE_INFINITY });
      return;
    case 'fake':
      await runner({ ...base, direction: 'up', count: Number.POSITIVE_INFINITY, fake: true });
      return;
    case 'down':
      await runner({
        ...base,
        direction: 'down',
        count: countArg ? Number.parseInt(countArg, 10) : 1,
      });
      return;
    case 'status': {
      const pending = await runner({
        ...base,
        direction: 'up',
        count: Number.POSITIVE_INFINITY,
        dryRun: true,
      });
      if (pending.length === 0) console.log('Up to date — no pending migrations.');
      else {
        console.log(`${pending.length} pending migration(s):`);
        for (const m of pending) console.log(`  pending  ${m.name}`);
      }
      if (pending.length > 0) process.exitCode = 1;
      return;
    }
    default:
      console.error(`Unknown command: ${cmd}. Use: up | status | down | fake`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

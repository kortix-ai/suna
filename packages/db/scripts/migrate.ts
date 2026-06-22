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
 *   bun scripts/migrate.ts bootstrap          fresh-DB: install non-kortix prereqs, then `up`
 *
 * DB URL: $DATABASE_URL, or --target=<env> (reads <ENV>_DB_URL / DATABASE_URL
 * from apps/api/.env so secrets never go through the shell).
 */
import { runner } from 'node-pg-migrate';
import pg from 'pg';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const BOOTSTRAP_SQL = join(import.meta.dir, '..', 'drizzle', '0000_bootstrap.sql');
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

/**
 * Self-heal the one-time transition to the baseline migration system on an
 * environment whose schema PREDATES it. The baseline migration recreates the
 * entire managed schema, so running it against a DB that already has that schema
 * fails (e.g. `CREATE TYPE … AS ENUM` → duplicate_object 42710). Its header
 * documents the contract: on existing environments it must be "marked-applied
 * without running". This detects that case and fakes ONLY the baseline (the
 * oldest pending migration) so the real `up` that follows applies just the
 * genuinely-new migrations. A fresh DB has no schema → no-op → `up` creates it.
 *
 * Trigger is conservative: the managed schema sentinel (`kortix.accounts`) is
 * present AND the tracking table has no rows yet (never baselined). After the
 * fake records the baseline, this never fires again.
 */
async function autoBaselineIfNeeded(base: Record<string, unknown>, databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows: [schema] } = await client.query<{ exists: boolean }>(
      "select to_regclass('kortix.accounts') is not null as exists",
    );
    if (!schema?.exists) return; // fresh DB → let `up` run the baseline for real

    const { rows: [tbl] } = await client.query<{ exists: boolean }>(
      "select to_regclass('kortix_migrations.pgmigrations') is not null as exists",
    );
    if (tbl?.exists) {
      const { rows: [{ n }] } = await client.query<{ n: number }>(
        'select count(*)::int as n from kortix_migrations.pgmigrations',
      );
      if (n > 0) return; // already tracked (baseline recorded) → normal `up`
    }

    console.log('[migrate] existing managed schema with an empty migration ledger → faking the baseline (mark-applied, not run).');
    await runner({ ...(base as any), direction: 'up', count: 1, fake: true });
  } finally {
    await client.end();
  }
}

/**
 * Self-host only: install the NON-kortix prerequisites (the basejump account
 * framework + public credit RPCs + the auth.users signup triggers) on a FRESH
 * database, BEFORE the kortix baseline migration runs. The baseline's RLS
 * policies and functions reference `basejump.account_user`, so without this the
 * very first `up` fails with `relation "basejump.account_user" does not exist`.
 *
 * Deployed cloud/dev databases already have these objects (provided by the
 * platform / historical migrations now archived), so this is gated on basejump
 * being ABSENT — it is a no-op on every provisioned DB and idempotent on re-run.
 *
 * Sequencing: the basejump bootstrap installs triggers ON auth.users, so it must
 * run AFTER Supabase Auth (GoTrue) has created the auth schema. We poll for
 * auth.users rather than rely on compose ordering, which can't express "GoTrue
 * has finished its own migrations".
 */
async function selfHostBootstrapIfFresh(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const { rows: [r] } = await client.query<{ ok: boolean }>(
        "select to_regclass('auth.users') is not null as ok",
      );
      if (r?.ok) break;
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for auth.users — is Supabase Auth (GoTrue) running?');
      }
      await new Promise((res) => setTimeout(res, 2000));
    }

    const { rows: [bj] } = await client.query<{ ok: boolean }>(
      "select to_regclass('basejump.account_user') is not null as ok",
    );
    if (bj?.ok) {
      console.log('[migrate] basejump prerequisites already present — skipping bootstrap.');
      return;
    }

    if (!existsSync(BOOTSTRAP_SQL)) {
      throw new Error(`bootstrap SQL missing at ${BOOTSTRAP_SQL} (is packages/db/drizzle bundled in the image?)`);
    }
    console.log('[migrate] fresh database — installing non-kortix prerequisites (basejump + credit RPCs + signup triggers)…');
    const text = readFileSync(BOOTSTRAP_SQL, 'utf-8');
    let applied = 0;
    let skippedStorage = 0;
    // drizzle separates statements with this sentinel; we can't split on ';'
    // because function bodies contain semicolons. Run every statement on the
    // SAME session so the leading `SET check_function_bodies = false` persists.
    for (const chunk of text.split('--> statement-breakpoint')) {
      const stmt = chunk.trim();
      if (!stmt) continue;
      const code = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
      if (!code) continue; // comment-only chunk
      try {
        await client.query(stmt);
        applied++;
      } catch (err) {
        // The bundled bootstrap also seeds Supabase Storage buckets. A self-host
        // stack runs no Storage service, so the base image's `storage.buckets`
        // lacks the columns these INSERTs use. Those failures are expected and
        // harmless — skip storage-only statements, surface everything else.
        const msg = (err as Error)?.message ?? '';
        if (/\bstorage\./i.test(stmt) || /"buckets"/i.test(msg)) {
          skippedStorage++;
          continue;
        }
        console.error(`[migrate] bootstrap statement failed:\n${stmt.slice(0, 300)}`);
        throw err;
      }
    }
    console.log(`[migrate] bootstrap complete (${applied} statements applied, ${skippedStorage} storage statements skipped).`);
  } finally {
    await client.end();
  }
}

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
      await autoBaselineIfNeeded(base, databaseUrl);
      await runner({ ...base, direction: 'up', count: Number.POSITIVE_INFINITY });
      return;
    case 'bootstrap':
      // Fresh-DB convenience for self-host: prereqs (basejump etc.) → then `up`.
      await selfHostBootstrapIfFresh(databaseUrl);
      await autoBaselineIfNeeded(base, databaseUrl);
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
      console.error(`Unknown command: ${cmd}. Use: up | status | down | fake | bootstrap`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

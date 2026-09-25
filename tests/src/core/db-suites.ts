/**
 * The `db-suites` lane: every PostgreSQL-backed test file in the repository.
 *
 * A DB suite is a Bun test file that needs a real PostgreSQL. It gets its
 * database one of two ways:
 *
 *  - The lane hands it one. The lane migrates one TEMPLATE database per
 *    migration-history hash on the local Supabase cluster, then clones a fresh
 *    database from it for every file (`CREATE DATABASE … TEMPLATE`, ~150 ms).
 *    The file sees only its own rows, so it can never depend on, or break
 *    because of, the developer's data or a sibling file's rows.
 *  - The file starts its own disposable PostgreSQL container (the migration
 *    contracts in `packages/db/scripts` and `tests/migration`). The lane still
 *    runs it in its own process.
 *
 * Every file runs in its own `bun test` process. `mock.module()` is
 * process-global in Bun, so file order can never decide which module another
 * file sees, and `--isolate` is not needed.
 *
 * A DB suite that reports a skipped test, or no test at all, FAILS the lane.
 * The lane always supplies a database and Docker, so a skip here means the
 * suite never looked at the database it was given — a vacuous pass.
 *
 * This module is pure (node:fs only) so the runner unit tests can import it.
 * `tests/bin/db-suites.ts` owns the processes and the database.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** One discovery root: a package directory and the files in it that are DB suites. */
export interface DbSuiteRoot {
  /** Package directory, relative to the repository root. `bun test` runs here. */
  cwd: string;
  /** Directory scanned recursively, relative to `cwd`. */
  dir: string;
  /** File-name predicate. */
  match: (name: string) => boolean;
  /** `bun test --env-file`, relative to `cwd`. Hermetic placeholder config. */
  envFile?: string;
}

/**
 * THE discovery rule. The unit discovery of each package excludes exactly
 * these names, so a file is in one lane or the other, never both and never
 * neither:
 *   - `apps/api/scripts/test.sh` default mode excludes both apps/api patterns;
 *   - `packages/db` `test` ignores `*.integration.test.ts`;
 *   - `tests/migration` runs nowhere else.
 */
export const DB_SUITE_ROOTS: readonly DbSuiteRoot[] = [
  {
    cwd: 'apps/api',
    dir: 'src',
    match: (name) =>
      (name.startsWith('integration-') && name.endsWith('.test.ts')) ||
      name.endsWith('.integration.test.ts'),
    envFile: 'scripts/test.env',
  },
  {
    cwd: 'packages/db',
    dir: 'scripts',
    match: (name) => name.endsWith('.integration.test.ts'),
  },
  {
    cwd: 'tests',
    dir: 'migration',
    match: (name) => name.endsWith('.test.ts'),
  },
];

/**
 * Suites the lane lists but does not run. Each entry needs a reason a reader
 * can act on. The lane prints every entry on every run; an entry is never a
 * silent skip. Remove the entry when the reason is fixed.
 */
export const DB_SUITE_QUARANTINE: Readonly<Record<string, string>> = {
  'apps/api/src/__tests__/integration-project-snapshot.test.ts':
    'Needs a reachable S3-compatible bucket (KORTIX_PROJECT_SNAPSHOT_S3_*): the S3 round ' +
    'trip is the subject under test, and the lane provides only PostgreSQL. Run it by hand ' +
    'against local MinIO; un-quarantine when the lane can supply a bucket.',
  'packages/db/scripts/migration-ledger-repair.integration.test.ts':
    'The final pending-list check uses node-pg-migrate `dryRun`, which still runs a ' +
    "pending migration's `pgm.db.query()` statements (first seen with " +
    '20260818120000000_project_role_editor_to_manager.concurrent.ts), so the minimal ' +
    'fixture schema fails on kortix.project_members. `migrate.ts status` uses the same ' +
    'dry run. Fix: compute pending migrations without the runner, then use that here.',
};

export interface DbSuite {
  /** Repository-relative path of the test file. */
  file: string;
  /** Package directory, repository-relative. */
  cwd: string;
  /** Test file path relative to `cwd`. */
  path: string;
  envFile?: string;
}

function walk(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const toPosix = (path: string) => path.split(sep).join('/');

export function discoverDbSuites(
  root: string,
  roots: readonly DbSuiteRoot[] = DB_SUITE_ROOTS,
): DbSuite[] {
  const suites: DbSuite[] = [];
  for (const suiteRoot of roots) {
    const packageDir = join(root, suiteRoot.cwd);
    for (const full of walk(join(packageDir, suiteRoot.dir))) {
      const name = full.slice(full.lastIndexOf(sep) + 1);
      if (!suiteRoot.match(name)) continue;
      suites.push({
        file: toPosix(relative(root, full)),
        cwd: suiteRoot.cwd,
        path: toPosix(relative(packageDir, full)),
        ...(suiteRoot.envFile ? { envFile: suiteRoot.envFile } : {}),
      });
    }
  }
  return suites.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Keep the suites whose path contains any filter. No filter keeps all. A
 * filter that matches nothing is an error: a typo must not turn into a green
 * run of zero suites.
 */
export function selectDbSuites(suites: DbSuite[], filters: string[]): DbSuite[] {
  if (filters.length === 0) return suites;
  const unmatched = filters.filter((filter) => !suites.some((suite) => suite.file.includes(filter)));
  if (unmatched.length > 0) {
    throw new Error(`no DB suite matches ${unmatched.join(', ')}`);
  }
  return suites.filter((suite) => filters.some((filter) => suite.file.includes(filter)));
}

/**
 * Content hash of everything that shapes the migrated template: the platform
 * `auth` schema copied from the local Supabase database, the migration files,
 * the bootstrap SQL, and the migrate scripts with their prerequisites. A
 * change to any of them builds a new template; an unchanged tree reuses the
 * one already on the local cluster.
 */
export function migrationTemplateHash(root: string, platformSchemaSql: string): string {
  const hash = createHash('sha256');
  hash.update(platformSchemaSql);
  hash.update('\0');
  const inputs = ['packages/db/migrations', 'packages/db/drizzle', 'packages/db/scripts'];
  for (const input of inputs) {
    const files = walk(join(root, input))
      .filter((file) => !file.endsWith('.test.ts'))
      .sort();
    for (const file of files) {
      hash.update(toPosix(relative(root, file)));
      hash.update('\0');
      hash.update(readFileSync(file));
      hash.update('\0');
    }
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * `pg_dump` output as SQL the `pg` driver can send in one simple query.
 *
 * - psql meta-commands (`\restrict`, `\unrestrict` since PostgreSQL 17.6) are
 *   not SQL; drop them.
 * - Triggers on platform tables are product objects (the bootstrap installs one
 *   on `auth.users`, a later migration drops it). They reference functions the
 *   template does not have yet, and the migrations install their own; drop
 *   them. `pg_dump` writes each trigger on one line.
 */
export function dumpAsSql(dump: string): string {
  return dump
    .split('\n')
    .filter((line) => !line.startsWith('\\') && !line.startsWith('CREATE TRIGGER '))
    .join('\n');
}

export const TEMPLATE_PREFIX = 'kortix_dbsuite_tpl_';
export const SUITE_DATABASE_PREFIX = 'kortix_dbsuite_';

export function templateDatabaseName(hash: string): string {
  return `${TEMPLATE_PREFIX}${hash}`;
}

/** Per-file database. The pid lets a later run drop leftovers of a dead run. */
export function suiteDatabaseName(pid: number, index: number): string {
  return `${SUITE_DATABASE_PREFIX}${pid}_${index}`;
}

/** The pid encoded in a per-file database name, or null for any other name. */
export function suiteDatabaseOwnerPid(name: string): number | null {
  const match = name.match(new RegExp(`^${SUITE_DATABASE_PREFIX}(\\d+)_\\d+$`));
  return match ? Number(match[1]) : null;
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * The environment one suite process receives. Every DB suite reads
 * `TEST_DATABASE_URL`; `DATABASE_URL` is the same database because
 * `apps/api/src/config` reads it at import time. Both connect as `postgres`,
 * the role the API uses in every deployment, which is NOT a superuser on
 * Supabase.
 *
 * `TEST_DATABASE_SUPERUSER_URL` is the same database as the cluster
 * superuser, for fixture setup only (for example `session_replication_role`
 * to write rows that predate a trigger). `TEST_DATABASE_ADMIN_URL` reaches the
 * cluster's maintenance database for suites that create their own database.
 */
export function suiteEnvironment(input: {
  databaseUrl: string;
  adminUrl: string;
}): Record<string, string> {
  return {
    DATABASE_URL: input.databaseUrl,
    TEST_DATABASE_URL: input.databaseUrl,
    TEST_DATABASE_SUPERUSER_URL: withUser(input.databaseUrl, LOCAL_SUPERUSER),
    TEST_DATABASE_ADMIN_URL: input.adminUrl,
    KORTIX_TEST_DB_CONFIRM: 'I_UNDERSTAND_THIS_DELETES_TEST_DATA',
  };
}

/** Local Supabase's superuser. It shares the `postgres` role's local password. */
export const LOCAL_SUPERUSER = 'supabase_admin';

export function withUser(url: string, user: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  return parsed.toString();
}

export interface JunitCounts {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
}

/** Totals from the root `<testsuites>` element of Bun's JUnit report. */
export function parseJunitCounts(xml: string): JunitCounts | null {
  const match = xml.match(/<testsuites\b([^>]*)>/);
  if (!match) return null;
  const attribute = (name: string) => {
    const value = match[1]!.match(new RegExp(`\\b${name}="(\\d+)"`));
    return value ? Number(value[1]) : 0;
  };
  return {
    tests: attribute('tests'),
    failures: attribute('failures'),
    errors: attribute('errors'),
    skipped: attribute('skipped'),
  };
}

export type DbSuiteVerdict =
  | { ok: true }
  | { ok: false; reason: string };

export function dbSuiteVerdict(input: {
  exitCode: number;
  timedOut: boolean;
  counts: JunitCounts | null;
}): DbSuiteVerdict {
  if (input.timedOut) return { ok: false, reason: 'timed out' };
  if (!input.counts) return { ok: false, reason: `no JUnit report (exit ${input.exitCode})` };
  const { tests, failures, errors, skipped } = input.counts;
  if (failures + errors > 0) return { ok: false, reason: `${failures + errors} failed` };
  if (input.exitCode !== 0) return { ok: false, reason: `exit ${input.exitCode}` };
  if (tests === 0) return { ok: false, reason: 'ran no test' };
  if (skipped > 0) {
    return {
      ok: false,
      reason: `${skipped} skipped — a DB suite must run against the database the lane provides`,
    };
  }
  return { ok: true };
}

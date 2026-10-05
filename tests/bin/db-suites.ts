#!/usr/bin/env bun
/**
 * `db-suites` lane — see `src/core/db-suites.ts` for the contract.
 *
 *   bun tests/bin/db-suites.ts [path-filter ...] [--workers N]
 *
 * Needs the local Supabase PostgreSQL. `pnpm test` starts it before this lane.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { mapWithConcurrency } from '../src/core/concurrency';
import {
  DB_SUITE_QUARANTINE,
  type DbSuite,
  SUITE_DATABASE_PREFIX,
  dbSuiteVerdict,
  discoverDbSuites,
  dumpAsSql,
  migrationTemplateHash,
  parseJunitCounts,
  selectDbSuites,
  suiteDatabaseName,
  suiteDatabaseOwnerPid,
  suiteEnvironment,
  templateDatabaseName,
  withDatabase,
} from '../src/core/db-suites';
import { ensureLocalSupabase, resolveLocalTopology } from '../src/core/local-stack';

const root = resolve(import.meta.dir, '../..');
const SUITE_TIMEOUT_MS = Number(process.env.KORTIX_DB_SUITE_TIMEOUT_MS || 240_000);
const TEST_TIMEOUT_MS = process.env.KORTIX_DB_TEST_TIMEOUT_MS || '30000';

function parseArgs(argv: string[]): { filters: string[]; workers: number } {
  const filters: string[] = [];
  let workers = Number(process.env.KORTIX_DB_SUITE_WORKERS || 6);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--workers') workers = Number(argv[++index]);
    else if (arg.startsWith('--workers=')) workers = Number(arg.slice('--workers='.length));
    else filters.push(arg);
  }
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new Error('--workers must be a positive integer');
  }
  return { filters, workers };
}

const log = (line: string) => console.log(`[db-suites] ${line}`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function withClient<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A template no run has used for this long is dropped (another branch's history). */
const TEMPLATE_IDLE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Drop what earlier runs left behind: per-file databases and half-built
 * templates of dead processes, and templates idle for 3 days. Never touches a
 * live run's databases or the current template.
 */
async function dropLeftoverDatabases(adminUrl: string, currentTemplate: string): Promise<void> {
  await withClient(adminUrl, async (admin) => {
    const { rows } = await admin.query<{ datname: string; last_used: string | null }>(
      `select datname, shobj_description(oid, 'pg_database') as last_used
         from pg_database where left(datname, length($1)) = $1`,
      [`${SUITE_DATABASE_PREFIX}%`],
    );
    for (const { datname, last_used } of rows) {
      const suitePid = suiteDatabaseOwnerPid(datname);
      const buildPid = datname.match(/_build_(\d+)$/)?.[1];
      const stale =
        suitePid !== null
          ? !pidAlive(suitePid)
          : buildPid !== undefined
            ? !pidAlive(Number(buildPid))
            : datname !== currentTemplate &&
              !(Date.now() - Date.parse(last_used ?? '') < TEMPLATE_IDLE_MS);
      if (stale) await admin.query(`drop database if exists ${ident(datname)} with (force)`);
    }
  });
}

/** Record when a template was last used, for `dropLeftoverDatabases`. */
async function touchTemplate(admin: Client, name: string): Promise<void> {
  await admin.query(`comment on database ${ident(name)} is '${new Date().toISOString()}'`);
}

async function run(command: string[], options: { cwd: string; env: Record<string, string | undefined> }) {
  const child = Bun.spawn(command, { ...options, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, output: `${stdout}${stderr}` };
}

/**
 * GoTrue creates the `auth` schema by running its own migrations when it
 * starts. `supabase start --ignore-health-check` can return first, so wait for
 * GoTrue to answer before copying the schema.
 */
async function waitForPlatformAuth(apiUrl: string, timeoutMs = 120_000): Promise<void> {
  const health = new URL('/auth/v1/health', apiUrl).toString();
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(health, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
    } catch {
      // GoTrue is not listening yet.
    }
    if (performance.now() > deadline) {
      throw new Error(`Supabase Auth is not ready at ${health} after ${timeoutMs}ms`);
    }
    await Bun.sleep(1_000);
  }
}

/**
 * The Supabase platform `auth` schema, read from the local Supabase database.
 *
 * Product SQL reads `auth.users` columns (email, metadata) and calls
 * `auth.uid()`. A cloned database gets the real platform shape instead of the
 * one-column stub in `test-prereqs.sql`. `pg_dump` runs inside the Supabase
 * container, so its version always matches the server.
 */
async function dumpPlatformAuthSchema(adminUrl: string): Promise<string> {
  const port = new URL(adminUrl).port || '5432';
  const listed = await run(['docker', 'ps', '--filter', `publish=${port}`, '--format', '{{.Names}}'], {
    cwd: root,
    env: process.env,
  });
  const container = listed.stdout
    .split('\n')
    .map((name) => name.trim())
    .find((name) => name.startsWith('supabase_db_'));
  if (listed.exitCode !== 0 || !container) {
    throw new Error(`no local Supabase database container publishes port ${port}`);
  }
  const dumped = await run(
    [
      'docker', 'exec', container,
      'pg_dump', '-U', 'postgres', '--schema-only', '--schema=auth', '--no-owner', '--no-privileges', 'postgres',
    ],
    { cwd: root, env: process.env },
  );
  if (dumped.exitCode !== 0) {
    throw new Error(`pg_dump of the auth schema exited with code ${dumped.exitCode}:\n${dumped.output}`);
  }
  return dumpAsSql(dumped.stdout);
}

/**
 * The migrated template for the current migration history. Built once per
 * hash under a temporary name and published by RENAME, so two concurrent runs
 * never clone a half-migrated template.
 */
async function ensureTemplate(adminUrl: string): Promise<{ name: string; built: boolean }> {
  const authSchema = await dumpPlatformAuthSchema(adminUrl);
  const name = templateDatabaseName(migrationTemplateHash(root, authSchema));
  const exists = await withClient(adminUrl, async (admin) => {
    const { rowCount } = await admin.query(`select 1 from pg_database where datname = $1`, [name]);
    if (rowCount === 1) await touchTemplate(admin, name);
    return rowCount === 1;
  });
  if (exists) return { name, built: false };

  const building = `${name}_build_${process.pid}`;
  await withClient(adminUrl, (admin) => admin.query(`create database ${ident(building)}`));
  try {
    const buildUrl = withDatabase(adminUrl, building);
    const prerequisites = await readFile(join(root, 'packages/db/scripts/test-prereqs.sql'), 'utf8');
    await withClient(buildUrl, async (client) => {
      await client.query(authSchema);
      // pg_dump pins an empty search_path for its own session; restore it.
      await client.query('reset search_path');
      await client.query(prerequisites);
    });
    const migrated = await run(['bun', 'scripts/migrate.ts', 'local-up'], {
      cwd: join(root, 'packages/db'),
      env: { ...process.env, DATABASE_URL: buildUrl },
    });
    if (migrated.exitCode !== 0) {
      process.stdout.write(migrated.output);
      throw new Error(`migrating the template exited with code ${migrated.exitCode}`);
    }
    await withClient(adminUrl, async (admin) => {
      try {
        await admin.query(`alter database ${ident(building)} rename to ${ident(name)}`);
        await touchTemplate(admin, name);
      } catch (error) {
        // Another run published the same hash first. Its template is identical.
        if ((error as { code?: string }).code !== '42P04') throw error;
        await admin.query(`drop database if exists ${ident(building)} with (force)`);
      }
    });
    return { name, built: true };
  } catch (error) {
    await withClient(adminUrl, (admin) =>
      admin.query(`drop database if exists ${ident(building)} with (force)`),
    ).catch(() => {});
    throw error;
  }
}

interface SuiteResult {
  suite: DbSuite;
  ok: boolean;
  reason?: string;
  tests: number;
  durationMs: number;
}

async function runSuite(
  suite: DbSuite,
  index: number,
  context: { adminUrl: string; template: string; reportDir: string },
): Promise<SuiteResult> {
  const startedAt = performance.now();
  const database = suiteDatabaseName(process.pid, index);
  await withClient(context.adminUrl, (admin) =>
    admin.query(
      `create database ${ident(database)} template ${ident(context.template)} strategy file_copy`,
    ),
  );
  const report = join(context.reportDir, `${index}.xml`);
  try {
    const child = Bun.spawn(
      [
        // One file per process, so no `--isolate`: nothing can leak between
        // files, and Bun's per-file stdio swap under isolation (the Linux
        // EEXIST failure pinned in unit/test-runner-contract.test.ts) never runs.
        'bun',
        'test',
        `--timeout=${TEST_TIMEOUT_MS}`,
        ...(suite.envFile ? [`--env-file=${suite.envFile}`] : []),
        '--reporter=junit',
        `--reporter-outfile=${report}`,
        suite.path,
      ],
      {
        cwd: join(root, suite.cwd),
        env: {
          ...process.env,
          ...suiteEnvironment({
            databaseUrl: withDatabase(context.adminUrl, database),
            adminUrl: context.adminUrl,
          }),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SUITE_TIMEOUT_MS);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    const counts = parseJunitCounts(await readFile(report, 'utf8').catch(() => ''));
    const verdict = dbSuiteVerdict({ exitCode, timedOut, counts });
    const durationMs = performance.now() - startedAt;
    const tests = counts?.tests ?? 0;
    if (verdict.ok) {
      log(`PASS ${suite.file} ${tests} tests ${seconds(durationMs)}`);
      return { suite, ok: true, tests, durationMs };
    }
    const output = `${stdout}${stderr}`
      .split('\n')
      .map((line) => `[db-suites]   | ${line}`)
      .join('\n');
    console.log(`${output}\n[db-suites] FAIL ${suite.file}: ${verdict.reason} ${seconds(durationMs)}`);
    return { suite, ok: false, reason: verdict.reason, tests, durationMs };
  } finally {
    await withClient(context.adminUrl, (admin) =>
      admin.query(`drop database if exists ${ident(database)} with (force)`),
    ).catch((error) => log(`could not drop ${database}: ${String(error)}`));
  }
}

async function main(): Promise<number> {
  const startedAt = performance.now();
  const { filters, workers } = parseArgs(process.argv.slice(2));
  const discovered = discoverDbSuites(root);
  const selected = selectDbSuites(discovered, filters);
  const quarantined = selected.filter((suite) => DB_SUITE_QUARANTINE[suite.file]);
  const suites = selected.filter((suite) => !DB_SUITE_QUARANTINE[suite.file]);
  for (const suite of quarantined) {
    log(`QUARANTINED ${suite.file}: ${DB_SUITE_QUARANTINE[suite.file]}`);
  }

  const topology = resolveLocalTopology(root);
  const supabase = await ensureLocalSupabase(topology, { autoStart: false });
  const adminUrl = supabase.environment.DB_URL;
  const apiUrl = supabase.environment.API_URL;
  if (!adminUrl || !apiUrl) throw new Error('local Supabase reports no DB_URL or API_URL');
  await waitForPlatformAuth(apiUrl);

  const templateStartedAt = performance.now();
  const template = await ensureTemplate(adminUrl);
  log(
    `template ${template.name} ${template.built ? 'built' : 'reused'} ${seconds(performance.now() - templateStartedAt)}`,
  );
  await dropLeftoverDatabases(adminUrl, template.name);

  const reportDir = await mkdtemp(join(tmpdir(), 'kortix-db-suites-'));
  log(`running ${suites.length} suites, ${workers} at a time`);
  let results: SuiteResult[];
  try {
    results = await mapWithConcurrency(
      suites.map((suite, index) => ({ suite, index })),
      workers,
      ({ suite, index }) => runSuite(suite, index, { adminUrl, template: template.name, reportDir }),
    );
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.ok);
  const tests = results.reduce((sum, result) => sum + result.tests, 0);
  const slowest = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
  log(`slowest: ${slowest.map((r) => `${r.suite.file} ${seconds(r.durationMs)}`).join(', ')}`);
  for (const result of failed) log(`FAILED ${result.suite.file}: ${result.reason}`);
  log(
    `${failed.length === 0 ? 'PASS' : 'FAIL'} ${results.length - failed.length}/${results.length} suites, ${tests} tests, ${quarantined.length} quarantined, ${seconds(performance.now() - startedAt)}`,
  );
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = await main();

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DB_SUITE_QUARANTINE,
  dbSuiteVerdict,
  discoverDbSuites,
  dumpAsSql,
  parseJunitCounts,
  selectDbSuites,
  suiteDatabaseName,
  suiteDatabaseOwnerPid,
  suiteEnvironment,
  templateDatabaseName,
  withDatabase,
} from '../src/core/db-suites';

const root = resolve(import.meta.dirname, '../..');

function testFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'dist') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (/\.test\.(ts|tsx|mts)$/.test(entry.name)) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

describe('db-suites discovery', () => {
  const suites = discoverDbSuites(root);
  const files = new Set(suites.map((suite) => suite.file));

  it('finds the apps/api, packages/db, and tests/migration PostgreSQL suites', () => {
    expect(files.has('apps/api/src/__tests__/integration-prompt-inbox.test.ts')).toBe(true);
    expect(files.has('apps/api/src/__tests__/integration-session-status-transitions.test.ts')).toBe(true);
    expect(files.has('apps/api/src/billing/repositories/compute-sessions.integration.test.ts')).toBe(true);
    expect(files.has('packages/db/scripts/centralized-audit-v2.integration.test.ts')).toBe(true);
    expect(files.has('tests/migration/wallet-ledger.test.ts')).toBe(true);
    const inboxSuite = suites.find((suite) => suite.file.endsWith('integration-prompt-inbox.test.ts'));
    expect(inboxSuite).toEqual({
      file: 'apps/api/src/__tests__/integration-prompt-inbox.test.ts',
      cwd: 'apps/api',
      path: 'src/__tests__/integration-prompt-inbox.test.ts',
      envFile: 'scripts/test.env',
    });
  });

  it('never picks up a live or unit test', () => {
    for (const file of files) {
      expect(file).not.toMatch(/\.live\.test\.ts$/);
    }
    expect(files.has('apps/api/src/projects/lib/metadata-merge.test.ts')).toBe(false);
  });

  // The invariant that keeps a new DB suite from skipping silently in a unit
  // lane: a test file that asks for the lane's database must be a DB suite.
  it('owns every test file that reads the lane database variables', () => {
    const readsLaneDatabase = [
      ...testFiles(join(root, 'apps')),
      ...testFiles(join(root, 'packages')),
    ].filter((file) =>
      /process\.env\.(TEST_DATABASE_(URL|ADMIN_URL|SUPERUSER_URL)|KORTIX_TEST_DB_CONFIRM)\b/.test(
        readFileSync(join(root, file), 'utf8'),
      ),
    );
    expect(readsLaneDatabase.length).toBeGreaterThan(10);
    expect(readsLaneDatabase.filter((file) => !files.has(file))).toEqual([]);
  });

  it('keeps each quarantine entry pointed at a real suite with a reason', () => {
    for (const [file, reason] of Object.entries(DB_SUITE_QUARANTINE)) {
      expect(files.has(file)).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('keeps DB suites out of the unit discovery of every package', () => {
    const apiTestScript = readFileSync(join(root, 'apps/api/scripts/test.sh'), 'utf8');
    expect(apiTestScript).toContain("! -name 'integration-*'");
    expect(apiTestScript).toContain("! -name '*.integration.test.ts'");
    expect(apiTestScript).toContain('tests/bin/db-suites.ts');
    const dbPackage = JSON.parse(readFileSync(join(root, 'packages/db/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(dbPackage.scripts.test).toContain("--path-ignore-patterns='**/*.integration.test.ts'");
    const packageQuality = readFileSync(join(root, 'tests/bin/package-quality.ts'), 'utf8');
    expect(packageQuality).not.toContain("'tests/migration'");
  });
});

describe('db-suites selection', () => {
  const suites = [
    { file: 'apps/api/src/__tests__/integration-a.test.ts', cwd: 'apps/api', path: 'a' },
    { file: 'tests/migration/b.test.ts', cwd: 'tests', path: 'b' },
  ];

  it('keeps every suite without a filter and matches by path substring', () => {
    expect(selectDbSuites(suites, [])).toEqual(suites);
    expect(selectDbSuites(suites, ['tests/migration']).map((suite) => suite.file)).toEqual([
      'tests/migration/b.test.ts',
    ]);
  });

  it('rejects a filter that matches nothing instead of running zero suites', () => {
    expect(() => selectDbSuites(suites, ['integration-a', 'typo'])).toThrow(
      'no DB suite matches typo',
    );
  });
});

describe('db-suites databases', () => {
  it('names per-file databases so a later run can find a dead run by pid', () => {
    const name = suiteDatabaseName(4242, 7);
    expect(name).toBe('kortix_dbsuite_4242_7');
    expect(suiteDatabaseOwnerPid(name)).toBe(4242);
    expect(suiteDatabaseOwnerPid(templateDatabaseName('abc123'))).toBeNull();
    expect(suiteDatabaseOwnerPid('postgres')).toBeNull();
  });

  it('points every database variable at the file database and keeps the admin URL separate', () => {
    const adminUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
    const databaseUrl = withDatabase(adminUrl, 'kortix_dbsuite_1_0');
    expect(databaseUrl).toBe('postgresql://postgres:postgres@127.0.0.1:54322/kortix_dbsuite_1_0');
    expect(suiteEnvironment({ databaseUrl, adminUrl })).toEqual({
      DATABASE_URL: databaseUrl,
      TEST_DATABASE_URL: databaseUrl,
      TEST_DATABASE_SUPERUSER_URL:
        'postgresql://supabase_admin:postgres@127.0.0.1:54322/kortix_dbsuite_1_0',
      TEST_DATABASE_ADMIN_URL: adminUrl,
      KORTIX_TEST_DB_CONFIRM: 'I_UNDERSTAND_THIS_DELETES_TEST_DATA',
    });
  });

  it('drops psql meta-commands and product triggers from a pg_dump', () => {
    const dump = [
      '\\restrict abc',
      'CREATE SCHEMA auth;',
      'CREATE TRIGGER on_auth_user_created_webhook AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.trigger_welcome_email();',
      '\\unrestrict abc',
      '',
    ].join('\n');
    expect(dumpAsSql(dump)).toBe('CREATE SCHEMA auth;\n');
  });
});

describe('db-suites verdict', () => {
  const junit = (attributes: string) =>
    `<?xml version="1.0"?>\n<testsuites name="bun test" ${attributes}>\n</testsuites>`;

  it('reads the root totals of a Bun JUnit report', () => {
    expect(parseJunitCounts(junit('tests="5" assertions="0" failures="1" skipped="2"'))).toEqual({
      tests: 5,
      failures: 1,
      errors: 0,
      skipped: 2,
    });
    expect(parseJunitCounts('')).toBeNull();
  });

  it('passes only a suite that ran tests and skipped none', () => {
    const counts = { tests: 3, failures: 0, errors: 0, skipped: 0 };
    expect(dbSuiteVerdict({ exitCode: 0, timedOut: false, counts })).toEqual({ ok: true });
  });

  it('fails a skipped, empty, failed, crashed, or hung suite', () => {
    const base = { tests: 3, failures: 0, errors: 0, skipped: 0 };
    expect(
      dbSuiteVerdict({ exitCode: 0, timedOut: false, counts: { ...base, skipped: 3 } }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('3 skipped') });
    expect(
      dbSuiteVerdict({ exitCode: 0, timedOut: false, counts: { ...base, tests: 0 } }),
    ).toEqual({ ok: false, reason: 'ran no test' });
    expect(
      dbSuiteVerdict({ exitCode: 1, timedOut: false, counts: { ...base, failures: 1 } }),
    ).toEqual({ ok: false, reason: '1 failed' });
    expect(dbSuiteVerdict({ exitCode: 1, timedOut: false, counts: base })).toEqual({
      ok: false,
      reason: 'exit 1',
    });
    expect(dbSuiteVerdict({ exitCode: 1, timedOut: false, counts: null })).toEqual({
      ok: false,
      reason: 'no JUnit report (exit 1)',
    });
    expect(dbSuiteVerdict({ exitCode: 137, timedOut: true, counts: null })).toEqual({
      ok: false,
      reason: 'timed out',
    });
  });
});

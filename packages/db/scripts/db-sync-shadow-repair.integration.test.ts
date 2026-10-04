import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Execute the operator script with real PostgreSQL; only AWS secret retrieval is replaced.
test('shadow repair exports session sandboxes without a sort and preserves keyed repair', () => {
  const databaseUrl = process.env.TEST_DATABASE_ADMIN_URL ?? process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_ADMIN_URL or TEST_DATABASE_URL is required');
  const directory = mkdtempSync(join(tmpdir(), 'shadow-repair-'));
  const realPsql = Bun.which('psql');
  if (!realPsql) throw new Error('psql is required');
  const run = (args: string[], input?: string) => {
    const result = Bun.spawnSync(args, { stdin: input ? Buffer.from(input) : undefined });
    expect(result.stderr.toString()).not.toContain('ERROR:');
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  const sql = (url: string, text: string) =>
    run([realPsql, url, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], text);
  const name = `shadow_${process.pid}_${Date.now()}`;
  const fixtureUrl = process.env.TEST_DATABASE_SUPERUSER_URL ?? databaseUrl;
  const source = new URL(fixtureUrl);
  const target = new URL(fixtureUrl);
  source.pathname = `/${name}_source`;
  target.pathname = `/${name}_target`;
  try {
    // Pin the byte order the assertions below assume. The throwaway databases
    // otherwise inherit the lane database's locale, and the local Supabase
    // postgres defaults the locale provider to ICU, where LC_COLLATE 'C' is
    // still tailored (é sorts beside 'e', not after 'z') — datcollate reads
    // 'C' and the order still differs from the C byte order this test was
    // written against. LOCALE_PROVIDER libc makes 'C' the actual byte order,
    // on every image; the test is about the export mechanics, not locale.
    sql(
      databaseUrl,
      `CREATE DATABASE ${name}_source LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;`
        + ` CREATE DATABASE ${name}_target LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;`,
    );
    const schema = `
      CREATE SCHEMA kortix;
      CREATE TABLE kortix.api_keys (key_id uuid PRIMARY KEY, last_used_at timestamptz);
      CREATE TABLE kortix.credit_accounts (
        account_id uuid PRIMARY KEY, balance numeric, lifetime_granted numeric,
        lifetime_purchased numeric, lifetime_used numeric, expiring_credits numeric,
        non_expiring_credits numeric, daily_credits_balance numeric,
        balance_precise numeric, lifetime_granted_precise numeric,
        lifetime_purchased_precise numeric, lifetime_used_precise numeric,
        expiring_credits_precise numeric, non_expiring_credits_precise numeric,
        daily_credits_balance_precise numeric);
      CREATE TABLE kortix.credit_ledger (id uuid PRIMARY KEY);
      CREATE TABLE kortix.audit_events (event_id uuid PRIMARY KEY, occurred_at timestamptz);
      CREATE TABLE kortix.session_sandboxes (
        session_id text UNIQUE NOT NULL, last_used_at timestamptz, metadata jsonb, updated_at timestamptz);
    `;
    sql(source.href, schema);
    sql(target.href, schema);
    sql(
      source.href,
      `INSERT INTO kortix.session_sandboxes VALUES
      ('z-session', '2026-01-02Z', '{"text":"comma, quote \\" and newline\\n"}', '2026-01-03Z'),
      ('A-session', NULL, NULL, NULL),
      ('é-session', '2026-01-04Z', '{"nested":{"value":true}}', '2026-01-05Z'),
      ('source-only', NULL, '{}', NULL);`,
    );
    sql(
      target.href,
      `INSERT INTO kortix.session_sandboxes VALUES
      ('A-session', now(), '{}', now()),
      ('é-session', NULL, '{}', NULL),
      ('z-session', NULL, '{}', NULL),
      ('target-only', NULL, '{"retain":true}', NULL);
      CREATE SUBSCRIPTION ${name} CONNECTION 'host=127.0.0.1 port=1 dbname=unused'
        PUBLICATION shadow_fixture WITH (connect=false, enabled=false, create_slot=false, slot_name=NONE);`,
    );
    writeFileSync(
      join(directory, 'aws'),
      `#!/usr/bin/env node\nconsole.log(JSON.stringify(${JSON.stringify({ DATABASE_URL: source.href, target_database_url: target.href, replication_username: 'fixture', replication_password: 'fixture' })}));\n`,
      { mode: 0o700 },
    );
    // Capture the query delivered to psql at runtime, explain it, then execute unchanged.
    writeFileSync(
      join(directory, 'psql'),
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const command = args[args.indexOf('-c') + 1];
if (args.includes('-c') && command.includes('kortix.session_sandboxes')) {
  const select = command.slice(command.indexOf('(') + 1, command.indexOf(') TO'));
  const plan = spawnSync(${JSON.stringify(realPsql)}, [args[0], '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', 'SET enable_indexscan=off; SET enable_indexonlyscan=off; EXPLAIN (FORMAT JSON) ' + select]);
  if (plan.status !== 0) { process.stderr.write(plan.stderr); process.exit(1); }
  writeFileSync(${JSON.stringify(join(directory, 'plan.json'))}, plan.stdout);
}
const result = spawnSync(${JSON.stringify(realPsql)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
      { mode: 0o700 },
    );
    const execute = () => {
      const result = Bun.spawnSync(
        [
          'bash',
          resolve(import.meta.dir, '../../../scripts/prod-us-east-2/db-sync.sh'),
          'repair-shadow-mutations',
        ],
        {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            ALLOW_TARGET_SHADOW_REPAIR: '1',
            SUBSCRIPTION: name,
            TARGET_DATABASE_URL_OVERRIDE: target.href,
          },
        },
      );
      expect(result.stderr.toString()).not.toContain('ERROR:');
      expect(result.exitCode).toBe(0);
    };
    execute();
    const rows = sql(
      target.href,
      'SELECT json_agg(t ORDER BY session_id COLLATE "C") FROM kortix.session_sandboxes t;',
    );
    expect(JSON.parse(rows)).toEqual([
      { session_id: 'A-session', last_used_at: null, metadata: null, updated_at: null },
      {
        session_id: 'target-only',
        last_used_at: null,
        metadata: { retain: true },
        updated_at: null,
      },
      {
        session_id: 'z-session',
        last_used_at: '2026-01-02T00:00:00+00:00',
        metadata: { text: 'comma, quote " and newline\n' },
        updated_at: '2026-01-03T00:00:00+00:00',
      },
      {
        session_id: 'é-session',
        last_used_at: '2026-01-04T00:00:00+00:00',
        metadata: { nested: { value: true } },
        updated_at: '2026-01-05T00:00:00+00:00',
      },
    ]);
    execute();
    expect(
      sql(target.href, 'SELECT json_agg(t ORDER BY session_id COLLATE "C") FROM kortix.session_sandboxes t;'),
    ).toBe(rows);
    sql(source.href, 'TRUNCATE kortix.session_sandboxes;');
    execute();
    expect(
      sql(target.href, 'SELECT json_agg(t ORDER BY session_id COLLATE "C") FROM kortix.session_sandboxes t;'),
    ).toBe(rows);
    expect(
      sql(
        target.href,
        `SELECT subenabled FROM pg_subscription WHERE subname='${name}' AND subdbid=(SELECT oid FROM pg_database WHERE datname=current_database());`,
      ).trim(),
    ).toBe('f');
    const plan = readFileSync(join(directory, 'plan.json'), 'utf8');
    expect(JSON.parse(plan)[0].Plan['Node Type']).toBe('Seq Scan');
    expect(plan).not.toContain('Sort');
  } finally {
    sql(target.href, `DROP SUBSCRIPTION IF EXISTS ${name};`);
    sql(
      databaseUrl,
      `DROP DATABASE IF EXISTS ${name}_source WITH (FORCE); DROP DATABASE IF EXISTS ${name}_target WITH (FORCE);`,
    );
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

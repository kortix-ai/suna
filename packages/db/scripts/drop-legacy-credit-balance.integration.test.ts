/**
 * The legacy `public.credit_balance` retirement, against a real PostgreSQL.
 *
 * The migration drops a basejump-era table that only databases older than the
 * Kortix baseline still carry, plus its last accessor `public.add_credits`.
 * Three things are worth a test: it drops exactly the dead pair (and nothing
 * else), it is a no-op where the objects never existed, and it refuses
 * (dropping nothing) while a surviving function body, another table's RLS
 * policy, a column default or a pg_cron command still references either name —
 * none of those callers record a pg_depend row, so an unguarded DROP would
 * succeed and leave the caller broken. The fixture's own add_credits body
 * mentions the table, so the clean drop also proves the guard excludes the
 * objects it drops.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { dockerAvailable } from './docker-available';

const container = `kortix-drop-legacy-credit-balance-${crypto.randomUUID().slice(0, 8)}`;
const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_drop_legacy_credit_balance.sql').scanSync({ cwd: migrationDirectory }),
);
let containerStarted = false;
let migration = '';

function dockerPsql(database: string, sql: string) {
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      container,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      'postgres',
      '-d',
      database,
      '-v',
      'ON_ERROR_STOP=1',
      '-t',
      '-A',
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) throw new Error(output);
  return output.trim();
}

/** node-pg-migrate runs each file in one transaction; mirror that. */
function applyMigration(database: string) {
  return dockerPsql(database, `BEGIN;\n${migration}\nCOMMIT;\n`);
}

/** The legacy state a pre-baseline (prod-shaped) database carries. */
function legacyFixture(): string {
  return `
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS 'SELECT NULL::text';
    CREATE TABLE public.credit_balance (
        account_id uuid NOT NULL,
        balance_dollars numeric(10,2) DEFAULT 0 NOT NULL,
        total_purchased numeric(10,2) DEFAULT 0 NOT NULL,
        total_used numeric(10,2) DEFAULT 0 NOT NULL,
        last_updated timestamp with time zone DEFAULT now(),
        metadata jsonb DEFAULT '{}'::jsonb,
        CONSTRAINT credit_balance_balance_dollars_check CHECK ((balance_dollars >= (0)::numeric)),
        CONSTRAINT credit_balance_total_purchased_check CHECK ((total_purchased >= (0)::numeric)),
        CONSTRAINT credit_balance_total_used_check CHECK ((total_used >= (0)::numeric))
    );
    ALTER TABLE public.credit_balance ADD CONSTRAINT credit_balance_pkey PRIMARY KEY (account_id);
    ALTER TABLE public.credit_balance ADD CONSTRAINT credit_balance_user_id_fkey
      FOREIGN KEY (account_id) REFERENCES auth.users(id) ON DELETE CASCADE;
    CREATE INDEX idx_credit_balance_account_id ON public.credit_balance USING btree (account_id);
    CREATE POLICY "Service role can manage all credit balances" ON public.credit_balance
      USING ((auth.role() = 'service_role'::text));
    CREATE POLICY "Users can view their own credit balance" ON public.credit_balance
      FOR SELECT USING ((auth.uid() = account_id));
    CREATE FUNCTION public.add_credits(p_user_id uuid, p_amount numeric, p_purchase_id uuid DEFAULT NULL::uuid)
      RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER AS $fn$
    DECLARE
        new_balance DECIMAL;
    BEGIN
        INSERT INTO public.credit_balance (user_id, balance_dollars, total_purchased)
        VALUES (p_user_id, p_amount, p_amount)
        ON CONFLICT (user_id) DO UPDATE
        SET balance_dollars = credit_balance.balance_dollars + p_amount,
            total_purchased = credit_balance.total_purchased + p_amount,
            last_updated = NOW()
        RETURNING balance_dollars INTO new_balance;
        RETURN new_balance;
    END;
    $fn$;
  `;
}

function freshDatabase(name: string, fixture: string) {
  dockerPsql('postgres', `CREATE DATABASE ${name};`);
  if (fixture) dockerPsql(name, fixture);
}

function legacyState(database: string): string {
  return dockerPsql(
    database,
    `SELECT
       (to_regclass('public.credit_balance') IS NOT NULL) || ',' ||
       (to_regprocedure('public.add_credits(uuid, numeric, uuid)') IS NOT NULL) || ',' ||
       (SELECT count(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'credit_balance');`,
  );
}

describe.skipIf(!dockerAvailable)(
  'drop legacy credit_balance migration — real PostgreSQL',
  () => {
    beforeAll(async () => {
      if (migrationNames.length !== 1) return;
      migration = await Bun.file(resolve(migrationDirectory, migrationNames[0]!)).text();

      const started = Bun.spawnSync([
        'docker',
        'run',
        '--rm',
        '-d',
        '--name',
        container,
        '-e',
        'POSTGRES_PASSWORD=test',
        'postgres:16-alpine',
      ]);
      if (started.exitCode !== 0) throw new Error(started.stderr.toString());
      containerStarted = true;

      for (let attempt = 0; attempt < 50; attempt += 1) {
        // TCP, never the unix socket: initdb runs a temporary socket-only
        // server whose readiness says nothing about the real one.
        const probe = Bun.spawnSync(
          ['docker', 'exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-c', 'SELECT 1'],
          { stdout: 'ignore', stderr: 'ignore' },
        );
        if (probe.exitCode === 0) return;
        await Bun.sleep(250);
      }
      throw new Error('Disposable PostgreSQL did not become ready');
    }, 60_000);

    afterAll(() => {
      if (!containerStarted) return;
      Bun.spawnSync(['docker', 'rm', '-f', '-v', container], { stdout: 'ignore', stderr: 'ignore' });
    });

    test('drops the table, its policies and add_credits, and a second apply is a no-op', () => {
      freshDatabase('legacy_db', legacyFixture());
      expect(legacyState('legacy_db')).toBe('true,true,2');

      applyMigration('legacy_db');
      expect(legacyState('legacy_db')).toBe('false,false,0');

      applyMigration('legacy_db');
      expect(legacyState('legacy_db')).toBe('false,false,0');
    }, 60_000);

    test('is a no-op on a database built from the Kortix baseline', () => {
      freshDatabase('baseline_db', '');
      applyMigration('baseline_db');
      expect(legacyState('baseline_db')).toBe('false,false,0');
      expect(dockerPsql('baseline_db', "SELECT to_regclass('public.credit_balance') IS NULL")).toBe(
        't',
      );
    }, 60_000);

    test('refuses and drops nothing while another function body calls public.add_credits', () => {
      freshDatabase(
        'caller_db',
        `${legacyFixture()}
         CREATE FUNCTION public.calls_add_credits() RETURNS void LANGUAGE plpgsql AS $$
         BEGIN
           PERFORM public.add_credits(gen_random_uuid(), 1);
         END $$;`,
      );
      expect(() => applyMigration('caller_db')).toThrow(
        /drop refused, a function body still references it: public\.calls_add_credits/,
      );
      expect(legacyState('caller_db')).toBe('true,true,2');
    }, 60_000);

    test('refuses and drops nothing while another function body reads the table', () => {
      freshDatabase(
        'reader_db',
        `${legacyFixture()}
         CREATE FUNCTION public.reads_credit_balance() RETURNS int LANGUAGE plpgsql AS $$
         BEGIN
           RETURN (SELECT count(*) FROM public.credit_balance);
         END $$;`,
      );
      expect(() => applyMigration('reader_db')).toThrow(
        /drop refused, a function body still references it: public\.reads_credit_balance/,
      );
      expect(legacyState('reader_db')).toBe('true,true,2');
    }, 60_000);

    test('refuses and drops nothing while another add_credits overload reads the table', () => {
      // The guard excludes the dropped (uuid, numeric, uuid) overload BY OID;
      // a sibling overload is a surviving caller, not a self-reference.
      freshDatabase(
        'overload_db',
        `${legacyFixture()}
         CREATE FUNCTION public.add_credits(p_user_id uuid, p_amount numeric)
           RETURNS numeric LANGUAGE plpgsql AS $$
         BEGIN
           RETURN (SELECT balance_dollars FROM public.credit_balance WHERE account_id = p_user_id);
         END $$;`,
      );
      expect(() => applyMigration('overload_db')).toThrow(
        /drop refused, a function body still references it/,
      );
      expect(legacyState('overload_db')).toBe('true,true,2');
    }, 60_000);

    test('refuses and drops nothing while another table has a policy referencing either name', () => {
      freshDatabase(
        'policy_db',
        `${legacyFixture()}
         CREATE TABLE public.other_table (id uuid PRIMARY KEY);
         CREATE POLICY other_uses_balance ON public.other_table FOR SELECT
           USING (EXISTS (SELECT 1 FROM public.credit_balance));`,
      );
      expect(() => applyMigration('policy_db')).toThrow(
        /drop refused, an RLS policy still references it: public\.other_table :: other_uses_balance/,
      );
      expect(legacyState('policy_db')).toBe('true,true,2');
    }, 60_000);

    test('refuses and drops nothing while a column default calls public.add_credits', () => {
      freshDatabase(
        'default_db',
        `${legacyFixture()}
         CREATE TABLE public.default_probe (x numeric DEFAULT public.add_credits(gen_random_uuid(), 1));`,
      );
      expect(() => applyMigration('default_db')).toThrow(
        /drop refused, a column default still references it: public\.default_probe\.x/,
      );
      expect(legacyState('default_db')).toBe('true,true,2');
    }, 60_000);

    test('refuses and drops nothing while a pg_cron command references the table', () => {
      freshDatabase(
        'cron_db',
        `${legacyFixture()}
         CREATE SCHEMA cron;
         CREATE TABLE cron.job (jobid serial PRIMARY KEY, jobname text, command text);
         INSERT INTO cron.job (jobname, command) VALUES
           ('credit-balance-report', 'SELECT count(*) FROM public.credit_balance;');`,
      );
      expect(() => applyMigration('cron_db')).toThrow(
        /drop refused, a pg_cron job still references it: credit-balance-report/,
      );
      expect(legacyState('cron_db')).toBe('true,true,2');
    }, 60_000);
  },
);

/**
 * KRTX-1143 regression test: the auth_rls_initplan rewrite of public.messages'
 * message_select_policy (migration *_message_select_policy_initplan.sql).
 *
 * The Supabase performance advisor flagged the legacy suna policy: it calls
 * auth.uid() once PER ROW (the planner inlines it into the per-row filter of
 * the correlated subplan) instead of once per statement. The rewrite wraps the
 * two auth.uid() calls in (select auth.uid()) initplans — the advisor's
 * prescribed remediation — and changes nothing else.
 *
 * This test stands up a real PostgreSQL, rebuilds the legacy surface with the
 * policy qual exactly as prod carried it, applies the migration, and asserts:
 *   1. the fixture reproduces the defect (per-row evaluation visible in the
 *      plan, bare auth.uid() in the stored qual) — the red state;
 *   2. after the rewrite the stored qual wraps both auth.uid() calls and no
 *      bare call remains — the state the advisor lints;
 *   3. the plan evaluates auth.uid() once (an InitPlan feeds the per-row
 *      filter through a parameter);
 *   4. visible rows are identical before and after for every access path
 *      (owner's own account, public project, platform admin, anonymous);
 *   5. the other three policies on the table are untouched, and a second
 *      apply is a no-op;
 *   6. on a database without the legacy public tables the migration is a
 *      guarded no-op (fresh baseline builds hold only kortix.*).
 *
 * Docker per the house pattern (drop-legacy-public-functions); a disposable
 * local cluster (initdb into a temp dir) stands in when Docker is absent, so
 * a sandbox without Docker still runs the suite for real instead of skipping.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dockerAvailable } from './docker-available';

const container = `kortix-msg-policy-${crypto.randomUUID().slice(0, 8)}`;
const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_message_select_policy_initplan.sql').scanSync({ cwd: migrationDirectory }),
);
let migration = '';

/** The legacy surface, with message_select_policy EXACTLY as prod carried it
 *  (pg_policies, 2026-10-02) and auth.uid()/has_role_on_account verbatim. */
const FIXTURE = /* sql */ `
BEGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA basejump;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
CREATE TYPE basejump.account_role AS ENUM ('owner', 'member');
CREATE TABLE basejump.account_user (
  user_id uuid NOT NULL,
  account_id uuid NOT NULL,
  account_role basejump.account_role NOT NULL DEFAULT 'member'
);
CREATE OR REPLACE FUNCTION basejump.has_role_on_account(account_id uuid, account_role basejump.account_role DEFAULT NULL::basejump.account_role)
 RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
select exists(
  select 1 from basejump.account_user wu
  where wu.user_id = auth.uid()
    and wu.account_id = has_role_on_account.account_id
    and (wu.account_role = has_role_on_account.account_role or has_role_on_account.account_role is null)
);
$function$;
CREATE TYPE public.user_role AS ENUM ('user', 'admin', 'super_admin');
CREATE TABLE public.user_roles (
  user_id uuid NOT NULL,
  role public.user_role NOT NULL DEFAULT 'user',
  granted_by uuid,
  granted_at timestamptz DEFAULT now(),
  metadata jsonb
);
CREATE TABLE public.projects (
  project_id uuid PRIMARY KEY,
  name text,
  account_id uuid,
  is_public boolean,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.threads (
  thread_id uuid PRIMARY KEY,
  account_id uuid,
  project_id uuid,
  is_public boolean,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.messages (
  message_id uuid PRIMARY KEY,
  thread_id uuid NOT NULL,
  type text,
  is_llm_message boolean,
  content jsonb,
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY message_select_policy ON public.messages
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (
    (
      EXISTS (
        SELECT 1
        FROM threads
        LEFT JOIN projects ON threads.project_id = projects.project_id
        WHERE threads.thread_id = messages.thread_id
          AND (
            (threads.is_public IS TRUE)
            OR (threads.account_id = auth.uid())
            OR (basejump.has_role_on_account(threads.account_id) = true)
            OR (
              EXISTS (
                SELECT 1
                FROM projects
                WHERE projects.project_id = threads.project_id
                  AND (
                    (projects.is_public IS TRUE)
                    OR (basejump.has_role_on_account(projects.account_id) = true)
                  )
              )
            )
          )
      )
    )
    OR (
      EXISTS (
        SELECT 1
        FROM user_roles
        WHERE (user_roles.user_id = auth.uid())
          AND (user_roles.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))
      )
    )
  );

-- The other three policies on the table, verbatim prod shape (the rewrite
-- must leave them untouched).
CREATE POLICY message_insert_policy ON public.messages
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM threads
      LEFT JOIN projects ON threads.project_id = projects.project_id
      WHERE threads.thread_id = messages.thread_id
        AND (
          (basejump.has_role_on_account(threads.account_id) = true)
          OR (basejump.has_role_on_account(projects.account_id) = true)
        )
    )
  );
CREATE POLICY message_update_policy ON public.messages
  AS PERMISSIVE FOR UPDATE TO public
  USING (
    EXISTS (
      SELECT 1
      FROM threads
      LEFT JOIN projects ON threads.project_id = projects.project_id
      WHERE threads.thread_id = messages.thread_id
        AND (
          (basejump.has_role_on_account(threads.account_id) = true)
          OR (basejump.has_role_on_account(projects.account_id) = true)
        )
    )
  );
CREATE POLICY message_delete_policy ON public.messages
  AS PERMISSIVE FOR DELETE TO public
  USING (
    EXISTS (
      SELECT 1
      FROM threads
      LEFT JOIN projects ON threads.project_id = projects.project_id
      WHERE threads.thread_id = messages.thread_id
        AND (
          (basejump.has_role_on_account(threads.account_id) = true)
          OR (basejump.has_role_on_account(projects.account_id) = true)
        )
    )
  );

GRANT USAGE ON SCHEMA public, auth, basejump TO anon, authenticated;
GRANT SELECT ON public.messages, public.threads, public.projects, public.user_roles TO anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth, basejump TO anon, authenticated;
-- user A owns personal account A (basejump: personal account id == user id);
-- user B is a platform admin; user C has no relation to anything.
INSERT INTO public.projects VALUES
  ('11111111-1111-1111-1111-111111111111', 'p-private-a', 'aaaaaaaa-1000-0000-0000-00000000000a', false, now()),
  ('22222222-2222-2222-2222-222222222222', 'p-public-b',  'bbbbbbbb-2000-0000-0000-00000000000b', true,  now());
INSERT INTO public.threads VALUES
  ('11111111-aaaa-1111-1111-111111111111', 'aaaaaaaa-1000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', false, now()),
  ('22222222-bbbb-2222-2222-222222222222', 'bbbbbbbb-2000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', false, now()),
  ('33333333-cccc-3333-3333-333333333333', 'bbbbbbbb-2000-0000-0000-00000000000b', NULL,                                   false, now());
INSERT INTO basejump.account_user VALUES
  ('aaaaaaaa-1000-0000-0000-00000000000a', 'aaaaaaaa-1000-0000-0000-00000000000a', 'member');
INSERT INTO public.user_roles VALUES
  ('bbbbbbbb-2000-0000-0000-00000000000b', 'admin', NULL, now(), NULL);
INSERT INTO public.messages
SELECT gen_random_uuid(), t.thread_id, 'user', false, '{"role":"user"}'::jsonb, NULL, now()
FROM (SELECT thread_id, generate_series(1, 4) AS i FROM public.threads) t;
COMMIT;
`;

const JWT_A = 'aaaaaaaa-1000-0000-0000-00000000000a';
const JWT_B = 'bbbbbbbb-2000-0000-0000-00000000000b';
const JWT_C = 'cccccccc-3000-0000-0000-00000000000c';
const PERSONAS: Array<{ name: string; role: string; jwt: string | null }> = [
  { name: 'owner', role: 'authenticated', jwt: JWT_A },
  { name: 'admin', role: 'authenticated', jwt: JWT_B },
  { name: 'outsider', role: 'authenticated', jwt: JWT_C },
  { name: 'anonymous', role: 'anon', jwt: null },
];

/** Visible message ids for one persona, under the CURRENT policy. */
function visibleIds(database: string, persona: { role: string; jwt: string | null }): string {
  const claims = persona.jwt
    ? `SELECT set_config('request.jwt.claims', '{"sub":"${persona.jwt}","role":"authenticated"}', true);`
    : '';
  return sql(
    database,
    `SET ROLE ${persona.role};
     ${claims}
     SELECT coalesce(array_agg(message_id ORDER BY message_id)::text, 'none') FROM public.messages;
     RESET ROLE;`,
  );
}

/** The stored policy qual, whitespace-insensitive for expression comparison. */
function policyQual(database: string): string {
  return sql(
    database,
    `SELECT qual FROM pg_policies WHERE schemaname='public' AND tablename='messages' AND policyname='message_select_policy';`,
  ).toLowerCase().replace(/\s+/g, '');
}

/** Every Filter in the Seq/Index Scan subtree of public.messages, plus whether
 *  that subtree holds an InitPlan node (a one-time scalar evaluation). */
function messagesPlan(database: string, jwt: string): { filters: string[]; hasInitPlan: boolean } {
  const raw = sql(
    database,
    `SET ROLE authenticated;
     SELECT set_config('request.jwt.claims', '{"sub":"${jwt}","role":"authenticated"}', true);
     EXPLAIN (FORMAT JSON) SELECT count(*) FROM public.messages;
     RESET ROLE;`,
  );
  const plan = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1))[0]!.Plan;
  const filters: string[] = [];
  let hasInitPlan = false;
  const walk = (node: Record<string, unknown>): void => {
    if (typeof node.Filter === 'string') filters.push(node.Filter);
    if (node['Parent Relationship'] === 'InitPlan') hasInitPlan = true;
    for (const key of ['Plans', 'Sub Plan', 'InitPlan']) {
      for (const child of (node[key] as Record<string, unknown>[] | undefined) ?? []) walk(child);
    }
  };
  const scan = [plan, ...collect(plan)].find((node) => node['Relation Name'] === 'messages');
  if (!scan) throw new Error('no public.messages scan in plan');
  walk(scan);
  return { filters, hasInitPlan };
}

function collect(node: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const key of ['Plans', 'Sub Plan', 'InitPlan']) {
    for (const child of (node[key] as Record<string, unknown>[] | undefined) ?? []) out.push(child, ...collect(child));
  }
  return out;
}

// --- server provider: docker per the house pattern, else a disposable local
// --- cluster so a sandbox without Docker still runs the suite for real.
interface Server {
  sql(database: string, statement: string): string;
  stop(): void;
}

function localPostgresBins(): { initdb: string; postgres: string; pgCtl: string; psql: string } | null {
  const dirs = [
    process.env.KORTIX_TEST_PG_BIN,
    '/usr/lib/postgresql/16/bin',
    '/usr/lib/postgresql/15/bin',
  ].filter((dir): dir is string => Boolean(dir));
  for (const dir of dirs) {
    if (existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'postgres'))) {
      return {
        initdb: join(dir, 'initdb'),
        postgres: join(dir, 'postgres'),
        pgCtl: join(dir, 'pg_ctl'),
        psql: existsSync(join(dir, 'psql')) ? join(dir, 'psql') : 'psql',
      };
    }
  }
  return null;
}

let server: Server;
let clusterDir: string | null = null;

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolvePort(port));
    });
    probe.on('error', reject);
  });
}

async function startServer(): Promise<Server> {
  if (dockerAvailable) {
    const started = Bun.spawnSync([
      'docker', 'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=test', 'postgres:16-alpine',
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const probe = Bun.spawnSync(
        ['docker', 'exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-c', 'SELECT 1'],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (probe.exitCode === 0) {
        ready = true;
        break;
      }
      await Bun.sleep(250);
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
    return {
      sql(database, statement) {
        const result = Bun.spawnSync(
          ['docker', 'exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', database,
           '-v', 'ON_ERROR_STOP=1', '-t', '-A'],
          { stdin: Buffer.from(statement), stdout: 'pipe', stderr: 'pipe' },
        );
        const output = `${result.stdout.toString()}${result.stderr.toString()}`;
        if (result.exitCode !== 0) throw new Error(output);
        return output.trim();
      },
      stop() {
        Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
      },
    };
  }
  const bins = localPostgresBins();
  if (!bins) return { sql: () => '', stop: () => {} }; // unused: the suite skips
  clusterDir = mkdtempSync(join(tmpdir(), 'kortix-msg-policy-'));
  const sockDir = join(clusterDir, 'sock');
  mkdirSync(sockDir);
  const dataDir = join(clusterDir, 'data');
  Bun.spawnSync([bins.initdb, '-D', dataDir, '-U', 'postgres', '--auth=trust'], { stdout: 'ignore', stderr: 'pipe' });
  const port = await freePort();
  appendFileSync(
    join(dataDir, 'postgresql.conf'),
    `listen_addresses = '127.0.0.1'\nunix_socket_directories = '${sockDir}'\n` +
      `fsync = off\nsynchronous_commit = off\nfull_page_writes = off\n`,
  );
  const started = Bun.spawnSync(
    [bins.pgCtl, '-D', dataDir, '-o', `-p ${port} -k ${sockDir}`, '-l', join(clusterDir, 'log'), '-w', 'start'],
    { stdout: 'ignore', stderr: 'pipe' },
  );
  if (started.exitCode !== 0) throw new Error(started.stderr.toString());
  const psqlArgs = [bins.psql, '-h', sockDir, '-p', String(port), '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-t', '-A'];
  return {
    sql(database, statement) {
      const result = Bun.spawnSync([...psqlArgs, '-d', database], {
        stdin: Buffer.from(statement), stdout: 'pipe', stderr: 'pipe',
      });
      const output = `${result.stdout.toString()}${result.stderr.toString()}`;
      if (result.exitCode !== 0) throw new Error(output);
      return output.trim();
    },
    stop() {
      Bun.spawnSync([bins.pgCtl, '-D', dataDir, '-m', 'immediate', 'stop'], { stdout: 'ignore', stderr: 'ignore' });
      if (clusterDir) rmSync(clusterDir, { recursive: true, force: true });
    },
  };
}

function sql(database: string, statement: string): string {
  return server.sql(database, statement);
}

/** node-pg-migrate runs each file in one transaction; mirror that. */
function applyMigration(database: string): void {
  sql(database, `BEGIN;\n${migration}\nCOMMIT;\n`);
}

let beforeQual = '';
const beforeIds = new Map<string, string>();
let beforePlan = { filters: [] as string[], hasInitPlan: false };
let afterQual = '';
const afterIds = new Map<string, string>();
let afterPlan = { filters: [] as string[], hasInitPlan: false };

const suite = describe.skipIf(dockerAvailable === false && localPostgresBins() === null);

suite('message_select_policy initplan rewrite — real PostgreSQL', () => {
  beforeAll(async () => {
    if (migrationNames.length !== 1) throw new Error(`expected exactly one *_message_select_policy_initplan.sql migration, found ${migrationNames.length}`);
    migration = await Bun.file(resolve(migrationDirectory, migrationNames[0]!)).text();

    server = await startServer();

    sql('postgres', 'CREATE DATABASE legacy_db;');
    sql('legacy_db', FIXTURE);

    // The red state: the fixture reproduces the advisor's finding.
    for (const persona of PERSONAS) beforeIds.set(persona.name, visibleIds('legacy_db', persona));
    beforeQual = policyQual('legacy_db');
    beforePlan = messagesPlan('legacy_db', JWT_A);

    applyMigration('legacy_db');

    afterQual = policyQual('legacy_db');
    for (const persona of PERSONAS) afterIds.set(persona.name, visibleIds('legacy_db', persona));
    afterPlan = messagesPlan('legacy_db', JWT_A);
  }, 120_000);

  afterAll(() => {
    server?.stop();
  });

  test('fixture reproduces the finding: auth.uid() evaluated per row, bare in the stored qual', () => {
    expect(beforeQual).toContain('=auth.uid()');
    expect(beforePlan.filters.some((filter) => filter.includes('current_setting') || filter.includes('auth.uid('))).toBe(true);
    // Sanity: the personas actually exercise distinct access paths.
    expect(beforeIds.get('owner')).not.toBe(beforeIds.get('admin'));
    expect(beforeIds.get('outsider')).not.toBe(beforeIds.get('admin'));
  });

  test('after the rewrite the stored qual wraps both auth.uid() calls and no bare call remains', () => {
    expect(afterQual).not.toContain('=auth.uid()');
    expect(afterQual.split('selectauth.uid()').length - 1).toBe(2);
  });

  test('the plan evaluates auth.uid() once: an InitPlan feeds the per-row filter', () => {
    expect(afterPlan.filters.some((filter) => filter.includes('current_setting') || filter.includes('auth.uid('))).toBe(false);
    expect(afterPlan.hasInitPlan).toBe(true);
  });

  test('visible rows are identical before and after for every access path', () => {
    for (const persona of PERSONAS) {
      expect(afterIds.get(persona.name)).toBe(beforeIds.get(persona.name));
    }
    // The rewrite must not have collapsed the access paths either.
    expect(afterIds.get('owner')).not.toBe(afterIds.get('admin'));
  });

  test('the other three policies are untouched and the policy shape is preserved', () => {
    const shape = sql(
      'legacy_db',
      `SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='messages' AND policyname IN
         ('message_insert_policy', 'message_update_policy', 'message_delete_policy');`,
    );
    expect(shape).toBe('3');
    const shape2 = sql(
      'legacy_db',
      `SELECT cmd || '|' || roles::text || '|' || permissive FROM pg_policies
       WHERE schemaname='public' AND tablename='messages' AND policyname='message_select_policy';`,
    );
    expect(shape2).toBe('SELECT|{public}|PERMISSIVE');
  });

  test('a second apply is a no-op', () => {
    applyMigration('legacy_db');
    expect(policyQual('legacy_db')).toBe(afterQual);
  });

  test('a database without the legacy public tables takes the guarded skip path', () => {
    sql('postgres', 'CREATE DATABASE baseline_db;');
    applyMigration('baseline_db');
    const tables = sql(
      'baseline_db',
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'messages';`,
    );
    expect(tables).toBe('0');
  });
});

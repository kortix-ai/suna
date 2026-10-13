/**
 * `--db` worktrees: one Postgres database per worktree inside the primary local
 * Supabase (`kortix-local`), instead of a second Supabase stack per worktree.
 *
 * A full stack costs ~0.6–0.9 GB of RAM and 8 containers. A branch database is
 * a copy of the primary's `auth`, `basejump`, `kortix*` and `public` schemas
 * (~200 MB, ~3 s), migrated to the worktree branch. GoTrue, Kong, Storage and
 * Studio stay shared.
 *
 * GoTrue writes users only to the primary `postgres` database, and the product
 * schema has foreign keys to `auth.users`. A trigger on the primary's
 * `auth.users` pushes every insert/update/delete into each registered branch
 * through dblink (`kortix_wt.branches`), so a user who signs up after the copy
 * exists in the branch too, with the branch's own triggers and cascades. Create
 * and start also run a full reconcile (`kortix_wt.pull_users`).
 */
import { sh, type ShResult } from './exec';
import { SHARED_SUPABASE_PORTS } from './supabase';

export function branchDbName(name: string): string {
  return `kortix_wt_${name.replace(/-/g, '_')}`;
}

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Schemas a branch copies. Supabase's own (storage, realtime, cron, vault, …) stay in the primary. */
const BRANCH_SCHEMAS = ['auth', 'basejump', 'kortix', 'kortix_wallet', 'kortix_migrations', 'public'];
/** Audit rows are ~1.5 GB on a long-lived primary and nothing in a branch reads history. */
const SKIP_DATA = ['kortix.audit_events*', 'auth.audit_log_entries'];

const PRIMARY_SQL = `
select pg_advisory_xact_lock(hashtext('kortix_wt'));
create extension if not exists dblink with schema extensions;
create schema if not exists kortix_wt;
create table if not exists kortix_wt.branches (datname text primary key, conninfo text not null);
create or replace function kortix_wt.push_user() returns trigger language plpgsql security definer set search_path = '' as $$
declare b record;
begin
  for b in select br.datname, br.conninfo from kortix_wt.branches br join pg_database d on d.datname = br.datname loop
    begin
      perform extensions.dblink_exec(b.conninfo, format('call kortix_wt.apply_users(%L, %L)', tg_op, jsonb_build_array(to_jsonb(coalesce(new, old)))));
    exception when others then
      -- Never fail a GoTrue write because a branch is broken. start reconciles.
      raise warning 'kortix_wt: % of auth.users % to % failed: %', tg_op, to_jsonb(coalesce(new, old))->>'id', b.datname, sqlerrm;
    end;
  end loop;
  return null;
end $$;
create or replace trigger kortix_wt_push_user after insert or update or delete on auth.users
  for each row execute function kortix_wt.push_user();
`;

const BRANCH_SQL = `
create schema if not exists kortix_wt;
create or replace procedure kortix_wt.apply_users(op text, rows jsonb) language plpgsql as $$
declare cols text; sets text;
begin
  if op = 'DELETE' then
    delete from auth.users where id in (select (r->>'id')::uuid from jsonb_array_elements(rows) r);
    return;
  end if;
  select string_agg(quote_ident(attname), ', '), string_agg(format('%1$I = excluded.%1$I', attname), ', ')
    into cols, sets
    from pg_attribute where attrelid = 'auth.users'::regclass and attnum > 0 and not attisdropped and attgenerated = '';
  execute format(
    'insert into auth.users as u (%s) select %s from jsonb_populate_recordset(null::auth.users, $1)
       on conflict (id) do update set %s where u is distinct from excluded', cols, cols, sets) using rows;
end $$;
-- ponytail: a delete pushed while pull_users holds an older snapshot can re-insert
-- that user until the next start; local dev only.
create or replace procedure kortix_wt.pull_users(primary_conninfo text) language plpgsql as $$
declare rows jsonb;
begin
  select r into rows from extensions.dblink(primary_conninfo,
    'select coalesce(jsonb_agg(to_jsonb(u)), ''[]'') from auth.users u') as t(r jsonb);
  delete from auth.users where id not in (select (x->>'id')::uuid from jsonb_array_elements(rows) x);
  call kortix_wt.apply_users('UPSERT', rows);
end $$;
`;

export interface PrimaryDb {
  /** Host-side admin URL (`postgresql://postgres:…@127.0.0.1:54322/postgres`). */
  url: string;
  /** The primary's Postgres container: the branch→primary and primary→branch dblink host. */
  container: string;
}

export function primaryDb(url: string): PrimaryDb | null {
  const port = new URL(url).port || String(SHARED_SUPABASE_PORTS.sbDb);
  const container = sh(['docker', 'ps', '--filter', `publish=${port}`, '--format', '{{.Names}}']).stdout
    .split('\n').map((n) => n.trim()).find((n) => n.startsWith('supabase_db_'));
  return container ? { url, container } : null;
}

/**
 * dblink conninfo as seen from inside the container. Not 127.0.0.1: that is
 * `trust` in Supabase's pg_hba, and dblink refuses a non-superuser connection
 * that sends no password. The container name resolves to its network address,
 * which is scram-sha-256.
 */
function conninfo(p: PrimaryDb, database: string): string {
  const u = new URL(p.url);
  return `host=${p.container} port=5432 dbname=${database} user=${decodeURIComponent(u.username)} password=${decodeURIComponent(u.password)}`;
}

function psql(url: string, sql: string): ShResult {
  return sh(['psql', url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
}

function lit(s: string): string { return `'${s.replace(/'/g, "''")}'`; }

export function branchDbExists(p: PrimaryDb, name: string): boolean {
  return sh(['psql', p.url, '-XAtc', `select 1 from pg_database where datname = ${lit(branchDbName(name))}`]).stdout.trim() === '1';
}

/**
 * Copy the primary into `<db>_build`, then publish it by RENAME, so an
 * interrupted create never leaves a half-restored database that a resume
 * would accept. Returns an error message, or null.
 */
export function createBranchDb(p: PrimaryDb, name: string): string | null {
  const db = branchDbName(name);
  const build = `${db}_build`;
  const dump = `/tmp/${db}.dump`;
  const fail = (what: string, r: ShResult) => `${what}: ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n')}`;

  let r = psql(p.url, `drop database if exists ${build} with (force)`);
  if (!r.ok) return fail('drop stale build database', r);
  r = psql(p.url, `create database ${build}`);
  if (!r.ok) return fail('create database', r);
  const buildUrl = withDatabase(p.url, build);
  r = psql(buildUrl, 'create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create extension if not exists "uuid-ossp" with schema extensions; create extension if not exists dblink with schema extensions;');
  if (!r.ok) return fail('create extensions', r);

  // pg_dump/pg_restore run inside the container so their version matches the server.
  // The list drops `public` (exists already) and the primary's own sync trigger.
  const schemas = BRANCH_SCHEMAS.map((s) => `-n ${s}`).join(' ');
  const skip = SKIP_DATA.map((t) => `--exclude-table-data='${t}'`).join(' ');
  r = sh(['docker', 'exec', p.container, 'sh', '-c', [
    'set -e',
    `trap 'rm -f ${dump} ${dump}.list' EXIT`,
    `pg_dump -U postgres -Fc --no-owner --no-privileges ${schemas} ${skip} -f ${dump} postgres`,
    `pg_restore -l ${dump} | grep -v -e ' SCHEMA - public ' -e ' kortix_wt_push_user ' > ${dump}.list`,
    `pg_restore -U postgres --no-owner --no-privileges --exit-on-error -L ${dump}.list -d ${build} ${dump}`,
  ].join('\n')]);
  if (!r.ok) return fail('copy primary schemas', r);

  r = psql(buildUrl, BRANCH_SQL);
  if (!r.ok) return fail('install branch sync procedures', r);
  r = psql(p.url, `alter database ${build} rename to ${db}`);
  if (!r.ok) return fail('publish database', r);
  return null;
}

/**
 * Register the branch for the push trigger and reconcile every user. Idempotent;
 * `start` runs it every time, which also repairs anything a push missed.
 */
export function syncBranchUsers(p: PrimaryDb, name: string): string | null {
  const db = branchDbName(name);
  let r = psql(p.url, PRIMARY_SQL);
  if (!r.ok) return `install primary sync trigger: ${r.stderr.trim()}`;
  r = psql(p.url, `insert into kortix_wt.branches values (${lit(db)}, ${lit(conninfo(p, db))}) on conflict (datname) do update set conninfo = excluded.conninfo`);
  if (!r.ok) return `register branch: ${r.stderr.trim()}`;
  const branchUrl = withDatabase(p.url, db);
  r = psql(branchUrl, BRANCH_SQL);
  if (!r.ok) return `install branch sync procedures: ${r.stderr.trim()}`;
  r = psql(branchUrl, `call kortix_wt.pull_users(${lit(conninfo(p, 'postgres'))})`);
  if (!r.ok) return `reconcile auth.users: ${r.stderr.trim()}`;
  return null;
}

export function dropBranchDb(p: PrimaryDb, name: string): string | null {
  const db = branchDbName(name);
  // The registry table exists only once a branch was synced.
  psql(p.url, `delete from kortix_wt.branches where datname = ${lit(db)}`);
  const r = psql(p.url, `drop database if exists ${db} with (force)`);
  return r.ok ? null : `drop database ${db}: ${r.stderr.trim()}`;
}

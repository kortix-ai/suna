// The --db mirror against the real local Postgres: a scratch "primary" and a
// scratch branch database, both inside the primary Supabase container. The
// developer's own `postgres` database is never touched. Needs the primary
// local Supabase (the only place `--db` runs); without it the file skips.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sh } from '../lib/exec';
import { branchDbName, dropBranchDb, primaryDb, syncBranchUsers, withDatabase } from '../lib/branch-db';
import { SHARED_SUPABASE_PORTS, slotDbUrl } from '../lib/supabase';

const ADMIN = slotDbUrl(SHARED_SUPABASE_PORTS);
const container = sh(['psql', ADMIN, '-XAtc', 'select 1']).ok ? primaryDb(ADMIN)?.container : undefined;
const NAME = `mirror_test_${process.pid}`;
const SCRATCH_PRIMARY = `kortix_wt_${NAME}_primary`;
const BRANCH = branchDbName(NAME);
const p = { url: withDatabase(ADMIN, SCRATCH_PRIMARY), container: container ?? '' };
const branchUrl = withDatabase(ADMIN, BRANCH);

const AUTH_SCHEMA = `
create schema if not exists extensions; create extension if not exists dblink with schema extensions;
create schema auth;
create table auth.users (id uuid primary key, email text, deleted_at timestamptz, banned_until timestamptz);
create table auth.sessions (id uuid primary key, user_id uuid not null references auth.users on delete cascade,
  not_after timestamptz, refreshed_at timestamp);`;

function q(url: string, sql: string): string {
  const r = sh(['psql', url, '-XAtq', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  if (!r.ok) throw new Error(r.stderr);
  return r.stdout.trim();
}
const sessionIn = (url: string, id: string) => q(url, `select count(*) from auth.sessions where id = '${id}'`);

describe.skipIf(!container)('--db branch mirror of auth.users + auth.sessions', () => {
  beforeAll(() => {
    for (const db of [SCRATCH_PRIMARY, BRANCH]) {
      q(ADMIN, `drop database if exists ${db} with (force)`);
      q(ADMIN, `create database ${db}`);
      q(withDatabase(ADMIN, db), AUTH_SCHEMA);
    }
  });
  afterAll(() => {
    dropBranchDb(p, NAME);
    q(ADMIN, `drop database if exists ${SCRATCH_PRIMARY} with (force)`);
  });

  test('start reconciles a session created before the branch registered', () => {
    const user = randomUUID();
    const session = randomUUID();
    q(p.url, `insert into auth.users (id, email) values ('${user}', 'a@example.test');
              insert into auth.sessions (id, user_id) values ('${session}', '${user}')`);
    expect(syncBranchUsers(p, NAME)).toBeNull();
    expect(sessionIn(branchUrl, session)).toBe('1');
  });

  test('a sign-in after start reaches the branch, and a sign-out removes it', () => {
    const user = randomUUID();
    const session = randomUUID();
    q(p.url, `insert into auth.users (id, email) values ('${user}', 'b@example.test');
              insert into auth.sessions (id, user_id) values ('${session}', '${user}')`);
    expect(sessionIn(branchUrl, session)).toBe('1');

    q(p.url, `update auth.sessions set refreshed_at = now() where id = '${session}'`);
    expect(q(branchUrl, `select refreshed_at is not null from auth.sessions where id = '${session}'`)).toBe('t');

    q(p.url, `delete from auth.sessions where id = '${session}'`);
    expect(sessionIn(branchUrl, session)).toBe('0');
  });

  // Creates a database and syncs twice: ~2.7 s alone, over 5 s beside the CI DB suites.
  test('start upgrades a branch an older checkout created (no apply_rows yet)', () => {
    const OLD = `${NAME}_old`;
    const oldUrl = withDatabase(ADMIN, branchDbName(OLD));
    q(ADMIN, `drop database if exists ${branchDbName(OLD)} with (force)`);
    q(ADMIN, `create database ${branchDbName(OLD)}`);
    try {
      q(oldUrl, AUTH_SCHEMA);
      expect(syncBranchUsers(p, OLD)).toBeNull();
      q(oldUrl, 'drop procedure kortix_wt.apply_rows(text, text, jsonb) cascade');
      expect(syncBranchUsers(p, NAME)).toBeNull();
      const user = randomUUID();
      q(p.url, `insert into auth.users (id, email) values ('${user}', 'c@example.test')`);
      expect(q(oldUrl, `select count(*) from auth.users where id = '${user}'`)).toBe('1');
    } finally {
      dropBranchDb(p, OLD);
    }
  }, 20_000);

  test('start removes a session the branch kept after a missed push', () => {
    const user = q(branchUrl, 'select id from auth.users limit 1');
    const stale = randomUUID();
    q(branchUrl, `insert into auth.sessions (id, user_id) values ('${stale}', '${user}')`);
    expect(syncBranchUsers(p, NAME)).toBeNull();
    expect(sessionIn(branchUrl, stale)).toBe('0');
  });
});

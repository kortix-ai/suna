/**
 * Integration test (real local DB, real GoTrue `auth` schema): token liveness
 * is one `auth.sessions` + `auth.users` read, with no GoTrue call and no cache.
 * A deleted session row, a ban, a soft-deleted user and a passed `not_after`
 * each end the token on the next check.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { PgClient } from './helpers/pg-client';
import {
  __setJwtLivenessLoaderForTests,
  confirmJwtLive,
} from '../shared/jwt-liveness';

const superuser = new PgClient({ connectionString: process.env.TEST_DATABASE_SUPERUSER_URL });
const USER = crypto.randomUUID();
const EMAIL = `liveness-${USER.slice(0, 8)}@example.test`;
let goTrueCalls = 0;

async function session(): Promise<string> {
  const id = crypto.randomUUID();
  await superuser.query(`insert into auth.sessions (id, user_id) values ($1, $2)`, [id, USER]);
  return id;
}

const check = (sessionId: string, sub = USER) => confirmJwtLive('synthetic-token', { sub, session_id: sessionId });

beforeAll(async () => {
  await superuser.connect();
  await superuser.query(`insert into auth.users (id, email) values ($1, $2)`, [USER, EMAIL]);
  __setJwtLivenessLoaderForTests(async () => {
    goTrueCalls++;
    return null;
  });
});

afterEach(async () => {
  await superuser.query(`update auth.users set banned_until = null, deleted_at = null where id = $1`, [USER]);
});

afterAll(async () => {
  __setJwtLivenessLoaderForTests(null);
  await superuser.query(`delete from auth.sessions where user_id = $1`, [USER]);
  await superuser.query(`delete from auth.users where id = $1`, [USER]);
  await superuser.end();
});

test('a live session answers from the DB without a GoTrue call', async () => {
  expect(await check(await session())).toEqual({ id: USER, email: EMAIL });
});

test('a signed-out session (row deleted) is refused on the next check', async () => {
  const id = await session();
  expect(await check(id)).not.toBeNull();
  await superuser.query(`delete from auth.sessions where id = $1`, [id]);
  expect(await check(id)).toBeNull();
});

test('a banned user is refused; an expired ban is not', async () => {
  const id = await session();
  await superuser.query(`update auth.users set banned_until = now() + interval '1 hour' where id = $1`, [USER]);
  expect(await check(id)).toBeNull();
  await superuser.query(`update auth.users set banned_until = now() - interval '1 second' where id = $1`, [USER]);
  expect(await check(id)).not.toBeNull();
});

test('a soft-deleted user is refused', async () => {
  const id = await session();
  await superuser.query(`update auth.users set deleted_at = now() where id = $1`, [USER]);
  expect(await check(id)).toBeNull();
});

test('a session past not_after is refused', async () => {
  const id = await session();
  await superuser.query(`update auth.sessions set not_after = now() - interval '1 second' where id = $1`, [id]);
  expect(await check(id)).toBeNull();
});

test('a session of another user does not confirm this subject', async () => {
  expect(await check(await session(), crypto.randomUUID())).toBeNull();
});

test('no check above reached GoTrue', () => {
  expect(goTrueCalls).toBe(0);
});

test('a token without session_id asks GoTrue', async () => {
  let asked = 0;
  __setJwtLivenessLoaderForTests(async () => {
    asked++;
    return { id: USER, email: EMAIL };
  });
  expect(await confirmJwtLive('synthetic-token', { sub: USER })).toEqual({ id: USER, email: EMAIL });
  expect(asked).toBe(1);
});

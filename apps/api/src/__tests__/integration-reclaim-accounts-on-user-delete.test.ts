/**
 * Real HTTP + Postgres proof: deleting an auth user (what the Supabase Auth
 * admin API does: DELETE FROM auth.users) must reclaim every account the
 * delete would otherwise orphan. A user-deleted personal account keeps its
 * project rows forever with no member left to reach them: the project id
 * exists, GET returns 403 "You do not have access to this account", and a
 * re-signup with the same address boots a fresh account instead (KRTX-1300).
 *
 * Three shapes are proven here:
 *   1. sole member (the personal account) — account and projects reclaimed;
 *   2. a surviving member keeps the account and its projects reachable;
 *   3. an account whose remaining members are already dead (their auth rows
 *      went earlier) is reclaimed by the last live member's deletion.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, accountMembers, projects } from '@kortix/db';
import { inArray, sql } from 'drizzle-orm';

import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { resolveAccountId } from '../accounts/resolve-account';
import { db } from '../lib/db';
import { deleteFromView, insertIntoView } from './helpers/compat-views';

const SOLO = crypto.randomUUID(); // user and personal account, sole member
const SHARED = crypto.randomUUID(); // user whose personal account has a second member
const LIVE = crypto.randomUUID(); // the second, surviving member (co-owner)
const DEADROW = crypto.randomUUID(); // membership row of an already-dead user (no auth row)
const LAST_LIVE = crypto.randomUUID(); // last live member of a dead-member account
const NEW = crypto.randomUUID(); // the re-signup user, same email as SOLO, new id

const SOLO_EMAIL = `solo-${SOLO}@example.test`;
const SHARED_EMAIL = `shared-${SHARED}@example.test`;
const LAST_LIVE_EMAIL = `last-live-${LAST_LIVE}@example.test`;

const SOLO_A = SOLO; // a personal account's id IS its user id
const SHARED_A = SHARED;
const DEAD_A = crypto.randomUUID(); // team account with one dead and one live member

const P1 = crypto.randomUUID();
const P2 = crypto.randomUUID();
const P3 = crypto.randomUUID();
const P4 = crypto.randomUUID();

let ip = 0;

function get(path: string, token: string) {
  ip += 1;
  return app.request(path, {
    headers: { Authorization: `Bearer ${token}`, 'x-forwarded-for': `198.51.100.${ip % 250}` },
  });
}

async function seedUser(id: string, email: string) {
  await db.execute(sql`insert into auth.users (id, email) values (${id}::uuid, ${email})`);
}

async function seedProject(projectId: string, accountId: string, label: string) {
  await db.insert(projects).values({
    projectId,
    accountId,
    name: label,
    repoUrl: `https://example.test/${label}.git`,
    metadata: {},
  });
}

async function countRows(query: ReturnType<typeof sql>): Promise<number> {
  const res = (await db.execute(query)) as unknown as
    | Array<{ n: string }>
    | { rows: Array<{ n: string }> };
  return Number((Array.isArray(res) ? res : res.rows)[0]!.n);
}

const accountGone = (id: string) =>
  countRows(sql`select count(*) n from kortix.accounts where account_id = ${id}::uuid`);
const projectGone = (id: string) =>
  countRows(sql`select count(*) n from kortix.projects where project_id = ${id}::uuid`);

beforeAll(async () => {
  for (const [id, email] of [
    [SOLO, SOLO_EMAIL],
    [SHARED, SHARED_EMAIL],
    [LIVE, `live-${LIVE}@example.test`],
    [LAST_LIVE, LAST_LIVE_EMAIL],
  ] as const) {
    await seedUser(id, email);
  }
  for (const [id, label] of [
    [SOLO_A, 'solo-personal'],
    [SHARED_A, 'shared-personal'],
    [DEAD_A, 'dead-member-team'],
  ] as const) {
    await db.insert(accounts).values({ accountId: id, name: `reclaim-on-delete-${label}` });
  }
  await insertIntoView(db, accountMembers, [
    { accountId: SOLO_A, userId: SOLO, accountRole: 'owner' },
    { accountId: SHARED_A, userId: SHARED, accountRole: 'owner' },
    { accountId: SHARED_A, userId: LIVE, accountRole: 'owner' },
    { accountId: DEAD_A, userId: DEADROW, accountRole: 'member' },
    { accountId: DEAD_A, userId: LAST_LIVE, accountRole: 'owner' },
  ]);
  await seedProject(P1, SOLO_A, 'reclaim-solo-1');
  await seedProject(P2, SOLO_A, 'reclaim-solo-2');
  await seedProject(P3, SHARED_A, 'reclaim-shared');
  await seedProject(P4, DEAD_A, 'reclaim-dead-members');
});

afterAll(async () => {
  // SOLO_A/DEAD_A are already gone when the fix ran (the trigger reclaimed
  // them); deleting a missing row is a no-op, so one list covers both runs.
  await db.delete(accounts).where(inArray(accounts.accountId, [SOLO_A, SHARED_A, DEAD_A, NEW]));
  await deleteFromView(
    db,
    accountMembers,
    sql`account_id in (${SOLO_A}::uuid, ${SHARED_A}::uuid, ${DEAD_A}::uuid)`,
  );
  await db.execute(
    sql`delete from auth.users where id in (${SOLO}::uuid, ${SHARED}::uuid, ${LIVE}::uuid, ${LAST_LIVE}::uuid, ${NEW}::uuid)`,
  );
});

describe('deleting an auth user reclaims the accounts it would orphan', () => {
  test('every seeded project is reachable before any deletion', async () => {
    const soloPat = (
      await createAccountToken({ accountId: SOLO_A, userId: SOLO, name: 'solo', agentGrant: null })
    ).secretKey;
    const livePat = (
      await createAccountToken({ accountId: SHARED_A, userId: LIVE, name: 'live', agentGrant: null })
    ).secretKey;
    const lastLivePat = (
      await createAccountToken({
        accountId: DEAD_A,
        userId: LAST_LIVE,
        name: 'last-live',
        agentGrant: null,
      })
    ).secretKey;

    { const r = await get(`/v1/projects/${P1}`, soloPat); expect(r.status).toBe(200); }
    expect((await get(`/v1/projects/${P3}`, livePat)).status).toBe(200);
    expect((await get(`/v1/projects/${P4}`, lastLivePat)).status).toBe(200);
  });

  test('deleting the sole member reclaims the personal account and its projects; the same-address re-signup finds no 403 orphan', async () => {
    await db.execute(sql`delete from auth.users where id = ${SOLO}::uuid`);

    expect(await accountGone(SOLO_A)).toBe(0);
    expect(await projectGone(P1)).toBe(0);
    expect(await projectGone(P2)).toBe(0);

    // Re-signup with the same address: a new auth id, same email — what the
    // Supabase admin re-create does. The signup path (resolveAccountId) must
    // boot a fresh personal account for the new id, and the old
    // project id must answer 404 (gone), never 403 (exists but unreachable).
    await seedUser(NEW, SOLO_EMAIL);
    expect(await resolveAccountId(NEW)).toBe(NEW);
    expect(await countRows(sql`select count(*) n from kortix.accounts where account_id = ${NEW}::uuid`)).toBe(1);
    const newPat = (
      await createAccountToken({ accountId: NEW, userId: NEW, name: 'new', agentGrant: null })
    ).secretKey;
    expect((await get(`/v1/projects/${P1}`, newPat)).status).toBe(404);
  });

  test('a surviving member keeps the account and its projects reachable', async () => {
    await db.execute(sql`delete from auth.users where id = ${SHARED}::uuid`);

    expect(await accountGone(SHARED_A)).toBe(1);
    expect(await projectGone(P3)).toBe(1);
  });

  test('an account whose remaining members are all dead is reclaimed by its last live member', async () => {
    await db.execute(sql`delete from auth.users where id = ${LAST_LIVE}::uuid`);

    expect(await accountGone(DEAD_A)).toBe(0);
    expect(await projectGone(P4)).toBe(0);
  });
});

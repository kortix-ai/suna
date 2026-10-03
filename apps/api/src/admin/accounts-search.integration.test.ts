/**
 * Integration test (real local PostgreSQL): the admin accounts-list search
 * predicate (`apps/api/src/admin/accounts-search.ts`).
 *
 * KRTX-1127: the search branch used to be
 * `EXISTS (SELECT 1 FROM auth.users au INNER JOIN kortix.account_members am …
 * au.email ILIKE …)`. On prod the planner resolved that EXISTS as a hashed
 * SubPlan driven by account_memberships: one membership scan plus one
 * auth.users primary-key probe PER MEMBERSHIP — ~46k random probes into a
 * ~472 MB heap on every search call (mean 3978 ms over 47 calls; 45 s
 * measured cold with EXPLAIN ANALYZE). The fix resolves the branch
 * users-first behind a LATERAL + `offset 0` fence: one sequential pass over
 * auth.users with the ILIKE filter, then one membership probe per matching
 * user (mean 756 ms measured on prod with the same method).
 *
 * Two properties are pinned here:
 * 1. Behavior: the predicate matches exactly the accounts the old EXISTS form
 *    matched (name contains the term OR a member's email contains it). The
 *    list query and the count query in `./index.ts` share this predicate, so
 *    one check covers both.
 * 2. Shape: the email branch stays users-first — auth.users is scanned once
 *    with the ILIKE filter and account_memberships is probed BY USER ID. The
 *    pathological direction (auth.users probed by primary key per membership)
 *    must not come back: dropping the LATERAL/`offset 0` fence flips the plan
 *    and fails this test.
 */
import { describe, expect, test } from 'bun:test';
import { accounts } from '@kortix/db';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { qualifiedColumn } from '../shared/sql-qualified-column';
import { adminAccountsSearchCondition } from './accounts-search';

// Synthetic fixtures. No real ids, no real emails.
const USER_A = 'a0000000-0000-4000-8000-000000000001';
const USER_B = 'a0000000-0000-4000-8000-000000000002';
const USER_C = 'a0000000-0000-4000-8000-000000000003';
const ACCOUNT_ALPHA = 'b0000000-0000-4000-8000-000000000001';
const ACCOUNT_BETA = 'b0000000-0000-4000-8000-000000000002';
const ACCOUNT_GAMMA = 'b0000000-0000-4000-8000-000000000003';

type Rows = { rows?: Array<Record<string, unknown>> } & Array<Record<string, unknown>>;
const planText = (result: unknown) =>
  ((result as Rows).rows ?? (result as Rows))
    .map((row) => String(Object.values(row)[0]))
    .join('\n');

async function seed() {
  await db.execute(sql`
    insert into auth.users (id, email)
    values (${USER_A}::uuid, 'owner-alpha@example.test'),
           (${USER_B}::uuid, 'member-strip@example.test'),
           (${USER_C}::uuid, 'owner-gamma@example.test')
    on conflict (id) do nothing`);
  await db.execute(sql`
    insert into ${accounts} (account_id, name)
    values (${ACCOUNT_ALPHA}::uuid, 'alpha-co'),
           (${ACCOUNT_BETA}::uuid, 'beta-llc'),
           (${ACCOUNT_GAMMA}::uuid, 'gamma-labs')
    on conflict (account_id) do nothing`);
  await db.execute(sql`
    insert into kortix.account_memberships (user_id, account_id)
    values (${USER_A}::uuid, ${ACCOUNT_ALPHA}::uuid),
           (${USER_B}::uuid, ${ACCOUNT_BETA}::uuid),
           (${USER_C}::uuid, ${ACCOUNT_GAMMA}::uuid)
    on conflict (user_id, account_id) do nothing`);
}

/** The email branch exactly as it shipped before the fence (the oracle). */
const legacySearchCondition = (term: string): SQL =>
  sql`(${accounts.name} ilike ${`%${term}%`} or EXISTS (SELECT 1 FROM auth.users au
    INNER JOIN kortix.account_members am ON am.user_id = au.id
    WHERE am.account_id = ${qualifiedColumn(accounts.accountId)} AND au.email ILIKE ${`%${term}%`}))`;

async function accountIds(condition: SQL) {
  const rows = await db.select({ accountId: accounts.accountId }).from(accounts).where(condition);
  return rows.map((r) => r.accountId).sort();
}

/**
 * Plan-shape seed: prod-like RATIO (auth.users ≫ account_memberships — on prod
 * 409k users vs 46k memberships), large enough that the planner's own cost
 * model picks the memberships-first direction for an UNFENCED EXISTS form
 * (the pathology this fix removes) and can only keep users-first because the
 * fence forces it. ANALYZE first: without stats the planner falls back to
 * tiny-table defaults and the shape is not deterministic.
 */
const PLAN_USERS = 50_000;
const PLAN_MEMBERSHIPS = 5_000;

async function seedPlanScale() {
  await seed();
  await db.execute(sql`
    insert into auth.users (id, email)
    select (md5('plan-user-' || g::text))::uuid, 'plan-user-' || g || '@example.test'
    from generate_series(1, ${PLAN_USERS}) g
    on conflict (id) do nothing`);
  await db.execute(sql`
    insert into kortix.account_memberships (user_id, account_id)
    select (md5('plan-user-' || g::text))::uuid, ${ACCOUNT_ALPHA}::uuid
    from generate_series(1, ${PLAN_MEMBERSHIPS}) g
    on conflict (user_id, account_id) do nothing`);
  await db.execute(sql`analyze auth.users`);
  await db.execute(sql`analyze ${accounts}`);
  await db.execute(sql`analyze kortix.account_memberships`);
}

describe('admin accounts search predicate', () => {
  test('matches exactly what the pre-fence EXISTS form matched', async () => {
    await seed();
    for (const term of ['alpha', 'strip', 'labs', 'no-such-term-x9']) {
      const [fixed, legacy] = await Promise.all([
        accountIds(adminAccountsSearchCondition(term)),
        accountIds(legacySearchCondition(term)),
      ]);
      expect(fixed).toEqual(legacy);
    }
    // One explicit expectation, read off the fixtures: the member email term
    // matches exactly the account that member belongs to.
    expect(await accountIds(adminAccountsSearchCondition('strip'))).toEqual([ACCOUNT_BETA]);
  });

  test('the email branch resolves users-first, never users-per-membership', async () => {
    await seedPlanScale();
    // A non-selective pattern: with it, an unfenced EXISTS form plans the
    // memberships-first direction on this data (that IS the KRTX-1127
    // pathology), so this assertion can only hold while the fence holds.
    const plan = await db.execute(sql`
      EXPLAIN SELECT ${accounts.accountId} FROM ${accounts}
      WHERE ${adminAccountsSearchCondition('a')}`);
    const text = planText(plan);
    // One sequential pass over auth.users with the ILIKE filter drives the
    // branch; account_memberships is probed by user id per matching user.
    expect(text).toContain('Seq Scan on users');
    expect(text).toMatch(/Index Cond: \(user_id = /);
    // The pathological direction — auth.users probed by primary key per
    // membership — must never come back.
    expect(text).not.toContain('Index Cond: (id = ');
  });
});

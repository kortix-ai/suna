/**
 * DB suite: one free credit grant per person (Workspaces, 2026-11-05).
 * Real schema, real wallet functions, real role store. Billing is switched on
 * for the suite; nothing else is mocked.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accounts, creditAccounts, freeCreditClaims } from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';

import { insertIntoView } from '../../__tests__/helpers/compat-views';
import { createOwnedAccount } from '../../accounts/core/create-account';
import { config } from '../../config';
import { db } from '../../shared/db';
import { checkBillingAdmission } from './billing-gate';
import { processFreeTierCreditRotation } from './free-tier-rotation';
import { getTier } from './tiers';

const FREE_USD = getTier('free').monthlyCredits;
const mutable = config as { KORTIX_BILLING_INTERNAL_ENABLED: boolean };
const billingBefore = mutable.KORTIX_BILLING_INTERNAL_ENABLED;
const users: string[] = [];
const created: string[] = [];

async function person(): Promise<string> {
  const id = crypto.randomUUID();
  users.push(id);
  await db.execute(sql`insert into auth.users (id, email) values (${id}::uuid, ${`fc-${id}@example.test`})`);
  return id;
}

async function workspace(userId: string, name: string): Promise<string> {
  const account = await createOwnedAccount({ userId, name, email: null });
  created.push(account.accountId);
  return account.accountId;
}

async function wallet(accountId: string) {
  const [row] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
  return { balance: Number(row?.balance ?? 0), tier: row?.tier, eligible: row?.freeCreditsEligible };
}

beforeAll(() => {
  mutable.KORTIX_BILLING_INTERNAL_ENABLED = true;
});
afterAll(async () => {
  mutable.KORTIX_BILLING_INTERNAL_ENABLED = billingBefore;
  await db.delete(creditAccounts).where(inArray(creditAccounts.accountId, created));
  await db.delete(accounts).where(inArray(accounts.accountId, created));
  if (users.length) await db.delete(freeCreditClaims).where(inArray(freeCreditClaims.userId, users));
});

describe('free credits once per person', () => {
  test("a person's first workspace gets the free grant; the second starts on Free with 0", async () => {
    const userId = await person();
    const first = await workspace(userId, 'First');
    const second = await workspace(userId, 'Second');

    expect(await wallet(first)).toEqual({ balance: FREE_USD, tier: 'free', eligible: true });
    expect(await wallet(second)).toEqual({ balance: 0, tier: 'free', eligible: false });
  });

  test('the second workspace is refused a session with the usual insufficient-credits answer', async () => {
    const userId = await person();
    await workspace(userId, 'Paid For');
    const second = await workspace(userId, 'Unpaid');
    expect(await checkBillingAdmission(second)).toMatchObject({
      ok: false,
      reason: 'insufficient_credits',
      billingState: 'no_subscription',
      message: 'Out of credits. Pick a plan or top up to continue.',
    });
  });

  test('deleting the first workspace and creating another never grants twice', async () => {
    const userId = await person();
    const first = await workspace(userId, 'Gone');
    await db.delete(accounts).where(eq(accounts.accountId, first));
    const again = await workspace(userId, 'Again');
    expect((await wallet(again)).balance).toBe(0);
  });

  test('a dormant sign-up account (no project, does not pay) is not an earlier workspace: the first created one gets the grant', async () => {
    const userId = await person();
    const legacy = crypto.randomUUID();
    created.push(legacy);
    await db.insert(accounts).values({ accountId: legacy, name: 'legacy personal' });
    await insertIntoView(db, accountMembers, [{ accountId: legacy, userId, accountRole: 'owner' }]);
    const next = await workspace(userId, 'After the rule');
    expect(await wallet(next)).toMatchObject({ balance: FREE_USD, eligible: true });
  });

  test('an owned account with a project row, or one that pays, is an earlier workspace: 0 on a new one', async () => {
    const withProject = await person();
    const used = crypto.randomUUID();
    created.push(used);
    await db.insert(accounts).values({ accountId: used, name: 'legacy with project' });
    await insertIntoView(db, accountMembers, [{ accountId: used, userId: withProject, accountRole: 'owner' }]);
    await db.execute(sql`insert into kortix.projects (account_id, name, repo_url, status)
      values (${used}::uuid, 'legacy archived', 'https://example.invalid/legacy.git', 'archived')`);
    expect(await wallet(await workspace(withProject, 'After a used one'))).toMatchObject({ balance: 0, eligible: false });

    const payer = await person();
    const paid = crypto.randomUUID();
    created.push(paid);
    await db.insert(accounts).values({ accountId: paid, name: 'legacy paying' });
    await insertIntoView(db, accountMembers, [{ accountId: paid, userId: payer, accountRole: 'owner' }]);
    await db.insert(creditAccounts).values({ accountId: paid, tier: 'tier_2_20' });
    expect(await wallet(await workspace(payer, 'After a paying one'))).toMatchObject({ balance: 0, eligible: false });
  });

  test('the monthly rotation skips a further workspace and keeps rotating an account that holds a grant', async () => {
    const userId = await person();
    const second = (await workspace(userId, 'Rotation first'), await workspace(userId, 'Rotation second'));
    // An existing account with a grant: a row from before the rule (eligible by default).
    const legacy = crypto.randomUUID();
    created.push(legacy);
    await db.insert(accounts).values({ accountId: legacy, name: 'legacy granted' });
    await db.insert(creditAccounts).values({ accountId: legacy, tier: 'free', nextCreditGrant: '2026-01-01T00:00:00Z' });
    const due = '2026-01-01T00:00:00Z';
    await db.update(creditAccounts).set({ nextCreditGrant: due }).where(eq(creditAccounts.accountId, second));

    await processFreeTierCreditRotation(new Date('2026-02-02T00:00:00Z'));

    expect(await wallet(legacy)).toMatchObject({ balance: FREE_USD, eligible: true });
    expect((await wallet(second)).balance).toBe(0);
  });
});

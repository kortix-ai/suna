/**
 * DB suite: a RevenueCat purchase bills the workspace it was made in
 * (Workspaces C6). One person holds several workspaces; the store event names
 * the person, the `kortix_workspace_id` subscriber attribute names the
 * workspace, and a renewal follows the account that holds the subscription.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { creditAccounts, freeCreditClaims } from '@kortix/db';
import { inArray, sql } from 'drizzle-orm';

import { createOwnedAccount } from '../../accounts/core/create-account';
import { db } from '../../shared/db';
import { workspaceIdOfAccount } from '../../workspaces/surface';
import { resolveRevenueCatAccountId } from './revenuecat-webhooks';

const users: string[] = [];
const created: string[] = [];

async function person(): Promise<string> {
  const id = crypto.randomUUID();
  users.push(id);
  await db.execute(sql`insert into auth.users (id, email) values (${id}::uuid, ${`rc-${id}@example.test`})`);
  return id;
}

async function workspace(userId: string, name: string): Promise<string> {
  const account = await createOwnedAccount({ userId, name, email: null });
  created.push(account.accountId);
  return account.accountId;
}

const attribute = (workspaceId: string | null) => ({ kortix_workspace_id: { value: workspaceId } });

afterAll(async () => {
  await db.delete(creditAccounts).where(inArray(creditAccounts.accountId, created));
  await db.execute(sql`delete from kortix.accounts where account_id = any(${`{${created.join(',')}}`}::uuid[])`);
  if (users.length) await db.delete(freeCreditClaims).where(inArray(freeCreditClaims.userId, users));
});

describe('RevenueCat attribution per workspace', () => {
  test('a purchase that names a workspace of the person bills that workspace, not the first one', async () => {
    const userId = await person();
    const first = await workspace(userId, 'RC first');
    const second = await workspace(userId, 'RC second');
    const secondId = (await workspaceIdOfAccount(second))!;

    expect(await resolveRevenueCatAccountId(userId, { subscriber_attributes: attribute(secondId) })).toBe(second);
    // No attribute: the person's default account, as before.
    expect(await resolveRevenueCatAccountId(userId, {})).toBe(first);
  });

  test("a purchase that names another person's workspace falls back to the buyer's default account", async () => {
    const buyer = await person();
    const own = await workspace(buyer, 'RC buyer');
    const other = await workspace(await person(), 'RC other');
    const otherId = (await workspaceIdOfAccount(other))!;
    expect(await resolveRevenueCatAccountId(buyer, { subscriber_attributes: attribute(otherId) })).toBe(own);
  });

  test('a renewal follows the account that holds the store subscription', async () => {
    const userId = await person();
    await workspace(userId, 'RC default');
    const holder = await workspace(userId, 'RC holder');
    const transaction = `rc_txn_${crypto.randomUUID()}`;
    await db
      .insert(creditAccounts)
      .values({ accountId: holder, tier: 'credits', provider: 'revenuecat', revenuecatSubscriptionId: transaction })
      .onConflictDoUpdate({ target: creditAccounts.accountId, set: { provider: 'revenuecat', revenuecatSubscriptionId: transaction } });
    expect(await resolveRevenueCatAccountId(userId, { original_transaction_id: transaction })).toBe(holder);
  });
});

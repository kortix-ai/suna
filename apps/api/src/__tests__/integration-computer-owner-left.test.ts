/**
 * Integration test (real local DB): a computer whose owner left the account is
 * no longer a target for that account's agents (KRTX-1722). Removal stopped the
 * owner's sign-in and grants, and the paired laptop stayed a shell and
 * filesystem target: the next scheduled run wrote company data to the disk of
 * someone who no longer worked there.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accountMemberships, accounts, tunnelConnections } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { executeComputerCall } from '../tunnel/core/rpc-core';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
let tunnelId = '';

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'computer-owner-left' });
  await insertIntoView(db, accountMembers, { accountId: ACCOUNT, userId: OWNER, accountRole: 'member' });
  const [row] = await db
    .insert(tunnelConnections)
    .values({ accountId: ACCOUNT, ownerUserId: OWNER, name: 'Laptop' })
    .returning({ tunnelId: tunnelConnections.tunnelId });
  tunnelId = row!.tunnelId;
});

afterAll(async () => {
  await db.delete(tunnelConnections).where(eq(tunnelConnections.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

const call = (method: string) => executeComputerCall({ tunnelId, accountId: ACCOUNT, method, args: {} });

describe('a computer whose owner left the account', () => {
  test('while the owner is a member, the account reaches the machine', async () => {
    expect((await call('status')).ok).toBe(true);
    // Offline here, so a real call stops at the relay, not at ownership.
    expect(await call('fs_list')).toMatchObject({ ok: false, kind: 'computer_offline' });
  });

  test('after the owner leaves, every call is refused before the relay', async () => {
    // What removal and leave do to the identity row.
    await db
      .delete(accountMemberships)
      .where(and(eq(accountMemberships.accountId, ACCOUNT), eq(accountMemberships.userId, OWNER)));
    expect(await call('status')).toMatchObject({ ok: false, kind: 'computer_owner_left' });
    expect(await call('fs_list')).toMatchObject({ ok: false, kind: 'computer_owner_left' });
  });
});

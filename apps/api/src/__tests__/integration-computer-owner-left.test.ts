/**
 * Integration test (real local DB): a computer whose owner left the account is
 * no longer a target for that account's agents (KRTX-1722). Removal stopped the
 * owner's sign-in and grants, and the paired laptop stayed a shell and
 * filesystem target: the next scheduled run wrote company data to the disk of
 * someone who no longer worked there.
 *
 * A machine has two placements. Shared with a project at pairing, it lives in
 * the team account. Paired privately, it lives in the owner's personal account
 * (id = user id) and reaches a team project through the owner's computer
 * account there. The guard keys on the calling account, so it covers both.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountMembers, accountMemberships, accounts, tunnelConnections } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../shared/db';
import { executeComputerCall } from '../tunnel/core/rpc-core';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
// A personal account's id is its owner's user id.
const PERSONAL = OWNER;
let tunnelId = '';
let personalTunnelId = '';

async function pairMachine(accountId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(tunnelConnections)
    .values({ accountId, ownerUserId: OWNER, name })
    .returning({ tunnelId: tunnelConnections.tunnelId });
  return row!.tunnelId;
}

beforeAll(async () => {
  await db.insert(accounts).values([
    { accountId: ACCOUNT, name: 'computer-owner-left' },
    { accountId: PERSONAL, name: 'computer-owner-left-personal' },
  ]);
  await insertIntoView(db, accountMembers, [
    { accountId: ACCOUNT, userId: OWNER, accountRole: 'member' },
    { accountId: PERSONAL, userId: OWNER, accountRole: 'owner' },
  ]);
  tunnelId = await pairMachine(ACCOUNT, 'Laptop');
  personalTunnelId = await pairMachine(PERSONAL, 'Personal laptop');
});

afterAll(async () => {
  await db.delete(tunnelConnections).where(eq(tunnelConnections.ownerUserId, OWNER));
  await db.delete(accounts).where(inArray(accounts.accountId, [ACCOUNT, PERSONAL]));
});

const call = (method: string, machine = tunnelId, accountId = ACCOUNT) =>
  executeComputerCall({ tunnelId: machine, accountId, method, args: {} });

describe('a computer whose owner left the account', () => {
  test('while the owner is a member, the account reaches the machine', async () => {
    expect((await call('status')).ok).toBe(true);
    // Offline here, so a real call stops at the relay, not at ownership.
    expect(await call('fs_list')).toMatchObject({ ok: false, kind: 'computer_offline' });
  });

  test('while the owner is a member, the account reaches their personal machine', async () => {
    expect((await call('status', personalTunnelId)).ok).toBe(true);
    expect(await call('fs_list', personalTunnelId)).toMatchObject({ ok: false, kind: 'computer_offline' });
  });

  test('after the owner leaves, every call is refused before the relay', async () => {
    // What removal and leave do to the identity row.
    await db
      .delete(accountMemberships)
      .where(and(eq(accountMemberships.accountId, ACCOUNT), eq(accountMemberships.userId, OWNER)));
    expect(await call('status')).toMatchObject({ ok: false, kind: 'computer_owner_left' });
    expect(await call('fs_list')).toMatchObject({ ok: false, kind: 'computer_owner_left' });
  });

  test('after the owner leaves, the account cannot reach their personal machine either', async () => {
    expect(await call('status', personalTunnelId)).toMatchObject({ ok: false, kind: 'computer_owner_left' });
    expect(await call('fs_list', personalTunnelId)).toMatchObject({ ok: false, kind: 'computer_owner_left' });
  });

  test('the personal machine still serves the personal account', async () => {
    expect((await call('status', personalTunnelId, PERSONAL)).ok).toBe(true);
    expect(await call('fs_list', personalTunnelId, PERSONAL)).toMatchObject({ ok: false, kind: 'computer_offline' });
  });
});

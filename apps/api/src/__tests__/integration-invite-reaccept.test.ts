// Real-PostgreSQL tests for `POST /v1/account-invites/:id/accept` re-entry.
//
// Accepting an already-accepted invite re-ran its bootstrap grants: the SCIM
// group memberships and `exclusive` project roles the inviter staged. A member
// whose group an admin or the IdP removed got it back by clicking the old
// link. Re-entry applies nothing now, and the first accept stamps the invite
// with a compare-and-set that also checks expiry, so an invite that expired
// between the read and the write applies nothing either.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accountGroupMembers, accountGroups, accountInvitations, accountMemberships, accounts } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { createAccountToken } from '../repositories/account-tokens';
import { assignRole, SYSTEM_ACTOR } from '../iam/assignments';
import { interleave } from './helpers/interleave';

const { app } = await import('../index');

const ACCOUNT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const users: string[] = [];

const email = () => `reaccept-${crypto.randomUUID()}@example.test`;

async function invitee(address: string) {
  const id = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO auth.users (id, email, raw_app_meta_data, email_confirmed_at)
    VALUES (${id}::uuid, ${address}, '{"provider":"email","providers":["email"]}'::jsonb, now())
  `);
  await db.insert(accounts).values({ accountId: id, name: 'reaccept-invitee-personal' });
  await db.insert(accountMemberships).values({ accountId: id, userId: id });
  users.push(id);
  const { secretKey } = await createAccountToken({ accountId: id, userId: id, name: 'reaccept-invitee' });
  const accept = async (inviteId: string) => {
    const res = await app.request(`/v1/account-invites/${inviteId}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { id, accept };
}

async function inviteWithGroup(address: string, groupId: string): Promise<string> {
  const [row] = await db
    .insert(accountInvitations)
    .values({
      accountId: ACCOUNT,
      email: address,
      invitedBy: OWNER,
      initialRole: 'member',
      bootstrapGrants: [{ group_id: groupId }],
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    .returning({ inviteId: accountInvitations.inviteId });
  return row!.inviteId;
}

async function inGroup(groupId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: accountGroupMembers.userId })
    .from(accountGroupMembers)
    .where(and(eq(accountGroupMembers.groupId, groupId), eq(accountGroupMembers.userId, userId)));
  return rows.length === 1;
}

async function isMember(userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: accountMemberships.userId })
    .from(accountMemberships)
    .where(and(eq(accountMemberships.accountId, ACCOUNT), eq(accountMemberships.userId, userId)));
  return rows.length === 1;
}

async function newGroup(): Promise<string> {
  const [group] = await db
    .insert(accountGroups)
    .values({ accountId: ACCOUNT, name: `reaccept-${crypto.randomUUID().slice(0, 8)}` })
    .returning({ groupId: accountGroups.groupId });
  return group!.groupId;
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'invite-reaccept' });
  await db.execute(sql`INSERT INTO auth.users (id, email) VALUES (${OWNER}::uuid, ${email()})`);
  await db.insert(accountMemberships).values({ accountId: ACCOUNT, userId: OWNER });
  await assignRole(SYSTEM_ACTOR, ACCOUNT, {
    principal: { type: 'user', id: OWNER },
    roleKey: 'owner',
    scope: { type: 'account' },
    exclusive: true,
  });
});

afterAll(async () => {
  const all = [ACCOUNT, ...users];
  await db.execute(sql`DELETE FROM kortix.account_tokens WHERE account_id IN (${sql.join(all.map((id) => sql`${id}::uuid`), sql`, `)})`);
  await db.delete(accounts).where(inArray(accounts.accountId, all));
  await db.execute(sql`DELETE FROM auth.users WHERE id IN (${sql.join([OWNER, ...users].map((id) => sql`${id}::uuid`), sql`, `)})`);
});

describe('invite re-entry and expiry (real PostgreSQL)', () => {
  test('re-accepting an accepted invite does not restore a group the admin removed', async () => {
    const address = email();
    const user = await invitee(address);
    const groupId = await newGroup();
    const inviteId = await inviteWithGroup(address, groupId);

    const first = await user.accept(inviteId);
    expect(first.status).toBe(200);
    expect(first.body.already_accepted).toBe(false);
    expect(await inGroup(groupId, user.id)).toBe(true);

    // The admin (or the IdP) removes the member from the group.
    await db
      .delete(accountGroupMembers)
      .where(and(eq(accountGroupMembers.groupId, groupId), eq(accountGroupMembers.userId, user.id)));

    const again = await user.accept(inviteId);
    expect(again.status).toBe(200);
    expect(again.body.already_accepted).toBe(true);
    expect(again.body.bootstrap_grants_applied).toEqual([]);
    expect(await inGroup(groupId, user.id)).toBe(false);
  });

  test('an invite that expires while the accept is in flight applies nothing', async () => {
    const address = email();
    const user = await invitee(address);
    const groupId = await newGroup();
    const inviteId = await inviteWithGroup(address, groupId);

    const outcome = await interleave(
      (tx) =>
        tx.query(`UPDATE kortix.account_invitations SET expires_at = now() - interval '1 minute' WHERE invite_id = $1`, [
          inviteId,
        ]),
      () => user.accept(inviteId),
      'account_invitations',
    );
    expect(outcome.status).toBe(409);
    expect(await isMember(user.id)).toBe(false);
    expect(await inGroup(groupId, user.id)).toBe(false);
  });
});

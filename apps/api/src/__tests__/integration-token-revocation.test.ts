/**
 * Integration test (real local DB): revokeAllAccountTokensForUser — the
 * offboarding primitive. When a member is removed/deactivated (human UI or
 * SCIM/IdP), every one of their active tokens in that account (PATs AND live
 * sandbox session tokens) is revoked so they can't keep acting on a bearer.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { accountTokens, accounts, projects } from '@kortix/db';
import { db } from '../shared/db';
import {
  revokeAllAccountTokensForUser,
  revokeSessionConnectorTokens,
} from '../repositories/account-tokens';

const ACCOUNT = crypto.randomUUID();
const WORKSPACE = crypto.randomUUID();
const USER = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const OTHER_ACCOUNT = crypto.randomUUID();

let n = 0;
async function seedToken(userId: string, opts: { workspaceId?: string; sessionId?: string } = {}) {
  const tokenId = crypto.randomUUID();
  n += 1;
  await db.insert(accountTokens).values({
    tokenId,
    accountId: ACCOUNT,
    userId,
    name: `tok-${n}`,
    publicKey: `pk_${n}_${tokenId.slice(0, 8)}`,
    secretKeyHash: `hash_${n}_${tokenId.slice(0, 8)}`,
    workspaceId: opts.workspaceId ?? null,
    sessionId: opts.sessionId ?? null,
  });
  return tokenId;
}
const statusOf = async (tokenId: string) =>
  (await db.select({ status: accountTokens.status }).from(accountTokens).where(eq(accountTokens.tokenId, tokenId)))[0]?.status;

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'tok-revoke-test' });
  await db.insert(accounts).values({ accountId: OTHER_ACCOUNT, name: 'tok-revoke-test-other' });
  await db.insert(projects).values({ workspaceId: WORKSPACE, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git' });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT)); // cascades tokens
  await db.delete(accounts).where(eq(accounts.accountId, OTHER_ACCOUNT));
});

describe('revokeAllAccountTokensForUser', () => {
  test('revokes ALL of the user’s active tokens (PAT + live session) but nobody else’s', async () => {
    const pat = await seedToken(USER); // a personal access token
    const session = await seedToken(USER, { workspaceId: WORKSPACE, sessionId: 'sess-1' }); // a live sandbox token
    const otherPat = await seedToken(OTHER); // a different member — must be untouched

    const revoked = await revokeAllAccountTokensForUser(USER, ACCOUNT);
    expect(revoked).toBe(2);

    expect(await statusOf(pat)).toBe('revoked');
    expect(await statusOf(session)).toBe('revoked');
    expect(await statusOf(otherPat)).toBe('active'); // isolation: only the removed user

    // revoked_at is stamped so audits can see when.
    const [row] = await db.select({ revokedAt: accountTokens.revokedAt }).from(accountTokens).where(eq(accountTokens.tokenId, pat));
    expect(row?.revokedAt).toBeTruthy();
  });

  test('is idempotent — a second call revokes nothing (no active tokens left)', async () => {
    expect(await revokeAllAccountTokensForUser(USER, ACCOUNT)).toBe(0);
  });

  test('is scoped to the account — a token in another account is not touched', async () => {
    const otherAccount = crypto.randomUUID();
    await db.insert(accounts).values({ accountId: otherAccount, name: 'other-acct' });
    try {
      const foreign = await (async () => {
        const tokenId = crypto.randomUUID();
        await db.insert(accountTokens).values({
          tokenId, accountId: otherAccount, userId: USER, name: 'foreign',
          publicKey: `pk_f_${tokenId.slice(0, 8)}`, secretKeyHash: `hash_f_${tokenId.slice(0, 8)}`,
        });
        return tokenId;
      })();
      await revokeAllAccountTokensForUser(USER, ACCOUNT); // same user, different account
      expect(await statusOf(foreign)).toBe('active');
    } finally {
      await db.delete(accounts).where(eq(accounts.accountId, otherAccount));
    }
  });
});

describe('revokeSessionConnectorTokens', () => {
  test('revokes every live token for ONE session, leaving other sessions alone', async () => {
    // A session can hold several tokens — each re-provision mints another under
    // the same session_id — so revoking "the" token is not enough.
    const first = await seedToken(USER, { workspaceId: WORKSPACE, sessionId: 'sess-gone' });
    const afterRestart = await seedToken(USER, { workspaceId: WORKSPACE, sessionId: 'sess-gone' });
    const neighbour = await seedToken(USER, { workspaceId: WORKSPACE, sessionId: 'sess-alive' });

    const revoked = await revokeSessionConnectorTokens('sess-gone', ACCOUNT);

    expect(revoked).toBe(2);
    expect(await statusOf(first)).toBe('revoked');
    expect(await statusOf(afterRestart)).toBe('revoked');
    expect(await statusOf(neighbour)).toBe('active');
  });

  test('will not reach across accounts on a session id', async () => {
    const mine = await seedToken(USER, { workspaceId: WORKSPACE, sessionId: 'sess-shared-id' });
    expect(await revokeSessionConnectorTokens('sess-shared-id', OTHER_ACCOUNT)).toBe(0);
    expect(await statusOf(mine)).toBe('active');
  });

  test('is idempotent — a second call revokes nothing further', async () => {
    await seedToken(USER, { workspaceId: WORKSPACE, sessionId: 'sess-twice' });
    expect(await revokeSessionConnectorTokens('sess-twice', ACCOUNT)).toBe(1);
    expect(await revokeSessionConnectorTokens('sess-twice', ACCOUNT)).toBe(0);
  });
});

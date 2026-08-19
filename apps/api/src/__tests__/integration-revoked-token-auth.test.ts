/**
 * Integration (real local DB + the real Hono app): a token whose `revoked_at`
 * is stamped must stop authenticating immediately, at the repository AND over
 * HTTP.
 *
 * `validateAccountToken` used to gate on `status = 'active'` alone. Nothing in
 * the database ties `status` and `revoked_at` together — `account_tokens` has no
 * CHECK, no trigger and no partial index — so a row could be `status='active'`
 * with `revoked_at` set and it authenticated cleanly on every surface, emitting
 * a normal `auth.login.success` audit event that hid the bypass.
 *
 * The release-gate sweep revokes its test PATs with exactly that write
 * (`UPDATE account_tokens SET revoked_at = now()`). 186 "Connector Session"
 * tokens survived it and their sandbox agents kept hitting the staging gateway
 * with dead credentials until it reported `degraded`.
 *
 * The `revoked_at`-only UPDATE below is the whole point of this test: revoking
 * through `revokeAccountToken` (which sets both columns) would pass even with
 * the bug present.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken, validateAccountToken } from '../repositories/account-tokens';

const ACCOUNT = crypto.randomUUID();
const USER = crypto.randomUUID();
const minted: string[] = [];

beforeAll(async () => {
  await db.execute(
    sql`insert into kortix.accounts (account_id, name) values (${ACCOUNT}, 'revoked-token-auth-test')`,
  );
  // No ON CONFLICT: the pair is freshly generated, so it cannot collide, and a
  // local DB behind on migration 105 has no matching constraint to infer (42P10).
  await db.execute(
    sql`insert into kortix.account_members (user_id, account_id, account_role)
        values (${USER}, ${ACCOUNT}, 'owner')`,
  );
});

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  // Cascades account_members and any remaining tokens.
  await db.execute(sql`delete from kortix.accounts where account_id = ${ACCOUNT}`);
});

async function mintToken(name: string): Promise<{ secretKey: string; tokenId: string }> {
  const token = await createAccountToken({ accountId: ACCOUNT, userId: USER, name });
  minted.push(token.tokenId);
  return { secretKey: token.secretKey, tokenId: token.tokenId };
}

/** Stamp ONLY `revoked_at`, leaving `status = 'active'` — the real-world write. */
async function stampRevokedAtOnly(tokenId: string): Promise<void> {
  await db.execute(
    sql`update kortix.account_tokens set revoked_at = now() where token_id = ${tokenId}`,
  );
}

const authedRequest = (secretKey: string) =>
  app.request('/v1/accounts', { headers: { Authorization: `Bearer ${secretKey}` } });

describe('a revoked_at-stamped token stops authenticating', () => {
  test('repository: valid before the stamp, refused after it', async () => {
    const { secretKey, tokenId } = await mintToken('revoked-at-only-repo');

    const before = await validateAccountToken(secretKey);
    expect(before.isValid).toBe(true);
    expect(before.accountId).toBe(ACCOUNT);

    await stampRevokedAtOnly(tokenId);

    const after = await validateAccountToken(secretKey);
    expect(after.isValid).toBe(false);
    expect(after.error).toBe('PAT not found or revoked');
  });

  test('the row really is still status=active — status alone would have let it through', async () => {
    const { secretKey, tokenId } = await mintToken('revoked-at-only-status');
    await stampRevokedAtOnly(tokenId);

    const rows = (await db.execute(
      sql`select status, revoked_at from kortix.account_tokens where token_id = ${tokenId}`,
    )) as unknown as Array<{ status: string; revoked_at: string | null }>;

    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.revoked_at).toBeTruthy();
    expect((await validateAccountToken(secretKey)).isValid).toBe(false);
  });

  test('HTTP: the same bearer returns 401 after the stamp', async () => {
    const { secretKey, tokenId } = await mintToken('revoked-at-only-http');

    const before = await authedRequest(secretKey);
    expect(before.status).not.toBe(401);

    await stampRevokedAtOnly(tokenId);

    const after = await authedRequest(secretKey);
    expect(after.status).toBe(401);
  });

  test('a token revoked the ordinary way (both columns) is still refused', async () => {
    const { secretKey, tokenId } = await mintToken('revoked-both-columns');
    await db.execute(
      sql`update kortix.account_tokens set status = 'revoked', revoked_at = now() where token_id = ${tokenId}`,
    );

    expect((await validateAccountToken(secretKey)).isValid).toBe(false);
    expect((await authedRequest(secretKey)).status).toBe(401);
  });

  test('an untouched token still authenticates — the gate is not refusing everything', async () => {
    const { secretKey } = await mintToken('never-revoked');

    expect((await validateAccountToken(secretKey)).isValid).toBe(true);
    expect((await authedRequest(secretKey)).status).not.toBe(401);
  });
});

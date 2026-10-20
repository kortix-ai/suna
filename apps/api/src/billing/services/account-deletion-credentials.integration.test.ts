import { afterAll, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accounts, accountTokens, accountDeletionRequests, kortixApiKeys, oauthClients, oauthAuthorizationCodes, oauthAccessTokens, oauthRefreshTokens, scimTokens, gatewayApiKeys, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { requestAccountDeletion, cancelAccountDeletion } from './account-deletion';
import { PgClient } from '../../__tests__/helpers/pg-client';

const admin = new PgClient({ connectionString: process.env.TEST_DATABASE_SUPERUSER_URL });
afterAll(() => admin.end());

test('scheduling revokes existing credentials, not data or a fresh recovery sign-in', async () => {
  await admin.connect();
  const user = crypto.randomUUID();
  const neighbor = crypto.randomUUID();
  const session = crypto.randomUUID();
  const neighborSession = crypto.randomUUID();
  await admin.query('INSERT INTO auth.users (id) VALUES ($1), ($2)', [user, neighbor]);
  await db.insert(accounts).values([{ accountId: user, name: 'deletion' }, { accountId: neighbor, name: 'neighbor' }]);
  await admin.query('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2), ($3, $4)', [session, user, neighborSession, neighbor]);
  for (const accountId of [user, neighbor]) {
    await db.insert(accountTokens).values({ accountId, userId: accountId, name: 'test', publicKey: crypto.randomUUID(), secretKeyHash: 'synthetic-hash' });
  }
  await db.insert(kortixApiKeys).values({ accountId: user, sandboxId: crypto.randomUUID(), publicKey: crypto.randomUUID(), secretKeyHash: 'synthetic-api-key', title: 'test' });
  const clientId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  await db.insert(projects).values({ projectId, accountId: user, name: 'test', repoUrl: 'https://example.test/test.git' });
  await db.insert(gatewayApiKeys).values({ accountId: user, projectId, name: 'test', keyPrefix: 'test', secretKeyHash: crypto.randomUUID() });
  await db.insert(scimTokens).values({ accountId: user, name: 'test', publicPrefix: 'test', secretHash: crypto.randomUUID() });
  await db.insert(oauthClients).values({ clientId, accountId: user, name: 'test', clientSecretHash: 'synthetic' });
  const accessId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 3600_000);
  await db.insert(oauthAccessTokens).values({ id: accessId, clientId, accountId: user, userId: user, tokenHash: crypto.randomUUID(), expiresAt });
  await db.insert(oauthAuthorizationCodes).values([user, neighbor].map(accountId => ({ clientId, accountId, userId: accountId, code: crypto.randomUUID(), redirectUri: 'https://example.test/callback', codeChallenge: 'synthetic', expiresAt })));
  await db.insert(oauthRefreshTokens).values({ accessTokenId: accessId, clientId, accountId: user, userId: user, tokenHash: crypto.randomUUID(), expiresAt });
  try {
    const result = await requestAccountDeletion(user, user);
    expect(result.can_cancel).toBe(true);
    const [old] = await db.select().from(accountTokens).where(eq(accountTokens.accountId, user));
    expect(old?.status).toBe('revoked');
    expect(old?.revokedAt).not.toBeNull();
    expect(await db.select().from(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.accountId, user))).toHaveLength(0);
    expect(await db.select().from(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.accountId, neighbor))).toHaveLength(1);
    expect((await db.select().from(gatewayApiKeys).where(eq(gatewayApiKeys.accountId, user)))[0]?.status).toBe('revoked');
    expect((await db.select().from(scimTokens).where(eq(scimTokens.accountId, user)))[0]?.revokedAt).toBeInstanceOf(Date);
    expect((await db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.accountId, user)))[0]?.revokedAt).toBeInstanceOf(Date);
    expect((await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.accountId, user)))[0]?.revokedAt).toBeInstanceOf(Date);
    expect((await db.select().from(kortixApiKeys).where(eq(kortixApiKeys.accountId, user)))[0]?.status).toBe('revoked');
    expect((await admin.query('SELECT id FROM auth.sessions WHERE id = $1', [session])).rows).toHaveLength(0);
    expect((await admin.query('SELECT id FROM auth.sessions WHERE id = $1', [neighborSession])).rows).toHaveLength(1);
    expect((await db.select().from(accountTokens).where(eq(accountTokens.accountId, neighbor)))[0]?.status).toBe('active');
    expect(await db.select().from(accounts).where(eq(accounts.accountId, user))).toHaveLength(1);
    const fresh = crypto.randomUUID();
    await admin.query('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [fresh, user]);
    await cancelAccountDeletion(user);
    expect((await admin.query('SELECT id FROM auth.sessions WHERE id = $1', [fresh])).rows).toHaveLength(1);
    expect((await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.accountId, user)))[0]?.status).toBe('cancelled');
    expect((await db.select().from(accountTokens).where(eq(accountTokens.accountId, user)))[0]?.status).toBe('revoked');
  } finally {
    await db.delete(projects).where(eq(projects.accountId, user));
    await db.delete(kortixApiKeys).where(eq(kortixApiKeys.accountId, user));
    await db.delete(accountDeletionRequests).where(eq(accountDeletionRequests.accountId, user));
    await db.delete(accounts).where(sql`${accounts.accountId} IN (${user}::uuid, ${neighbor}::uuid)`);
    await admin.query('DELETE FROM auth.users WHERE id IN ($1, $2)', [user, neighbor]);
  }
});

test('team deletion preserves the owner sign-in and personal credentials', async () => {
  const owner = crypto.randomUUID();
  const team = crypto.randomUUID();
  const session = crypto.randomUUID();
  await admin.query('INSERT INTO auth.users (id) VALUES ($1)', [owner]);
  await db.insert(accounts).values([{ accountId: owner, name: 'personal' }, { accountId: team, name: 'team' }]);
  await admin.query('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [session, owner]);
  for (const accountId of [owner, team]) {
    await db.insert(accountTokens).values({ accountId, userId: owner, name: 'test', publicKey: crypto.randomUUID(), secretKeyHash: crypto.randomUUID() });
  }
  try {
    await requestAccountDeletion(team, owner);
    expect((await db.select().from(accountTokens).where(eq(accountTokens.accountId, team)))[0]?.status).toBe('revoked');
    expect((await db.select().from(accountTokens).where(eq(accountTokens.accountId, owner)))[0]?.status).toBe('active');
    expect((await admin.query('SELECT id FROM auth.sessions WHERE id = $1', [session])).rows).toHaveLength(1);
  } finally {
    await db.delete(accountDeletionRequests).where(eq(accountDeletionRequests.accountId, team));
    await db.delete(accounts).where(sql`${accounts.accountId} IN (${owner}::uuid, ${team}::uuid)`);
    await admin.query('DELETE FROM auth.users WHERE id = $1', [owner]);
  }
});

test('a revocation failure rolls back the pending deletion and earlier revocations', async () => {
  const user = crypto.randomUUID();
  await db.insert(accounts).values({ accountId: user, name: 'rollback' });
  await db.insert(accountTokens).values({ accountId: user, userId: user, name: 'test', publicKey: crypto.randomUUID(), secretKeyHash: crypto.randomUUID() });
  await db.insert(kortixApiKeys).values({ accountId: user, sandboxId: crypto.randomUUID(), publicKey: crypto.randomUUID(), secretKeyHash: crypto.randomUUID(), title: 'rollback' });
  await admin.query(`CREATE FUNCTION kortix.reject_test_revocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic revocation failure'; END $$`);
  await admin.query(`CREATE TRIGGER reject_test_revocation BEFORE UPDATE ON kortix.api_keys FOR EACH ROW EXECUTE FUNCTION kortix.reject_test_revocation()`);
  try {
    await expect(requestAccountDeletion(user, user)).rejects.toThrow();
    expect(await db.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.accountId, user))).toHaveLength(0);
    expect((await db.select().from(accountTokens).where(eq(accountTokens.accountId, user)))[0]?.status).toBe('active');
  } finally {
    await admin.query('DROP TRIGGER reject_test_revocation ON kortix.api_keys');
    await admin.query('DROP FUNCTION kortix.reject_test_revocation()');
    await db.delete(kortixApiKeys).where(eq(kortixApiKeys.accountId, user));
    await db.delete(accounts).where(eq(accounts.accountId, user));
  }
});

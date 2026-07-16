import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { accounts, gatewayApiKeys, projects } from '@kortix/db';
import { db } from '../shared/db';
import { hashSecretKey } from '../shared/crypto';
import { validateGatewayKey } from './gateway-keys';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const CREATOR = crypto.randomUUID();

let n = 0;
async function seedKey(opts: {
  status?: 'active' | 'revoked';
  expiresAt?: Date | null;
  createdBy?: string | null;
}) {
  n += 1;
  const secretKey = `kortix_gw_test_${n}_${crypto.randomUUID()}`;
  const [row] = await db
    .insert(gatewayApiKeys)
    .values({
      accountId: ACCOUNT,
      projectId: PROJECT,
      name: `test-key-${n}`,
      keyPrefix: secretKey.slice(0, 14),
      secretKeyHash: hashSecretKey(secretKey),
      status: opts.status ?? 'active',
      expiresAt: opts.expiresAt ?? null,
      createdBy: opts.createdBy === undefined ? CREATOR : opts.createdBy,
    })
    .returning({ keyId: gatewayApiKeys.keyId });
  return { secretKey, keyId: row!.keyId };
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'gateway-key-test-acct' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'gateway-key-test-project',
    repoUrl: 'https://example.test/gw-key.git',
  });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('validateGatewayKey', () => {
  test('accepts an active key with no expiry', async () => {
    const { secretKey, keyId } = await seedKey({ expiresAt: null });
    expect(await validateGatewayKey(secretKey)).toEqual({
      accountId: ACCOUNT,
      projectId: PROJECT,
      userId: CREATOR,
      keyId,
    });
  });

  test('accepts an active key whose expiry is in the future', async () => {
    const { secretKey } = await seedKey({ expiresAt: new Date(Date.now() + 60_000) });
    expect(await validateGatewayKey(secretKey)).not.toBeNull();
  });

  test('rejects a revoked key', async () => {
    const { secretKey } = await seedKey({ status: 'revoked' });
    expect(await validateGatewayKey(secretKey)).toBeNull();
  });

  test('rejects a key past its expiry', async () => {
    const { secretKey } = await seedKey({ expiresAt: new Date(Date.now() - 1) });
    expect(await validateGatewayKey(secretKey)).toBeNull();
  });

  test('rejects exactly at the expiry boundary instant', async () => {
    const now = new Date();
    const { secretKey } = await seedKey({ expiresAt: now });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await validateGatewayKey(secretKey)).toBeNull();
  });

  test('falls back userId to accountId when createdBy is null', async () => {
    const { secretKey } = await seedKey({ createdBy: null });
    expect((await validateGatewayKey(secretKey))?.userId).toBe(ACCOUNT);
  });

  test('rejects an unknown secret', async () => {
    expect(await validateGatewayKey(`kortix_gw_${crypto.randomUUID()}`)).toBeNull();
  });

  test('stamps lastUsedAt on a successful validation (fire-and-forget)', async () => {
    const { secretKey, keyId } = await seedKey({});
    expect(await validateGatewayKey(secretKey)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [row] = await db
      .select({ lastUsedAt: gatewayApiKeys.lastUsedAt })
      .from(gatewayApiKeys)
      .where(eq(gatewayApiKeys.keyId, keyId));
    expect(row?.lastUsedAt).toBeTruthy();
  });
});

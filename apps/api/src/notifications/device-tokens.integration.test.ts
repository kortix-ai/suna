// `kortix.push_device_tokens` on PostgreSQL: the upsert keyed on the token
// (insert, preference updates, ownership moves), the owner-only delete, and
// the list / bulk delete the push sender uses.
import { beforeEach, describe, expect, test } from 'bun:test';
import { pushDeviceTokens } from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../shared/db';
import { createPushDeviceTokenStore } from './device-tokens';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const store = createPushDeviceTokenStore(db);

async function rowOf(token: string) {
  const [row] = await db.select().from(pushDeviceTokens).where(eq(pushDeviceTokens.token, token));
  return row ?? null;
}

withDb('push device token store', () => {
  let userA: string;
  let userB: string;
  let token: string;

  beforeEach(() => {
    userA = crypto.randomUUID();
    userB = crypto.randomUUID();
    token = `ExponentPushToken[test-${crypto.randomUUID()}]`;
  });

  test('a new token is inserted with every preference true', async () => {
    const row = await store.upsert({ token, userId: userA, platform: 'ios', provider: 'expo' });

    expect(row).toMatchObject({
      token,
      userId: userA,
      platform: 'ios',
      provider: 'expo',
      enabled: true,
      onCompletion: true,
      onError: true,
      onQuestion: true,
      onPermission: true,
      playSound: true,
    });
    expect(await rowOf(token)).toMatchObject({ userId: userA });
  });

  test('a new token stores the preferences it was registered with', async () => {
    await store.upsert({
      token,
      userId: userA,
      platform: 'android',
      provider: 'expo',
      preferences: { onError: false, playSound: false },
    });

    expect(await rowOf(token)).toMatchObject({
      platform: 'android',
      enabled: true,
      onError: false,
      playSound: false,
    });
  });

  test('re-registering updates only the preferences it names and bumps updated_at', async () => {
    const first = await store.upsert({
      token,
      userId: userA,
      platform: 'ios',
      provider: 'expo',
      preferences: { onQuestion: false, playSound: false },
    });

    await store.upsert({ token, userId: userA, platform: 'ios', provider: 'expo', preferences: { playSound: true } });
    const afterPartial = await rowOf(token);
    expect(afterPartial).toMatchObject({ onQuestion: false, playSound: true });
    expect(afterPartial!.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    expect(afterPartial!.createdAt.getTime()).toBe(first.createdAt.getTime());

    await store.upsert({ token, userId: userA, platform: 'ios', provider: 'expo' });
    expect(await rowOf(token)).toMatchObject({ onQuestion: false, playSound: true });
  });

  test('a token registered by another user moves to that user', async () => {
    await store.upsert({ token, userId: userA, platform: 'ios', provider: 'expo' });
    await store.upsert({ token, userId: userB, platform: 'ios', provider: 'expo' });

    const rows = await db.select().from(pushDeviceTokens).where(eq(pushDeviceTokens.token, token));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userB);
    expect(await store.listByUser(userA)).toEqual([]);
    expect((await store.listByUser(userB)).map((r) => r.token)).toEqual([token]);
  });

  test("delete removes the caller's own token only", async () => {
    await store.upsert({ token, userId: userA, platform: 'ios', provider: 'expo' });

    expect(await store.deleteForUser(token, userB)).toBe(false);
    expect(await rowOf(token)).toMatchObject({ userId: userA });

    expect(await store.deleteForUser(token, userA)).toBe(true);
    expect(await rowOf(token)).toBeNull();

    expect(await store.deleteForUser(token, userA)).toBe(false);
  });

  test("listByUser returns every token of that user and none of another user's", async () => {
    const second = `${token}-2`;
    const foreign = `${token}-foreign`;
    await store.upsert({ token, userId: userA, platform: 'ios', provider: 'expo' });
    await store.upsert({ token: second, userId: userA, platform: 'android', provider: 'expo' });
    await store.upsert({ token: foreign, userId: userB, platform: 'ios', provider: 'expo' });

    expect((await store.listByUser(userA)).map((r) => r.token).sort()).toEqual([token, second].sort());
  });

  test('deleteTokens removes the listed tokens regardless of owner and ignores unknown ones', async () => {
    const other = `${token}-b`;
    const kept = `${token}-kept`;
    await store.upsert({ token, userId: userA, platform: 'ios', provider: 'expo' });
    await store.upsert({ token: other, userId: userB, platform: 'android', provider: 'expo' });
    await store.upsert({ token: kept, userId: userA, platform: 'ios', provider: 'expo' });

    expect(await store.deleteTokens([token, other, `${token}-unknown`])).toBe(2);
    expect(await store.deleteTokens([])).toBe(0);

    const left = await db
      .select({ token: pushDeviceTokens.token })
      .from(pushDeviceTokens)
      .where(inArray(pushDeviceTokens.token, [token, other, kept]));
    expect(left).toEqual([{ token: kept }]);
  });

  test('the platform CHECK constraint rejects anything but ios or android', async () => {
    await expect(
      store.upsert({ token, userId: userA, platform: 'web' as 'ios', provider: 'expo' }),
    ).rejects.toThrow();
  });
});

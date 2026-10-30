// `kortix.push_device_tokens` on PostgreSQL: the upsert keyed on the token
// (insert, preference updates, ownership moves), the owner-only delete, and
// the list / bulk delete the push sender uses.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { pushDeviceTokens } from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';
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

const users: string[] = [];

/** A live sign-in of `userId`, which `listByUser` needs to return a token. */
async function signIn(userId: string): Promise<string> {
  const id = crypto.randomUUID();
  if (!users.includes(userId)) {
    users.push(userId);
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role)
      values (${userId}::uuid, ${`push-${userId}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
  }
  await db.execute(sql`insert into auth.sessions (id, user_id) values (${id}::uuid, ${userId}::uuid)`);
  return id;
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

  afterEach(async () => {
    for (const id of users.splice(0)) await db.execute(sql`delete from auth.users where id = ${id}::uuid`);
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
    await store.upsert({ token, userId: userA, platform: 'ios', provider: 'expo', authSessionId: await signIn(userA) });
    await store.upsert({ token, userId: userB, platform: 'ios', provider: 'expo', authSessionId: await signIn(userB) });

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
    const a = await signIn(userA);
    await store.upsert({ token, userId: userA, platform: 'ios', provider: 'expo', authSessionId: a });
    await store.upsert({ token: second, userId: userA, platform: 'android', provider: 'expo', authSessionId: a });
    await store.upsert({ token: foreign, userId: userB, platform: 'ios', provider: 'expo', authSessionId: await signIn(userB) });

    expect((await store.listByUser(userA)).map((r) => r.token).sort()).toEqual([token, second].sort());
  });

  // KRTX-1722: a phone signed out from Settings > Security, or by "sign out
  // other devices" in GoTrue, kept getting lock-screen pushes. KRTX-2242: a
  // row with no recorded sign-in was pushed forever after the app signed out.
  test('listByUser returns only tokens whose sign-in still lives', async () => {
    const live = await signIn(userA);
    const ended = await signIn(userA);
    const expired = await signIn(userA);
    await db.execute(sql`update auth.sessions set not_after = now() + interval '1 hour' where id = ${live}::uuid`);
    await db.execute(sql`update auth.sessions set not_after = now() - interval '1 minute' where id = ${expired}::uuid`);
    const onLive = `${token}-live`;
    const onEnded = `${token}-ended`;
    const onExpired = `${token}-expired`;
    const unbound = `${token}-unbound`;
    await store.upsert({ token: onLive, userId: userA, platform: 'ios', provider: 'expo', authSessionId: live });
    await store.upsert({ token: onEnded, userId: userA, platform: 'ios', provider: 'expo', authSessionId: ended });
    await store.upsert({ token: onExpired, userId: userA, platform: 'ios', provider: 'expo', authSessionId: expired });
    await store.upsert({ token: unbound, userId: userA, platform: 'android', provider: 'expo' });
    expect((await store.listByUser(userA)).map((r) => r.token).sort()).toEqual([onEnded, onLive].sort());

    await db.execute(sql`delete from auth.sessions where id = ${ended}::uuid`);
    expect((await store.listByUser(userA)).map((r) => r.token)).toEqual([onLive]);
  });

  test('a re-registration records the sign-in it came from', async () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await store.upsert({ token, userId: userA, platform: 'ios', provider: 'expo', authSessionId: first });
    expect(await rowOf(token)).toMatchObject({ authSessionId: first });
    await store.upsert({ token, userId: userA, platform: 'ios', provider: 'expo', authSessionId: second });
    expect(await rowOf(token)).toMatchObject({ authSessionId: second });
    await store.upsert({ token, userId: userA, platform: 'ios', provider: 'expo' });
    expect(await rowOf(token)).toMatchObject({ authSessionId: null });
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

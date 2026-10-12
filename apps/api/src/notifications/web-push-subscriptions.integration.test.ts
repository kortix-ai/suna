// Web Push subscriptions on PostgreSQL (KRTX-1742): only push service
// endpoints are stored, a reused endpoint moves to its new owner, a user keeps
// at most 10, and a subscription dies with the sign-in that registered it.
import { afterAll, describe, expect, test } from 'bun:test';
import { webPushSubscriptions } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { fakePushBrowser } from '../__tests__/helpers/web-push-browser';
import {
  deleteWebPushSubscription,
  deleteWebPushSubscriptionsForSignIn,
  deleteWebPushSubscriptionsForUser,
  listDeliverableWebPushSubscriptions,
  registerWebPushSubscription,
  validateWebPushSubscriptionInput,
} from './web-push-subscriptions';

const users: string[] = [];

/** A user with one live sign-in. */
async function signedInUser(): Promise<{ userId: string; signIn: string }> {
  const userId = crypto.randomUUID();
  const signIn = crypto.randomUUID();
  users.push(userId);
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role)
    values (${userId}::uuid, ${`webpush-${userId.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
  await db.execute(sql`insert into auth.sessions (id, user_id) values (${signIn}::uuid, ${userId}::uuid)`);
  return { userId, signIn };
}

const fcm = (id: string = crypto.randomUUID()) => `https://fcm.googleapis.com/fcm/send/${id}`;
const keys = () => {
  const { p256dh, auth } = fakePushBrowser();
  return { p256dh, auth };
};

async function endpointsOf(userId: string): Promise<string[]> {
  const rows = await db.select().from(webPushSubscriptions).where(eq(webPushSubscriptions.userId, userId));
  return rows.map((row) => row.endpoint).sort();
}

afterAll(async () => {
  for (const userId of users) {
    await db.delete(webPushSubscriptions).where(eq(webPushSubscriptions.userId, userId));
    await db.execute(sql`delete from auth.users where id = ${userId}::uuid`);
  }
});

describe('validating a subscription', () => {
  test('push service endpoints on every allowed host pass', () => {
    for (const endpoint of [
      fcm(),
      'https://android.googleapis.com/gcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QGx',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      expect(validateWebPushSubscriptionInput({ endpoint, keys: keys() })).toEqual({ ok: true });
    }
  });

  test('IP literals, internal names and look-alike hosts are not push services', () => {
    for (const endpoint of [
      'https://127.0.0.1/push',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/push',
      'https://localhost/push',
      'https://internal-alb.vpc.local/admin',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilfcm.googleapis.com/x',
      'https://fcm-googleapis.com/x',
      'https://notify.windows.com.attacker.test/x',
    ]) {
      expect(validateWebPushSubscriptionInput({ endpoint, keys: keys() })).toEqual({ ok: false, error: 'unsupported_push_service' });
    }
  });

  test('http, userinfo, an explicit port, a non-URL and an oversized endpoint are invalid', () => {
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://user:pw@fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com:8443/fcm/send/x',
      'not a url',
      `https://fcm.googleapis.com/fcm/send/${'a'.repeat(2048)}`,
    ]) {
      expect(validateWebPushSubscriptionInput({ endpoint, keys: keys() })).toEqual({ ok: false, error: 'invalid_endpoint' });
    }
  });

  test('keys must decode to a 65-byte uncompressed point and a 16-byte secret', () => {
    const good = keys();
    const point = Buffer.from(good.p256dh, 'base64url');
    const compressed = Buffer.from(point);
    compressed[0] = 2;
    for (const bad of [
      { p256dh: point.subarray(0, 64).toString('base64url'), auth: good.auth },
      { p256dh: compressed.toString('base64url'), auth: good.auth },
      { p256dh: `${good.p256dh.slice(0, -2)}+/`, auth: good.auth },
      { p256dh: good.p256dh, auth: Buffer.alloc(15).toString('base64url') },
      { p256dh: good.p256dh, auth: '' },
    ]) {
      expect(validateWebPushSubscriptionInput({ endpoint: fcm(), keys: bad })).toEqual({ ok: false, error: 'invalid_keys' });
    }
    // A padded base64url value from an older browser is the same key.
    expect(validateWebPushSubscriptionInput({ endpoint: fcm(), keys: { p256dh: `${good.p256dh}=`, auth: `${good.auth}==` } })).toEqual({ ok: true });
  });
});

describe('the subscription store', () => {
  test('registering refuses invalid input and stores nothing', async () => {
    const { userId, signIn } = await signedInUser();
    await expect(registerWebPushSubscription({ endpoint: 'https://127.0.0.1/x', keys: keys(), userId, authSessionId: signIn, aal: 'aal1' }))
      .rejects.toThrow('unsupported_push_service');
    expect(await endpointsOf(userId)).toEqual([]);
  });

  test('a reused endpoint moves to the user who registered it last', async () => {
    const alice = await signedInUser();
    const bob = await signedInUser();
    const endpoint = fcm();
    await registerWebPushSubscription({ endpoint, keys: keys(), userId: alice.userId, authSessionId: alice.signIn, aal: 'aal1' });
    await registerWebPushSubscription({ endpoint, keys: keys(), userId: bob.userId, authSessionId: bob.signIn, aal: 'aal2' });

    expect(await endpointsOf(alice.userId)).toEqual([]);
    const [row] = await db.select().from(webPushSubscriptions).where(eq(webPushSubscriptions.endpoint, endpoint));
    expect(row).toMatchObject({ userId: bob.userId, authSessionId: bob.signIn, aal: 'aal2' });
    expect(await deleteWebPushSubscription(alice.userId, endpoint)).toBe(false);
    expect(await deleteWebPushSubscription(bob.userId, endpoint)).toBe(true);
  });

  test('a user keeps at most 10: the least recently registered is evicted', async () => {
    const { userId, signIn } = await signedInUser();
    const endpoints = Array.from({ length: 11 }, () => fcm());
    for (const endpoint of endpoints.slice(0, 10)) {
      await registerWebPushSubscription({ endpoint, keys: keys(), userId, authSessionId: signIn, aal: 'aal1' });
    }
    // Re-registering the oldest refreshes it, so the second oldest goes next.
    await registerWebPushSubscription({ endpoint: endpoints[0]!, keys: keys(), userId, authSessionId: signIn, aal: 'aal1' });
    await registerWebPushSubscription({ endpoint: endpoints[10]!, keys: keys(), userId, authSessionId: signIn, aal: 'aal1' });

    const kept = await endpointsOf(userId);
    expect(kept).toHaveLength(10);
    expect(kept).toContain(endpoints[0]!);
    expect(kept).toContain(endpoints[10]!);
    expect(kept).not.toContain(endpoints[1]!);
  });

  test('a subscription whose sign-in ended is not deliverable and is deleted', async () => {
    const { userId, signIn } = await signedInUser();
    const ended = crypto.randomUUID();
    const expired = crypto.randomUUID();
    await db.execute(sql`
      insert into auth.sessions (id, user_id, not_after)
      values (${ended}::uuid, ${userId}::uuid, null), (${expired}::uuid, ${userId}::uuid, now() - interval '1 minute')`);
    const live = fcm();
    await registerWebPushSubscription({ endpoint: live, keys: keys(), userId, authSessionId: signIn, aal: 'aal1' });
    await registerWebPushSubscription({ endpoint: fcm(), keys: keys(), userId, authSessionId: ended, aal: 'aal1' });
    await registerWebPushSubscription({ endpoint: fcm(), keys: keys(), userId, authSessionId: expired, aal: 'aal1' });
    await db.execute(sql`delete from auth.sessions where id = ${ended}::uuid`);

    expect((await listDeliverableWebPushSubscriptions(userId)).map((row) => row.endpoint)).toEqual([live]);
    expect(await endpointsOf(userId)).toEqual([live]);
  });

  test('device sign-out drops that sign-in only; account erasure drops them all', async () => {
    const { userId, signIn } = await signedInUser();
    const other = crypto.randomUUID();
    await db.execute(sql`insert into auth.sessions (id, user_id) values (${other}::uuid, ${userId}::uuid)`);
    const kept = fcm();
    await registerWebPushSubscription({ endpoint: fcm(), keys: keys(), userId, authSessionId: signIn, aal: 'aal1' });
    await registerWebPushSubscription({ endpoint: kept, keys: keys(), userId, authSessionId: other, aal: 'aal1' });

    expect(await deleteWebPushSubscriptionsForSignIn(signIn)).toBe(1);
    expect(await endpointsOf(userId)).toEqual([kept]);
    expect(await deleteWebPushSubscriptionsForUser(userId)).toBe(1);
    expect(await endpointsOf(userId)).toEqual([]);
  });
});

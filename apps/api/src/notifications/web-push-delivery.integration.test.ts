// Web Push delivery on PostgreSQL (KRTX-1742), the server half of "all tabs
// closed, the browser still alerts": a turn end for a subscribed user goes
// through the live notifier and reaches the subscription endpoint as ONE
// aes128gcm POST with a VAPID header that verifies against the stored key,
// and the browser decrypts a payload that opens the session. Only `fetch` is
// injected; the inbox, preferences, subscriptions and key pair are real.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createPublicKey, verify } from 'node:crypto';
import { accounts, notifications, webPushSubscriptions } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { removeSeeded, seedProject, seedSession, type SeededProject } from '../__tests__/helpers/integration-fixtures';
import { fakePushBrowser, type FakePushBrowser } from '../__tests__/helpers/web-push-browser';
import { deliver, liveNotifierDeps } from './notifier';
import { getVapidPublicKey } from './vapid-keys';
import type { PushFetch } from './web-push';
import { sendWebPushToUser } from './web-push-delivery';
import { registerWebPushSubscription } from './web-push-subscriptions';

interface Posted {
  url: string;
  headers: Headers;
  body: Uint8Array;
}

const seeded: SeededProject[] = [];
const users: string[] = [];

async function signedInUser(): Promise<{ userId: string; signIn: string }> {
  const userId = crypto.randomUUID();
  const signIn = crypto.randomUUID();
  users.push(userId);
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role)
    values (${userId}::uuid, ${`push-${userId.slice(0, 8)}@example.test`}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
  await db.execute(sql`insert into auth.sessions (id, user_id) values (${signIn}::uuid, ${userId}::uuid)`);
  return { userId, signIn };
}

/** A browser subscribed for `user`, answering every push with `status`. */
async function subscribe(user: { userId: string; signIn: string }, aal = 'aal1'): Promise<FakePushBrowser & { endpoint: string }> {
  const browser = fakePushBrowser();
  const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
  await registerWebPushSubscription({ endpoint, keys: browser, userId: user.userId, authSessionId: user.signIn, aal });
  return { ...browser, endpoint };
}

function pushService(statusFor: (url: string) => number = () => 201): { fetch: PushFetch; posted: Posted[] } {
  const posted: Posted[] = [];
  return {
    posted,
    fetch: async (url, init) => {
      posted.push({ url, headers: new Headers(init.headers), body: init.body as Uint8Array });
      return new Response(null, { status: statusFor(url) });
    },
  };
}

function vapidVerifies(authorization: string, publicKey: string, endpoint: string): boolean {
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(authorization);
  if (!match || match[4] !== publicKey) return false;
  const claims = JSON.parse(Buffer.from(match[2]!, 'base64url').toString());
  if (claims.aud !== new URL(endpoint).origin || claims.exp > Date.now() / 1000 + 24 * 3600) return false;
  const point = Buffer.from(publicKey, 'base64url');
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  return verify('sha256', Buffer.from(`${match[1]}.${match[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(match[3]!, 'base64url'));
}

afterAll(async () => {
  for (const userId of users) {
    await db.delete(webPushSubscriptions).where(eq(webPushSubscriptions.userId, userId));
    await db.delete(notifications).where(eq(notifications.userId, userId));
    await db.execute(sql`delete from auth.users where id = ${userId}::uuid`);
  }
  await removeSeeded(seeded);
});

describe('Web Push delivery', () => {
  let project: SeededProject;
  let sessionId: string;

  beforeEach(async () => {
    project = await seedProject(`webpush-${crypto.randomUUID().slice(0, 8)}`);
    seeded.push(project);
    sessionId = await seedSession(project, crypto.randomUUID());
  });

  test('a turn end reaches the subscribed browser as one encrypted, VAPID-signed POST that opens the session', async () => {
    const alice = await signedInUser();
    const browser = await subscribe(alice);
    const service = pushService();
    const deps = liveNotifierDeps({
      pushEnabled: true,
      listDevices: async () => [],
      sendExpo: async () => undefined,
      sendWebPush: (input) => sendWebPushToUser(input, { fetch: service.fetch }),
    });

    const [record] = await deliver({
      kind: 'turn_done',
      accountId: project.account_id,
      projectId: project.project_id,
      sessionId,
      title: 'Refactor the billing page',
      recipients: [alice.userId],
    }, deps);

    expect(record!.webPushSent).toBe(1);
    expect(service.posted).toHaveLength(1);
    const [post] = service.posted;
    expect(post!.url).toBe(browser.endpoint);
    expect(post!.headers.get('content-encoding')).toBe('aes128gcm');
    expect(post!.headers.get('urgency')).toBe('normal');
    expect(post!.headers.get('ttl')).toBe('3600');
    expect(vapidVerifies(post!.headers.get('authorization')!, await getVapidPublicKey(), browser.endpoint)).toBe(true);

    const shown = JSON.parse(browser.decrypt(post!.body));
    expect(shown).toMatchObject({
      title: 'Refactor the billing page',
      body: 'Session complete. Tap to see the result.',
      tag: `completion:${sessionId}`,
      notificationId: record!.notificationId,
      kind: 'turn_done',
      type: 'completion',
      projectId: project.project_id,
      sessionId,
      url: `/projects/${project.project_id}/sessions/${sessionId}?notification=${record!.notificationId}`,
    });
    expect(Buffer.byteLength(JSON.stringify(shown))).toBeLessThan(2048);
  });

  test('a question is urgent; a gone subscription is deleted and a live one still gets it', async () => {
    const alice = await signedInUser();
    const live = await subscribe(alice);
    const gone = await subscribe(alice);
    const service = pushService((url) => (url === gone.endpoint ? 410 : 201));
    const content = {
      title: 'S',
      body: 'Kortix has a question: Which region?',
      payload: {
        notificationId: crypto.randomUUID(), kind: 'question' as const, type: 'question',
        projectId: project.project_id, sessionId, triggerSlug: null, url: '/projects',
      },
    };

    expect(await sendWebPushToUser({ userId: alice.userId, accountId: project.account_id, content }, { fetch: service.fetch })).toEqual({ sent: 1 });
    expect(service.posted.map((p) => p.headers.get('urgency'))).toEqual(['high', 'high']);
    const left = await db.select().from(webPushSubscriptions).where(eq(webPushSubscriptions.userId, alice.userId));
    expect(left.map((row) => row.endpoint)).toEqual([live.endpoint]);
  });

  test('an account that requires MFA gets no push on a browser registered at aal1', async () => {
    await db.update(accounts).set({ mfaRequired: true }).where(eq(accounts.accountId, project.account_id));
    const alice = await signedInUser();
    await subscribe(alice, 'aal1');
    const stepped = await subscribe(alice, 'aal2');
    const service = pushService();
    const content = {
      title: 'S', body: 'b',
      payload: { notificationId: crypto.randomUUID(), kind: 'turn_done' as const, type: 'completion', projectId: project.project_id, sessionId, triggerSlug: null, url: '/projects' },
    };

    expect(await sendWebPushToUser({ userId: alice.userId, accountId: project.account_id, content }, { fetch: service.fetch })).toEqual({ sent: 1 });
    expect(service.posted.map((p) => p.url)).toEqual([stepped.endpoint]);
  });

  test('a browser whose sign-in ended gets nothing, and its subscription is deleted', async () => {
    const alice = await signedInUser();
    await subscribe(alice);
    await db.execute(sql`delete from auth.sessions where id = ${alice.signIn}::uuid`);
    const service = pushService();
    const content = {
      title: 'S', body: 'b',
      payload: { notificationId: crypto.randomUUID(), kind: 'turn_done' as const, type: 'completion', projectId: project.project_id, sessionId, triggerSlug: null, url: '/projects' },
    };

    expect(await sendWebPushToUser({ userId: alice.userId, accountId: project.account_id, content }, { fetch: service.fetch })).toEqual({ sent: 0 });
    expect(service.posted).toEqual([]);
    expect(await db.select().from(webPushSubscriptions).where(eq(webPushSubscriptions.userId, alice.userId))).toEqual([]);
  });
});

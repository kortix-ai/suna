// Contract of /v1/notifications with an in-memory store, fake services and a
// stub auth middleware (DI, no mock.module). SQL behavior is proven in
// device-tokens.integration.test.ts and inbox-read.integration.test.ts.
import { describe, expect, test } from 'bun:test';
import type { MiddlewareHandler } from 'hono';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@kortix/shared/notification-kinds';
import type { PushDeviceTokenRow, PushDeviceTokenStore, UpsertDeviceTokenInput } from './device-tokens';
import { createNotificationsApp, type NotificationServices } from './routes';
import { validateWebPushSubscriptionInput } from './web-push-subscriptions';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const TOKEN = 'ExponentPushToken[synthetic-a/b+c]';

function memoryStore() {
  const rows = new Map<string, PushDeviceTokenRow>();
  const upserts: UpsertDeviceTokenInput[] = [];
  const store: PushDeviceTokenStore = {
    async upsert(input) {
      upserts.push(input);
      const now = new Date();
      const prev = rows.get(input.token);
      const p = input.preferences ?? {};
      const row: PushDeviceTokenRow = {
        token: input.token,
        userId: input.userId,
        platform: input.platform,
        provider: input.provider,
        enabled: p.enabled ?? prev?.enabled ?? true,
        onCompletion: p.onCompletion ?? prev?.onCompletion ?? true,
        onError: p.onError ?? prev?.onError ?? true,
        onQuestion: p.onQuestion ?? prev?.onQuestion ?? true,
        onPermission: p.onPermission ?? prev?.onPermission ?? true,
        playSound: p.playSound ?? prev?.playSound ?? true,
        authSessionId: input.authSessionId ?? null,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
      rows.set(input.token, row);
      return row;
    },
    async deleteForUser(token, userId) {
      if (rows.get(token)?.userId !== userId) return false;
      return rows.delete(token);
    },
    async listByUser(userId) {
      return [...rows.values()].filter((r) => r.userId === userId);
    },
    async deleteTokens(tokens) {
      return tokens.filter((t) => rows.delete(t)).length;
    },
  };
  return { store, rows, upserts };
}

type Identity = { userId?: string; authType?: string; sessionId?: string; iamTokenId?: string; mfaAal?: string } | null;

const authMiddleware: MiddlewareHandler = async (c, next) => {
  const raw = c.req.header('x-test-identity');
  const identity = raw ? (JSON.parse(raw) as Identity) : null;
  if (!identity) return c.json({ error: true, message: 'Unauthorized', status: 401 }, 401);
  for (const key of ['userId', 'authType', 'sessionId', 'iamTokenId', 'mfaAal'] as const) {
    if (identity[key]) c.set(key as never, identity[key] as never);
  }
  await next();
};

function appFor(store: PushDeviceTokenStore) {
  const app = createNotificationsApp({ store, authMiddleware });
  const as = (identity: Identity) => ({
    post: (body: unknown) =>
      app.request('/device-token', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(identity ? { 'x-test-identity': JSON.stringify(identity) } : {}),
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    del: (token: string) =>
      app.request(`/device-token/${encodeURIComponent(token)}`, {
        method: 'DELETE',
        headers: identity ? { 'x-test-identity': JSON.stringify(identity) } : {},
      }),
  });
  return { as };
}

const userA = { userId: USER_A, authType: 'supabase' };
const userB = { userId: USER_B, authType: 'supabase' };
const register = { device_token: TOKEN, device_type: 'ios', provider: 'expo' };

describe('POST /device-token', () => {
  test('the mobile client body registers the token for the caller with default preferences', async () => {
    const { store, rows, upserts } = memoryStore();
    const res = await appFor(store).as(userA).post(register);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: 'Device token registered' });
    expect(upserts).toEqual([
      { token: TOKEN, userId: USER_A, platform: 'ios', provider: 'expo', authSessionId: null, preferences: undefined },
    ]);
    expect(rows.get(TOKEN)).toMatchObject({ userId: USER_A, enabled: true, playSound: true });
  });

  // KRTX-1722: a push goes only while the registering sign-in exists.
  test("a sign-in JWT records its session; a personal token and a malformed id record none", async () => {
    const { store, upserts } = memoryStore();
    const signIn = '11111111-2222-4333-8444-555555555555';
    await appFor(store).as({ ...userA, sessionId: signIn }).post(register);
    await appFor(store).as({ ...userA, sessionId: 'not-a-uuid' }).post(register);
    await appFor(store).as({ userId: USER_A, authType: 'pat' }).post(register);
    expect(upserts.map((u) => u.authSessionId)).toEqual([signIn, null, null]);
  });

  test('snake_case preferences map to the store fields; omitted keys stay undefined', async () => {
    const { store, upserts } = memoryStore();
    const res = await appFor(store)
      .as(userA)
      .post({ ...register, device_type: 'android', preferences: { on_error: false, play_sound: false } });

    expect(res.status).toBe(200);
    expect(upserts[0]?.platform).toBe('android');
    expect(upserts[0]?.preferences).toEqual({
      enabled: undefined,
      onCompletion: undefined,
      onError: false,
      onQuestion: undefined,
      onPermission: undefined,
      playSound: false,
    });
  });

  test('provider may be omitted and defaults to expo', async () => {
    const { store, upserts } = memoryStore();
    const res = await appFor(store).as(userA).post({ device_token: TOKEN, device_type: 'ios' });
    expect(res.status).toBe(200);
    expect(upserts[0]?.provider).toBe('expo');
  });

  test('a token registered by another user moves to the caller', async () => {
    const { store, rows } = memoryStore();
    const app = appFor(store);
    await app.as(userA).post(register);
    const res = await app.as(userB).post(register);
    expect(res.status).toBe(200);
    expect(rows.get(TOKEN)?.userId).toBe(USER_B);
  });

  const invalid: [string, unknown][] = [
    ['empty token', { ...register, device_token: '' }],
    ['whitespace token', { ...register, device_token: '   ' }],
    ['token over 512 chars', { ...register, device_token: 'x'.repeat(513) }],
    ['missing token', { device_type: 'ios', provider: 'expo' }],
    ['unknown device_type', { ...register, device_type: 'web' }],
    ['missing device_type', { device_token: TOKEN, provider: 'expo' }],
    ['non-expo provider', { ...register, provider: 'fcm' }],
    ['non-boolean preference', { ...register, preferences: { enabled: 'yes' } }],
    ['unknown preference key', { ...register, preferences: { on_everything: true } }],
    ['malformed JSON', '{"device_token":'],
  ];
  for (const [name, body] of invalid) {
    test(`${name} → 400 and nothing is stored`, async () => {
      const { store, upserts } = memoryStore();
      const res = await appFor(store).as(userA).post(body);
      expect(res.status).toBe(400);
      expect(upserts).toEqual([]);
    });
  }

  test('a token of exactly 512 chars is accepted', async () => {
    const { store } = memoryStore();
    const res = await appFor(store).as(userA).post({ ...register, device_token: 'x'.repeat(512) });
    expect(res.status).toBe(200);
  });

  test('no credential → 401', async () => {
    const { store, upserts } = memoryStore();
    const res = await appFor(store).as(null).post(register);
    expect(res.status).toBe(401);
    expect(upserts).toEqual([]);
  });

  const nonHuman: [string, Identity][] = [
    ['service account', { userId: USER_A, authType: 'service_account' }],
    ['session-scoped agent PAT', { userId: USER_A, authType: 'pat', sessionId: 'session-1' }],
    ['account API key', { userId: USER_A, authType: 'apiKey' }],
  ];
  for (const [name, identity] of nonHuman) {
    test(`${name} → 403 and nothing is stored`, async () => {
      const { store, upserts } = memoryStore();
      const res = await appFor(store).as(identity).post(register);
      expect(res.status).toBe(403);
      expect(upserts).toEqual([]);
    });
  }

  test('a personal CLI PAT may register', async () => {
    const { store } = memoryStore();
    const res = await appFor(store).as({ userId: USER_A, authType: 'pat' }).post(register);
    expect(res.status).toBe(200);
  });
});

describe('DELETE /device-token/:token', () => {
  test('the owner deletes a URL-encoded Expo token', async () => {
    const { store, rows } = memoryStore();
    const app = appFor(store);
    await app.as(userA).post(register);

    const res = await app.as(userA).del(TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deleted: true });
    expect(rows.has(TOKEN)).toBe(false);
  });

  test("another user's token is untouched and the answer matches an unknown token", async () => {
    const { store, rows } = memoryStore();
    const app = appFor(store);
    await app.as(userA).post(register);

    const res = await app.as(userB).del(TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deleted: false });
    expect(rows.get(TOKEN)?.userId).toBe(USER_A);
  });

  test('a repeated delete is idempotent', async () => {
    const { store } = memoryStore();
    const app = appFor(store);
    await app.as(userA).post(register);
    await app.as(userA).del(TOKEN);

    const res = await app.as(userA).del(TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deleted: false });
  });

  test('a token over 512 chars → 400', async () => {
    const { store } = memoryStore();
    const res = await appFor(store).as(userA).del('x'.repeat(513));
    expect(res.status).toBe(400);
  });

  test('no credential → 401; service account → 403', async () => {
    const { store } = memoryStore();
    const app = appFor(store);
    expect((await app.as(null).del(TOKEN)).status).toBe(401);
    expect((await app.as({ userId: USER_A, authType: 'service_account' }).del(TOKEN)).status).toBe(403);
  });
});

// ─── The inbox, preferences and Web Push routes (KRTX-1742) ─────────────────

const SIGN_IN = '11111111-2222-4333-8444-555555555555';
const NOTIFICATION_ID = '01920000-0000-7000-8000-000000000001';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/synthetic-endpoint';
const P256DH = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const AUTH_SECRET = Buffer.alloc(16, 9).toString('base64url');

function inboxApp() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string, args: unknown[]) => calls.push({ name, args });
  const services: Partial<NotificationServices> = {
    listInbox: async (...args) => {
      record('listInbox', args);
      return { notifications: [], unread_count: 3, next_before: null };
    },
    markInboxRead: async (...args) => {
      record('markInboxRead', args);
      return { updated: 1, unread_count: 2 };
    },
    loadPreferences: async (...args) => {
      record('loadPreferences', args);
      return DEFAULT_NOTIFICATION_PREFERENCES;
    },
    updatePreferences: async (...args) => {
      record('updatePreferences', args);
      return { ...DEFAULT_NOTIFICATION_PREFERENCES, question: { push: false, email: true } };
    },
    emailAvailable: () => false,
    vapidPublicKey: async () => 'BSyntheticPublicKey',
    validateWebPush: validateWebPushSubscriptionInput,
    registerWebPush: async (...args) => {
      record('registerWebPush', args);
    },
    deleteWebPush: async (...args) => {
      record('deleteWebPush', args);
      return true;
    },
  };
  const app = createNotificationsApp({ store: memoryStore().store, authMiddleware, services });
  const send = (method: string, path: string, identity: Identity, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(identity ? { 'x-test-identity': JSON.stringify(identity) } : {}),
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  return { send, calls, named: (name: string) => calls.filter((call) => call.name === name).map((call) => call.args) };
}

const browser = { userId: USER_A, authType: 'supabase', sessionId: SIGN_IN };
const nonPeople: [string, Identity][] = [
  ['service account', { userId: USER_A, authType: 'service_account' }],
  ['session-scoped agent PAT', { userId: USER_A, authType: 'pat', sessionId: 'session-1' }],
  ['account API key', { userId: USER_A, authType: 'apiKey' }],
];

describe('GET /v1/notifications', () => {
  test('lists the caller\'s page with the default limit and the sign-in MFA state', async () => {
    const h = inboxApp();
    const res = await h.send('GET', '/', { ...browser, mfaAal: 'aal2' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notifications: [], unread_count: 3, next_before: null });
    expect(h.named('listInbox')).toEqual([[USER_A, { limit: 20, before: undefined }, { iamTokenId: null, mfaAal: 'aal2' }]]);
  });

  test('limit and before are passed through; a personal token carries its token id', async () => {
    const h = inboxApp();
    const res = await h.send('GET', `/?limit=50&before=${NOTIFICATION_ID}`, { userId: USER_A, authType: 'pat', iamTokenId: 'token-1' });
    expect(res.status).toBe(200);
    expect(h.named('listInbox')).toEqual([[USER_A, { limit: 50, before: NOTIFICATION_ID }, { iamTokenId: 'token-1', mfaAal: null }]]);
  });

  for (const query of ['?limit=0', '?limit=51', '?limit=two', '?before=not-a-uuid']) {
    test(`${query} → 400 and nothing is read`, async () => {
      const h = inboxApp();
      expect((await h.send('GET', `/${query}`, browser)).status).toBe(400);
      expect(h.calls).toEqual([]);
    });
  }

  test('no credential → 401; a non-person credential → 403', async () => {
    const h = inboxApp();
    expect((await h.send('GET', '/', null)).status).toBe(401);
    for (const [, identity] of nonPeople) expect((await h.send('GET', '/', identity)).status).toBe(403);
    expect(h.calls).toEqual([]);
  });
});

describe('POST /v1/notifications/read', () => {
  test('ids, all and session_id each map to one target', async () => {
    const h = inboxApp();
    for (const body of [{ ids: [NOTIFICATION_ID] }, { all: true }, { session_id: 'session-7' }]) {
      const res = await h.send('POST', '/read', browser, body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ updated: 1, unread_count: 2 });
    }
    expect(h.named('markInboxRead').map((args) => args.slice(0, 2))).toEqual([
      [USER_A, { ids: [NOTIFICATION_ID] }],
      [USER_A, { all: true }],
      [USER_A, { sessionId: 'session-7' }],
    ]);
  });

  const invalid: [string, unknown][] = [
    ['an empty body', {}],
    ['two targets', { all: true, session_id: 'session-7' }],
    ['an empty id list', { ids: [] }],
    ['101 ids', { ids: Array.from({ length: 101 }, () => NOTIFICATION_ID) }],
    ['a non-uuid id', { ids: ['42'] }],
    ['all: false', { all: false }],
    ['an unknown key', { ids: [NOTIFICATION_ID], everything: true }],
    ['no body', undefined],
  ];
  for (const [name, body] of invalid) {
    test(`${name} → 400 and nothing changes`, async () => {
      const h = inboxApp();
      expect((await h.send('POST', '/read', browser, body)).status).toBe(400);
      expect(h.calls).toEqual([]);
    });
  }

  test('a non-person credential → 403', async () => {
    const h = inboxApp();
    for (const [, identity] of nonPeople) expect((await h.send('POST', '/read', identity, { all: true })).status).toBe(403);
    expect(h.calls).toEqual([]);
  });
});

describe('GET and PUT /v1/notifications/preferences', () => {
  test('GET returns every kind and whether email can be sent', async () => {
    const h = inboxApp();
    const res = await h.send('GET', '/preferences', browser);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kinds: DEFAULT_NOTIFICATION_PREFERENCES, email_available: false });
    expect(h.named('loadPreferences')).toEqual([[USER_A]]);
  });

  test('PUT passes the partial patch and returns the saved record', async () => {
    const h = inboxApp();
    const res = await h.send('PUT', '/preferences', browser, { kinds: { question: { push: false } } });
    expect(res.status).toBe(200);
    expect((await res.json()).kinds.question).toEqual({ push: false, email: true });
    expect(h.named('updatePreferences')).toEqual([[USER_A, { kinds: { question: { push: false } } }]]);
  });

  const invalid: [string, unknown][] = [
    ['an unknown kind', { kinds: { everything: { push: false } } }],
    ['an unknown channel', { kinds: { question: { sms: true } } }],
    ['a non-boolean value', { kinds: { question: { push: 'no' } } }],
    ['no kinds', {}],
    ['no body', undefined],
  ];
  for (const [name, body] of invalid) {
    test(`PUT with ${name} → 400 and nothing is saved`, async () => {
      const h = inboxApp();
      expect((await h.send('PUT', '/preferences', browser, body)).status).toBe(400);
      expect(h.named('updatePreferences')).toEqual([]);
    });
  }

  test('a non-person credential → 403', async () => {
    const h = inboxApp();
    for (const [, identity] of nonPeople) {
      expect((await h.send('GET', '/preferences', identity)).status).toBe(403);
      expect((await h.send('PUT', '/preferences', identity, { kinds: {} })).status).toBe(403);
    }
    expect(h.calls).toEqual([]);
  });
});

describe('Web Push routes', () => {
  const subscription = { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH_SECRET }, expirationTime: null };

  test('GET /web-push/key returns the public key', async () => {
    const h = inboxApp();
    const res = await h.send('GET', '/web-push/key', browser);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ public_key: 'BSyntheticPublicKey' });
  });

  test('a browser sign-in registers its subscription, bound to the sign-in and its assurance level', async () => {
    const h = inboxApp();
    expect((await h.send('POST', '/web-push/subscriptions', browser, subscription)).status).toBe(200);
    expect((await h.send('POST', '/web-push/subscriptions', { ...browser, mfaAal: 'aal2' }, subscription)).status).toBe(200);
    expect(h.named('registerWebPush')).toEqual([
      [{ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH_SECRET }, userId: USER_A, authSessionId: SIGN_IN, aal: 'aal1' }],
      [{ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH_SECRET }, userId: USER_A, authSessionId: SIGN_IN, aal: 'aal2' }],
    ]);
  });

  test('a personal token, or a sign-in without a session id, → 403 and nothing is stored', async () => {
    const h = inboxApp();
    expect((await h.send('POST', '/web-push/subscriptions', { userId: USER_A, authType: 'pat' }, subscription)).status).toBe(403);
    expect((await h.send('POST', '/web-push/subscriptions', { userId: USER_A, authType: 'supabase' }, subscription)).status).toBe(403);
    expect((await h.send('POST', '/web-push/subscriptions', { ...browser, sessionId: 'not-a-uuid' }, subscription)).status).toBe(403);
    for (const [, identity] of nonPeople) {
      expect((await h.send('POST', '/web-push/subscriptions', identity, subscription)).status).toBe(403);
    }
    expect(h.named('registerWebPush')).toEqual([]);
  });

  const refused: [string, unknown, string | null][] = [
    ['an internal host', { ...subscription, endpoint: 'https://internal-alb.vpc.local/admin' }, 'unsupported_push_service'],
    ['an IP address', { ...subscription, endpoint: 'https://169.254.169.254/latest' }, 'unsupported_push_service'],
    ['plain http', { ...subscription, endpoint: 'http://fcm.googleapis.com/fcm/send/x' }, 'invalid_endpoint'],
    ['an explicit port', { ...subscription, endpoint: 'https://fcm.googleapis.com:8443/fcm/send/x' }, 'invalid_endpoint'],
    ['a short p256dh key', { ...subscription, keys: { p256dh: AUTH_SECRET, auth: AUTH_SECRET } }, 'invalid_keys'],
    ['an endpoint over 2048 chars', { ...subscription, endpoint: `${ENDPOINT}/${'x'.repeat(2048)}` }, null],
    ['no keys', { endpoint: ENDPOINT }, null],
  ];
  for (const [name, body, code] of refused) {
    test(`${name} → 400${code ? ` ${code}` : ''} and nothing is stored`, async () => {
      const h = inboxApp();
      const res = await h.send('POST', '/web-push/subscriptions', browser, body);
      expect(res.status).toBe(400);
      if (code) expect((await res.json()).code).toBe(code);
      expect(h.named('registerWebPush')).toEqual([]);
    });
  }

  test('DELETE removes the caller\'s endpoint only', async () => {
    const h = inboxApp();
    const res = await h.send('DELETE', `/web-push/subscriptions?endpoint=${encodeURIComponent(ENDPOINT)}`, browser);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(h.named('deleteWebPush')).toEqual([[USER_A, ENDPOINT]]);
  });

  test('DELETE without an endpoint → 400; a non-person → 403', async () => {
    const h = inboxApp();
    expect((await h.send('DELETE', '/web-push/subscriptions', browser)).status).toBe(400);
    for (const [, identity] of nonPeople) {
      expect((await h.send('DELETE', `/web-push/subscriptions?endpoint=${encodeURIComponent(ENDPOINT)}`, identity)).status).toBe(403);
    }
    expect(h.named('deleteWebPush')).toEqual([]);
  });
});

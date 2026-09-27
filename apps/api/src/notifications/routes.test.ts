// Contract of /v1/notifications/device-token with an in-memory store and a
// stub auth middleware (DI, no mock.module). SQL behavior is proven in
// device-tokens.integration.test.ts.
import { describe, expect, test } from 'bun:test';
import type { MiddlewareHandler } from 'hono';
import type { PushDeviceTokenRow, PushDeviceTokenStore, UpsertDeviceTokenInput } from './device-tokens';
import { createNotificationsApp } from './routes';

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

type Identity = { userId?: string; authType?: string; sessionId?: string } | null;

function appFor(store: PushDeviceTokenStore) {
  const authMiddleware: MiddlewareHandler = async (c, next) => {
    const raw = c.req.header('x-test-identity');
    const identity = raw ? (JSON.parse(raw) as Identity) : null;
    if (!identity) return c.json({ error: true, message: 'Unauthorized', status: 401 }, 401);
    if (identity.userId) c.set('userId', identity.userId);
    if (identity.authType) c.set('authType', identity.authType);
    if (identity.sessionId) c.set('sessionId', identity.sessionId);
    await next();
  };
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
      { token: TOKEN, userId: USER_A, platform: 'ios', provider: 'expo', preferences: undefined },
    ]);
    expect(rows.get(TOKEN)).toMatchObject({ userId: USER_A, enabled: true, playSound: true });
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

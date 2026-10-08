/**
 * Mobile push notification device tokens. Maps to spec §4 "Push notification
 * device tokens" (PUSH-1). Needs OWNER + NONMEMBER principals (two distinct
 * users). Tokens are synthetic, run-scoped Expo-shaped strings; the flow
 * deletes every token it registers.
 */
import { flow } from '../core/flow';
import { PASSWORD } from '../fixtures/principals';

flow(
  'PUSH-1',
  {
    domain: 'notifications',
    tags: ['smoke'],
    routes: ['POST /v1/notifications/device-token', 'DELETE /v1/notifications/device-token/:token'],
  },
  async (ctx) => {
    // Brackets and a slash: the mobile client URL-encodes the token in the path.
    const token = `ExponentPushToken[${ctx.fixtures.name('push')}/a+b]`;
    const register = { device_token: token, device_type: 'ios', provider: 'expo' };
    const del = (who: typeof ctx.P.OWNER) =>
      ctx.client.as(who).del('/v1/notifications/device-token/:token', { params: { token } });

    try {
      await ctx.step('ANON cannot register a device token → 401', async () => {
        const r = await ctx.client.as(ctx.P.ANON).post('/v1/notifications/device-token', register);
        r.status(401);
      });

      await ctx.step('OWNER registers the token with the body the mobile app sends → 200', async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post('/v1/notifications/device-token', register);
        r.status(200).body().has('$.success', true).exists('$.message');
      });

      await ctx.step('OWNER re-registers the same token with preferences → 200 (upsert, no conflict)', async () => {
        const r = await ctx.client.as(ctx.P.OWNER).post('/v1/notifications/device-token', {
          ...register,
          preferences: {
            enabled: true,
            on_completion: true,
            on_error: false,
            on_question: true,
            on_permission: true,
            play_sound: false,
          },
        });
        r.status(200).body().has('$.success', true);
      });

      await ctx.step('an invalid body is rejected → 400 for each malformed field', async () => {
        const bad = [
          { ...register, device_token: '' },
          { ...register, device_token: 'x'.repeat(513) },
          { ...register, device_type: 'web' },
          { ...register, provider: 'fcm' },
          { ...register, preferences: { enabled: 'yes' } },
        ];
        for (const body of bad) {
          const r = await ctx.client.as(ctx.P.OWNER).post('/v1/notifications/device-token', body);
          r.status(400);
        }
      });

      await ctx.step("NONMEMBER deleting OWNER's token → 200 with deleted=false; the token survives", async () => {
        const r = await del(ctx.P.NONMEMBER);
        r.status(200).body().has('$.success', true).has('$.deleted', false);
      });

      await ctx.step('OWNER deletes the URL-encoded token → 200 with deleted=true (proves it survived)', async () => {
        const r = await del(ctx.P.OWNER);
        r.status(200).body().has('$.success', true).has('$.deleted', true);
      });

      await ctx.step('a repeated delete is idempotent → 200 with deleted=false', async () => {
        const r = await del(ctx.P.OWNER);
        r.status(200).body().has('$.success', true).has('$.deleted', false);
      });

      await ctx.step('NONMEMBER registers the same token → it moves to NONMEMBER', async () => {
        await ctx.client.as(ctx.P.OWNER).post('/v1/notifications/device-token', register).then((r) => r.status(200));
        const r = await ctx.client.as(ctx.P.NONMEMBER).post('/v1/notifications/device-token', register);
        r.status(200);
        const ownerDelete = await del(ctx.P.OWNER);
        ownerDelete.status(200).body().has('$.deleted', false);
        const nonmemberDelete = await del(ctx.P.NONMEMBER);
        nonmemberDelete.status(200).body().has('$.deleted', true);
      });

      await ctx.step('ANON cannot delete a device token → 401', async () => {
        const r = await del(ctx.P.ANON);
        r.status(401);
      });
    } finally {
      // Cleanup: whichever principal still owns the token removes it.
      await del(ctx.P.OWNER).catch(() => undefined);
      await del(ctx.P.NONMEMBER).catch(() => undefined);
    }
  },
);

// KRTX-1722: a phone signed out from Settings > Security kept its push token,
// so its lock screen kept showing session titles and agent questions. A
// device sign-out now drops the token that sign-in registered, and only it.
flow(
  'PUSH-2',
  {
    domain: 'notifications',
    routes: [
      'POST /v1/notifications/device-token',
      'DELETE /v1/notifications/device-token/:token',
      'GET /v1/accounts/me/devices',
      'DELETE /v1/accounts/me/devices/:sessionId',
    ],
  },
  async (ctx) => {
    const here = await ctx.fixtures.user({ label: 'PUSHSIGNOUT' });
    const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
    const phoneToken = `ExponentPushToken[${ctx.fixtures.name('push-phone')}]`;
    const ownToken = `ExponentPushToken[${ctx.fixtures.name('push-own')}]`;
    const del = (token: string) =>
      ctx.client.as(here).del('/v1/notifications/device-token/:token', { params: { token } });
    const phone = { access: '', id: '' };

    try {
      await ctx.step('a second sign-in (the phone) registers its push token; the caller registers its own', async () => {
        const signIn = await ctx.client.as(ctx.P.ANON).post('/v1/auth/sign-in/password', {
          email: here.email,
          password: PASSWORD,
        });
        signIn.status(200);
        phone.access = signIn.json<any>().session.access_token;
        const devices = await ctx.client.as(here).get('/v1/accounts/me/devices');
        devices.status(200);
        phone.id = (devices.json<any>().devices as Array<{ session_id: string; current: boolean }>).find(
          (d) => !d.current,
        )!.session_id;
        const register = (device_token: string) => ({ device_token, device_type: 'ios', provider: 'expo' });
        (await ctx.client.as(ctx.P.ANON).post('/v1/notifications/device-token', register(phoneToken), bearer(phone.access)))
          .status(200)
          .body()
          .has('$.success', true);
        (await ctx.client.as(here).post('/v1/notifications/device-token', register(ownToken))).status(200);
      });

      await ctx.step("signing the phone out drops the phone's token: a delete finds nothing (deleted=false)", async () => {
        (await ctx.client.as(here).del(`/v1/accounts/me/devices/${phone.id}`)).status(200).body().has('$.ok', true);
        (await del(phoneToken)).status(200).body().has('$.deleted', false);
      });

      await ctx.step("the caller's own token survives the phone's sign-out (deleted=true)", async () => {
        (await del(ownToken)).status(200).body().has('$.deleted', true);
      });
    } finally {
      await del(phoneToken).catch(() => undefined);
      await del(ownToken).catch(() => undefined);
    }
  },
);

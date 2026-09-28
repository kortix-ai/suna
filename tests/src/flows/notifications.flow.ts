/**
 * Mobile push notification device tokens. Maps to spec §4 "Push notification
 * device tokens" (PUSH-1). Needs OWNER + NONMEMBER principals (two distinct
 * users). Tokens are synthetic, run-scoped Expo-shaped strings; the flow
 * deletes every token it registers.
 */
import { flow } from '../core/flow';

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

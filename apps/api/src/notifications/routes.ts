// /v1/notifications — the mobile app registers and removes its Expo push
// device token here, with per-device notification preferences.
import { createRoute, z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { supabaseAuth } from '../middleware/auth';
import { pushDeviceTokenStore, type PushDeviceTokenStore } from './device-tokens';

// Expo tokens look like `ExponentPushToken[...]` (~41 chars). 512 bounds the row.
const DeviceToken = z.string().trim().min(1).max(512);

const PreferencesSchema = z
  .object({
    enabled: z.boolean().optional(),
    on_completion: z.boolean().optional(),
    on_error: z.boolean().optional(),
    on_question: z.boolean().optional(),
    on_permission: z.boolean().optional(),
    play_sound: z.boolean().optional(),
  })
  .strict()
  .openapi('PushNotificationPreferences');

const RegisterBodySchema = z
  .object({
    device_token: DeviceToken,
    device_type: z.enum(['ios', 'android']),
    provider: z.literal('expo').optional().default('expo'),
    preferences: PreferencesSchema.optional(),
  })
  .openapi('RegisterDeviceTokenRequest');

const RegisterResponseSchema = z
  .object({ success: z.literal(true), message: z.string() })
  .openapi('RegisterDeviceTokenResponse');

const DeleteResponseSchema = z
  .object({
    success: z.literal(true),
    // False when the token is unknown OR belongs to another user; the two are
    // indistinguishable on purpose.
    deleted: z.boolean(),
  })
  .openapi('DeleteDeviceTokenResponse');

type NotificationsContext = Context<AppEnv>;

/**
 * Only a human's own credential may bind a device: a browser/app session JWT
 * or a personal CLI token. Service accounts carry a synthetic user id, and a
 * session-scoped PAT belongs to an agent inside a sandbox.
 */
function deviceOwner(c: NotificationsContext): string | Response {
  const authType = c.get('authType');
  const userId = c.get('userId');
  const humanCredential = authType === 'supabase' || (authType === 'pat' && !c.get('sessionId'));
  if (!humanCredential || !userId) {
    return c.json(
      { error: true, message: 'Device tokens require a signed-in user', status: 403 },
      403,
    );
  }
  return userId;
}

export interface NotificationsAppDeps {
  store?: PushDeviceTokenStore;
  authMiddleware?: MiddlewareHandler;
}

export function createNotificationsApp(deps: NotificationsAppDeps = {}) {
  const store = () => deps.store ?? pushDeviceTokenStore();
  const app = makeOpenApiApp<AppEnv>();
  app.use('*', deps.authMiddleware ?? supabaseAuth);

  app.openapi(
    createRoute({
      method: 'post',
      path: '/device-token',
      tags: ['notifications'],
      summary: 'Register this device for push notifications',
      description:
        'Upserts the device token for the caller. A token registered by another user moves to the caller. ' +
        'Omitted preference keys keep their stored value (true for a new token).',
      ...auth,
      request: {
        body: { required: true, content: { 'application/json': { schema: RegisterBodySchema } } },
      },
      responses: {
        200: json(RegisterResponseSchema, 'Device token registered'),
        ...errors(400, 401, 403),
      },
    }),
    async (c: any) => {
      const owner = deviceOwner(c);
      if (owner instanceof Response) return owner;
      const body = c.req.valid('json') as z.infer<typeof RegisterBodySchema>;
      const p = body.preferences;
      await store().upsert({
        token: body.device_token,
        userId: owner,
        platform: body.device_type,
        provider: body.provider,
        preferences: p && {
          enabled: p.enabled,
          onCompletion: p.on_completion,
          onError: p.on_error,
          onQuestion: p.on_question,
          onPermission: p.on_permission,
          playSound: p.play_sound,
        },
      });
      return c.json({ success: true, message: 'Device token registered' }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/device-token/{token}',
      tags: ['notifications'],
      summary: 'Unregister a push device token',
      description:
        "Deletes the token only when the caller owns it. Idempotent: an unknown token or another user's token returns 200 with deleted=false.",
      ...auth,
      request: { params: z.object({ token: DeviceToken }) },
      responses: {
        200: json(DeleteResponseSchema, 'Device token removed or already absent'),
        ...errors(400, 401, 403),
      },
    }),
    async (c: any) => {
      const owner = deviceOwner(c);
      if (owner instanceof Response) return owner;
      const { token } = c.req.valid('param') as { token: string };
      const deleted = await store().deleteForUser(token, owner);
      return c.json({ success: true, deleted }, 200);
    },
  );

  return app;
}

export const notificationsApp = createNotificationsApp();

// /v1/notifications — a person's notifications (KRTX-1742): the inbox the bell
// and the mobile app read, per-kind preferences, browser Web Push
// subscriptions, and the mobile app's Expo push device tokens with their
// per-device preferences.
import { createRoute, z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { NOTIFICATION_KINDS, type NotificationKindName, type NotificationKindPreferences } from '@kortix/shared/notification-kinds';
import type { AppEnv } from '../types';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { supabaseAuth } from '../middleware/auth';
import { isUuid } from '../shared/validate';
import { pushDeviceTokenStore, type PushDeviceTokenStore } from './device-tokens';
import { isNotificationEmailAvailable } from './email-delivery';
import { listInbox, markInboxRead, type InboxReadContext } from './inbox-read';
import { loadEffectivePreferences, updateNotificationPreferences, type NotificationPreferencesPatch } from './preferences';
import { getVapidPublicKey } from './vapid-keys';
import {
  deleteWebPushSubscription,
  registerWebPushSubscription,
  validateWebPushSubscriptionInput,
  WEB_PUSH_ENDPOINT_MAX_CHARS,
} from './web-push-subscriptions';

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

const KindSchema = z.enum(NOTIFICATION_KINDS);

const InboxNotificationSchema = z
  .object({
    id: z.string().uuid(),
    kind: KindSchema,
    title: z.string().openapi({ description: 'The session title (live when the session exists) or the automation name.' }),
    body: z.string().openapi({ description: 'Detail: the question text or the error. May be empty.' }),
    project_id: z.string().uuid().nullable(),
    project_name: z.string().nullable(),
    session_id: z.string().nullable(),
    trigger_slug: z.string().nullable(),
    actor_user_id: z.string().uuid().nullable().openapi({ description: 'Who caused it: the sharer or the prompter.' }),
    url: z.string().openapi({ description: 'Web path that opens the subject and marks the row read.' }),
    read: z.boolean(),
    created_at: z.string(),
  })
  .openapi('InboxNotification');

const InboxPageSchema = z
  .object({
    notifications: z.array(InboxNotificationSchema),
    unread_count: z.number().int().openapi({ description: 'Unread rows among the newest 100 unread ones. Show 99+ above 99.' }),
    next_before: z.string().uuid().nullable().openapi({ description: 'Pass as `before` for the next page; null on the last page.' }),
  })
  .openapi('InboxNotificationPage');

const InboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20).openapi({ description: 'Rows per page, 1 to 50. Default 20.' }),
  before: z.string().uuid().optional().openapi({ description: 'A notification id: return only older rows.' }),
});

const MarkReadBodySchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(100).optional().openapi({ description: 'Mark these rows read (1 to 100).' }),
    all: z.literal(true).optional().openapi({ description: 'Mark every row read.' }),
    session_id: z.string().min(1).max(128).optional().openapi({ description: "Mark this session's rows read." }),
  })
  .strict()
  .refine((body) => [body.ids, body.all, body.session_id].filter((value) => value !== undefined).length === 1, {
    message: 'Send exactly one of ids, all, session_id',
  })
  .openapi('MarkNotificationsReadRequest');

const MarkReadResponseSchema = z
  .object({ updated: z.number().int(), unread_count: z.number().int() })
  .openapi('MarkNotificationsReadResponse');

const ChannelSchema = z.object({ push: z.boolean(), email: z.boolean() });
const ChannelPatchSchema = z.object({ push: z.boolean().optional(), email: z.boolean().optional() }).strict();

const NotificationPreferencesSchema = z
  .object({
    kinds: z.object(Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, ChannelSchema]))),
    email_available: z.boolean().openapi({ description: 'False when this deployment cannot send email: hide the email switches.' }),
  })
  .openapi('NotificationPreferences');

const NotificationPreferencesPatchSchema = z
  .object({
    kinds: z
      .object(Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, ChannelPatchSchema.optional()])))
      .strict()
      .openapi({ description: 'Per kind, the channels to change. Omitted kinds and channels keep their value.' }),
  })
  .strict()
  .openapi('NotificationPreferencesPatch');

const WebPushKeySchema = z
  .object({ public_key: z.string().openapi({ description: 'VAPID application server key, base64url.' }) })
  .openapi('WebPushPublicKey');

const WebPushSubscriptionBodySchema = z
  .object({
    endpoint: z.string().min(1).max(WEB_PUSH_ENDPOINT_MAX_CHARS).openapi({ description: "The browser's PushSubscription endpoint (https, a known push service)." }),
    keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
  })
  .openapi('WebPushSubscriptionRequest');

const OkSchema = z.object({ ok: z.literal(true) });
const DeletedSchema = z.object({ deleted: z.boolean() });

/**
 * Only a human's own credential may read the inbox or bind a device: a
 * browser/app session JWT or a personal CLI token. Service accounts carry a
 * synthetic user id, and a session-scoped PAT belongs to an agent inside a
 * sandbox.
 */
function humanCaller(c: Context<AppEnv>): string | null {
  const authType = c.get('authType');
  const userId = c.get('userId');
  const humanCredential = authType === 'supabase' || (authType === 'pat' && !c.get('sessionId'));
  return humanCredential && userId ? userId : null;
}

const NOT_A_PERSON = { error: true, message: 'Notifications require a signed-in user', status: 403 } as const;

function deviceOwner(c: Context<AppEnv>): string | Response {
  return humanCaller(c) ?? c.json({ error: true, message: 'Device tokens require a signed-in user', status: 403 }, 403);
}

/** The sign-in this device holds (a JWT's `session_id`): a push goes only while it exists. */
function signInOf(c: Context<AppEnv>): string | null {
  const sessionId = c.get('sessionId');
  return c.get('authType') === 'supabase' && isUuid(sessionId) ? sessionId : null;
}

/** The sign-in's MFA state, for the account MFA step-up the inbox applies. */
function readContextOf(c: Context): InboxReadContext {
  return { iamTokenId: (c.get('iamTokenId') as string | undefined) ?? null, mfaAal: (c.get('mfaAal') as string | undefined) ?? null };
}

/** What the routes call; tests replace them (DI, no mock.module). */
export interface NotificationServices {
  listInbox: typeof listInbox;
  markInboxRead: typeof markInboxRead;
  loadPreferences(userId: string): Promise<NotificationKindPreferences>;
  updatePreferences(userId: string, patch: NotificationPreferencesPatch): Promise<NotificationKindPreferences>;
  emailAvailable(): boolean;
  vapidPublicKey(): Promise<string>;
  validateWebPush: typeof validateWebPushSubscriptionInput;
  registerWebPush(input: Parameters<typeof registerWebPushSubscription>[0]): Promise<void>;
  deleteWebPush(userId: string, endpoint: string): Promise<boolean>;
}

const LIVE_SERVICES: NotificationServices = {
  listInbox,
  markInboxRead,
  loadPreferences: async (userId) => (await loadEffectivePreferences([userId])).get(userId)!,
  updatePreferences: (userId, patch) => updateNotificationPreferences(userId, patch),
  emailAvailable: isNotificationEmailAvailable,
  vapidPublicKey: getVapidPublicKey,
  validateWebPush: validateWebPushSubscriptionInput,
  registerWebPush: (input) => registerWebPushSubscription(input),
  deleteWebPush: (userId, endpoint) => deleteWebPushSubscription(userId, endpoint),
};

export interface NotificationsAppDeps {
  store?: PushDeviceTokenStore;
  authMiddleware?: MiddlewareHandler;
  services?: Partial<NotificationServices>;
}

export function createNotificationsApp(deps: NotificationsAppDeps = {}) {
  const store = () => deps.store ?? pushDeviceTokenStore();
  const services: NotificationServices = { ...LIVE_SERVICES, ...deps.services };
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
        authSessionId: signInOf(c),
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

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['notifications'],
      summary: 'List your notifications, newest first',
      description:
        'One page of the caller\'s inbox and the unread count. A row whose session, project or account the caller can no longer open is left out.',
      ...auth,
      request: { query: InboxQuerySchema },
      responses: {
        200: json(InboxPageSchema, 'One page of notifications'),
        ...errors(400, 401, 403),
      },
    }),
    async (c) => {
      const owner = humanCaller(c);
      if (!owner) return c.json(NOT_A_PERSON, 403);
      const { limit, before } = c.req.valid('query');
      return c.json(await services.listInbox(owner, { limit, before }, readContextOf(c)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/read',
      tags: ['notifications'],
      summary: 'Mark notifications as read',
      description: 'Send exactly one of `ids`, `all` or `session_id`. Only the caller\'s own rows change.',
      ...auth,
      request: { body: { required: true, content: { 'application/json': { schema: MarkReadBodySchema } } } },
      responses: {
        200: json(MarkReadResponseSchema, 'Rows marked read and the new unread count'),
        ...errors(400, 401, 403),
      },
    }),
    async (c) => {
      const owner = humanCaller(c);
      if (!owner) return c.json(NOT_A_PERSON, 403);
      const body = c.req.valid('json');
      const target = body.ids ? { ids: body.ids } : body.session_id ? { sessionId: body.session_id } : { all: true as const };
      return c.json(await services.markInboxRead(owner, target, readContextOf(c)), 200);
    },
  );

  const preferencesResponse = async (userId: string, kinds?: NotificationKindPreferences) => ({
    kinds: kinds ?? (await services.loadPreferences(userId)),
    email_available: services.emailAvailable(),
  });

  app.openapi(
    createRoute({
      method: 'get',
      path: '/preferences',
      tags: ['notifications'],
      summary: 'Read your notification preferences',
      description: 'Push and email on or off for each notification kind, with the defaults filled in.',
      ...auth,
      responses: {
        200: json(NotificationPreferencesSchema, 'Effective preferences'),
        ...errors(401, 403),
      },
    }),
    async (c) => {
      const owner = humanCaller(c);
      if (!owner) return c.json(NOT_A_PERSON, 403);
      return c.json(await preferencesResponse(owner), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/preferences',
      tags: ['notifications'],
      summary: 'Change your notification preferences',
      description: 'Sets push or email for the kinds named; every other kind and channel keeps its value.',
      ...auth,
      request: { body: { required: true, content: { 'application/json': { schema: NotificationPreferencesPatchSchema } } } },
      responses: {
        200: json(NotificationPreferencesSchema, 'Effective preferences after the change'),
        ...errors(400, 401, 403),
      },
    }),
    async (c) => {
      const owner = humanCaller(c);
      if (!owner) return c.json(NOT_A_PERSON, 403);
      const { kinds } = c.req.valid('json');
      const saved = await services.updatePreferences(owner, { kinds: kinds as Partial<Record<NotificationKindName, { push?: boolean; email?: boolean }>> });
      return c.json(await preferencesResponse(owner, saved), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/web-push/key',
      tags: ['notifications'],
      summary: 'Get the Web Push public key',
      description: 'The VAPID application server key a browser subscribes with.',
      ...auth,
      responses: {
        200: json(WebPushKeySchema, 'The public key'),
        ...errors(401, 403),
      },
    }),
    async (c) => {
      const owner = humanCaller(c);
      if (!owner) return c.json(NOT_A_PERSON, 403);
      return c.json({ public_key: await services.vapidPublicKey() }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/web-push/subscriptions',
      tags: ['notifications'],
      summary: 'Register this browser for push notifications',
      description:
        'Stores the browser\'s Web Push subscription for the caller, bound to this sign-in. Only a browser sign-in may call it. ' +
        'The endpoint must be https on a known push service (400 `unsupported_push_service` otherwise). At most 10 per user; the oldest goes.',
      ...auth,
      request: { body: { required: true, content: { 'application/json': { schema: WebPushSubscriptionBodySchema } } } },
      responses: {
        200: json(OkSchema, 'Subscription stored'),
        ...errors(400, 401, 403),
      },
    }),
    async (c) => {
      const owner = humanCaller(c);
      if (!owner) return c.json(NOT_A_PERSON, 403);
      const signIn = signInOf(c);
      if (!signIn) {
        return c.json({ error: true, message: 'Browser push requires a browser sign-in', status: 403 }, 403);
      }
      const body = c.req.valid('json');
      const input = { endpoint: body.endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } };
      const valid = services.validateWebPush(input);
      if (!valid.ok) {
        const message = valid.error === 'unsupported_push_service' ? 'This push service is not supported' : 'Invalid push subscription';
        return c.json({ error: true, message, code: valid.error, status: 400 }, 400);
      }
      const aal = readContextOf(c).mfaAal === 'aal2' ? 'aal2' : 'aal1';
      await services.registerWebPush({ ...input, userId: owner, authSessionId: signIn, aal });
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/web-push/subscriptions',
      tags: ['notifications'],
      summary: 'Unregister a browser push subscription',
      description: "Deletes the caller's subscription for this endpoint. Another user's endpoint or an unknown one returns deleted=false.",
      ...auth,
      request: { query: z.object({ endpoint: z.string().min(1).max(WEB_PUSH_ENDPOINT_MAX_CHARS) }) },
      responses: {
        200: json(DeletedSchema, 'Subscription removed or already absent'),
        ...errors(400, 401, 403),
      },
    }),
    async (c) => {
      const owner = humanCaller(c);
      if (!owner) return c.json(NOT_A_PERSON, 403);
      const { endpoint } = c.req.valid('query');
      return c.json({ deleted: await services.deleteWebPush(owner, endpoint) }, 200);
    },
  );

  return app;
}

export const notificationsApp = createNotificationsApp();

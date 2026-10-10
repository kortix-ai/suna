// Notifications — `/v1/notifications/*` (apps/api/src/notifications/routes.ts).
// A native app registers its push device token and per-device preferences.
// Every signed-in person has one inbox, one preference record (push and email
// per kind), and Web Push subscriptions for their browsers (KRTX-1742).

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** Per-device push preferences. An omitted key keeps its stored value (true for a new token). */
export interface PushNotificationPreferences {
  enabled?: boolean;
  on_completion?: boolean;
  on_error?: boolean;
  on_question?: boolean;
  on_permission?: boolean;
  play_sound?: boolean;
}

export interface RegisterDeviceTokenInput {
  device_token: string;
  device_type: 'ios' | 'android';
  /** Defaults to `expo` on the server. */
  provider?: 'expo';
  preferences?: PushNotificationPreferences;
}

/**
 * Register this device for push notifications. Idempotent upsert: a token
 * registered by another user moves to the caller. Needs a human credential
 * (session JWT or personal token); a service account gets 403.
 */
export async function registerDeviceToken(input: RegisterDeviceTokenInput) {
  return unwrap(
    await backendApi.post<{ success: true; message: string }>('/notifications/device-token', input),
  );
}

/**
 * Unregister a push device token. Idempotent: `deleted` is false for an unknown
 * token or another user's token. `signal` aborts the request.
 */
export async function unregisterDeviceToken(deviceToken: string, options?: { signal?: AbortSignal }) {
  return unwrap(
    await backendApi.delete<{ success: true; deleted: boolean }>(
      `/notifications/device-token/${encodeURIComponent(deviceToken)}`,
      { signal: options?.signal },
    ),
  );
}

// ── Inbox (KRTX-1742) ───────────────────────────────────────────────────────

/**
 * Every kind of inbox notification, in display order. Held equal to the
 * server's list by a parity test (`notifications.test.ts`).
 */
export const INBOX_NOTIFICATION_KINDS = [
  'turn_done',
  'turn_error',
  'question',
  'permission',
  'shared',
  'automation_failed',
  'automation_recovered',
] as const;

/**
 * What a notification is about: a turn ended (`turn_done`, `turn_error`), the
 * agent asks (`question`, `permission`), a session was shared with you
 * (`shared`), or an automation fails or works again.
 */
export type InboxNotificationKind = (typeof INBOX_NOTIFICATION_KINDS)[number];

/** One notification in the caller's inbox. */
export interface InboxNotification {
  /** Time-ordered (uuid v7): the newest id is the newest row. */
  id: string;
  kind: InboxNotificationKind;
  /** The subject: the session title (live when the session exists) or the automation name. */
  title: string;
  /** The detail: the question text, the error, the share line. May be empty. */
  body: string;
  project_id: string | null;
  project_name: string | null;
  session_id: string | null;
  /** The automation, for the two automation kinds. */
  trigger_slug: string | null;
  /** Who caused it: the person who shared or prompted. */
  actor_user_id: string | null;
  /** The web path that opens the subject; its `?notification=<id>` marks the row read. */
  url: string;
  read: boolean;
  created_at: string;
}

/** One page of the inbox, newest first. */
export interface InboxNotificationPage {
  notifications: InboxNotification[];
  /** Unread rows the caller may still see, counted over the newest 100 (show `99+` above 99). */
  unread_count: number;
  /** Pass as `before` for the next page; `null` on the last page. */
  next_before: string | null;
}

/**
 * The caller's newest notifications. Rows the caller can no longer see (a
 * revoked share, a lost project) are left out. A failed read does not call
 * the host's error handler: a host polls this.
 */
export async function listNotifications(
  params: { limit?: number; before?: string } = {},
  options?: { signal?: AbortSignal },
) {
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.before) query.set('before', params.before);
  const search = query.toString();
  return unwrap(
    await backendApi.get<InboxNotificationPage>(`/notifications${search ? `?${search}` : ''}`, {
      showErrors: false,
      signal: options?.signal,
    }),
  );
}

/**
 * Mark rows read: the given ids (1 to 100), every row, or every row of one
 * session. Only the caller's own rows change; an id of another user's row is
 * ignored. Returns how many rows changed and the new unread count.
 */
export async function markNotificationsRead(
  input: { ids: string[] } | { all: true } | { sessionId: string },
) {
  const body = 'ids' in input ? { ids: input.ids } : 'all' in input ? { all: true } : { session_id: input.sessionId };
  return unwrap(
    await backendApi.post<{ updated: number; unread_count: number }>('/notifications/read', body),
  );
}

// ── Preferences (KRTX-1742) ─────────────────────────────────────────────────

/**
 * The caller's notification preferences: per kind, whether to push (phone and
 * browser) and whether to email. The inbox row is always written.
 */
export interface NotificationPreferences {
  kinds: Record<InboxNotificationKind, { push: boolean; email: boolean }>;
  /** False when this deployment sends no email: hide the email choices. */
  email_available: boolean;
}

/** A partial update: only the kinds and channels named change. */
export interface NotificationPreferencesPatch {
  kinds: Partial<Record<InboxNotificationKind, Partial<{ push: boolean; email: boolean }>>>;
}

/** The record of a user who never saved one. Held equal to the server's defaults by a parity test. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences['kinds'] = {
  turn_done: { push: true, email: false },
  turn_error: { push: true, email: true },
  question: { push: true, email: true },
  permission: { push: true, email: false },
  shared: { push: true, email: true },
  automation_failed: { push: true, email: true },
  automation_recovered: { push: true, email: false },
};

/** The caller's effective preferences (the defaults with their saved choices applied). */
export async function getNotificationPreferences() {
  return unwrap(
    await backendApi.get<NotificationPreferences>('/notifications/preferences', { showErrors: false }),
  );
}

/** Save some choices; returns the effective record. Concurrent saves of different kinds both apply. */
export async function updateNotificationPreferences(patch: NotificationPreferencesPatch) {
  return unwrap(await backendApi.put<NotificationPreferences>('/notifications/preferences', patch));
}

// ── Web Push (KRTX-1742) ────────────────────────────────────────────────────

/**
 * A browser push subscription, read from `PushSubscription.toJSON()`
 * (`endpoint`, `keys.p256dh`, `keys.auth`). Only these three are sent.
 */
export interface WebPushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The server's VAPID public key: pass it as `applicationServerKey` to `pushManager.subscribe`. */
export async function getWebPushPublicKey() {
  // Web Push sync runs in the background: a failure is the host's to log, never a toast.
  return unwrap(await backendApi.get<{ public_key: string }>('/notifications/web-push/key', { showErrors: false }));
}

/**
 * Deliver the caller's notifications to this browser. Needs a browser
 * sign-in: a personal token or a service account gets 403. An endpoint on an
 * unknown push service gets 400. Registering an endpoint again moves it to
 * the caller.
 */
export async function registerWebPushSubscription(subscription: WebPushSubscriptionInput) {
  const body = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
  };
  return unwrap(await backendApi.post<{ ok: true }>('/notifications/web-push/subscriptions', body, { showErrors: false }));
}

/**
 * Stop Web Push to this browser. Idempotent: `deleted` is false for an
 * unknown endpoint or another user's. `signal` aborts the request.
 */
export async function unregisterWebPushSubscription(endpoint: string, options?: { signal?: AbortSignal }) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(
      `/notifications/web-push/subscriptions?endpoint=${encodeURIComponent(endpoint)}`,
      { signal: options?.signal, showErrors: false },
    ),
  );
}

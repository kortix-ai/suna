// Push notifications — `/v1/notifications/device-token` (apps/api/src/notifications/routes.ts).
// A native app registers its push device token and per-device preferences.

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

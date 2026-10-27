/**
 * Device registration for remote push: OS permission, the Expo push token,
 * and the server's device-token rows (`@kortix/sdk` `registerDeviceToken`).
 *
 * - `syncPushRegistration()`: signed in and permission already granted →
 *   register the token with the current preferences. Never asks.
 * - `requestPushPermissionOnce()`: after the first successful send. Asks the
 *   OS once per install, then registers on grant.
 * - `syncPushPreferences()`: re-posts preferences after a toggle.
 * - `carryOverLegacyKinds()`: copies the kinds this phone turned off into the
 *   user's record, once. Only for a user with a `notification_center`
 *   project (KRTX-1742); the device row keeps this phone's switches.
 * - `unregisterPushOnSignOut()`: deletes this device's row before the auth
 *   session is cleared. Bounded, never throws. A failure records the row as
 *   `pendingRelease` (stores/push-store.ts).
 * - `flushPendingRelease()`: removes a recorded row without a credential
 *   (`@kortix/sdk` `releaseDeviceToken`), KRTX-2242.
 *
 * Remote push does not exist in Expo Go on Android (SDK 53+: token calls
 * throw). There, every function here is a no-op.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { isRunningInExpoGo } from 'expo';
import { log } from '@/lib/logger';
import {
  registerDeviceToken,
  releaseDeviceToken,
  unregisterDeviceToken,
  updateNotificationPreferences,
} from '@kortix/sdk';
import { API_URL } from '@/api/config';
import {
  legacyKindPatch,
  serverPreferences,
  SIGN_OUT_UNREGISTER_TIMEOUT_MS,
  type ServerPreferences,
} from '@/lib/notifications/push';
import { withDeadline } from '@/lib/utils/with-deadline';
import { useNotificationStore } from '@/stores/notification-store';
import { usePushStore } from '@/stores/push-store';

type NotificationsModule = typeof import('expo-notifications');

let notificationsModule: NotificationsModule | null | undefined;

/** expo-notifications, or null when its native module is missing. */
export function getNotifications(): NotificationsModule | null {
  if (notificationsModule === undefined) {
    try {
      notificationsModule = require('expo-notifications') as NotificationsModule;
    } catch (error) {
      log.warn('[PUSH] expo-notifications not available:', error);
      notificationsModule = null;
    }
  }
  return notificationsModule;
}

function isPhysicalDevice(): boolean {
  try {
    const Device = require('expo-device') as typeof import('expo-device');
    return Device.isDevice === true;
  } catch {
    return false;
  }
}

/** Remote push can work here: a real device, not Expo Go on Android, not web. */
export function remotePushSupported(): boolean {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  if (Platform.OS === 'android' && isRunningInExpoGo()) return false;
  if (!getNotifications()) return false;
  return isPhysicalDevice();
}

async function permissionGranted(Notifications: NotificationsModule): Promise<boolean> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    return status === 'granted';
  } catch (error) {
    log.warn('[PUSH] Permission check failed:', error);
    return false;
  }
}

async function fetchExpoPushToken(Notifications: NotificationsModule): Promise<string | null> {
  const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
  if (!projectId) {
    log.warn('[PUSH] No EAS project id: no push token');
    return null;
  }
  try {
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch (error) {
    log.warn('[PUSH] Push token unavailable:', error);
    return null;
  }
}

let syncInFlight: Promise<string | null> | null = null;
/** `<token>|<preferences JSON>` last accepted by the server, to skip repeats. */
let lastPosted: string | null = null;
/**
 * A register succeeded since the last `beginPushSignIn()`. The persisted token
 * survives sign-out, so it cannot tell whether this sign-in has a row yet.
 * Sign-out leaves it as is: until the bridge sees the sign-out, a resume must
 * not re-register the outgoing user's row after its DELETE.
 */
let registeredThisSignIn = false;
/**
 * Set by `unregisterPushOnSignOut()`, cleared by `beginPushSignIn()`. While
 * set, no register posts: the outgoing user's JWT still works, and a POST
 * after the DELETE re-binds the row to them (KRTX-2242).
 */
let signingOut = false;

/** True once a register succeeded for the current sign-in. */
export function registeredForThisSignIn(): boolean {
  return registeredThisSignIn;
}

/** Starts a sign-in: no register has succeeded for it yet. */
export function beginPushSignIn(): void {
  signingOut = false;
  registeredThisSignIn = false;
}

function postedKey(token: string, prefs: ReturnType<typeof serverPreferences>): string {
  return `${token}|${JSON.stringify(prefs)}`;
}

let carryOverInFlight: Promise<void> | null = null;

/**
 * Copies the kinds this phone turned off into the user's record, once
 * (KRTX-1742). A project with `notification_center` on pushes a session kind
 * only when the record AND this phone's switch allow it, so the record then
 * holds this phone's choice on every device and Web Push. Called when such a
 * project opens and from Settings → Notifications in that mode; a user with
 * no such project sends no write. Waits for the stored switches to load. A
 * failure leaves the marker off, and the next call tries again.
 */
export function carryOverLegacyKinds(): Promise<void> {
  if (!carryOverInFlight) {
    carryOverInFlight = runCarryOver().finally(() => {
      carryOverInFlight = null;
    });
  }
  return carryOverInFlight;
}

/** Resolves once `store` has read its persisted state. */
async function hydrated(store: {
  persist: { hasHydrated: () => boolean; onFinishHydration: (fn: () => void) => () => void };
}): Promise<void> {
  if (store.persist.hasHydrated()) return;
  await new Promise<void>((resolve) => {
    const unsubscribe = store.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
}

async function runCarryOver(): Promise<void> {
  const store = useNotificationStore;
  await hydrated(store);
  if (store.getState().legacyKindsMigrated) return;
  const patch = legacyKindPatch(store.getState().preferences);
  try {
    if (patch) await updateNotificationPreferences(patch);
    store.getState().markLegacyKindsMigrated();
  } catch (error) {
    log.warn('[PUSH] Legacy kind carry-over failed:', error);
  }
}

/**
 * Registers this device when OS permission is already granted. The caller
 * guarantees a signed-in user. Returns the token, or null.
 */
export function syncPushRegistration(): Promise<string | null> {
  if (!syncInFlight) {
    syncInFlight = runSync().finally(() => {
      syncInFlight = null;
    });
  }
  return syncInFlight;
}

/** Idempotent upsert: re-registering the same token only updates its preferences. */
function register(token: string, preferences: ServerPreferences) {
  return registerDeviceToken({
    device_token: token,
    device_type: Platform.OS === 'ios' ? 'ios' : 'android',
    provider: 'expo',
    preferences,
  });
}

async function runSync(): Promise<string | null> {
  if (signingOut) return null;
  // A release still in flight must not delete the row this sign-in registers.
  await flushInFlight;
  if (signingOut || !remotePushSupported()) return null;
  const Notifications = getNotifications()!;
  if (!(await permissionGranted(Notifications))) return null;
  const token = await fetchExpoPushToken(Notifications);
  if (!token) return null;
  const prefs = serverPreferences(useNotificationStore.getState().preferences);
  // Sign-out can start during the permission and token reads above.
  if (signingOut) return null;
  try {
    await register(token, prefs);
    // Sign-out started while the POST ran: its DELETE owns the row now.
    if (signingOut) return null;
    lastPosted = postedKey(token, prefs);
    registeredThisSignIn = true;
    const push = usePushStore.getState();
    push.setToken(token);
    // The row is now bound to this sign-in: nothing is left to release.
    if (push.pendingRelease?.backendUrl === API_URL && push.pendingRelease.token === token) {
      push.setPendingRelease(null);
    }
    return token;
  } catch (error) {
    log.warn('[PUSH] Register failed:', error);
    return null;
  }
}

/**
 * Re-posts the current preferences for the registered token. Skips when the
 * server already has these values, and during sign-out. The caller guarantees a signed-in user.
 */
export async function syncPushPreferences(): Promise<void> {
  const token = usePushStore.getState().token;
  if (signingOut || !token || !remotePushSupported()) return;
  const prefs = serverPreferences(useNotificationStore.getState().preferences);
  const key = postedKey(token, prefs);
  if (key === lastPosted) return;
  try {
    await register(token, prefs);
    if (!signingOut) lastPosted = key;
  } catch (error) {
    log.warn('[PUSH] Preference sync failed:', error);
  }
}

/**
 * Asks for OS permission once per install, then registers on grant.
 * Called after a successful prompt send. Never throws.
 */
export async function requestPushPermissionOnce(): Promise<void> {
  try {
    if (usePushStore.getState().permissionAsked) return;
    if (!remotePushSupported()) return;
    const Notifications = getNotifications()!;
    usePushStore.getState().markPermissionAsked();
    if (!(await permissionGranted(Notifications))) {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') return;
    }
    await syncPushRegistration();
  } catch (error) {
    log.warn('[PUSH] Permission request failed:', error);
  }
}

const TIMED_OUT = Symbol('timed out');

/**
 * Deletes this device's token row for the signed-in user. Resolves within
 * SIGN_OUT_UNREGISTER_TIMEOUT_MS; never throws. A failure or timeout records
 * the row as `pendingRelease` for `flushPendingRelease()`. The local token
 * stays: the next sign-in re-registers it for the new user. Also removes the
 * previous user's notifications from the tray and drops a queued tap.
 */
export async function unregisterPushOnSignOut(): Promise<void> {
  signingOut = true;
  // A register POST already sent must reach the server before the DELETE,
  // or it re-binds the row to this sign-in.
  if (syncInFlight) await withDeadline(syncInFlight, SIGN_OUT_UNREGISTER_TIMEOUT_MS, null);
  const token = usePushStore.getState().token;
  lastPosted = null;
  usePushStore.setState({ pendingOpen: null });
  try {
    getNotifications()
      ?.dismissAllNotificationsAsync()
      .catch((error: unknown) => log.warn('[PUSH] Tray clear failed:', error));
  } catch (error) {
    log.warn('[PUSH] Tray clear failed:', error);
  }
  if (!token) {
    log.log('[PUSH] Sign-out: no push token on this device');
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIGN_OUT_UNREGISTER_TIMEOUT_MS);
  try {
    // The deadline also covers the auth header read, which can wait on a
    // token refresh before the request starts.
    const result = await withDeadline(
      unregisterDeviceToken(token, { signal: controller.signal }),
      SIGN_OUT_UNREGISTER_TIMEOUT_MS,
      TIMED_OUT
    );
    if (result === TIMED_OUT) {
      log.warn('[PUSH] Unregister on sign-out timed out: release pending');
      usePushStore.getState().setPendingRelease({ backendUrl: API_URL, token });
    } else if (!result.deleted) {
      // Another user's row, or already gone: nothing of this sign-in is left.
      log.log('[PUSH] Unregister on sign-out: no row for this user');
    }
  } catch (error) {
    log.warn('[PUSH] Unregister on sign-out failed: release pending', error);
    usePushStore.getState().setPendingRelease({ backendUrl: API_URL, token });
  } finally {
    clearTimeout(timer);
  }
}

let flushInFlight: Promise<void> | null = null;

/**
 * Removes the row a failed sign-out left (`pendingRelease`) without a
 * credential. Skipped while signed in on the same backend with the same
 * token: the next register binds that row to the current sign-in. Cleared on
 * success and on a 4xx other than 408/429 (an older server without the route
 * answers 401 or 404); kept on a network error, 5xx, 408 or 429 for the next
 * call. Never throws.
 */
export function flushPendingRelease({ signedIn }: { signedIn: boolean }): Promise<void> {
  if (!flushInFlight) {
    flushInFlight = runFlush(signedIn).finally(() => {
      flushInFlight = null;
    });
  }
  return flushInFlight;
}

/**
 * A 4xx other than 408/429 does not change on retry. The release route answers
 * only 200, 400 or 429; an older server answers its auth 401 or a 404.
 */
function isFinalRejection(status: unknown): boolean {
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function runFlush(signedIn: boolean): Promise<void> {
  await hydrated(usePushStore);
  const pending = usePushStore.getState().pendingRelease;
  if (!pending) return;
  if (signedIn && pending.backendUrl === API_URL && pending.token === usePushStore.getState().token) return;
  try {
    await releaseDeviceToken(pending.token, { backendUrl: pending.backendUrl });
  } catch (error) {
    if (!isFinalRejection((error as { status?: unknown } | null)?.status)) {
      log.warn('[PUSH] Release of a signed-out token failed, retrying later:', error);
      return;
    }
    log.log('[PUSH] Backend rejected the release: dropping the pending release', error);
  }
  if (usePushStore.getState().pendingRelease === pending) usePushStore.getState().setPendingRelease(null);
}

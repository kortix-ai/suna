/**
 * Device registration for remote push: OS permission, the Expo push token,
 * and the server's device-token rows (lib/notifications/api.ts).
 *
 * - `syncPushRegistration()`: signed in and permission already granted →
 *   register the token with the current preferences. Never asks.
 * - `requestPushPermissionOnce()`: after the first successful send. Asks the
 *   OS once per install, then registers on grant.
 * - `syncPushPreferences()`: re-posts preferences after a toggle.
 * - `unregisterPushOnSignOut()`: deletes this device's row before the auth
 *   session is cleared. Bounded, never throws.
 *
 * Remote push does not exist in Expo Go on Android (SDK 53+: token calls
 * throw). There, every function here is a no-op.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { isRunningInExpoGo } from 'expo';
import { log } from '@/lib/logger';
import { notificationsApi } from '@/lib/notifications/api';
import { serverPreferences, SIGN_OUT_UNREGISTER_TIMEOUT_MS } from '@/lib/notifications/push';
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

function postedKey(token: string, prefs: ReturnType<typeof serverPreferences>): string {
  return `${token}|${JSON.stringify(prefs)}`;
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

async function runSync(): Promise<string | null> {
  if (!remotePushSupported()) return null;
  const Notifications = getNotifications()!;
  if (!(await permissionGranted(Notifications))) return null;
  const token = await fetchExpoPushToken(Notifications);
  if (!token) return null;
  const prefs = serverPreferences(useNotificationStore.getState().preferences);
  try {
    await notificationsApi.registerDeviceToken(token, prefs);
    lastPosted = postedKey(token, prefs);
    usePushStore.getState().setToken(token);
    return token;
  } catch (error) {
    log.warn('[PUSH] Register failed:', error);
    return null;
  }
}

/**
 * Re-posts the current preferences for the registered token. Skips when the
 * server already has these values. The caller guarantees a signed-in user.
 */
export async function syncPushPreferences(): Promise<void> {
  const token = usePushStore.getState().token;
  if (!token || !remotePushSupported()) return;
  const prefs = serverPreferences(useNotificationStore.getState().preferences);
  const key = postedKey(token, prefs);
  if (key === lastPosted) return;
  try {
    await notificationsApi.registerDeviceToken(token, prefs);
    lastPosted = key;
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

/**
 * Deletes this device's token row for the signed-in user. Resolves within
 * SIGN_OUT_UNREGISTER_TIMEOUT_MS; a failure is logged, never thrown. The
 * local token stays: the next sign-in re-registers it for the new user.
 */
export async function unregisterPushOnSignOut(): Promise<void> {
  const token = usePushStore.getState().token;
  lastPosted = null;
  if (!token) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIGN_OUT_UNREGISTER_TIMEOUT_MS);
  try {
    // The deadline also covers the auth header read, which can wait on a
    // token refresh before the request starts.
    await withDeadline(
      notificationsApi.unregisterDeviceToken(token, controller.signal),
      SIGN_OUT_UNREGISTER_TIMEOUT_MS,
      undefined
    );
  } catch (error) {
    log.warn('[PUSH] Unregister on sign-out failed (non-critical):', error);
  } finally {
    clearTimeout(timer);
  }
}

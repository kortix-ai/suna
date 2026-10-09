import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { storage } from '@/stores/in-memory-async-storage';

// The per-kind switches an app from before KRTX-1742 stored on the phone move
// into the user's record once. Until that write succeeds, the device row keeps
// the stored values, so a phone's old opt-out holds through any deploy order.
// Real: the push rules, the notification store, the push store. The native
// modules and the SDK's requests are stubs.

const STORE_KEY = '@notification_preferences';
const registered: { preferences: Record<string, boolean> }[] = [];
const patches: unknown[] = [];
let patchFails = false;

mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('expo', () => ({ isRunningInExpoGo: () => false }));
mock.module('expo-constants', () => ({ default: { expoConfig: { extra: { eas: { projectId: 'eas-test' } } } } }));
mock.module('expo-device', () => ({ isDevice: true }));
mock.module('expo-notifications', () => ({
  getPermissionsAsync: async () => ({ status: 'granted' }),
  getExpoPushTokenAsync: async () => ({ data: 'ExponentPushToken[test]' }),
}));
mock.module('@/lib/logger', () => ({ log: { log() {}, warn() {}, error() {} } }));
mock.module('@kortix/sdk', () => ({
  INBOX_NOTIFICATION_KINDS: ['turn_done', 'turn_error', 'question', 'permission', 'shared', 'automation_failed', 'automation_recovered'],
  registerDeviceToken: async (input: { preferences: Record<string, boolean> }) => {
    registered.push(input);
    return { success: true, message: 'ok' };
  },
  unregisterDeviceToken: async () => ({ success: true, deleted: true }),
  updateNotificationPreferences: async (patch: unknown) => {
    patches.push(patch);
    if (patchFails) throw new Error('503');
    return { kinds: {}, email_available: true };
  },
}));

let registration: typeof import('./registration');
let useNotificationStore: typeof import('@/stores/notification-store').useNotificationStore;
beforeAll(async () => {
  registration = await import('./registration');
  useNotificationStore = (await import('@/stores/notification-store')).useNotificationStore;
});

/** Loads the store as an app from before KRTX-1742 left it: per-kind switches, no migration flag. */
async function loadStored(preferences: Record<string, boolean> | null) {
  useNotificationStore.setState({ preferences: { enabled: true, playSound: true }, legacyKindsMigrated: false });
  storage.clear();
  if (preferences) storage.set(STORE_KEY, JSON.stringify({ state: { preferences }, version: 0 }));
  await useNotificationStore.persist.rehydrate();
}

const LEGACY = { enabled: true, onCompletion: false, onError: true, onQuestion: false, onPermission: true, playSound: true };
const ALL_ON = { enabled: true, on_completion: true, on_error: true, on_question: true, on_permission: true, play_sound: true };

function storedFlag(): unknown {
  return JSON.parse(storage.get(STORE_KEY) ?? '{}').state?.legacyKindsMigrated;
}

beforeEach(() => {
  registered.length = 0;
  patches.length = 0;
  patchFails = false;
});
// Sign-out clears the last posted key, so each test posts from scratch.
afterEach(() => registration.unregisterPushOnSignOut());

describe('legacy per-kind switches', () => {
  test('a kind this phone turned off moves to the user record once; then every column posts on', async () => {
    await loadStored(LEGACY);
    expect(await registration.syncPushRegistration()).toBe('ExponentPushToken[test]');
    expect(patches).toEqual([{ kinds: { turn_done: { push: false }, question: { push: false } } }]);
    expect(registered.at(-1)?.preferences).toEqual(ALL_ON);
    expect(storedFlag()).toBe(true);

    useNotificationStore.getState().setPreference('playSound', false);
    await registration.syncPushPreferences();
    await registration.syncPushRegistration();
    expect(patches).toHaveLength(1);
    expect(registered.at(-1)?.preferences).toEqual({ ...ALL_ON, play_sound: false });
  });

  test('a failed move keeps posting the stored values, and the next sync retries it', async () => {
    await loadStored(LEGACY);
    patchFails = true;
    await registration.syncPushRegistration();
    expect(patches).toHaveLength(1);
    expect(registered.at(-1)?.preferences).toEqual({ ...ALL_ON, on_completion: false, on_question: false });
    expect(useNotificationStore.getState().legacyKindsMigrated).toBe(false);

    patchFails = false;
    await registration.syncPushPreferences();
    expect(patches).toHaveLength(2);
    expect(registered.at(-1)?.preferences).toEqual(ALL_ON);
    expect(useNotificationStore.getState().legacyKindsMigrated).toBe(true);
  });

  test('before the stored switches load, nothing moves and nothing is marked', async () => {
    await loadStored(LEGACY);
    const hydrated = spyOn(useNotificationStore.persist, 'hasHydrated').mockReturnValue(false);
    try {
      await registration.syncPushRegistration();
    } finally {
      hydrated.mockRestore();
    }
    expect(patches).toHaveLength(0);
    expect(useNotificationStore.getState().legacyKindsMigrated).toBe(false);

    // Loaded: the next sync (the bridge re-posts after the store changes) moves them.
    await registration.syncPushPreferences();
    expect(patches).toEqual([{ kinds: { turn_done: { push: false }, question: { push: false } } }]);
    expect(registered.at(-1)?.preferences).toEqual(ALL_ON);
  });

  test('a fresh install moves nothing, marks the move done, and posts every column on', async () => {
    await loadStored(null);
    await registration.syncPushRegistration();
    expect(patches).toHaveLength(0);
    expect(registered.at(-1)?.preferences).toEqual(ALL_ON);
    expect(storedFlag()).toBe(true);
  });
});

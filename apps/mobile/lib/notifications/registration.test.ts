import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { storage } from '@/stores/in-memory-async-storage';

// The device row always carries this phone's switches: a project with the
// `notification_center` flag off reads them alone, as before KRTX-1742. The
// kinds this phone turned off reach the user's record only through
// `carryOverLegacyKinds()`, once, for a user with a flag-on project.
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

const ALL_ON_PREFS = { enabled: true, onCompletion: true, onError: true, onQuestion: true, onPermission: true, playSound: true };

/** Loads the store from what an earlier app left on disk (null: a fresh install). */
async function loadStored(state: Record<string, unknown> | null) {
  useNotificationStore.setState({ preferences: ALL_ON_PREFS, legacyKindsMigrated: false });
  storage.clear();
  if (state) storage.set(STORE_KEY, JSON.stringify({ state, version: 0 }));
  await useNotificationStore.persist.rehydrate();
}

const STORED = { enabled: true, onCompletion: false, onError: true, onQuestion: false, onPermission: true, playSound: true };
const STORED_WIRE = { enabled: true, on_completion: false, on_error: true, on_question: false, on_permission: true, play_sound: true };
const ALL_ON = { enabled: true, on_completion: true, on_error: true, on_question: true, on_permission: true, play_sound: true };
const OPT_OUTS = { kinds: { turn_done: { push: false }, question: { push: false } } };

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

describe("the device row carries this phone's switches", () => {
  test('a sync posts the stored per-kind switches and writes no record', async () => {
    await loadStored({ preferences: STORED });
    expect(await registration.syncPushRegistration()).toBe('ExponentPushToken[test]');
    expect(registered.at(-1)?.preferences).toEqual(STORED_WIRE);
    expect(patches).toHaveLength(0);
    expect(useNotificationStore.getState().legacyKindsMigrated).toBe(false);

    useNotificationStore.getState().setPreference('onQuestion', true);
    await registration.syncPushPreferences();
    expect(registered.at(-1)?.preferences).toEqual({ ...STORED_WIRE, on_question: true });
    expect(patches).toHaveLength(0);
  });

  test('after the carry-over the columns still post the stored values', async () => {
    await loadStored({ preferences: STORED });
    await registration.carryOverLegacyKinds();
    await registration.syncPushRegistration();
    expect(registered.at(-1)?.preferences).toEqual(STORED_WIRE);
  });

  test('a phone that ran the first KRTX-1742 build posts its stored switches again', async () => {
    // That build marked the move done and posted every column on.
    await loadStored({ preferences: STORED, legacyKindsMigrated: true });
    await registration.syncPushRegistration();
    expect(registered.at(-1)?.preferences).toEqual(STORED_WIRE);
    expect(patches).toHaveLength(0);
  });

  test('an install from the first KRTX-1742 build stored no per-kind switches: they load as on', async () => {
    await loadStored({ preferences: { enabled: true, playSound: false }, legacyKindsMigrated: true });
    expect(useNotificationStore.getState().preferences).toEqual({ ...ALL_ON_PREFS, playSound: false });
    await registration.syncPushRegistration();
    expect(registered.at(-1)?.preferences).toEqual({ ...ALL_ON, play_sound: false });
  });

  test('a fresh install posts every column on', async () => {
    await loadStored(null);
    await registration.syncPushRegistration();
    expect(registered.at(-1)?.preferences).toEqual(ALL_ON);
  });
});

describe('carryOverLegacyKinds', () => {
  test("moves the kinds this phone turned off into the user's record once", async () => {
    await loadStored({ preferences: STORED });
    await Promise.all([registration.carryOverLegacyKinds(), registration.carryOverLegacyKinds()]);
    expect(patches).toEqual([OPT_OUTS]);
    expect(storedFlag()).toBe(true);

    await registration.carryOverLegacyKinds();
    expect(patches).toHaveLength(1);
  });

  test('a failed write leaves the marker off; the next call retries it', async () => {
    await loadStored({ preferences: STORED });
    patchFails = true;
    await registration.carryOverLegacyKinds();
    expect(patches).toHaveLength(1);
    expect(useNotificationStore.getState().legacyKindsMigrated).toBe(false);

    patchFails = false;
    await registration.carryOverLegacyKinds();
    expect(patches).toEqual([OPT_OUTS, OPT_OUTS]);
    expect(useNotificationStore.getState().legacyKindsMigrated).toBe(true);
  });

  test('before the stored switches load, it waits for them', async () => {
    await loadStored({ preferences: STORED });
    const hydrated = spyOn(useNotificationStore.persist, 'hasHydrated').mockReturnValue(false);
    let done = false;
    try {
      const pending = registration.carryOverLegacyKinds().then(() => {
        done = true;
      });
      await Promise.resolve();
      expect(done).toBe(false);
      expect(patches).toHaveLength(0);
      await useNotificationStore.persist.rehydrate();
      await pending;
    } finally {
      hydrated.mockRestore();
    }
    expect(patches).toEqual([OPT_OUTS]);
    expect(useNotificationStore.getState().legacyKindsMigrated).toBe(true);
  });

  test('nothing turned off: no write, marked done', async () => {
    await loadStored(null);
    await registration.carryOverLegacyKinds();
    expect(patches).toHaveLength(0);
    expect(storedFlag()).toBe(true);
  });
});

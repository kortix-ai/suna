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
/** The register POST rejects while set. */
let registerFails = false;
let trayDismissals = 0;
/** The sign-out DELETE: resolves this, or throws when it is an Error, or never settles when null. */
let unregisterResult: { success: true; deleted: boolean } | Error | null = { success: true, deleted: true };
const released: { token: string; backendUrl?: string }[] = [];
/** The release POST: resolves, or rejects with this. */
let releaseError: unknown = null;
/** While set, the release POST waits for it. */
let releaseGate: Promise<void> | null = null;
/** While set, the register POST waits for it. */
let registerGate: Promise<void> | null = null;
/** Call order of the register and sign-out requests. */
const calls: string[] = [];
const API_URL = 'https://api.kortix.test';

mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('expo', () => ({ isRunningInExpoGo: () => false }));
mock.module('expo-constants', () => ({ default: { expoConfig: { extra: { eas: { projectId: 'eas-test' } } } } }));
mock.module('expo-device', () => ({ isDevice: true }));
mock.module('expo-notifications', () => ({
  getPermissionsAsync: async () => ({ status: 'granted' }),
  getExpoPushTokenAsync: async () => ({ data: 'ExponentPushToken[test]' }),
  dismissAllNotificationsAsync: async () => {
    trayDismissals += 1;
  },
}));
mock.module('@/api/config', () => ({ API_URL }));
mock.module('@/lib/logger', () => ({ log: { log() {}, warn() {}, error() {} } }));
mock.module('@kortix/sdk', () => ({
  INBOX_NOTIFICATION_KINDS: ['turn_done', 'turn_error', 'question', 'permission', 'shared', 'automation_failed', 'automation_recovered'],
  registerDeviceToken: async (input: { preferences: Record<string, boolean> }) => {
    registered.push(input);
    if (registerGate) await registerGate;
    calls.push('register');
    if (registerFails) throw new Error('503');
    return { success: true, message: 'ok' };
  },
  unregisterDeviceToken: () => {
    calls.push('delete');
    const result = unregisterResult;
    if (result === null) return new Promise(() => {});
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  },
  releaseDeviceToken: async (token: string, options?: { backendUrl?: string }) => {
    released.push({ token, backendUrl: options?.backendUrl });
    if (releaseGate) await releaseGate;
    if (releaseError) throw releaseError;
    return { ok: true };
  },
  updateNotificationPreferences: async (patch: unknown) => {
    patches.push(patch);
    if (patchFails) throw new Error('503');
    return { kinds: {}, email_available: true };
  },
}));

let registration: typeof import('./registration');
let useNotificationStore: typeof import('@/stores/notification-store').useNotificationStore;
let usePushStore: typeof import('@/stores/push-store').usePushStore;
beforeAll(async () => {
  registration = await import('./registration');
  useNotificationStore = (await import('@/stores/notification-store')).useNotificationStore;
  usePushStore = (await import('@/stores/push-store')).usePushStore;
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
  registerFails = false;
  trayDismissals = 0;
  unregisterResult = { success: true, deleted: true };
  released.length = 0;
  releaseError = null;
  releaseGate = null;
  registerGate = null;
  calls.length = 0;
  registration.beginPushSignIn();
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

// KRTX-2242: a sign-out that cannot delete its row leaves a durable record,
// and a later call removes the row without a credential.
describe('pendingRelease', () => {
  const TOKEN = 'ExponentPushToken[test]';
  const PENDING = { backendUrl: API_URL, token: TOKEN };
  const OLD_BACKEND = { backendUrl: 'https://old.example.test', token: TOKEN };
  const pending = () => usePushStore.getState().pendingRelease;
  const storedPending = () => JSON.parse(storage.get('@push_registration') ?? '{}').state?.pendingRelease;

  beforeEach(() => usePushStore.setState({ token: TOKEN, pendingRelease: null }));
  afterEach(() => usePushStore.setState({ pendingRelease: null }));

  test('a failed sign-out DELETE records the row for this backend, persisted', async () => {
    unregisterResult = new Error('offline');
    await registration.unregisterPushOnSignOut();
    expect(pending()).toEqual(PENDING);
    expect(storedPending()).toEqual(PENDING);
  });

  // Real timers: waits the 3 s deadline.
  test('a sign-out DELETE past the deadline records the row', async () => {
    unregisterResult = null;
    await registration.unregisterPushOnSignOut();
    unregisterResult = { success: true, deleted: true }; // the shared afterEach signs out again
    expect(pending()).toEqual(PENDING);
  }, 10_000);

  test('a confirmed DELETE, deleted or not, records nothing', async () => {
    await registration.unregisterPushOnSignOut();
    unregisterResult = { success: true, deleted: false };
    await registration.unregisterPushOnSignOut();
    expect(pending()).toBeNull();
  });

  test('signed out: the flush releases the row on its backend and clears the record', async () => {
    usePushStore.setState({ pendingRelease: OLD_BACKEND });
    await registration.flushPendingRelease({ signedIn: false });
    expect(released).toEqual([{ token: TOKEN, backendUrl: OLD_BACKEND.backendUrl }]);
    expect(pending()).toBeNull();
  });

  test('a 404 (a server without the route) clears the record', async () => {
    usePushStore.setState({ pendingRelease: PENDING });
    releaseError = Object.assign(new Error('HTTP 404'), { status: 404 });
    await registration.flushPendingRelease({ signedIn: false });
    expect(pending()).toBeNull();
  });

  test('a 401 (an older server: auth runs before its 404) clears the record', async () => {
    usePushStore.setState({ pendingRelease: PENDING });
    releaseError = Object.assign(new Error('HTTP 401'), { status: 401 });
    await registration.flushPendingRelease({ signedIn: false });
    expect(pending()).toBeNull();
  });

  test('a 429 or a 408 keeps the record for the next call', async () => {
    usePushStore.setState({ pendingRelease: PENDING });
    releaseError = Object.assign(new Error('HTTP 429'), { status: 429 });
    await registration.flushPendingRelease({ signedIn: false });
    expect(pending()).toEqual(PENDING);
    releaseError = Object.assign(new Error('HTTP 408'), { status: 408 });
    await registration.flushPendingRelease({ signedIn: false });
    expect(pending()).toEqual(PENDING);
  });

  test('a network error or a 5xx keeps the record for the next call', async () => {
    usePushStore.setState({ pendingRelease: PENDING });
    releaseError = new TypeError('Network request failed');
    await registration.flushPendingRelease({ signedIn: false });
    expect(pending()).toEqual(PENDING);
    releaseError = Object.assign(new Error('HTTP 503'), { status: 503 });
    await registration.flushPendingRelease({ signedIn: false });
    expect(pending()).toEqual(PENDING);
    expect(released).toHaveLength(2);
  });

  test('signed in on the same backend with the same token: no release', async () => {
    usePushStore.setState({ pendingRelease: PENDING });
    await registration.flushPendingRelease({ signedIn: true });
    expect(released).toHaveLength(0);
    expect(pending()).toEqual(PENDING);
  });

  test('signed in, the record names another backend: released', async () => {
    usePushStore.setState({ pendingRelease: OLD_BACKEND });
    await registration.flushPendingRelease({ signedIn: true });
    expect(released).toHaveLength(1);
    expect(pending()).toBeNull();
  });

  test('a register of the same token on the same backend clears the record', async () => {
    await loadStored(null);
    usePushStore.setState({ pendingRelease: PENDING });
    expect(await registration.syncPushRegistration()).toBe(TOKEN);
    expect(pending()).toBeNull();
  });

  test('a register started during a release posts only after the release resolves', async () => {
    await loadStored(null);
    usePushStore.setState({ pendingRelease: OLD_BACKEND });
    let open!: () => void;
    releaseGate = new Promise<void>((resolve) => (open = resolve));
    const flush = registration.flushPendingRelease({ signedIn: true });
    while (released.length === 0) await new Promise((r) => setTimeout(r, 0));
    const sync = registration.syncPushRegistration();
    await new Promise((r) => setTimeout(r, 10));
    expect(registered).toHaveLength(0);
    open();
    await flush;
    expect(await sync).toBe(TOKEN);
    expect(registered).toHaveLength(1);
  });

  test('a register on another backend keeps the record of the old one', async () => {
    await loadStored(null);
    usePushStore.setState({ pendingRelease: OLD_BACKEND });
    await registration.syncPushRegistration();
    expect(pending()).toEqual(OLD_BACKEND);
  });
});

describe('sign-out ends this sign-in on the device', () => {
  test('a register for this sign-in is tracked apart from the persisted token', async () => {
    await loadStored(null);
    registration.beginPushSignIn();
    expect(registration.registeredForThisSignIn()).toBe(false);

    // The token from the last sign-in stays persisted; a failed register is not this sign-in's row.
    usePushStore.setState({ token: 'ExponentPushToken[test]' });
    registerFails = true;
    expect(await registration.syncPushRegistration()).toBeNull();
    expect(registration.registeredForThisSignIn()).toBe(false);

    registerFails = false;
    expect(await registration.syncPushRegistration()).toBe('ExponentPushToken[test]');
    expect(registration.registeredForThisSignIn()).toBe(true);

    // Sign-out keeps the flag: a resume before the bridge sees the sign-out must not re-register.
    await registration.unregisterPushOnSignOut();
    expect(registration.registeredForThisSignIn()).toBe(true);
    expect(usePushStore.getState().token).toBe('ExponentPushToken[test]');

    // The next sign-in starts with no register for it.
    registration.beginPushSignIn();
    expect(registration.registeredForThisSignIn()).toBe(false);
  });

  // Real timers: the DELETE never settles, so sign-out waits the 3 s deadline.
  test('while the sign-out DELETE runs, no sync posts for the outgoing user', async () => {
    await loadStored(null);
    await registration.syncPushRegistration();
    expect(registered).toHaveLength(1);

    unregisterResult = null;
    const signOut = registration.unregisterPushOnSignOut();
    // A resume or a debounced toggle during the sign-out window.
    useNotificationStore.getState().setPreference('onError', false);
    await registration.syncPushPreferences();
    expect(await registration.syncPushRegistration()).toBeNull();
    expect(registered).toHaveLength(1);

    await signOut;
    unregisterResult = { success: true, deleted: true }; // the shared afterEach signs out again
    usePushStore.setState({ pendingRelease: null });
  }, 10_000);

  test('a register POST already sent completes before the sign-out DELETE', async () => {
    await loadStored(null);
    await registration.syncPushRegistration();
    calls.length = 0;
    let open = () => {};
    registerGate = new Promise<void>((resolve) => (open = resolve));
    const sync = registration.syncPushRegistration();
    while (registered.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    const signOut = registration.unregisterPushOnSignOut();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);

    open();
    await sync;
    await signOut;
    expect(calls).toEqual(['register', 'delete']);
  });

  test('the next sign-in registers again after a sign-out', async () => {
    await loadStored(null);
    await registration.unregisterPushOnSignOut();
    expect(await registration.syncPushRegistration()).toBeNull();
    expect(registered).toHaveLength(0);

    registration.beginPushSignIn();
    expect(await registration.syncPushRegistration()).toBe('ExponentPushToken[test]');
    expect(registered).toHaveLength(1);
  });

  test("sign-out clears the tray and drops a queued tap", async () => {
    usePushStore.getState().requestOpen('project-a', 'session-a');
    await registration.unregisterPushOnSignOut();
    expect(usePushStore.getState().pendingOpen).toBeNull();
    expect(trayDismissals).toBe(1);
  });

  test('a failed preference sync is retried by the next call', async () => {
    await loadStored(null);
    await registration.syncPushRegistration();
    useNotificationStore.getState().setPreference('onError', false);
    registerFails = true;
    await registration.syncPushPreferences();
    registerFails = false;
    await registration.syncPushPreferences();
    expect(registered).toHaveLength(3);
    expect(registered.at(-1)?.preferences).toEqual({ ...ALL_ON, on_error: false });
    await registration.syncPushPreferences();
    expect(registered).toHaveLength(3);
  });
});

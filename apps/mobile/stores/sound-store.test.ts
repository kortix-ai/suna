import { beforeEach, describe, expect, mock, test } from 'bun:test';

// In-memory AsyncStorage: the sound store persists through it.
const storage = new Map<string, string>();
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: async (key: string) => {
      storage.delete(key);
    },
  },
}));

const { useSoundStore } = await import('./sound-store');

const STORAGE_KEY = '@sound_preferences';

function seed(version: number, state: Record<string, unknown>) {
  storage.set(STORAGE_KEY, JSON.stringify({ state, version }));
}

describe('sound store: pack migration to v1', () => {
  beforeEach(() => {
    storage.clear();
  });

  test('a legacy "opencode" pack migrates to "kortix"', async () => {
    seed(0, { preferences: { pack: 'opencode', volume: 0.7, events: {}, hapticsEnabled: true } });

    await useSoundStore.persist.rehydrate();

    expect(useSoundStore.getState().preferences.pack).toBe('kortix');
    expect(useSoundStore.getState().preferences.volume).toBe(0.7);
  });

  test('an unknown persisted pack value migrates to "kortix"', async () => {
    seed(0, { preferences: { pack: 'not-a-real-pack', volume: 0.3, events: {}, hapticsEnabled: false } });

    await useSoundStore.persist.rehydrate();

    expect(useSoundStore.getState().preferences.pack).toBe('kortix');
  });

  test('a persisted "off" pack is preserved, not forced to "kortix"', async () => {
    seed(0, { preferences: { pack: 'off', volume: 0.5, events: {}, hapticsEnabled: true } });

    await useSoundStore.persist.rehydrate();

    expect(useSoundStore.getState().preferences.pack).toBe('off');
  });

  test('a persisted "kortix" pack is preserved', async () => {
    seed(0, { preferences: { pack: 'kortix', volume: 0.9, events: { send: false }, hapticsEnabled: true } });

    await useSoundStore.persist.rehydrate();

    const { preferences } = useSoundStore.getState();
    expect(preferences.pack).toBe('kortix');
    expect(preferences.events.send).toBe(false);
  });

  test('no persisted data at all still yields the default "kortix" pack', async () => {
    await useSoundStore.persist.rehydrate();

    expect(useSoundStore.getState().preferences.pack).toBe('kortix');
  });
});

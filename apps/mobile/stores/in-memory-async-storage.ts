import { mock } from 'bun:test';

// Test-only. One in-memory AsyncStorage for every store test. Bun shares one
// module registry across test files, and zustand's persist middleware keeps the
// storage object it was created with. Two files that each mock AsyncStorage
// with their own Map therefore break whichever file imports a store second.
// Import this module before the first store import.
export const storage = new Map<string, string>();

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

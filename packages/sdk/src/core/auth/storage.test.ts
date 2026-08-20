import { afterEach, describe, expect, test } from 'bun:test';

import {
  createLocalStorageAuthStorage,
  createMemoryAuthStorage,
  parseStoredSession,
  resolveAuthStorage,
  serializeStoredSession,
  type KortixAuthStorage,
} from './storage';
import type { KortixAuthSession } from './session';

const GOTRUE_URL = 'https://supa.kortix.test';

const session: KortixAuthSession = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_at: 1770000000,
  token_type: 'bearer',
  user: { id: 'u1', email: 'a@b.test' },
};

/** Install a fake `localStorage` global for one test. */
function withLocalStorage(impl: Partial<Storage> | null, run: () => void): void {
  const holder = globalThis as { localStorage?: unknown };
  const had = 'localStorage' in holder;
  const previous = holder.localStorage;
  if (impl === null) delete holder.localStorage;
  else holder.localStorage = impl;
  try {
    run();
  } finally {
    if (had) holder.localStorage = previous;
    else delete holder.localStorage;
  }
}

afterEach(() => {
  // The helper restores in `finally`; this is belt-and-braces for a throw
  // inside the restore itself.
});

describe('createMemoryAuthStorage', () => {
  test('round-trips and removes', async () => {
    const storage = createMemoryAuthStorage();
    expect(await storage.getItem('k')).toBeNull();
    await storage.setItem('k', 'v');
    expect(await storage.getItem('k')).toBe('v');
    await storage.removeItem('k');
    expect(await storage.getItem('k')).toBeNull();
  });

  test('two instances do not share state', async () => {
    const a = createMemoryAuthStorage();
    const b = createMemoryAuthStorage();
    await a.setItem('k', 'v');
    expect(await b.getItem('k')).toBeNull();
  });
});

describe('createLocalStorageAuthStorage', () => {
  test('returns an adapter when the probe write/read/remove succeeds', async () => {
    const backing = new Map<string, string>();
    withLocalStorage(
      {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => void backing.set(key, value),
        removeItem: (key: string) => void backing.delete(key),
      },
      () => {
        const storage = createLocalStorageAuthStorage();
        expect(storage).not.toBeNull();
        void storage?.setItem('kortix.auth.session', 'blob');
        expect(storage?.getItem('kortix.auth.session')).toBe('blob');
        // The probe key must not be left behind.
        expect([...backing.keys()]).toEqual(['kortix.auth.session']);
      },
    );
  });

  test('returns null when setItem THROWS — Safari private mode, quota-full origin', () => {
    // `typeof localStorage !== 'undefined'` is true in Safari private mode; the
    // object exists and `setItem` throws a QuotaExceededError. A presence check
    // alone therefore picks an adapter that fails on the first write.
    withLocalStorage(
      {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('QuotaExceededError');
        },
        removeItem: () => {},
      },
      () => {
        expect(createLocalStorageAuthStorage()).toBeNull();
      },
    );
  });

  test('returns null when the probe read does not return what was written', () => {
    withLocalStorage(
      { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      () => {
        expect(createLocalStorageAuthStorage()).toBeNull();
      },
    );
  });

  test('returns null when there is no localStorage global', () => {
    withLocalStorage(null, () => {
      expect(createLocalStorageAuthStorage()).toBeNull();
    });
  });
});

describe('resolveAuthStorage', () => {
  test('prefers an explicitly supplied storage', async () => {
    const explicit = createMemoryAuthStorage();
    await explicit.setItem('marker', 'explicit');
    withLocalStorage(
      {
        getItem: () => 'from-local-storage',
        setItem: () => {},
        removeItem: () => {},
      },
      () => {
        expect(resolveAuthStorage(explicit)).toBe(explicit);
      },
    );
  });

  test('falls back to memory when localStorage is unusable — no exception escapes', async () => {
    withLocalStorage(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error('nope');
        },
        removeItem: () => {},
      },
      () => {
        const storage = resolveAuthStorage();
        expect(storage).toBeDefined();
        void storage.setItem('k', 'v');
        expect(storage.getItem('k')).toBe('v');
      },
    );
  });

  test('uses localStorage when it works', () => {
    const backing = new Map<string, string>();
    withLocalStorage(
      {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => void backing.set(key, value),
        removeItem: (key: string) => void backing.delete(key),
      },
      () => {
        const storage = resolveAuthStorage();
        void storage.setItem('k', 'v');
        expect(backing.get('k')).toBe('v');
      },
    );
  });
});

describe('async adapters (React Native AsyncStorage shape)', () => {
  test('are awaited on read and write', async () => {
    const backing = new Map<string, string>();
    const asyncStorage: KortixAuthStorage = {
      getItem: async (key) => {
        await Promise.resolve();
        return backing.get(key) ?? null;
      },
      setItem: async (key, value) => {
        await Promise.resolve();
        backing.set(key, value);
      },
      removeItem: async (key) => {
        await Promise.resolve();
        backing.delete(key);
      },
    };

    await asyncStorage.setItem('kortix.auth.session', serializeStoredSession(GOTRUE_URL, session));
    const raw = await asyncStorage.getItem('kortix.auth.session');
    expect(parseStoredSession(raw, GOTRUE_URL)).toEqual(session);
  });
});

describe('persisted blob', () => {
  test('is versioned and URL-stamped', () => {
    const raw = serializeStoredSession(GOTRUE_URL, session);
    expect(JSON.parse(raw)).toEqual({ v: 1, url: GOTRUE_URL, session });
  });

  test('round-trips through parseStoredSession', () => {
    expect(parseStoredSession(serializeStoredSession(GOTRUE_URL, session), GOTRUE_URL)).toEqual(
      session,
    );
  });

  test('discards a blob written by an older version (v: 0)', () => {
    const raw = JSON.stringify({ v: 0, url: GOTRUE_URL, session });
    expect(parseStoredSession(raw, GOTRUE_URL)).toBeNull();
  });

  test('discards a blob stamped with a DIFFERENT GoTrue url', () => {
    // One browser profile driving both dev-api and api shares one localStorage
    // origin. Without the stamp, the dev token is handed to prod and every call
    // 401s with no explanation.
    const raw = serializeStoredSession('https://supa.other.test', session);
    expect(parseStoredSession(raw, GOTRUE_URL)).toBeNull();
  });

  test('discards a non-JSON blob without throwing', () => {
    expect(parseStoredSession('}{ not json', GOTRUE_URL)).toBeNull();
  });

  test('discards null, an empty string, and a blob with no access_token', () => {
    expect(parseStoredSession(null, GOTRUE_URL)).toBeNull();
    expect(parseStoredSession('', GOTRUE_URL)).toBeNull();
    expect(
      parseStoredSession(
        JSON.stringify({ v: 1, url: GOTRUE_URL, session: { refresh_token: 'r' } }),
        GOTRUE_URL,
      ),
    ).toBeNull();
  });
});

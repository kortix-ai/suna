/**
 * Session persistence: the storage interface, its two built-in adapters, and
 * the versioned + URL-stamped blob format.
 */

import type { KortixAuthSession } from './session';

/**
 * Where a signed-in session is kept between calls (and between reloads).
 *
 * Async-tolerant by design — every call site in this module `await`s the
 * result — so React Native's `AsyncStorage` and Expo's `SecureStore` satisfy
 * this interface with no adapter of their own.
 */
export interface KortixAuthStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** The default storage key for the persisted session blob. */
export const DEFAULT_STORAGE_KEY = 'kortix.auth.session';

/** Current blob version. A blob at any other version is discarded. */
export const STORAGE_BLOB_VERSION = 1;

/** In-memory storage. Sessions do not survive a reload — correct and honest
 *  for a worker, a CLI, or a locked-down browser. */
export function createMemoryAuthStorage(): KortixAuthStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/**
 * `localStorage` storage, or `null` when it is not usable.
 *
 * The check is a real write/read/remove PROBE, not `typeof localStorage !==
 * 'undefined'`. In Safari private mode and on a quota-full origin the object
 * exists and `setItem` THROWS, so a presence check picks an adapter that fails
 * on the first real write. Guarded global access per the tripwire's documented
 * blind spot: the global is read once, behind `typeof`, and never touched
 * again by name.
 */
export function createLocalStorageAuthStorage(): KortixAuthStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const store = localStorage;
    if (!store) return null;
    const probeKey = '__kortix_auth_probe__';
    store.setItem(probeKey, '1');
    const readBack = store.getItem(probeKey);
    store.removeItem(probeKey);
    if (readBack !== '1') return null;
    return {
      getItem: (key) => store.getItem(key),
      setItem: (key, value) => store.setItem(key, value),
      removeItem: (key) => store.removeItem(key),
    };
  } catch {
    return null;
  }
}

/**
 * Resolution order: an explicit adapter, then a probed `localStorage`, then
 * memory. Never throws — an unusable browser store degrades to memory.
 */
export function resolveAuthStorage(explicit?: KortixAuthStorage): KortixAuthStorage {
  return explicit ?? createLocalStorageAuthStorage() ?? createMemoryAuthStorage();
}

interface StoredBlob {
  v: number;
  url: string;
  session: KortixAuthSession;
}

/** Serialize a session, stamped with the GoTrue url it belongs to. */
export function serializeStoredSession(url: string, session: KortixAuthSession): string {
  const blob: StoredBlob = { v: STORAGE_BLOB_VERSION, url, session };
  return JSON.stringify(blob);
}

/**
 * Parse a persisted blob, or return `null`.
 *
 * `null` for: absent, non-JSON, wrong version, no `access_token`, and — the
 * one that matters — a blob stamped with a DIFFERENT GoTrue url. One browser
 * profile driving both `dev-api` and `api` shares a single `localStorage`
 * origin; without the stamp the dev token is handed to prod and every call
 * 401s with no explanation. A corrupt cache must never throw on read.
 */
export function parseStoredSession(
  raw: string | null | undefined,
  url: string,
): KortixAuthSession | null {
  if (!raw) return null;
  try {
    const blob = JSON.parse(raw) as Partial<StoredBlob> | null;
    if (!blob || typeof blob !== 'object') return null;
    if (blob.v !== STORAGE_BLOB_VERSION) return null;
    if (blob.url !== url) return null;
    const session = blob.session;
    if (!session || typeof session !== 'object') return null;
    if (typeof session.access_token !== 'string' || session.access_token.length === 0) return null;
    return session;
  } catch {
    return null;
  }
}

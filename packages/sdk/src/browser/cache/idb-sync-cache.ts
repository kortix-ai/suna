/**
 * IndexedDB persistence layer for the sync store.
 * Provides instant session data on cold loads (stale-while-revalidate).
 *
 * Schema: one object store "sessions" keyed by cacheKey, each entry holds
 * { cacheKey, userId, sessionId, messages, parts, updatedAt }.
 */

import { platformConfig } from '../../core/http/config';
import { buildSessionCacheKey } from './idb-sync-cache-key';

const DB_NAME = 'kortix-session-cache';
const DB_VERSION = 2;
const STORE_NAME = 'sessions';
const MAX_CACHED_SESSIONS = 50;
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CachedSession {
  cacheKey: string;
  userId: string;
  sessionId: string;
  kortixSessionScope?: string;
  messages: any[];
  parts: Record<string, any[]>;
  updatedAt: number;
}

let cacheScopePromise: Promise<string | null> | null = null;

function getCurrentCacheScope(): Promise<string | null> {
  if (cacheScopePromise) return cacheScopePromise;

  const pending = (async () => {
    try {
      const userId = (await platformConfig().getUserId?.()) ?? null;
      return userId ? `user:${userId}` : null;
    } catch {
      return null;
    }
  })();
  cacheScopePromise = pending;

  // Authentication can hydrate after the first cache access. Retain a real
  // user scope for this browser session, but let an unauthenticated lookup be
  // retried instead of pinning `null` until reload.
  void pending.then((scope) => {
    if (!scope && cacheScopePromise === pending) {
      cacheScopePromise = null;
    }
  });

  return pending;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'cacheKey' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

const pendingWrites = new Map<
  string,
  {
    scope: string;
    sessionId: string;
    kortixSessionScope?: string;
    messages: any[];
    parts: Record<string, any[]>;
  }
>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 500;

// The caps below are only real if something enforces them. Prune once per page
// load, off the back of the first flush, so the cache cannot grow forever
// without any host having to remember to call it.
let prunedThisLoad = false;

async function flushPendingWrites(): Promise<void> {
  flushTimer = null;
  if (pendingWrites.size === 0) return;
  if (!prunedThisLoad) {
    prunedThisLoad = true;
    void pruneIDBCache();
  }
  const batch = new Map(pendingWrites);
  pendingWrites.clear();
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const [cacheKey, { scope, sessionId, kortixSessionScope, messages, parts }] of batch) {
      const partsForSession: Record<string, any[]> = {};
      for (const msg of messages) {
        if (parts[msg.id]) {
          partsForSession[msg.id] = parts[msg.id];
        }
      }
      store.put({
        cacheKey,
        userId: scope,
        sessionId,
        kortixSessionScope,
        messages,
        parts: partsForSession,
        updatedAt: Date.now(),
      } satisfies CachedSession);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Non-critical
  }
}

export async function saveSessionToIDB(
  sessionId: string,
  messages: any[],
  parts: Record<string, any[]>,
  kortixSessionScope?: string,
): Promise<void> {
  const scope = await getCurrentCacheScope();
  if (!scope) return;

  const cacheKey = buildSessionCacheKey(scope, sessionId, kortixSessionScope);
  pendingWrites.set(cacheKey, {
    scope,
    sessionId,
    kortixSessionScope,
    messages,
    parts,
  });
  if (!flushTimer) {
    flushTimer = setTimeout(flushPendingWrites, FLUSH_INTERVAL_MS);
  }
}

export function flushIDBWrites(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
  }
  return flushPendingWrites();
}

export async function loadSessionFromIDB(
  sessionId: string,
  kortixSessionScope?: string,
): Promise<{ messages: any[]; parts: Record<string, any[]> } | null> {
  try {
    const scope = await getCurrentCacheScope();
    if (!scope) return null;

    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(buildSessionCacheKey(scope, sessionId, kortixSessionScope));
    const result = await new Promise<CachedSession | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!result) return null;
    if (result.userId !== scope) return null;
    if (kortixSessionScope) {
      if (result.kortixSessionScope !== kortixSessionScope) return null;
    } else if (result.sessionId !== sessionId) {
      return null;
    }
    if (Date.now() - result.updatedAt > MAX_SESSION_AGE_MS) {
      deleteSessionFromIDB(sessionId, kortixSessionScope);
      return null;
    }
    return { messages: result.messages, parts: result.parts };
  } catch {
    return null;
  }
}

export async function loadAllSessionIdsFromIDB(): Promise<string[]> {
  try {
    const scope = await getCurrentCacheScope();
    if (!scope) return [];

    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    const entries = await new Promise<CachedSession[]>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as CachedSession[]);
      req.onerror = () => reject(req.error);
    });
    return entries.filter((entry) => entry.userId === scope).map((entry) => entry.sessionId);
  } catch {
    return [];
  }
}

export async function deleteSessionFromIDB(
  sessionId: string,
  kortixSessionScope?: string,
): Promise<void> {
  try {
    const scope = await getCurrentCacheScope();
    if (!scope) return;

    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(buildSessionCacheKey(scope, sessionId, kortixSessionScope));
  } catch {
    // ignore
  }
}

export async function clearSessionIDBCache(): Promise<void> {
  // The host calls this on sign-out and account changes. Invalidate identity
  // before touching IndexedDB so the next write cannot reuse the previous user.
  cacheScopePromise = null;
  try {
    pendingWrites.clear();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
  } catch {
    // ignore
  }
}

export async function pruneIDBCache(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    const entries = await new Promise<CachedSession[]>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const now = Date.now();
    // Delete by `cacheKey` — it is the store's keyPath. Deleting by `sessionId`
    // matched no record, so prune silently kept every entry forever and the
    // 50-session / 7-day caps were never enforced.
    const stale = entries.filter((e) => now - e.updatedAt > MAX_SESSION_AGE_MS);
    for (const e of stale) {
      store.delete(e.cacheKey);
    }
    const fresh = entries
      .filter((e) => now - e.updatedAt <= MAX_SESSION_AGE_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (fresh.length > MAX_CACHED_SESSIONS) {
      for (const e of fresh.slice(MAX_CACHED_SESSIONS)) {
        store.delete(e.cacheKey);
      }
    }
  } catch {
    // ignore
  }
}

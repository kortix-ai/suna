/**
 * IndexedDB persistence layer for the sync store.
 * Provides instant session data on cold loads (stale-while-revalidate).
 *
 * Schema: one object store "sessions" keyed by cacheKey, each entry holds
 * { cacheKey, userId, sessionId, messages, parts, updatedAt }.
 */

import { createClient } from "@/lib/supabase/client";

const DB_NAME = "kortix-session-cache";
const DB_VERSION = 2;
const STORE_NAME = "sessions";
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CachedSession {
  cacheKey: string;
  userId: string;
  sessionId: string;
  messages: any[];
  parts: Record<string, any[]>;
  updatedAt: number;
}

async function getCurrentCacheScope(): Promise<string | null> {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    return user?.id ? `user:${user.id}` : null;
  } catch {
    return null;
  }
}

function buildCacheKey(scope: string, sessionId: string): string {
  return `${scope}:session:${sessionId}`;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
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

const pendingWrites = new Map<string, {
  scope: string;
  sessionId: string;
  messages: any[];
  parts: Record<string, any[]>;
}>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 500;

async function flushPendingWrites(): Promise<void> {
  flushTimer = null;
  if (pendingWrites.size === 0) return;
  const batch = new Map(pendingWrites);
  pendingWrites.clear();
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const [cacheKey, { scope, sessionId, messages, parts }] of batch) {
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
): Promise<void> {
  const scope = await getCurrentCacheScope();
  if (!scope) return;

  const cacheKey = buildCacheKey(scope, sessionId);
  pendingWrites.set(cacheKey, { scope, sessionId, messages, parts });
  if (!flushTimer) {
    flushTimer = setTimeout(flushPendingWrites, FLUSH_INTERVAL_MS);
  }
}

export async function loadSessionFromIDB(
  sessionId: string,
): Promise<{ messages: any[]; parts: Record<string, any[]> } | null> {
  try {
    const scope = await getCurrentCacheScope();
    if (!scope) return null;

    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(buildCacheKey(scope, sessionId));
    const result = await new Promise<CachedSession | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!result) return null;
    if (result.userId !== scope || result.sessionId !== sessionId) return null;
    if (Date.now() - result.updatedAt > MAX_SESSION_AGE_MS) {
      deleteSessionFromIDB(sessionId);
      return null;
    }
    return { messages: result.messages, parts: result.parts };
  } catch {
    return null;
  }
}

export async function deleteSessionFromIDB(sessionId: string): Promise<void> {
  try {
    const scope = await getCurrentCacheScope();
    if (!scope) return;

    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(buildCacheKey(scope, sessionId));
  } catch {
    // ignore
  }
}

export async function clearSessionIDBCache(): Promise<void> {
  try {
    pendingWrites.clear();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
  } catch {
    // ignore
  }
}

/**
 * IndexedDB persistence layer for the sync store.
 * Provides instant session data on cold loads (stale-while-revalidate).
 *
 * Schema: one object store "sessions" keyed by sessionId, each entry holds
 * { messages: Message[], parts: Record<messageId, Part[]>, updatedAt: number }
 */

const DB_NAME = "kortix-session-cache";
const DB_VERSION = 1;
const STORE_NAME = "sessions";
const MAX_CACHED_SESSIONS = 50;
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CachedSession {
  sessionId: string;
  messages: any[];
  parts: Record<string, any[]>;
  updatedAt: number;
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
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "sessionId" });
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

const pendingWrites = new Map<string, { messages: any[]; parts: Record<string, any[]> }>();
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
    for (const [sessionId, { messages, parts }] of batch) {
      const partsForSession: Record<string, any[]> = {};
      for (const msg of messages) {
        if (parts[msg.id]) {
          partsForSession[msg.id] = parts[msg.id];
        }
      }
      store.put({
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

export function saveSessionToIDB(
  sessionId: string,
  messages: any[],
  parts: Record<string, any[]>,
): void {
  pendingWrites.set(sessionId, { messages, parts });
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
): Promise<{ messages: any[]; parts: Record<string, any[]> } | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(sessionId);
    const result = await new Promise<CachedSession | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!result) return null;
    if (Date.now() - result.updatedAt > MAX_SESSION_AGE_MS) {
      deleteSessionFromIDB(sessionId);
      return null;
    }
    return { messages: result.messages, parts: result.parts };
  } catch {
    return null;
  }
}

export async function loadAllSessionIdsFromIDB(): Promise<string[]> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAllKeys();
    return await new Promise<string[]>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as string[]);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function deleteSessionFromIDB(sessionId: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(sessionId);
  } catch {
    // ignore
  }
}

export async function pruneIDBCache(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    const entries = await new Promise<CachedSession[]>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const now = Date.now();
    const stale = entries.filter((e) => now - e.updatedAt > MAX_SESSION_AGE_MS);
    for (const e of stale) {
      store.delete(e.sessionId);
    }
    const fresh = entries
      .filter((e) => now - e.updatedAt <= MAX_SESSION_AGE_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (fresh.length > MAX_CACHED_SESSIONS) {
      for (const e of fresh.slice(MAX_CACHED_SESSIONS)) {
        store.delete(e.sessionId);
      }
    }
  } catch {
    // ignore
  }
}

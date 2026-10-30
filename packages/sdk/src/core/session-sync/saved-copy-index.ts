/**
 * The LRU index of a saved-copy store: which sessions hold copies, how big
 * each is, and when it was last written or read. Owns the index file's
 * serialization (`parseIndex`), the serialized write queue (`enqueue`),
 * eviction (`evict`) and the touch/forget operations. Split out of
 * `saved-copy-store.ts`, which keeps the blob plumbing and the copy API;
 * `saved-copy-store.test.ts` pins the behavior.
 */

import type { KeyValueStorage } from '../cache/persisted-query-cache';

/** Format version of the index file and the copy blobs. Bumped together. */
export const VERSION = 1;

export interface IndexEntry {
  /** `projectId/sessionId`. */
  s: string;
  /** Serialized size. */
  b: number;
  /** Last written or read, epoch ms. */
  u: number;
  /** `captured_at` of the stored envelope, epoch ms, or 0. */
  c: number;
}

type MaybePromise<T> = T | Promise<T>;

export function isPromise<T>(value: unknown): value is Promise<T> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

/** Apply `fn` now when `value` is ready, else when it resolves. */
export function then<T, R>(value: MaybePromise<T>, fn: (resolved: T) => R): MaybePromise<R> {
  return isPromise<T>(value) ? value.then(fn) : fn(value);
}

/**
 * The index layer of one user's store, parameterized over the storage, the
 * key prefix and the LRU bounds. Every operation swallows storage failures —
 * a lost index costs only eviction order; the copies stay readable.
 */
export function createSavedCopyIndex(options: {
  storage: KeyValueStorage;
  /** `${namespace}:${userId}:` — copies live at `${prefix}${projectId}/${sessionId}`, the index at `${prefix}index`. */
  prefix: string;
  maxSessions: number;
  maxBytes: number;
  now: () => number;
}) {
  const { storage, prefix, maxSessions, maxBytes, now } = options;
  const indexKey = `${prefix}index`;

  const safeGet = (key: string): MaybePromise<string | null> => {
    try {
      const value = storage.getItem(key);
      return isPromise<string | null>(value) ? value.catch(() => null) : value;
    } catch {
      return null;
    }
  };

  const safeRemove = async (key: string): Promise<void> => {
    try {
      await storage.removeItem(key);
    } catch {
      // Nothing to forget.
    }
  };

  const parseIndex = (raw: string | null): IndexEntry[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as { v?: number; entries?: IndexEntry[] };
      return parsed?.v === VERSION && Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  };

  /** Index changes are serialized: two writes never interleave on an async store. */
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const saveIndex = async (entries: IndexEntry[]) => {
    try {
      await storage.setItem(indexKey, JSON.stringify({ v: VERSION, entries }));
    } catch {
      // A lost index costs only eviction order; the copies stay readable.
    }
  };

  const loadIndex = async (): Promise<IndexEntry[]> => parseIndex(await safeGet(indexKey));

  /** Least recently used first, never `keep`, until both bounds hold. */
  const evict = async (entries: IndexEntry[], keep: string): Promise<IndexEntry[]> => {
    const kept = [...entries].sort((a, b) => a.u - b.u);
    let total = kept.reduce((sum, entry) => sum + entry.b, 0);
    while (kept.length > maxSessions || total > maxBytes) {
      const index = kept.findIndex((entry) => entry.s !== keep);
      if (index === -1) break;
      const [dropped] = kept.splice(index, 1);
      total -= dropped.b;
      await safeRemove(`${prefix}${dropped.s}`);
    }
    return kept;
  };

  const touch = (scope: string) => {
    void enqueue(async () => {
      const entries = await loadIndex();
      const entry = entries.find((candidate) => candidate.s === scope);
      if (!entry) return;
      entry.u = now();
      await saveIndex(entries);
    });
  };

  const forgetScope = (scope: string) =>
    enqueue(async () => {
      await safeRemove(`${prefix}${scope}`);
      const entries = await loadIndex();
      const kept = entries.filter((entry) => entry.s !== scope);
      if (kept.length !== entries.length) await saveIndex(kept);
    });

  return { indexKey, safeGet, safeRemove, enqueue, loadIndex, saveIndex, evict, touch, forgetScope };
}

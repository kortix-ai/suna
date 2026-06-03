'use client';

/**
 * Centralized, quota-resilient localStorage.
 *
 * The whole origin shares ONE ~5–10MB localStorage bucket. Every store, cache
 * and feature flag writes into it. Historically a few caches were keyed by the
 * *ephemeral* per-sandbox server id (`kortix_cache_sessions:<serverId>`, …) and
 * never evicted — so every new session minted a fresh set of keys that piled up
 * forever. Eventually the bucket saturated and the *next* `setItem` from *any*
 * store threw `QuotaExceededError` synchronously, crashing whatever happened to
 * write next (often something tiny and innocent, like the tab list).
 *
 * This module is the single chokepoint that keeps the bucket healthy:
 *
 *  1. `safeSetItem` NEVER throws. On a quota error it reclaims space by evicting
 *     the oldest *disposable* cache entries (across every registered family),
 *     then retries — and if it still can't fit, it gives up silently instead of
 *     crashing the UI. Losing a disposable cache is free; it just refetches.
 *  2. `ScopedCache` is the right way to write a per-scope cache: it stamps each
 *     entry with a timestamp and prunes its family to the N most-recent scopes
 *     on every write, so an ephemeral key space can't grow unbounded.
 *  3. `createSafeJSONStorage` gives every zustand `persist` store the same
 *     never-throw guarantee, so no store can ever be the crash site again.
 *
 * Anything that should be sacrificed under memory pressure must register its
 * key family here (ScopedCache does this for you). Durable user preferences are
 * deliberately NOT registered, so they survive a reclaim.
 */

import { createJSONStorage, type StateStorage } from 'zustand/middleware';

/** Registered prefixes for caches that are safe to evict to reclaim quota. */
const disposableFamilies = new Set<string>();
/** Registered exact keys (single-blob caches) that are safe to evict. */
const disposableKeys = new Set<string>();

/**
 * Register a `<prefix>:<scope>` key family as disposable. Entries under it may
 * be evicted (oldest first) when the bucket is full. Idempotent.
 */
function registerDisposableFamily(prefix: string): void {
  disposableFamilies.add(prefix);
}

/**
 * Register a single exact key (a self-contained cache blob, e.g. an internally
 * LRU'd map) as disposable. These are evicted only as a LAST resort — after
 * every scoped-family entry — since they tend to be already-bounded and more
 * valuable than a stale per-sandbox snapshot. Idempotent.
 */
export function registerDisposableKey(key: string): void {
  disposableKeys.add(key);
}

function hasWindow(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

/** Every localStorage key currently present (snapshot — safe to mutate during). */
function allKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null) keys.push(k);
  }
  return keys;
}

/** A scope key belongs to a family iff it starts with `<family>:`. */
function keyBelongsToFamily(key: string, family: string): boolean {
  return key.startsWith(`${family}:`);
}

/**
 * Read the timestamp a ScopedCache stamped into an entry. Legacy / foreign
 * entries (raw arrays, un-stamped values) report 0 so they're evicted first.
 */
function entryTimestamp(raw: string | null): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as { t?: unknown } | null;
    return parsed && typeof parsed.t === 'number' ? parsed.t : 0;
  } catch {
    return 0;
  }
}

/**
 * All disposable entries currently in storage, oldest first. Used both for the
 * under-pressure reclaim and as the eviction order for any single family.
 */
function disposableEntriesOldestFirst(): Array<{ key: string; t: number }> {
  const entries: Array<{ key: string; t: number }> = [];
  for (const key of allKeys()) {
    if (disposableKeys.has(key)) {
      // Exact-key blobs are evicted last (sort to the end).
      entries.push({ key, t: Number.MAX_SAFE_INTEGER });
      continue;
    }
    for (const family of disposableFamilies) {
      if (keyBelongsToFamily(key, family)) {
        entries.push({ key, t: entryTimestamp(localStorage.getItem(key)) });
        break;
      }
    }
  }
  return entries.sort((a, b) => a.t - b.t);
}

/**
 * Write to localStorage without ever throwing. On a quota error, evict the
 * oldest disposable entries one at a time, retrying after each eviction, until
 * the write fits or there's nothing left to drop. The key being written is
 * never evicted. Returns whether the value was ultimately persisted.
 */
export function safeSetItem(key: string, value: string): boolean {
  if (!hasWindow()) return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // Likely QuotaExceededError. Reclaim space from disposable caches.
    const victims = disposableEntriesOldestFirst().filter((e) => e.key !== key);
    for (const victim of victims) {
      try {
        localStorage.removeItem(victim.key);
      } catch {
        /* ignore — try the next victim */
      }
      try {
        localStorage.setItem(key, value);
        return true;
      } catch {
        /* still over quota — keep evicting */
      }
    }
    return false;
  }
}

function safeGetItem(key: string): string | null {
  if (!hasWindow()) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeRemoveItem(key: string): void {
  if (!hasWindow()) return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Every ScopedCache constructed this session — drives the global boot sweep. */
const registeredCaches: ScopedCache<unknown>[] = [];

interface Wrapped<T> {
  /** The cached value. */
  v: T;
  /** Write timestamp (ms) — drives LRU eviction. */
  t: number;
}

/**
 * A localStorage-backed cache for data keyed by a *scope* (a server id, a
 * directory, `'global'`, …). Each family is automatically capped to its
 * `maxScopes` most-recently-written scopes, so an ephemeral scope space (e.g.
 * per-sandbox server ids) can never grow without bound. Entries are also
 * globally evictable under quota pressure (the family is registered as
 * disposable on construction).
 *
 * Values are stored wrapped as `{ v, t }`; callers see only the unwrapped
 * value. Legacy un-wrapped entries from before this layer existed simply read
 * as a miss (and get rewritten in the new shape on the next set).
 */
export class ScopedCache<T> {
  private readonly family: string;
  private readonly maxScopes: number;

  constructor(family: string, maxScopes: number) {
    if (maxScopes < 1) throw new Error('ScopedCache maxScopes must be >= 1');
    this.family = family;
    this.maxScopes = maxScopes;
    registerDisposableFamily(family);
    registeredCaches.push(this as ScopedCache<unknown>);
  }

  private keyFor(scope: string): string {
    return `${this.family}:${scope}`;
  }

  get(scope: string): T | undefined {
    const raw = safeGetItem(this.keyFor(scope));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Wrapped<T> | null;
      // Only honor entries written in the wrapped shape; anything else is a miss.
      if (parsed && typeof parsed === 'object' && 't' in parsed) {
        return parsed.v;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  set(scope: string, value: T): void {
    if (!hasWindow()) return;
    const wrapped: Wrapped<T> = { v: value, t: Date.now() };
    safeSetItem(this.keyFor(scope), JSON.stringify(wrapped));
    this.prune();
  }

  remove(scope: string): void {
    safeRemoveItem(this.keyFor(scope));
  }

  /** Drop all but the `maxScopes` most-recently-written scopes in this family. */
  prune(): void {
    if (!hasWindow()) return;
    const entries: Array<{ key: string; t: number }> = [];
    for (const key of allKeys()) {
      if (keyBelongsToFamily(key, this.family)) {
        entries.push({ key, t: entryTimestamp(localStorage.getItem(key)) });
      }
    }
    if (entries.length <= this.maxScopes) return;
    entries
      .sort((a, b) => b.t - a.t) // newest first
      .slice(this.maxScopes) // everything past the cap
      .forEach((e) => safeRemoveItem(e.key));
  }
}

/**
 * Prune every ScopedCache constructed so far back to its cap. Safe to call on
 * boot to reclaim space left by older builds that never evicted. Only sees
 * caches whose modules have loaded — but those are the large per-sandbox
 * families, and they're imported as soon as the app shell mounts.
 */
export function pruneAllRegisteredCaches(): void {
  if (!hasWindow()) return;
  for (const cache of registeredCaches) cache.prune();
}

/**
 * Shared zustand `StateStorage` that never throws. Every `persist(...)` store
 * should route through this via `createSafeJSONStorage()` so a full bucket
 * degrades to "preferences didn't save" instead of crashing the render.
 */
const safeLocalStorage: StateStorage = {
  getItem: (name) => safeGetItem(name),
  setItem: (name, value) => {
    safeSetItem(name, value);
  },
  removeItem: (name) => safeRemoveItem(name),
};

/** Drop-in replacement for `createJSONStorage(() => localStorage)`. */
export function createSafeJSONStorage<S>() {
  return createJSONStorage<S>(() => safeLocalStorage);
}

/**
 * Cross-tab registry of warm-session ids this BROWSER has already taken.
 *
 * Why it exists: the server deliberately reuses one warm session per user per
 * project (`apps/api/src/projects/routes/warm-sessions.ts`), so every tab the
 * user has open on a project holds the SAME session id in its in-memory ready
 * store (`use-warm-project-session.ts`). The moment one tab takes it for a
 * send, every other tab's held copy silently points at a session that now has
 * a conversation in it — and a later send from one of those tabs would land a
 * new prompt inside that old conversation. The in-memory `takenSessionIds`
 * defense (JAY-596/T20) cannot see across tabs; this registry is the shared
 * half of it.
 *
 * localStorage is the medium because it is the only synchronous cross-tab
 * channel: `takeWarmSessionEntry` must stay network-free and synchronous, so
 * the staleness check has to be a sync read. The `storage` event doubles as
 * the push channel — it fires in every OTHER tab on write, letting them drop
 * a now-stale ready entry and replenish while the user is still present.
 *
 * Scope and limits: per-browser only. Two different browsers/devices of the
 * same user can still race a take; that window is the seconds between one
 * device's take and the server's own marker drop at `/start`, versus the
 * minutes-to-hours a stale tab used to hold. Entries are pruned by age and
 * count because the server never re-offers a session once its warm marker
 * drops (~1s after a take), so old entries protect nothing.
 */

export interface WarmTakenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WarmTakenRegistry {
  has(sessionId: string): boolean;
  record(sessionId: string): void;
}

export const WARM_TAKEN_STORAGE_KEY = 'kortix:warm-session-taken:v1';

/** Drop entries older than this — the server-side marker drop makes a taken id
 *  unofferable within seconds, so a day is generous. */
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard cap so a pathological loop can never bloat the payload. */
const MAX_ENTRIES = 64;

type Entry = [id: string, atMs: number];

function parseEntries(raw: string | null): Entry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Entry =>
        Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number',
    );
  } catch {
    return [];
  }
}

function pruneEntries(entries: Entry[], nowMs: number): Entry[] {
  const fresh = entries.filter(([, at]) => nowMs - at < ENTRY_TTL_MS);
  fresh.sort((a, b) => a[1] - b[1]);
  return fresh.slice(-MAX_ENTRIES);
}

export function createWarmTakenRegistry(
  storage: WarmTakenStorage | null,
  now: () => number = Date.now,
): WarmTakenRegistry {
  // Mirror of everything THIS registry recorded, so a missing or throwing
  // storage degrades to exactly the old per-tab behavior instead of breaking.
  const memory = new Set<string>();

  const read = (): Entry[] => {
    if (!storage) return [];
    try {
      return parseEntries(storage.getItem(WARM_TAKEN_STORAGE_KEY));
    } catch {
      return [];
    }
  };

  return {
    has(sessionId) {
      if (memory.has(sessionId)) return true;
      return read().some(([id]) => id === sessionId);
    },
    record(sessionId) {
      memory.add(sessionId);
      if (!storage) return;
      try {
        const entries = read().filter(([id]) => id !== sessionId);
        entries.push([sessionId, now()]);
        storage.setItem(WARM_TAKEN_STORAGE_KEY, JSON.stringify(pruneEntries(entries, now())));
      } catch {
        // Quota/privacy-mode failures leave the in-memory mirror as the
        // defense — same coverage the app had before this registry existed.
      }
    },
  };
}

/**
 * The ids a `storage` event ADDED to the registry — i.e. the takes some OTHER
 * tab just made. Pure so the event wiring stays a one-liner and this logic is
 * testable without a window.
 */
export function takenIdsAddedByStorageEvent(event: {
  key: string | null;
  oldValue: string | null;
  newValue: string | null;
}): string[] {
  if (event.key !== WARM_TAKEN_STORAGE_KEY) return [];
  const before = new Set(parseEntries(event.oldValue).map(([id]) => id));
  return parseEntries(event.newValue)
    .map(([id]) => id)
    .filter((id) => !before.has(id));
}

function safeLocalStorage(): WarmTakenStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let appRegistry = createWarmTakenRegistry(safeLocalStorage());

/** The app-wide registry every real caller shares. */
export const warmTakenRegistry: WarmTakenRegistry = {
  has: (sessionId) => appRegistry.has(sessionId),
  record: (sessionId) => appRegistry.record(sessionId),
};

/**
 * Test hook: drop the app-wide registry's in-memory mirror. bun runs every
 * suite in one process, so without this a take recorded by one test leaks
 * into the next — the same reason the warm-session store is reset in
 * `beforeEach`. Production code never calls it.
 */
export function resetWarmTakenRegistry(): void {
  appRegistry = createWarmTakenRegistry(safeLocalStorage());
}

/**
 * Notify `listener` of every warm-session take made by ANOTHER tab. Returns an
 * unsubscribe. A no-op outside a browser (SSR, tests).
 */
export function subscribeToExternalWarmTakes(listener: (sessionId: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    for (const id of takenIdsAddedByStorageEvent(event)) listener(id);
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

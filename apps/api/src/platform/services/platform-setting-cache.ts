/**
 * A 30s-TTL cached reader over ONE `kortix.platform_settings` row.
 *
 * Every consumer of an instance-global setting reads through a sync accessor,
 * because the hot paths that need one (App-JWT signing, git backend auth)
 * cannot block on the database. The cache refreshes in the background; a cold
 * cache, a missing row, or a database hiccup resolves to the parser's
 * "nothing stored" value, so a deployment configured purely by env vars never
 * waits on the database at all.
 *
 * Shared by `github-app-identity.ts` and `managed-git-backend.ts` so the two
 * cannot drift on TTL, refresh, or write-then-read semantics.
 */

const TTL_MS = 30_000;

export interface CachedPlatformSetting<T> {
  /** Sync read. Serves the cached value and refreshes in the background. */
  read(): T;
  /** Force a fresh database read into the cache. Never throws. */
  refresh(): Promise<void>;
  /** Drop the cache so the next read refetches. */
  invalidate(): void;
  /** Overwrite the row, then await a cache refresh. */
  write(value: unknown): Promise<void>;
  /** Delete the row, then await a cache refresh. */
  clear(): Promise<void>;
  /** Test-only: seed the cache without a database. */
  __setForTests(value: unknown): void;
}

export function createCachedPlatformSetting<T>(
  key: string,
  parse: (value: unknown) => T,
): CachedPlatformSetting<T> {
  let cache: { value: T; at: number } | null = null;
  let inflight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    let value: T = parse(undefined);
    try {
      const { hasDatabase, db } = await import('../../shared/db');
      if (hasDatabase) {
        const { platformSettings } = await import('@kortix/db');
        const { eq } = await import('drizzle-orm');
        const [row] = await db
          .select({ value: platformSettings.value })
          .from(platformSettings)
          .where(eq(platformSettings.key, key))
          .limit(1);
        value = parse(row?.value);
      }
    } catch {
      /* database hiccup -> "nothing stored"; consumers fall back to env */
    }
    cache = { value, at: Date.now() };
  }

  function ensureFresh(): void {
    if (cache && Date.now() - cache.at < TTL_MS) return;
    if (!inflight) {
      inflight = refresh().finally(() => {
        inflight = null;
      });
    }
  }

  async function persist(value: unknown | null): Promise<void> {
    const { hasDatabase, db } = await import('../../shared/db');
    if (!hasDatabase) {
      throw new Error(`Database not configured — cannot store platform setting "${key}"`);
    }
    const { platformSettings } = await import('@kortix/db');
    const { eq } = await import('drizzle-orm');
    if (value === null) {
      await db.delete(platformSettings).where(eq(platformSettings.key, key));
    } else {
      await db
        .insert(platformSettings)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: platformSettings.key,
          set: { value, updatedAt: new Date() },
        });
    }
    cache = null;
    await refresh();
  }

  return {
    read(): T {
      ensureFresh();
      return cache ? cache.value : parse(undefined);
    },
    refresh,
    invalidate(): void {
      cache = null;
    },
    write: (value: unknown) => persist(value),
    clear: () => persist(null),
    __setForTests(value: unknown): void {
      cache = { value: parse(value), at: Date.now() };
    },
  };
}

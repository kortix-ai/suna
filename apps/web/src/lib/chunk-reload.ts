/**
 * One-shot recovery from a stale-deploy chunk failure.
 *
 * After a deploy, a tab still running the previous build requests chunk file
 * names that no longer exist, and the first lazy `next/dynamic` import
 * rejects — on /settings/profile that surfaced as an error page instead of
 * the panel. The App Router wraps `next/dynamic` in Suspense, so the
 * rejection never reaches `error.tsx`; and the dev turbopack loader leaves a
 * failed import pending forever instead of rejecting. The fix that covers
 * both lives at the loader: a rejected or hung import is a dead chunk —
 * reload the tab once (a fresh load requests the current build's chunks) and
 * hold the Suspense boundary while the navigation runs. The sessionStorage
 * guard is the loop brake: one auto-reload per 45 s per tab, so a chunk
 * failure that survives the reload lands on the existing error card instead
 * of spinning.
 */

const RELOAD_COOLDOWN_MS = 45_000;
const IMPORT_HANG_TIMEOUT_MS = 15_000;
const RELOAD_GUARD_KEY = 'kortix.staleChunkReloadAt';

/** A stale-deploy chunk failure: webpack's ChunkLoadError, or the browser's
 *  native message for a dynamic import it could not fetch. */
export function isChunkLoadError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'ChunkLoadError') return true;
    return /failed to fetch dynamically imported module|loading chunk \d+ failed/i.test(
      error.message,
    );
  }
  return false;
}

/** Reload the tab once per 45 s: true when the navigation started, false when
 *  the guard refuses — a reload this tab already made recently (no loop), no
 *  `window` on the server, or storage unavailable (no brake, no reload). */
export function reloadForStaleChunk(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
    if (last && Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/**
 * Wrap a `next/dynamic` loader with the one-shot stale-chunk recovery.
 *
 * A rejected import recovers when it matches `isChunkLoadError`; a hung one
 * (the dev loader) is treated as dead after 15 s — ponytail: a healthy import
 * slower than that reloads once, then the guard brakes; raise the timeout if
 * slow-network users report a needless reload. Any other rejection goes
 * straight to the existing error card, and so does a recovery the guard
 * refuses.
 */
export function withStaleChunkRecovery<T>(loader: () => Promise<T>): () => Promise<T> {
  return () => {
    let hung = false;
    const attempt = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        hung = true;
        reject(new Error('lazy chunk did not settle within 15s'));
      }, IMPORT_HANG_TIMEOUT_MS);
      loader().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    return attempt.then(undefined, (error: unknown) => {
      if (!hung && !isChunkLoadError(error)) throw error;
      if (!reloadForStaleChunk()) throw error;
      // Hold the Suspense boundary with a promise that never settles while
      // the reload tears the page down, so no error card flashes first.
      return new Promise<T>(() => {});
    });
  };
}

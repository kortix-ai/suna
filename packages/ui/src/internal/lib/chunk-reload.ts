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

import { isChunkLoadError as isChunkFailure, reloadForStaleChunk } from './chunk-load-recovery';

export { reloadForStaleChunk };

export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && isChunkFailure(error);
}

const IMPORT_HANG_TIMEOUT_MS = 15_000;

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

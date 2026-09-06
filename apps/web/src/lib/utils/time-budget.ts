/**
 * A wall clock for an `await` that has no ceiling of its own.
 *
 * This exists because of one concrete, reachable hang. `openDB()` in
 * `packages/sdk/src/browser/cache/idb-sync-cache.ts` registers
 * `onupgradeneeded`, `onsuccess` and `onerror` but NO `onblocked`, and the file
 * has no `onversionchange` handler either (`grep -c` returns 0 for both). An
 * `indexedDB.open` that needs a version upgrade while another tab still holds a
 * connection at the older version fires `blocked` and then NEITHER `success`
 * NOR `error` — the promise never settles. `DB_VERSION` has been bumped twice
 * in this repo, so a tab left open on the pre-bump bundle is all it takes. The
 * promise is memoized in `dbPromise`, so every later caller in that document
 * parks behind it too.
 *
 * `try`/`catch` cannot rescue a promise that never settles. Only a clock can.
 *
 * Never rejects: a rejection from `work` is reported as `failed`, not thrown,
 * so a caller can decide what a failure means without a second `try`.
 */

/** Milliseconds any single step may hold up a user-visible outcome. */
export const DEFAULT_TIME_BUDGET_MS = 2000;

export type BudgetOutcome<T> =
  | { status: 'settled'; value: T }
  | { status: 'failed'; error: unknown }
  | { status: 'timeout' };

/**
 * Resolve when `work` settles, or when `budgetMs` elapses — whichever is first.
 *
 * A timeout does NOT cancel `work`; nothing can cancel an in-flight IndexedDB
 * request. It only stops the caller waiting on it. Anything that must be true
 * before the caller proceeds has to happen SYNCHRONOUSLY before the awaited
 * step, not inside it.
 */
export function withTimeBudget<T>(
  work: Promise<T>,
  budgetMs: number = DEFAULT_TIME_BUDGET_MS,
): Promise<BudgetOutcome<T>> {
  return new Promise<BudgetOutcome<T>>((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'timeout' }), budgetMs);
    const finish = (outcome: BudgetOutcome<T>) => {
      clearTimeout(timer);
      // `resolve` after a timeout is a no-op, so a late settle is harmless.
      resolve(outcome);
    };
    work.then(
      (value) => finish({ status: 'settled', value }),
      (error) => finish({ status: 'failed', error }),
    );
  });
}

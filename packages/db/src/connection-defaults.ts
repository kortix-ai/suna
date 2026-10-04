/**
 * Default postgres.js main-pool limit for one Kortix API process.
 *
 * 5, not 6 (2026-09-27 incident): one connection of the former 6 was silently
 * spent by the base-move LISTEN/NOTIFY subscription
 * (`apps/api/src/lib/pg-broadcast.ts`), which `database-capacity.ts` did not
 * count. See `apps/api/src/lib/database-capacity.ts` for the full rolling-
 * deployment budget this feeds.
 */
export const DEFAULT_DB_POOL_MAX = 5;

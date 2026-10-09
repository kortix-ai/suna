/**
 * Default postgres.js main-pool limit for one Kortix API process.
 *
 * 5 (2026-09-27 incident): one connection of the former 6 was silently spent
 * by the base-move LISTEN/NOTIFY subscription (`apps/api/src/shared/pg-broadcast.ts`),
 * which `database-capacity.ts` did not count — the same deploy produced
 * SQLSTATE `53300` until the ceiling counted every pool.
 *
 * 6 (KRTX-2020): the first raise inside the request-concurrency budget. The
 * budget is the rolling-deployment envelope in `apps/api/src/shared/database-capacity.ts`:
 * 10 tasks × 2× rolling overlap × (6 + 2 + 1 + 1) = 200 ≤ 205 API connections
 * (237 usable minus the 32 non-API reserve). The headroom came from moving the
 * boot schema probe onto this same pool (it no longer opens its own transient
 * client). Raise ONE pool per change and re-run that module's test plus the
 * prod re-check in the learnings ledger before the next one; the next raise
 * does not fit the current budget and needs the infra lane.
 */
export const DEFAULT_DB_POOL_MAX = 6;

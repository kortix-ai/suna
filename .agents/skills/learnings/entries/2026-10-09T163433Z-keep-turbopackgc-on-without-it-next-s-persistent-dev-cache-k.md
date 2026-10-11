---
recorded: 2026-10-09T16:34:33Z
incident_date: 2026-10-09
---
# Keep turbopackGc on: without it Next's persistent dev cache keeps every task it ever computed and fills the disk

**Rule:** Keep `experimental.turbopackGc: true` in `apps/web/next.config.ts`. Before Next 16.4 the option did not exist, and its default is still `false`. Without it, Turbopack's persistent dev cache (`apps/web/.next/dev/cache/turbopack/<version>/`) keeps every task it ever computed, and every `git merge origin/dev` adds a new set. When the disk fills, delete that directory in an idle worktree. It is a cache: the cost is one cold compile.

**Trigger surface:** Upgrading Next, editing the `experimental` block of `next.config.ts`, setting `KORTIX_TURBOPACK_EVICTION=false` (Turbopack skips GC in long read-write sessions when memory eviction is off), or a developer machine near a full disk with many worktrees.

**Incident:** 2026-10-09, Next 16.3.6. A developer Mac reached 583 MB free of 927 GB. One idle worktree's `.next` was 61.7 GB. In another, the cache grew 17.2 GB on 10-07 and 4.7 GB on 10-08. A fresh cache is about 1 GB. The cache's own LOG proved no orphaned files: 278 SST files on disk, 278 live (2,163 written, 1,885 compacted and deleted), so the 21 GB was retained live data. A merge replay of 3 days of `dev` history (6 merges) grew the 16.3.6 cache from 1,228 MB to 1,416 MB. On 16.4.0 with GC it went from 835 MB to 955 MB, and GC cut 101 MB mid-session.

**Enforcement:** `apps/web/src/config/turbopack-gc.test.ts` fails when `turbopackGc: true` leaves `next.config.ts` (the `packages` lane of `pnpm test`). Turbopack prunes cache directories of other Next versions on its own (`db_versioning.rs`: it keeps the current one plus one other used in the last 3 days).

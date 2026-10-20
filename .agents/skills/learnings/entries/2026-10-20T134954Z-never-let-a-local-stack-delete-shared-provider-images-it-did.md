---
recorded: 2026-10-20T13:49:54Z
incident_date: 2026-10-20
---
# Never let a local stack delete shared provider images it did not build

**Rule:** A process that reads its own database must not delete provider resources other environments can boot from. A local stack (`KORTIX_LOCAL_DEV=1`) runs as `INTERNAL_KORTIX_ENV=dev` on dev's provider organisation, so any reap keyed on a name namespace plus a local "recently built" lookup must skip on a local stack.

**Trigger surface:** Adding or changing a provider image/snapshot reap or GC in `apps/api/src/snapshots/`, or running `pnpm worktree start` / `scripts/dev-local.sh` against real sandbox providers.

**Incident:** 2026-10-20 (KRTX-2546, reported 2026-10-16). One worktree's local stack logs held 30+ `[snapshots] meta: reaped superseded kortix-meta-dev-*` lines across its starts that day. `reapSupersededMetaSnapshots` keeps only the name it just built, and its protection lookup reads the local database, which never sees deployed dev's builds. Deployed dev caches its resolved meta image per process (`metaImageBuilds`), so a deleted live image breaks dev's meta sandbox creation until the API restarts. Three deletes were refused with `409 build_in_progress`; whether any deleted image was dev's live one at that moment is unknown.

**Enforcement:** `apps/api/src/snapshots/meta-snapshot-reap.test.ts`, "a local stack deletes no image": with `config.KORTIX_LOCAL_DEV` true, the reap deletes nothing. Deployed dev's own reap still removes the images local stacks leave behind.

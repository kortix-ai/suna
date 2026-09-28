---
recorded: 2026-09-25T23:21:02Z
incident_date: 2026-09-25
---
# A per-project git mirror on per-task ephemeral disk can permanently lose a tree after a repository replacement; the archive route must fall back to the content-addressed store

**Rule:** When a route decides "does this artifact exist?" by probing a
per-replica local cache (a bare git mirror on ECS task-local disk, keyed only
by project ID), never treat a cache miss as a final 404 if a durable,
content-addressed store might hold the same object under a caller-scoped key.
Try the store before answering not-found — the store key already proves
ownership, so it needs no cache confirmation.

**Trigger surface:** Serving a derived/cached artifact (a config archive, a
generated file, a compiled bundle) from a route that gates on a local
warm-cache check first and a shared object store second, on infrastructure
with more than one replica and no shared cache volume. Any operation that
replaces a resource's upstream origin with unrelated history is a redline: a
future fetch of the new origin can never regenerate the old cache entry, so a
cold replica's local cache permanently lacks it.

**Incident:** 2026-09-25, staging release gate run 36188978457 (`b6872877`,
`CONFIG_RELEASES_ENABLED=true`, #7691). `CFG-7` failed: "the project's own
stored archive: 404". `serveConfigArchive`
(`apps/api/src/config-releases/serve-archive.ts`) gated on
`isTreeObject(mirror, treeId)` before ever consulting the S3 store. After a
project's git origin is replaced with a second, unrelated repository, the OLD
config tree is unreachable from the new origin's history — no fetch
regenerates it. The bare mirror lives on per-ECS-task ephemeral disk
(`apps/api/src/projects/git/mirror.ts`, `repoCachePath` keyed only by
`projectId`), not shared across replicas, so a replica whose mirror never
warmed before the replacement clones straight from the CURRENT origin and can
never contain the old tree — a permanent 404 there, even though the archive
was durably stored in S3 under the project's own key. No user impact: caught
by the CFG-7 flow before the feature reached prod (`CONFIG_RELEASES_ENABLED`
stays off on prod). Fix: PR #7701.

**Enforcement:** `apps/api/src/config-releases/serve-archive.test.ts` — "CFG-7:
a tree the mirror no longer has (repository replaced) still serves from the
store" and its 404-when-both-miss sibling. `tests/src/flows/config-releases.flow.ts`
`CFG-7` proves it end to end against a real replaced repository.

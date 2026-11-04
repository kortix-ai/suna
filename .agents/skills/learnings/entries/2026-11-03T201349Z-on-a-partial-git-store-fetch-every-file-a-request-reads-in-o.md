---
recorded: 2026-11-03T20:13:49Z
incident_date: 2026-11-03
---
# On a partial git store, fetch every file a request reads in one batch, never one fetch per file

**Rule:** On a partial project store (`object-store.ts`), a code path that reads
N files fetches them in one request before it reads them: `prefetchRepoFiles`
for files by path, `ensureStoreObjects` for blob ids. Fetches into one store run
one at a time under the store lock, so N single-file reads cost N round trips to
the host (~0.5 s each from GitHub), even inside `Promise.all`. Count fetches,
not git processes: on a fresh store, `GIT_TRACE2_EVENT` or the store's
`objects/pack/*.pack` count (one pack per fetch) gives the number.

**Trigger surface:** any loop or `Promise.all` over `readRepoFile`,
`readManifestFromRepo` with `imports:`, `ensurePathObjects` per path; adding a
new file read to `loadProjectConfig`, the agent config routes, or session boot.

**Incident:** 2026-11-03, dev, after #11492 (partial store, also in prod since
v0.14.17). An internal project with 8 manifest imports and 45 skills: the
project page stayed blank, `GET /v1/projects/:id/detail` returned `503
request_deadline` after 25 s, `Server-Timing: git;dur=24248;desc="n=116"`.
Local repro on a fresh store: 55 GitHub fetches, 25.8 s. Fix #11639
(cfed6b94ab): one fetch for the imported manifests, one for every `SKILL.md`;
cold 2.6 s, 4 fetches. Every cold store paid it: a new replica, a deploy, a
cache eviction.

**Enforcement:** `apps/api/src/projects/git/partial-store-config.test.ts`
asserts at most 5 packs for a cold `loadProjectConfig` over 4 imports and 20
skills (the old code wrote 27). Not covered: nested imports still fetch one list
at a time; other multi-file readers have no fetch-count test yet.

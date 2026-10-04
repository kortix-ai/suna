---
recorded: 2026-10-04T00:31:57Z
incident_date: 2026-09-29
---
# A read path that loads git-backed project resources bounds the load and fails open

**Rule:** A GET route that enumerates git-backed project resources (agents, skills, config) must load them through a bounded, cached read and degrade on a bound breach. Reuse the module's cached loader (`loadConfigWithFilesCached`, 20 s TTL + in-flight dedup) wrapped in the shared `withTimeout` at an explicit budget; catch the rejection with the same fail-open the config-load failure already gets. Never call the uncached `loadConfigWithFiles` from a read route: the git mirror is an LRU-evicted 4 GB cache, and an evicted project's next read cold-clones (90 s budget) or fetches (30 s per-op) inside the request — slow-but-successful git work logs nothing, so the hang is invisible until the request-deadline guard 503s. Write routes keep the fresh, unbounded load: a write must validate against a just-pushed commit.

**Trigger surface:** Any route under `apps/api/src/projects/routes/` (or a lib helper) that calls `loadConfigWithFiles`, `listRepoFiles`, or another mirror-reading call on a request path; review of a latency incident whose p95 sits at the request deadline with empty `upstream_ms`.

**Incident:** 2026-09-29, prod. `GET /v1/projects/:id/resource-grants` p95 reached 25005 ms with 20 × 503 in one day, every slow response pinned at the 25 s request deadline. The route's own tail: 29 instrumented slow reads all had the git-backed `config` stage largest (1.5–21.8 s, mean ≈ 6.8 s) while the DB stages stayed fast; the reaper's LRU eviction ran on every ~10-min sweep with the mirror cache pinned at its 4 GB budget. The same window was also the audit-ingest DB convoy (fixed separately). Fixed by KRTX-821 (PR #9046): the picker read is cached and bounded at 5 s (`KORTIX_RESOURCE_GRANTS_CONFIG_BUDGET_MS`).

**Enforcement:** `apps/api/src/__tests__/unit-resource-grants-config-bound.test.ts` — a hanging config loader must reject with `TimeoutError` at the budget and a timely one must resolve; it fails with `TypeError: route.loadPickerConfig is not a function` on a tree without the bound. Route-level lint: grep for `loadConfigWithFiles(` in read routes fails review when the caller is a GET handler.

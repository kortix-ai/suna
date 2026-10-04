---
recorded: 2026-10-03T22:45:17Z
incident_date: 2026-10-03
---
# Bound the git-backed project-config load under the request deadline; a hung remote must degrade, not 503

**Rule:** Every git-backed read inside a request path — `loadProjectConfig` above
all — runs under a wall-clock budget (`KORTIX_PROJECT_CONFIG_TIMEOUT_MS`, default
10 s). A mirror refresh failure never marks the mirror fresh, so every later read
in the same load pays the full per-op timeout × retry ladder again. Bound the whole
load, map the `TimeoutError` onto the retryable `GitOperationError`, and degrade
(`manifest_status: 'error'`) instead of 503-ing at the deadline.

**Trigger surface:** Any route that awaits `loadProjectConfig` or
`readRepoFile`/`readManifestFromRepo` (secrets, project detail, Slack selection,
resource pickers).

**Incident:** 2026-09-29 and 2026-10-03 (KRTX-819): after a mirror eviction, one
project's remote hung; the manifest stage of `GET /v1/projects/:id/secrets` measured
542474 ms in the slow-read warn — two stacked cold-clone ladders of 3×90 s + 500 ms
delays — while the client was 503'd at the 25 s deadline. Second occurrence of the
2026-09-30 stop-route rule, on a surface that rule's enforcer did not cover.

**Enforcement:** `apps/api/src/projects/git/config-load-timeout.test.ts`
("rejects in bounded time with a retryable GitOperationError", "a load error that
is not a timeout propagates unchanged").

---
recorded: 2026-09-26T15:56:35Z
incident_date: 2026-08-27
---
# A readiness probe must not be the thing that initializes the resource it probes

**Rule:** gate every directory/workspace-scoped request — including your own
readiness probe and any proxy's — until the workspace is genuinely complete
(checkout + dependency install + injected files). Do not overlap a slow step
(repo materialization) with a process start "to save wall-clock" if the thing
you start builds per-directory state lazily on its first request. If a
readiness probe fires that first request against an incomplete workspace, the
process caches the wrong state for its whole lifetime; only a restart repairs
it, never a reload/dispose call.

**Trigger surface:** any boot sequence that starts a long-lived process before
its working directory is fully materialized, and any liveness check that
targets a workspace-scoped route.

**Incident:** #6964 spawned OpenCode at `proxy-up`, before checkout finished.
OpenCode builds its per-directory tool registry (importing from that
directory's `node_modules`) on the first directory-scoped request; on any repo
whose materialization outlived OpenCode's HTTP start, the readiness probe
itself was that first request, and the registry cached against an empty
workspace — every turn then failed `Cannot find module '<tool dep>'`, unfixed
by any reload. A follow-up fix (#7002) shipped inert because its gate-open
landed inside the early-spawn block instead of after dependency install; the
regression test that should have caught it anchored on the first index after a
marker instead of the real sequence, and a duplicate assignment satisfied it.

**Enforcement:** `boot-instrumentation.test.ts` — the readiness gate is closed
on the early-spawn path and opens only after deps + skills are installed; the
early-spawn block is asserted free of the gate-open call. A source-order
assertion must anchor on the real sequence, never on the first index after a
marker.

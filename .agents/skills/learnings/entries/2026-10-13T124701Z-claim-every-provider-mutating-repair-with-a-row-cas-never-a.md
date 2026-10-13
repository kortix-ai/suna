---
recorded: 2026-10-13T12:47:01Z
incident_date: 2026-10-13
---
# Claim every provider-mutating repair with a row CAS, never a read-then-patch; per-replica dedupe does not serialize prod

**Rule:** A code path that stops, starts or relaunches a session's box takes its claim with one conditional UPDATE … RETURNING on `session_sandboxes`. It also refuses while another live claim on that box holds (wake, restart, stop, repair). A per-replica `Set` dedupes one process only. A JS check on a metadata snapshot followed by a plain patch is not a lock.

**Trigger surface:** adding or changing a lifecycle claim (`claimInPlaceRestart`, `resumeStoppedSandbox`, the stop claim) or a background repair that calls `provider.start/stop/exec` (`legacy-runtime-bootstrap`, the wake ladder in `session-control-reconciler.ts`).

**Incident:** 2026-10-13, prod, 2 sessions in one internal project, each took ~5–6 min to open. (1) The server wake ladder sent `/restart` while a wake claim held its lease. The restart called `provider.stop()` on the box the wake was starting. The two Platinum `/start` calls then failed each other (`409 sandbox not stopped/archived`, `503 relocation_failed`), and each failed restart parked the session. (2) When the box ran, 4 concurrent `/start` polls on 4 API replicas each fired the legacy runtime bootstrap. The read-then-patch `running` record did not serialize them. Each run killed the daemon and launched `/sbin/pt-app`. 4 supervisors fought over `:8000`. The entrypoint's 2-strike guard rolled the agent back and pinned updates off (`blocked`), and 3 chains crash-looped every ~5 s until they were killed by hand.

**Enforcement:** `apps/api/src/__tests__/integration-legacy-bootstrap-claim.test.ts` (4 racing claims → 1 winner) and `integration-session-status-transitions.test.ts` ("never claims a stopped row under a live wake claim"). Both run in the `db-suites` lane. In the box, `apps/sandbox/entrypoint.sh` takes `flock` on `$AGENT_STATE_DIR/supervisor.lock`, so a second supervisor launches nothing (`apps/sandbox/scripts/test-entrypoint-swap.sh`, "a second supervisor on the same box launches no daemon"; run it in a Linux container). `platinum-start-restore.test.ts` pins that a provider start joins another caller's start instead of failing after the 30 s grace.

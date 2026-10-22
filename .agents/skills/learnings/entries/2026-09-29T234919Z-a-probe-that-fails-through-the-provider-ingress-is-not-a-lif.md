---
recorded: 2026-09-29T23:49:19Z
incident_date: 2026-09-29
---
# A probe that fails through the provider ingress is not a lifecycle fact; only a stop, a wake, a new sandbox, or the box's own loopback may take a live session out of ready

**Rule:** Three rules.

1. Client: once `/start` answered `ready`, a failed poll (`null`) or a transport `starting` (`unreachable`, `runtime_status_unknown`, `runtime_stop_unconfirmed`) keeps the live answer (`holdLiveStart`). The event stream owns transport recovery.
2. `/start`: a box whose daemon answered after its current boot epoch (`runtimeProvenAt`) answers `ready` through a probe miss and is never parked for one (`servesThroughProbeMiss`).
3. A dead-daemon relaunch decided through the ingress asks the box's loopback (`127.0.0.1:8000/kortix/health`) over provider exec first. A daemon that answers there ends the pass before any record, token or script.

**Trigger surface:** Any code that turns an ingress/proxy/probe failure into a stage, a park, a stop, a relaunch or a UI state: `runOpenSession`, `bootstrapLegacyRuntime`, `useSession`'s `/start` query, health probes.

**Incident:** 2026-09-29, prod, a healthy Platinum box. ~18 min of API→edge connect timeouts and header-less `503`s. `/start` answered `starting` with a `null` pin, and the web closed the live stream mid-answer. At 21:48 `/start` requested a dead-daemon relaunch of a healthy daemon. 83 sessions in 22 accounts logged the same probe miss in 24 h. On Daytona/E2B the 30 s stale budget parks the box and settles the open turn as `runtime_gone`. PR on branch `session-stays-alive`.

**Enforcement:**

- `packages/sdk/src/react/hold-live-start.test.ts` and `use-session-runtime-gate.test.ts` (the query folds through `holdLiveStart`).
- `readiness-clocks.test.ts` (`servesThroughProbeMiss`, and a stop strips the proof).
- `e2e-project-session-contract.test.ts` ("a probe miss on a box proven this boot keeps answering ready").
- `legacy-runtime-bootstrap.test.ts` (loopback probe before any record, token or script).
- Verified on a real local Platinum box: 120 s ingress blackout mid-turn (policy route drops `sport 8000`). 17/17 `/start` answered `ready`, the daemon pid was unchanged, and the turn completed without a reload.

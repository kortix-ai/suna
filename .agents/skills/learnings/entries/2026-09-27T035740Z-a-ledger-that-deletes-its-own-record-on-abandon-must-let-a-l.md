---
recorded: 2026-09-27T03:57:40Z
incident_date: 2026-09-26
---
# A ledger that deletes its own record on abandon must let a later genuine completion revive it

**Rule:** when a state machine writes a terminal "never happened"
verdict (e.g. `abandoned`) by DELETING the in-progress record it closes,
build in a correction path: if a genuine completion for the exact same
identity arrives later, overwrite the stale verdict instead of silently
short-circuiting on "already ended". Otherwise any false negative from
ANY writer — not just the one you just fixed — poisons that row forever.

**Trigger surface:** any turn/job/task ledger where a "never delivered"
verdict is written by a DIFFERENT code path than the one that later reports
success, and the two paths do not share a lock or a single source of truth
at write time.

**Incident:** the sandbox daemon's boot-time delivery check
(`reconcileInitialTurnAcceptanceToApi`, since fixed on `main` with a
15-minute deferred-verdict window via `awaitingPickup`) raced OpenCode's own
message-store write and reported `turn_abandoned` — which
`abandonSandboxTurn` deletes outright. 73 sessions/72h, 15 of 19
transcript-checked had actually completed. Even with the daemon race closed,
nothing else in the ledger corrected a false `abandoned` if some OTHER path
produced one.

**Enforcement:** `completeSandboxTurn`'s `reviveAbandonedTurnOnCompletion`
(`apps/api/src/projects/sandbox-turn-lifecycle.ts`) — a genuine idle/error
completion for a message the ledger already marked `abandoned` overwrites it
with the real outcome, gated to exact identity match and never on an
abort-only signal. Tests in `sandbox-turn-lifecycle.test.ts`.

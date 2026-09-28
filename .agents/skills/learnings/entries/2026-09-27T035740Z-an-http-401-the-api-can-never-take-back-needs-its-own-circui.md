---
recorded: 2026-09-27T03:57:40Z
incident_date: 2026-09-27
---
# An HTTP 401 the API can never take back needs its own circuit breaker, separate from retry/backoff

**Rule:** a daemon/agent process that calls a control-plane API on a loop
must distinguish "this failure might be transient, retry it" from "this
failure can never resolve itself" (e.g. `401 Session token is not active`
once a session is closed) and trip a SEPARATE counter that stops the process
— a patient exponential backoff on the wrong error just hammers politely
forever.

**Trigger surface:** any daemon-side HTTP client loop that already has a
transient-failure backoff (retry ladder, exponential delay) against a
control-plane API — check whether it also needs a permanent-failure
detector for the one response the server can never retract.

**Incident:** 76h prod window (see the provider `stop()` entry): three call
sites in `apps/kortix-sandbox-agent-server` (`turn-stream` begin/end,
`audit/events`, `runtime-assets/manifest`) each had their own transient-
failure backoff and none of them ever gave up permanently.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/session-token-health.ts`
(shared dead-token streak, wired to the daemon's own graceful `shutdown()`);
`apps/kortix-sandbox-agent-server/src/__tests__/session-token-health.test.ts`.

---
recorded: 2026-08-27T02:34:54Z
commit: 39685da48d
---
# A fire-and-forget scheduler must check its config BEFORE arming the timer, not inside the callback

- **Incident (2026-08-27):** the sandbox daemon's `scheduleRuntimeProjectionPush` (runtime-projection-relay.ts) always armed a 2s `unref()`d debounce timer, and only checked control-plane config (`KORTIX_SESSION_ID/TOKEN/API_URL`) inside the fired `doPush`. Every unconfigured daemon (self-host, local dev, and every daemon unit test that does not set those vars) armed a timer that fired later to do nothing. Bun runs a package's test files in ONE process, so the env-route test armed this relay and the unref'd timer fired mid a SIBLING test — flaking `env route — mid-session boundary rules arm the shim` intermittently in CI while the full suite passed 1098/0 locally. Re-running the lane never converged (3 attempts across #6950/#6953).
- **Rule:** a debounced/deferred fire-and-forget must no-op at the SCHEDULE call when there is nothing to do (no config, no sink), not only when the timer fires. An armed unref'd timer outlives its caller and leaks work into whatever runs next — a real production waste (self-host daemons scheduling pushes they can never send) and a test-order flake generator. Gate at entry: `if (!configured()) return` before `setTimeout`.
- **Enforcement:** `projectionConfigured()` guards the top of `scheduleRuntimeProjectionPush`; the relay's own test still sets the three env vars so the push path stays exercised (25/0).

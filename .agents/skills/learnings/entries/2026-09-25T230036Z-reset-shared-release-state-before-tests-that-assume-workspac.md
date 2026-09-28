---
recorded: 2026-09-25T23:00:36Z
incident_date: 2026-09-26
---
# Reset shared release state before tests that assume workspace governance

**Rule:** Reset `config-release` module state before and after daemon tests
that expect the workspace to own compiled governance. Process environment
cleanup alone does not clear the module's running release.

**Trigger surface:** Daemon tests of `/kortix/env` or compiled agent config.

**Incident:** On 2026-09-26, the package CI lane twice rejected a valid
compiled-config update test. A prior test left a release active in the shared
module state, so `/kortix/env` correctly ignored the update.

**Enforcement:** `env-route-secret-respawn.test.ts` resets release state in
`beforeEach` and `afterEach`; the `packages` CI lane runs the file.

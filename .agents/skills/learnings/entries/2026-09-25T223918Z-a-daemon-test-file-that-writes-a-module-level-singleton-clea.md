---
recorded: 2026-09-25T22:39:18Z
incident_date: 2026-09-25
---
# A daemon test file that writes a module-level singleton clears it in afterEach, not only in beforeEach

**Rule:** In `apps/kortix-sandbox-agent-server`, a test file that mutates
module-level state resets it in its own `afterEach`. A `beforeEach`-only reset
protects that file and leaks into every later file. A test whose assertion
depends on such a singleton also resets it in its own `beforeEach`, so it is
correct whatever ran before it.

**Trigger surface:** adding or editing any test under
`apps/kortix-sandbox-agent-server/src/__tests__/` that touches a module-level
`let` — the config-release `running` record, a registry, a cached client. The
daemon suite runs every file in ONE bun process, and bun's file ORDER is not
stable between runs, so a leak is harmless in one run and a red lane in the next.

**Incident:** 2026-09-25. `config-release-boot.test.ts` left
`running.release_id` non-null. `releaseGovernanceActive()`
(`harness/open-code/config-release.ts:141`) then made
`applyOpencodeRuntimeEnv` (`harness/open-code/control.ts:62`) skip
`KORTIX_COMPILED_AGENT_CONFIG`, so
`env-route-secret-respawn.test.ts:352` read `opencode_env_changed: false`.
Blast radius: the `packages` CI lane red on `main` and on every PR branched
from it. Run 36194114643 ran boot as daemon file #24 and env-route as #37 —
red. Run 36189946175 ran env-route at #42 and boot at #49 — green, on
byte-identical daemon code. Nothing in the product was broken.

**Enforcement:** the `packages` lane runs the daemon suite in one process, so
the leak is caught only when the order happens to expose it. There is no
enforcer for the class yet: build a tripwire that fails when a daemon test file
imports `resetConfigReleaseStateForTests` (or another `*ForTests` reset) and
calls it in `beforeEach` without also calling it in `afterEach`.

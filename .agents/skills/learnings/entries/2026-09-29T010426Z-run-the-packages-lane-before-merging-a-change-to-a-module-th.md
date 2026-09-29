---
recorded: 2026-09-29T01:04:26Z
incident_date: 2026-09-28
---
# Run the packages lane before merging a change to a module that unit tests mock, and keep one caller that can clear a shared breaker

**Rule:** Before you merge a change that adds a query, a call, or an export to a module, run the `packages` lane (`pnpm test -- --packages-only`, or the `test` label). Unit suites replace whole modules with `mock.module`, and a stub without the new member makes the suite fail. When a red lane is fixed, re-run it: the lane stops at the first failing workspace and hides the rest. A circuit breaker that call sites skip on must keep one path that can clear it (a probe), or its trip becomes permanent.

**Trigger surface:** Editing a module that `mock.module` replaces in tests (`shared/db`, `router/services/llm`, session-lifecycle stores). Adding a new consumer of `sessionTokenPresumedDead()` or any shared breaker. Triaging a red `packages` lane.

**Incident:** 2026-09-28 20:37Z to 2026-09-29 00:53Z. `Tests` on `main` was red for ~4 h 16 min in 4 waves, and each wave hid the next:
1. #8019 added `db.select().orderBy()` to `deliverQueuedContinue`. Three `shared/db` mocks had no `orderBy`, so 11 delivery tests saw `queued`. A changed `approval_instructions` string failed 1 more test.
2. #8050 gated the runtime-assets manifest fetch on the dead-token breaker. #8036 had relied on that fetch to clear the breaker. #8066 then gated every other relay. With no caller left to carry a healthy answer, an idle box could never clear the breaker after a credential rotation.
3. #8044's SWR tests used a 10 ms wall-clock TTL and flaked on CI.
4. #8057 moved `settleStreamUsage` into `services/llm.ts`. The `e2e-router` mock lacked the export, so the suite failed to load. #8023 and #8045 added 107 hardcoded strings that failed the web i18n audit. The API failure had masked both.
Fixed in #8064 (`5e91f758b0`). The first green run on `main` is 36505271569.

**Enforcement:** The `packages` CI lane runs on every push to `main` and on the `test`/`preview` labels. `session-token-health.test.ts` pins the 5-minute probe (`SESSION_TOKEN_DEAD_PROBE_MS`). `runtime-assets.test.ts` asserts that the manifest probe clears the breaker. There is no pre-merge gate on `main` yet. The enforcer to build: require the `packages` lane on a PR that touches a module under `mock.module`.

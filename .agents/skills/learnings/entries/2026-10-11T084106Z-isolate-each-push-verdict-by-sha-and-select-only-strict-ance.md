---
recorded: 2026-10-11T08:41:06Z
incident_date: 2026-10-11
---
# Isolate each push verdict by SHA and select only strict-ancestor green baselines

**Rule:** Give every pushed SHA its own test concurrency group. GitHub replaces an older pending run in a shared group even with cancellation disabled. Select a green baseline only from actual trunk-suite events and only when the compare API proves it is a strict ancestor of the failing SHA.

**Trigger surface:** Changing test workflow concurrency or selecting the last green run for a trunk failure report.

**Incident:** 2026-10-11, PR #9524 (KRTX-2114). The restored push lane shared one group across all trunk commits, so bursts could lose intermediate verdicts. Independent SHA groups permit out-of-order completion: the newest green run can be newer than the failing revision. A successful skipped PR run is not a trunk verdict.

**Enforcement:** `tests/unit/trunk-verdict.test.ts` executes the workflow expressions and reporter bash. It proves independent push groups, opt-in PR gates, red/cancelled reporting, strict-ancestor selection, PR-baseline exclusion, and lookup-failure reporting.

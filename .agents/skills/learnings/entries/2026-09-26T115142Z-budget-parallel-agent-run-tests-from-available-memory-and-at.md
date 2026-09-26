---
recorded: 2026-09-26T11:51:42Z
incident_date: 2026-09-25
---
# Budget parallel agent-run tests from available memory and attribute the whole box before blaming the runtime

**Rule:** Budget a parallel test suite from available host and cgroup memory.
When a guard fires, record the largest non-runtime processes before naming a
cause. Match runtime processes by executable and argument position, never by
words anywhere in a command line. Do not assume aborting a turn stops `setsid` work.

**Trigger surface:** sandbox test runners, `/proc` process diagnostics, memory
guard reasons, and the stopped-turn UI.

**Incident:** On 2026-09-25, a four-worker API suite exhausted a 12 GiB prod
session box. OpenCode held 674 MB while the box reached 96% used. The guard
stopped the turn; the detached suite continued and exited with test failures.
See `docs/incidents/2026-09-26-sandbox-api-test-memory.md`.

**Enforcement:** `test-runner-contract.test.ts` executes worker selection;
`resources.test.ts` checks process matching, attribution and guard text;
`interrupted-label.test.ts` checks the recovery advice.

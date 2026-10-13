---
recorded: 2026-10-13T16:09:21Z
incident_date: 2026-10-13
---
# A workflow dispatched with GITHUB_TOKEN never fires workflow_run; the dispatched run must request its own follow-up

**Rule:** A workflow run started with GITHUB_TOKEN (for example a gate that promote.yml dispatches) triggers no `workflow_run` event. Any follow-up that keys on its completion must be requested by the run itself: a final job dispatches the follow-up with its run id.

**Trigger surface:** Adding a `workflow_run` trigger, or dispatching a workflow from another workflow with `github.token`.

**Incident:** 2026-10-13, v0.13.57. #9626 added rerun-failed-once.yml (workflow_run on 'Tests - release'). promote.yml dispatched the gate with GITHUB_TOKEN, so the run's actor was github-actions[bot] and the rerun never fired after attempt 1 failed; the rerun was started by hand. The #9626 rehearsals dispatched the gate as a person, so they never exercised this path.

**Enforcement:** `tests/unit/sandbox-workflow.test.ts` (a gate that promote.yml dispatched asks for its own rerun) pins tests-release.yml's `request-rerun` job and the dispatch input of rerun-failed-once.yml.

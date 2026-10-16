---
recorded: 2026-10-14T09:13:04Z
incident_date: 2026-10-14
---
# Approve the release PR's own Tests run: the dispatched gate does not satisfy the prod ruleset

**Rule:** The prod ruleset counts only the `full suite + quality gates` check of the release PR's own `pull_request` run of `tests-release.yml`. A green run that `promote.yml` dispatches on the same SHA is not counted. `promote.yml` approves the PR run (`POST /actions/runs/<id>/approve`) right after it opens or updates the release PR; if that fails, approve it by hand at once.

**Trigger surface:** Running Promote to Production, or reading a release PR that shows `BLOCKED` while a dispatched gate on the same SHA is green.

**Incident:** 2026-10-14, release v0.13.57. The dispatched gate passed all 12 shards and the summary, but the PR stayed `BLOCKED` (`isRequired=false` on the dispatched check). Nobody can bypass: the ruleset has no bypass actors and `viewerCanMergeAsAdmin=false`. The PR run waited for approval, and each rerun there is a new attempt, so `rerun-failed-once.yml` (attempt 1 only) never fired for it. It took 6 attempts.

**Enforcement:** `tests/unit/sandbox-workflow.test.ts` — "Promote to Production approves the release pull request's own gate run" (no `gh workflow run tests-release.yml` in `promote.yml`) and the rerun tests (the first attempt that ran jobs reruns once, also when it is attempt 2).

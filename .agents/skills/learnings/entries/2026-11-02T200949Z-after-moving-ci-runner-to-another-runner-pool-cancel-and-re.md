---
recorded: 2026-11-02T20:09:49Z
incident_date: 2026-11-02
---
# After moving CI_RUNNER_* to another runner pool, cancel and re-dispatch every run still queued on the old label

**Rule:** A job takes its `runs-on` label when its run is created. Changing a
`CI_RUNNER_*` variable does not move a run that is already queued. After the
change, list the queued runs (`gh run list --status queued` and
`--status pending`) and cancel and re-dispatch each one whose job still names
the old pool. A queued job waits up to 24 h for a matching runner, and a
`deploy-*` run holds its concurrency group the whole time.

**Trigger surface:** Changing a `CI_RUNNER_*` repository variable, or a
`Deploy Dev` run that stays `pending` while its first job is `queued`.

**Incident:** 2026-11-02. A Deploy Dev run created at 19:28Z took
`vulcan-2vcpu-ubuntu-2404`; the variables moved to `ubuntu-24.04` at 19:30Z. No
vulcan runner took the job, and the run held `deploy-dev` for 37 min, blocking
the next dev deploy until it was cancelled at 20:05Z.

**Enforcement:** none yet. The enforcer to build: a step in the runner-swap
procedure, or a scheduled check, that fails when a queued job names a label no
`CI_RUNNER_*` variable selects.

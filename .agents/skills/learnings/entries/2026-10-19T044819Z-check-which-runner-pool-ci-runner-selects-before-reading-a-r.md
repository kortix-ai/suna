---
recorded: 2026-10-19T04:48:19Z
incident_date: 2026-10-19
---
# Check which runner pool CI_RUNNER_* selects before reading a red release suite

**Rule:** Before you debug a red `Tests` lane, release suite job or `Deploy Prod` job, run `gh variable list --repo kortix-ai/suna | grep CI_RUNNER` and read the job's runner name. When a job fails only on a `vulcan-*` runner (`ENOSPC`, 30 s test timeouts, `Upload body timed out due to inactivity`), treat it as the runner, not the code: set that tier to its GitHub-hosted label for the release and fix the pool separately. Never "fix" those tests.

**Trigger surface:** Reading a red nightly `Tests` run, a release PR's `full suite + quality gates`, or a cancelled `Deploy Prod` job; planning a Promote.

**Incident:** v0.14.2, 2026-10-19. `CI_RUNNER_L`, `CI_RUNNER_M` and `CI_RUNNER_M_2204` pointed at vulcan pools (set 2026-10-16 to 2026-10-18). On them, core-flows and core-db filled `/tmp` (`ENOSPC`, 74 failed flows), kortixd ran ~3x slower (11 tests timed out at 30 s), the self-host image build failed to extract a layer, and the `GitHub Release` job stalled its asset upload and was cancelled (5 of 33 assets). The same trees passed on `ubuntu-24.04` / `ubuntu-22.04`. The runner noise also hid real regressions (stale billing tests after #10147, web typecheck, i18n), which surfaced only once the lanes ran on GitHub-hosted runners. The release needed 3 Promote rounds and fix-forward PRs #10237, #10247, #10251.

**Enforcement:** none yet: `tests/unit/image-build-speed-workflow.test.ts` pins the free GitHub-hosted default in the workflow files but cannot see repository variables. The enforcer to build: a Promote preflight that prints every `CI_RUNNER_*` value and fails when a release-suite tier points at a pool without a recent green nightly.

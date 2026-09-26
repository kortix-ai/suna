---
recorded: 2026-09-26T15:57:10Z
incident_date: 2026-09-02
---
# A `[skip ci]` release-prep commit deadlocks the lane that ships releases

**Rule:** never add `[skip ci]` to a commit that lands on a branch whose
deploy resolves an artifact BY that commit's exact SHA. A
`chore(release): staging VERSION → X.Y.Z [skip ci]` commit landing on
`staging` means `Build Staging Artifacts` never runs for it, so no image
exists for that SHA — and `Deploy Staging` resolves staging HEAD and pulls
that exact tag. The deploy then fails `image not found`, staging silently
serves the previous build, and nothing alerts: the deploy failure is one red
run in a list, and staging's own `/health` keeps answering `ok` on the stale
build. Either drop `[skip ci]` from release-prep commits, or make the deploy
resolve the last BUILT ancestor instead of HEAD.

**Trigger surface:** any workflow that tags a release-prep commit `[skip ci]`
on a branch another workflow deploys by resolving HEAD.

**Incident:** v0.13.10, 2026-09-02: staging served ~3-day-old code while
`staging` HEAD said otherwise; no release could ship at all, including a
pending CVE-2026-56854 fix, until an unrelated commit unwedged the lane. Prod
was never at risk — `tests-release` asserts staging serves
`RELEASE_SOURCE_SHA` before promote — but no release could progress.

**Enforcement:** none yet — this is a TODO to build the enforcer (a check that
a deploy's resolved SHA has a corresponding successful build run).

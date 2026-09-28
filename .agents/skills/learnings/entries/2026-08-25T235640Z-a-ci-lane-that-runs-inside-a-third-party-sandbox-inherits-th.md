---
recorded: 2026-08-25T23:56:40Z
incident_date: 2026-08-26
commit: abf007be64
---
# A CI lane that runs inside a third-party sandbox inherits that provider's availability, and a fallback nobody exercises is not a fallback

**When:** deciding where a test lane executes, or adding a provider fallback
to any CI path. The PR gate ran each lane inside a Platinum sandbox with
`auto` fallback to Daytona. On 2026-08-25 Platinum restores timed out for ~an
hour; every lane that fell back landed on a Daytona guest whose kernel
(6.18.15) could not mount overlay2, so `dockerd` never started and the lane
exited 3 — on runs 32905168237, 32906337979, 32908378870 and all three
attempts of 32909110032. The fallback had never been exercised under load;
it added a second provider's failure modes instead of removing the first's.
The runner (8 vCPU / 32 GB, Docker, cached pnpm store and Docker images)
could run the lane itself: core 2m16s and browser 4m30s natively versus ~5 min
each through the sandbox. Rule: **run a lane on the runner unless the lane
needs something the runner cannot provide (a public origin, a specific
kernel, GPU); if a lane must use a provider, rehearse the fallback path
weekly or delete it.** PR #6906 removed the sandbox-worker path for the PR
gate; `deploy-preview.yml` keeps a sandbox only because a preview needs a
public HTTPS origin.
*Enforcer:* `tests/unit/sandbox-workflow.test.ts` "has no cloud-sandbox
worker path left" fails if `tests.yml` or `tests-pr.yml` names a provider
again.

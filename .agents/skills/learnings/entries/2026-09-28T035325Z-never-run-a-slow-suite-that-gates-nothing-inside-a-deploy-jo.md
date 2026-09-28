---
recorded: 2026-09-28T03:53:25Z
incident_date: 2026-09-28
---
# Never run a slow suite that gates nothing inside a deploy job, and re-check reality before a queued deploy runs

**Rule:** A deploy job does one thing: deploy, fast, latest-wins. A suite that
gates nothing does not run inside it on every trigger; make it opt-in. A run
that waited in a concurrency queue re-checks the head SHA, the label, and the
branch before it deploys, and cancels itself (grey) when any one moved.

**Trigger surface:** Editing `.github/workflows/deploy-preview.yml` or any
workflow that queues per PR (`cancel-in-progress: false`) and deploys to a
persistent environment; adding a test step to a deploy job.

**Incident:** 2026-09-28. Every `preview` label ran `pnpm test --
--target-full` inline in the deploy job (40-80 min). Five label suites ran at
once, shared one preview GitHub App, hit its secondary rate limit on repo
creation (`GITHUB_RATE_LIMITED` from `/projects/provision`), and each ran ~80
min: 13 failed / 3 flaky / 54 passed on one of them. 20 of the last 25 failed
preview runs failed at the suite step. Pushes queued behind the suite for up to
67 min; a third push cancelled the pending second. Two queued runs deployed
after their PRs merged and their branches were torn down, re-creating two 16 GB
Platinum environments. Platinum capacity did not cause the 01:40-03:20Z
failures (no capacity rejection). At 04:03Z a new storm of ~25 labelled agent
PRs (the factory's merge gate required "live and tested") filled the 512 GB
pool and deploys got `429`. The merge gate for agent PRs is now the six `Tests`
lanes plus a live preview on the head SHA; #7909 stops idle hosts and admits
suites on pool and GitHub capacity.

**Enforcement:** `tests/unit/sandbox-workflow.test.ts` ("the preview label is a
fast deploy, and a superseded run never deploys") and
`infra/scripts/test-ecs-preview-runtime.py` assert `PREVIEW_RUN_TESTS` is
dispatch-only, the revalidate step supersedes on SHA/label/branch via
`gh run cancel`, and the comment and hostname steps use `!cancelled()`.

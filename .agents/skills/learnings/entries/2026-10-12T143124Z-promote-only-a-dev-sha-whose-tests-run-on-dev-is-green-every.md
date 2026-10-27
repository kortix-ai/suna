---
recorded: 2026-10-12T14:31:24Z
incident_date: 2026-10-12
---
# Promote only a dev SHA whose Tests run on dev is green; every push to dev runs the suite

**Rule:** Promote to `staging` only the newest `dev` SHA with a green `Tests` run on `dev` (the **kortix-release** skill, Step 2). Never promote `dev` HEAD blind and fix forward through staging pull requests. A red `dev` run blocks the next promotion: fix `dev` first. Merge into `prod` only on a green `full suite + quality gates`; `--admin` over a red gate needs the owner's explicit OK for that release.

**Trigger surface:** Planning a promotion or a release; changing the triggers of `.github/workflows/tests.yml`, `promote.yml`, or `rerun-failed-once.yml`; proposing to stop running `Tests` on pushes to `dev`.

**Incident:** 2026-10-11/12, v0.13.54 to v0.13.56. Four staging promotions (#9595, #9606, #9614, #9620) failed on browser journeys broken by UI PRs merged to `dev` 0.8 to 1.5 hours earlier (#9558, #9566, #9592, #9599). No check ran on `dev` between the merge and the staging pull request, so each break cost one full round: a local suite run plus about 30 min of staging CI. Over v0.13.45 to v0.13.56 the same class cost 49 of 96 failure hours; the median time from first promotion to prod was 13h13m against an 87-minute clean path. The daily `dev` run caught 2 of 18 such breaks before their promotion, and it was red every day from 2026-10-03, so nobody trusted it. The release gate passed 3 of 13 runs, and 9 of 12 releases merged over it with `--admin`.

**Enforcement:** `tests.yml` runs every lane on each push to `dev`, queued per ref. A pull request into `staging` reuses the green `dev` run of its head SHA (`reuse dev verdict`). `rerun-failed-once.yml` reruns a failed gate or staging-PR run once and names the failed jobs on the PR. `promote.yml` dispatches the gate itself. `tests/unit/sandbox-workflow.test.ts` pins all four.

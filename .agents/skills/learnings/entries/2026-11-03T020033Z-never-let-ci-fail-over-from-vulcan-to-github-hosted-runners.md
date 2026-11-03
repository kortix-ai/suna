---
recorded: 2026-11-03T02:00:33Z
incident_date: 2026-11-02
---
# Never let CI fail over from Vulcan to GitHub-hosted runners in a private repository

**Rule:** A private repository's CI never moves to GitHub-hosted runners
automatically. There, every GitHub-hosted minute counts against the
organization's 3,000 included minutes and then is billed. A private repository
waits for Vulcan. Only public repositories (suna) may fail over, because their
minutes are free. A scheduled workflow in a private repository never hard-codes
`runs-on: ubuntu-latest`. It reads a `vars.CI_RUNNER_*` variable that points at
a Vulcan label.

**Trigger surface:** Editing `VULCAN_FALLBACK_REPOS` or
`.github/fallback-watchdog.json` in `kortix-ai/vulcan`. Setting a
`CI_RUNNER_*` variable to a GitHub label. Adding a `schedule:` workflow, or a
hard-coded `runs-on:`, to a private repository (platinum, vulcan, capture).

**Incident:** 2026-11-02. Vulcan runners did not start for about 10 min
(06:30 UTC) and about 20 min (19:20 UTC). `/readyz` answered 200 both times.
The fallback watchdog moved the private platinum repository's
`CI_RUNNER_S/M/DEPLOY` to `ubuntu-24.04`. It moved them back only after 6
healthy ticks in a row, and one stuck run at 21:42 reset that count, so the
evening fallback lasted 3 h 10 min. Platinum used 4,771 GitHub-hosted minutes
that day, and the organization reached 5,072 of 3,000 included minutes on
2026-11-03. Two steady leaks added to it. The watchdog itself ran on a billed
runner about 124 times a day. `ptxp-release-cut.yml` (every 15 min,
hard-coded `ubuntu-latest`) would have cost about 2,900 minutes a month.
GitHub's audit log API answers 404 on this plan. The watchdog's state
variable `VULCAN_FALLBACK_STATE` (`changedAt`, `flipped`) was the only record
of who changed the variables. Fixed in kortix-ai/vulcan#201 and
kortix-ai/platinum#2541.

**Enforcement:** The watchdog reads `GET /repos/{repo}` and never moves a
private repository unless `allowPrivate: true` is set. The tests in
`scripts/fallback-watchdog/watchdog.test.ts` ("private repositories") fail
when that guard breaks. Nothing yet catches a hard-coded `ubuntu-latest` in a
private repository's scheduled workflow. To find one, run
`gh api /organizations/kortix-ai/settings/billing/usage` and group `Minutes`
by `repositoryName`.

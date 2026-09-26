---
recorded: 2026-09-25T03:37:40Z
incident_date: 2026-09-25
commit: 84738af9c6
---
# A scheduled workflow runs as the last person who edited its cron line

**Rule:** When someone leaves the org, list every workflow whose scheduled runs
carry their login, and change each cron line in a PR. GitHub dispatches a
`schedule` as the user who last changed that line and stops dispatching once
that user loses repository access. The workflow still reads `active`, so
`gh workflow list` shows nothing wrong. **Trigger surface:** offboarding, or a
nightly job whose newest run is weeks old.

**Incident:** `db-drift.yml` last ran on schedule 2026-08-04 and
`security-scan.yml` on 2026-08-03. Both runs' `actor` was the author of the
2026-06-21 cron lines, who is no longer an org member (`GET
/orgs/<org>/members/<login>` → 404). Every other scheduled workflow ran as a
current member and kept running. Seven weeks of drift checks and CVE scans did
not run, and nothing reported it. **Check:** for each scheduled workflow, `gh
run list --workflow <file> --event schedule --limit 1 --json databaseId`, then
`gh api repos/<repo>/actions/runs/<id> --jq .actor.login`, and compare the date
with the cron. **Enforcer:** none; the check above is manual.

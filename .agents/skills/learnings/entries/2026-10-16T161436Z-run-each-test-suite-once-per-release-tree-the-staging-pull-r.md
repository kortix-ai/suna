---
recorded: 2026-10-16T16:14:36Z
incident_date: 2026-10-16
---
# Run each test suite once per release tree: the staging pull request and the deployed release gate, never the push to dev

**Rule:** The `Tests` lanes run on the pull request into `staging` (the gate), nightly on `dev`, on the `test` label, and on dispatch. A push to `dev` runs no lane. The pull request into `prod` runs only `Tests - release` against deployed staging plus the path-gated SOC 2 scanners; CI, CodeQL, DB Migrations, i18n and the secret scans do not run again on a tree that differs from staging only in `VERSION`. A new check goes on the staging pull request, a schedule, or a dispatch.

**Trigger surface:** Adding or editing a workflow trigger, a release step, or a rule in `AGENTS.md`, the `testing`, `contributing` or `kortix-release` skill.

**Incident:** 2026-10-12 to 2026-10-16. Every push to `dev` ran 10 `Tests` lanes: 43 of 43 completed runs were red (21 browser tests failed in every run), ~2,600 job-min a week, and no signal. The prod pull request re-ran CI, CodeQL and Tests checks on the staging tree. v0.13.57 needed 5 release-gate rounds over 20.4 h. A local attestation rule made agents run the full suite before every push: 559 of 4,626 commits in 60 days only touched `tests/attestations/`.

**Enforcement:** `tests/unit/sandbox-workflow.test.ts`: "the suite runs nightly and on the staging pull request, never on a push to dev" and "the prod pull request re-runs no tree check".

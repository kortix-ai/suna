---
recorded: 2026-10-16T17:35:36Z
incident_date: 2026-10-16
---
# Gate a release only on the release suite of the PR into prod; never re-test a tree, and dispatch build-staging after a workflow-token merge

**Rule:** One Promote to Production dispatch takes the `dev` HEAD into `staging` (a PR that runs no check), waits until staging serves it, and opens the release PR into `prod`. That PR runs the release suite once: contract lanes, deployed smoke, browser journeys, CI, CodeQL, scanners. `full suite + quality gates` requires every check green and is the only gate. Nothing runs on a push to `dev` or on the PR into `staging`. A merge made with the workflow token starts no `push` workflow, so Promote dispatches `build-staging.yml` itself. This supersedes the 2026-09-29 entry (the staging PR's own checks are the gate) and the 2026-10-12 entry (promote only a dev SHA whose Tests run is green).

**Trigger surface:** Editing `promote.yml`, `tests.yml`, `tests-release.yml` or any workflow's `pull_request` branches; writing the release skill; planning a promote.

**Incident:** 2026-10-16. The same release tree ran the full suite on the PR into `staging` (local stack) and again on the PR into `prod` (deployed staging), and CI, CodeQL and the scanners ran on both. Staging is not soaked, so the second stage added only deployment coverage. v0.13.57 needed 5 gate rounds over 20.4 h. The deployed smoke now runs 45 seam flows in 116 s (3 min 27 s job) against 10-17 min per shard on 6 shards before.

**Enforcement:** `tests/unit/sandbox-workflow.test.ts` (no workflow triggers on a PR into `staging`; `tests-release.yml` is the only caller of `tests.yml`; Promote has the dev leg, `dry_run`, merge commit, build dispatch) and `tests/unit/deployed-set.test.ts` (30-50 `deployed` flows, one seam table).

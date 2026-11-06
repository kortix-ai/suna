---
recorded: 2026-11-06T11:08:26Z
incident_date: 2026-11-06
---
# Cancel the gate run of a superseded release head; the tests-release concurrency group queues the new head behind it

**Rule:** After a re-promote moves the release PR head, cancel the `Tests - release` run of the old head. The group `tests-release-staging` has `cancel-in-progress: false`, so the new head's run waits until the old one ends, and the old result never counts.

**Trigger surface:** Re-promoting (`promote.yml -f ref=staging`) while a gate run is still in progress on the release PR.

**Incident:** 2026-11-06, v0.15.0 (#11872). Two dispatches 4 min apart force-pushed the release branch. The second head's gate run stayed `pending` for 30 min behind the first, superseded run. The release driver cancelled the superseded run (`gh run cancel <id>`), and the real run started within 1 min.

**Enforcement:** `promote.yml` (open-release-pr job) cancels every not-completed `tests-release.yml` pull_request run on the release branch whose `head_sha` is not the head it just pushed. Test: `tests/unit/sandbox-workflow.test.ts` ("Promote to Production approves the release pull request's own gate run").

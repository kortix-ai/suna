---
recorded: 2026-11-03T07:07:02Z
incident_date: 2026-11-03
---
# Refresh APT indexes before installing bootstrap dependencies

**Rule:** Run apt-get update before the first package install on a minimal CI runner, including packages needed to add another repository.

**Trigger surface:** Workflow Git/PPA bootstrap on Ubuntu runners with cleaned package indexes.

**Incident:** Release v0.14.17 run 41590536896 attempt 3 lost all six contract lanes before tests: installing software-properties-common failed with exit 100. The bootstrap refreshed indexes only after installing the PPA helper.

**Enforcement:** `tests/unit/git-bootstrap-workflow.test.ts` executes the actual workflow shell against an empty-index APT model and covers the already-supported Git fast path.

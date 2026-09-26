---
recorded: 2026-09-21T11:59:42Z
incident_date: 2026-09-21
commit: 111b39703e
---
# Runner-policy tests must name intentional GitHub-hosted jobs

**Rule:** When a workflow job must use a GitHub-hosted runner, add a job-specific
exception to the runner-policy test in the same change. Never allow a bare
GitHub-hosted label for an entire workflow. **Incident:** PR #7448 moved four npm
publish jobs to `ubuntu-latest` for npm provenance but left the Blacksmith
kill-switch test unchanged. Every `main`-based PR then failed its core lane.
**Enforcer:** `tests/unit/image-build-speed-workflow.test.ts` permits only the
four named npm publish jobs and rejects every other bare Linux runner label.

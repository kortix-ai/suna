---
recorded: 2026-10-22T23:43:13Z
incident_date: 2026-10-22
---
# Check a Drata exclusion by finding ID after a pipeline scan turns red on an unchanged file

**Rule:** When `drata-compliance.yml` turns red on a file the release did not change, read the result with `GET public/workspaces/1/pipelines/results?runId=<id>` and compare the finding's `findingId` and `idHistory` with the excluded findings. Drata keys exclusions by finding ID and can re-key a finding, so an existing exclusion stops matching. Re-create the exclusion in the Drata app (Monitoring → Pipelines → Exclusions) with the rationale from `infra/terraform/compliance-monitoring/README.md`. Never merge past the red check: in the SOC 2 audit period a bypass is an audit exception.

**Trigger surface:** A red `compliance-as-code-action` on a release PR into `prod`, or on the daily scan.

**Incident:** 2026-10-22, release v0.14.7 (#10730). Test 8025 on `modules/capture-store` `aws_iam_role_policy.device` came back as Critical. The file had not changed between v0.14.6 and v0.14.7, and v0.14.6 had passed at 16:18 UTC. The finding ID had gained a `|2` suffix, with the old IDs in `idHistory`. Drata's public API has no exclusion endpoint, and its web app sits behind a Cloudflare bot check, so an agent cannot re-create the exclusion: a person with Drata access must do it. The check passed again before the release merged.

**Enforcement:** none yet. To build: a step in `drata-compliance.yml` that prints a red finding's `idHistory` and names the README row whose exclusion no longer matches.

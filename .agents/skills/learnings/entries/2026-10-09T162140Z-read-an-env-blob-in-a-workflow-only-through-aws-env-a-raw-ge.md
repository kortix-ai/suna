---
recorded: 2026-10-09T16:21:40Z
incident_date: 2026-10-09
---
# Read an env blob in a workflow only through aws-env; a raw get-secret-value carries its own region and survives a region move

**Rule:** A workflow reads a `kortix-*-env` blob only through the aws-env
action, so `blob_region` in `.github/actions/aws-env/fetch.sh` decides its
region. A raw `aws secretsmanager get-secret-value` names its own region, and a
region move leaves it reading the old copy. When a blob moves, grep the
workflows and scripts for its name, not only the aws-env steps.

**Trigger surface:** Adding a workflow step that needs a value from an env
blob. Moving a blob to another region or deleting its old copy.

**Incident:** 2026-10-09, a near-miss during the us-west-2 removal. PR #9430
moved every aws-env read and its notes said no workflow read the us-west-2
dev and staging copies. `configure-preview-edge.yml` still read
`kortix-dev-env`, `kortix-staging-env` and `kortix-prod-env` raw in us-west-2.
It runs on dispatch only (last run 2026-08-20), so nothing read a stale value.
The next dispatch after the planned deletion of the old copies would have
skipped the dev and staging edge secrets and left those previews answering 503.

**Enforcement:** `tests/unit/aws-env-action.test.ts`:
- "reads no env blob with a raw get-secret-value outside aws-env, except the
  listed whole-blob jobs" goes red for a new raw read in any workflow;
- "maps no blob to us-west-2" goes red for a row that names the old region.
Scripts outside `.github/workflows` are not covered: grep them by blob name.

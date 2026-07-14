---
name: compliance-sweep
description: Daily compliance-drift check for {{projectName}}. Reads AWS resource state and audit logs across {{aws_regions}}, compares against the compliance policy stored in skills and memory, files every finding, and drafts proposed remediation as a reviewed change — never applying a fix. Load this when the daily cron fires the sweep, or a human asks for a compliance, drift, or policy check.
---

<skill name="compliance-sweep">

<overview>
Once a day, check `{{projectName}}`'s AWS footprint against policy before drift
accumulates into an audit problem. Each run is a **fresh session in its own
sandbox** — one sweep, one disposable machine, nothing carried over. The agent
reads AWS resource state and the audit logs with **read-only** access, checks
both against the compliance policy, files every finding to
{{alert_channel}}, and drafts remediation as a **reviewed change request** — it
never applies a fix itself.
</overview>

<when-to-load>
- The daily cron fires the compliance sweep.
- A human asks for a compliance check, a drift check, or a policy audit.
- Someone asks to add or change a rule in the compliance policy itself.
</when-to-load>

<workflow>

## Step 0 — Load the policy, fresh

This is not a ledger to resume — it's live policy, loaded fresh every run:
```sh
cat .kortix/memory/compliance-policy.md 2>/dev/null || echo "(no policy file yet — using the defaults below)"
```
If no policy file exists yet, use these starting defaults and propose creating
`.kortix/memory/compliance-policy.md` from them on this run:
- **Buckets** — none public unless explicitly allow-listed by name.
- **Tags** — every resource carries `owner` and `environment`.
- **IAM roles** — no role holds `*:*` or an unscoped `iam:PassRole`.

## Step 1 — Pull AWS resource state (read-only)

Scope to {{aws_regions}} (comma-separated):
```sh
for region in $(echo "{{aws_regions}}" | tr ',' ' '); do
  for bucket in $(aws s3api list-buckets --query 'Buckets[].Name' --output text); do
    aws s3api get-bucket-policy-status --bucket "$bucket" --region "$region" 2>/dev/null
    aws s3api get-bucket-tagging        --bucket "$bucket" --region "$region" 2>/dev/null
  done
  for role in $(aws iam list-roles --query 'Roles[].RoleName' --output text); do
    aws iam list-attached-role-policies --role-name "$role"
    aws iam list-role-policies          --role-name "$role"
  done
done
```
Every call here is a read (`list-*`, `get-*`). The credentials are brokered
server-side and read-only — you use them, you never see the raw key.

## Step 2 — Check against policy

For each resource, evaluate against the policy loaded in Step 0:

| Check | Violation condition | Finding type |
|---|---|---|
| Bucket exposure | `PolicyStatus.IsPublic = true` and the bucket isn't allow-listed | Newly public bucket |
| Tagging | Missing a required tag key from the policy | Untagged resource |
| IAM scope | Role holds `*:*`, an unscoped `iam:PassRole`, or a policy broader than its template | Over-broad role |

## Step 3 — Cross-reference the audit logs

For every violation from Step 2, find when it happened and who did it:
```sh
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue="<resource-id>" \
  --max-results 10 --region <region>
```
Attach the event time, actor, and source IP (if present) to the finding. If
nothing turns up inside the CloudTrail retention window, note the finding as
"origin unknown — predates available audit history" rather than guessing.

## Step 4 — Draft the proposed remediation (never apply it)

- **Bucket** → draft the tightened bucket policy / block-public-access config.
- **Tags** → draft the missing tag set from the policy.
- **Role** → draft the narrower policy (drop the offending statement or scope
  the resource/action).

Open one change request per finding via `project.cr.open` (or one per resource
group when several findings share a fix). Title it with the resource and
violation, e.g. `compliance: newly-public bucket acme-uploads`. The CR body is
the diagnosis from Step 3 (what, when, who) plus the proposed fix. A human
reviews and applies it — you stop at opening the CR.

## Step 5 — Post the summary

Post to {{alert_channel}}: one line per finding — resource, violation, when/who
changed it, and a link to its proposed CR. If nothing drifted, post one line
saying so; don't skip the post just because the sweep is clean.

</workflow>

<guardrails>
- **Read-only against AWS.** Every call in Step 1 and Step 3 is a read
  (`list-*`, `get-*`, `lookup-events`). Never call a `put-*`, `delete-*`, or
  `update-*` action against AWS from this skill.
- **No auto-remediation.** Every fix is a proposed, human-approved change
  request opened via `project.cr.open` — never applied directly, no exceptions
  for findings you're confident about.
- **Fresh every run.** There is no run-to-run ledger here — the only state
  carried between sweeps is the policy file itself, and that's authored by a
  human, not written by this skill.
- **Scoped, brokered secrets.** AWS access is read-only and brokered
  server-side; never surfaced to you or written to logs.
- **File everything the policy flags.** A finding you'd personally wave through
  still gets filed as written — this skill checks the policy, not intent.
</guardrails>

</skill>

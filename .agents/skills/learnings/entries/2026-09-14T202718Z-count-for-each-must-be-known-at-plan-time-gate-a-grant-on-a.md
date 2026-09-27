---
recorded: 2026-09-14T20:27:18Z
incident_date: 2026-09-14
commit: 9e20140952
---
# `count`/`for_each` must be known at PLAN time — gate a grant on a literal bool, never on an ARN created in the same apply

**When:** adding an optional resource to a Terraform module whose on/off input is
another resource's attribute (`count = var.bucket_arn != "" ? 1 : 0` fed by
`module.bucket.bucket_arn`). On a root where the bucket does not exist yet, the
ARN is unknown until apply and `terraform plan` fails with `Invalid count
argument`. `terraform validate` and `fmt` pass — only a plan catches it.
*Incident:* #7221 merged `ccd3f7596d`; Deploy Dev run `34891285433` failed at
"Apply dev API Terraform", which skipped the dev API and frontend deploys for
every push until the fix (`project_snapshots_enabled` bool). *Automation:* none
yet — candidate: Terraform CI runs `terraform plan -refresh=false` with a local
backend on each root that creates new resources.

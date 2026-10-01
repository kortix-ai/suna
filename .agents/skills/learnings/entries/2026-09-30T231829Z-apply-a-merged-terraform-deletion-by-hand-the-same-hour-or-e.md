---
recorded: 2026-09-30T23:18:29Z
incident_date: 2026-09-30
---
# Apply a merged Terraform deletion by hand the same hour, or every dev API deploy stays skipped

**Rule:** When a PR removes a Terraform resource in `infra/terraform/environments/dev*`, run `terraform plan` for that root after the merge, review the delete, and apply it by hand in the same session. The dev deploy guard in `.github/workflows/terraform-apply.yml` refuses every planned delete except an ECS task-definition replacement. `deploy-api-ecs` in `deploy-dev.yml` requires `terraform-dev` to succeed or skip, so one pending delete skips the API deploy for every later merge.

**Trigger surface:** Merging a PR that deletes or reverts a Terraform resource (a listener, a security-group rule, a record) in a dev root, or reading a "Not live on dev yet" comment that says `API · deploy skipped`.

**Incident:** 2026-09-30. #8506 removed the dev web ALB port-80 listener and its security-group rule. Every Deploy Dev run from 19:47Z to 23:20Z failed `Apply dev web Terraform` with "plans 1 blocked destructive change(s)", and `Deploy API to dev (ECS Fargate)` was skipped. The dev API stayed on a 19:49Z build for about 3.5 hours while about 30 PRs merged. The gateway kept deploying, so the API and gateway ran different commits. Resolved by a reviewed local `terraform plan` + `apply` of `infra/terraform/environments/dev-web` (0 added, 1 changed, 1 destroyed).

**Enforcement:** none yet: the Deploy Dev "Not live on dev yet" comment names `deploy skipped` but not the blocking job. Build: make that comment name the failed Terraform root and the blocked resource addresses.

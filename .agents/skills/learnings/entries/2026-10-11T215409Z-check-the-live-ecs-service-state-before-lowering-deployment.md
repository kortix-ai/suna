---
recorded: 2026-10-11T21:54:09Z
incident_date: 2026-10-11
---
# Check the live ECS service state before lowering deployment_maximum_percent — Availability Zone Rebalancing rejects values <= 100

**Rule:** Before pinning an ECS service's `deployment_maximum_percent` to 100 or below,
check whether Availability Zone Rebalancing is enabled on the LIVE service (drift: Terraform
does not manage the flag unless declared, and `terraform validate`/plan cannot see it).
ECS UpdateService rejects `maximumPercent <= 100` for rebalancing-enabled services with
InvalidParameterException, so the apply fails and blocks the release. The lowest workable
value with rebalancing on is just above 100 (prod pins 150, paired with minimum 50).

**Trigger surface:** `infra/terraform/modules/ecs-api` and any ECS service deployment
settings; a prod release whose Terraform plan touches `aws_ecs_service` deployment
configuration; any change that lowers `deployment_maximum_percent`.

**Incident:** 2026-10-11, the v0.13.54 prod release (run for `1182138e6`): "Apply prod API
Terraform" failed with `InvalidParameterException: The service couldn't be updated because
Availability Zone Rebalancing does not support maximumPercent <= 100 %` on
`kortix-prod/kortix-prod` — KRTX-586's PR #9518 had pinned 100 without knowing the service
had rebalancing enabled out-of-band. Release blocked ~1 h; no prod runtime impact (the ECS
service update was rejected atomically, so prod kept the old configuration). Fixed by pinning
150 (envelope overlap 2 → 1.5, ceiling 150 ≤ 205) — PR that follows #9518.

**Enforcement:** none yet in-repo: `terraform validate` cannot see live AWS service state.
The enforcer to build: a CI pre-apply check that DescribeServices the target service and
cross-references its `availabilityZoneRebalancing` against the planned
deploymentConfiguration (fail the release before apply). Until then, the module variable
description of `deployment_maximum_percent` carries the constraint and the cross-check test
pins the 50/150 pairing.

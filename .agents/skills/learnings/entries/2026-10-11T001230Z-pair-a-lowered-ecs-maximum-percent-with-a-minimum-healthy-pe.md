---
recorded: 2026-10-11T00:12:30Z
incident_date: 2026-10-10
---
# Pair a lowered ECS maximum_percent with a minimum_healthy_percent that rounds below desired

**Rule:** When you lower an ECS service's `deployment_maximum_percent` to 100 (or any value
where `floor(desired × max/100) <= desired`), pair it with a `deployment_minimum_healthy_percent`
below 100 that satisfies `ceil(desired × min/100) < desired` at the SMALLEST autoscaled
`desired_count` of that service. AWS rounds `minimumHealthyPercent` UP and `maximumPercent`
DOWN: min=100 + max=100 leaves the service unable to stop a task (all must stay healthy) and
unable to start one (the max is reached) — the rollout hangs and the deploy script times out;
the circuit breaker cannot fire because no replacement task is ever started.

**Trigger surface:** `infra/terraform/modules/ecs-api` (or any ECS service) deployment
settings; planning a prod release that applies them; changing `desired_count`, `min_capacity`
or `max_capacity` after pinning a maximum_percent.

**Incident:** 2026-10-10, KRTX-586 / PR #9518: the DB-budget funding step pinned
`deployment_maximum_percent = 100` on the prod and us-east-2-shadow API modules while the
module kept its hardcoded `deployment_minimum_healthy_percent = 100` — every subsequent prod
API release would have hung (prod desired=3, shadow desired=2). Caught by the independent
review before merge; no prod impact. Fixed with the 50/100 pairing on both stacks.

**Enforcement:** `apps/api/src/shared/database-capacity.test.ts` cross-checks the pairing
against the Terraform files (module variable defaults, `var.` usage, and both prod pins
`minimum_healthy 50` / `maximum 100`); the module variable validates 0–100 and its
description states the rounding rule.

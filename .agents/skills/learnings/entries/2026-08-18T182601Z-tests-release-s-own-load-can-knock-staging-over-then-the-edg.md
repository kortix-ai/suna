---
recorded: 2026-08-18T18:26:01Z
incident_date: 2026-08-18
commit: 8cd6f474f1
---
# `tests-release`'s own load can knock staging over, then the edge worker hides it as "maintenance"

**When:** running `pnpm test -- --target-full` (the `full suite + quality
gates` release gate) shortly after a fresh `main` → `staging` promotion.

Two consecutive attempts of the v0.13.0 release gate failed the same way, not
with flaky test assertions but with real `MAINTENANCE_MODE` 503s: 36
occurrences across a 40-minute window (15:11–15:51) in attempt 1, cascading
into unrelated failures across accounts, billing, admin-console and
sandbox-template journeys. `target-browser-full` finished in 2394.0s and
failed; `target-api-full` (439 flows, 1681 cases) never finished at all before
the 90-minute cap killed the job. `staging-api`'s own `/health` showed
`started_at` 21 minutes after the instability began — i.e. the backend task
itself went unhealthy and ECS replaced it mid-run.

The `MAINTENANCE_MODE` response is not a real maintenance flag — it is
`infra/cloudflare/workers/api-router/worker.mjs`'s `AUTOMATIC_MAINTENANCE`
fallback (`worker.mjs:251-273`): on ANY single fetch failure or 502/503/504
from the real origin, the edge worker rewrites that one response into a
generic "Kortix is temporarily unavailable... maintenance" 503, per request.
It is a reasonable UX choice for real end-user traffic, but it means a genuine
backend capacity problem during a test run is invisible in the log as "backend
overloaded" — it reads as "scheduled maintenance," which sent this
investigation looking for a deploy or a flag before the real cause (a single
staging ECS task under-provisioned for the full release suite's own real
concurrent traffic) was found.

**The rule: don't diagnose `MAINTENANCE_MODE` at face value.** Check whether
`X-Maintenance-Mode: blocking` correlates with the backend's own health/restart
timestamps before assuming an intentional maintenance window — it is far more
likely the edge worker masking a real origin failure. And: running the full
release suite immediately after redeploying the target it tests is a
self-inflicted-outage risk on a single-task environment — the fresh task has no
warm connection pools and no capacity headroom, and the suite's own real load
is enough to tip it over. Give staging-api real headroom (task count/size) for
release runs, or the gate keeps eating its own tail.
*Incident:* v0.13.0 release (PR #6520). Correction 2026-08-19: this entry was
written during attempt 5 of run 32151213430; **no attempt of that run has
passed** (attempts 3–6 and 8–10 failed, 2 and 7 were cancelled). The
maintenance-mode 503s were real but were not the dominant cause of the later
attempts (4 occurrences in attempt 10 vs 36 in attempt 1) — see the next entry.
Capacity fix not yet made — staging still runs this gate at capacity risk.

**Addendum (2026-08-19) — what the capacity audit found, and the durable fix.**
Three facts, none of them visible from the symptom:

- **Staging was smaller than dev.** `environments/staging/main.tf:98-103` ran
  the API at `512/1024`, `desired/min/max = 1/1/3`; dev runs `2/2/6` and carries
  no load. The environment that absorbs the heaviest load in the company had the
  smallest box, and its autoscaling ceiling was 3 × 0.5 vCPU = 1.5 vCPU total.
- **The single task was Spot with `base = 0`** (`modules/ecs-api/main.tf:506`)
  behind `deployment_minimum_healthy_percent = 100` (`:521`). One Spot reclaim
  empties the service and ECS cannot place the replacement until Spot capacity
  returns. Some of the "cascading failures" chased that night may have been
  reclaims, not load — and the edge laundered both into the same 503. **Any Spot
  service whose total unavailability is a real cost needs an on-demand base.**
- **The database tier lives outside Terraform.** The staging DB is hosted
  Supabase (`ujzsbwvurfyeuerxxeaz`), injected as `STAGING_DATABASE_URL`; a
  repo-wide grep for RDS/ElastiCache returns zero hits. The `ci_micro` →
  `ci_medium` resize therefore survives every apply AND is recorded by nothing.
  **A resource no plan can show is a resource only a runbook can hold** —
  `docs/runbooks/staging-sizing.md` now does.

**The Terraform trap this exposed, which generalises past staging:** the ecs-api
service carries `ignore_changes = [task_definition, desired_count]` and the
task-def carries `ignore_changes = [container_definitions]`, by design so CI
image rolls do not fight Terraform. `infra/scripts/ecs-deploy.sh` then renders
each new revision from the service's CURRENT one. So **changing `task_cpu` /
`task_memory` in Terraform registers a revision the service never adopts — the
apply is green and the live task never resizes.** Writing a size into Terraform
is not the same as a task running at that size; verify with
`describe-task-definition` on the service's live revision, never from the plan.
Fixed durably by having `ecs-deploy.sh` take ONLY `cpu`/`memory` from the
family's latest ACTIVE revision (Terraform's, right after an apply; its own
previous one otherwise) and everything else from the service's current revision
— so a resize propagates on the next deploy and is a no-op on every other one.
*Enforcer:* `worker.test.mjs` pins staging >= dev on cpu/memory/min_capacity,
pins `fargate_base_on_demand = 1` on both staging services, and pins the new
module variable's default at `0` so dev/prod strategies cannot move.

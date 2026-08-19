# Runbook — staging capacity and sizing

Staging is the only environment that ever sees the release gate's full load.
`pnpm test -- --target-full` drives 441 REST flows and 21 Playwright journeys
against `staging-api.kortix.com` / `staging.kortix.com`. Nothing else in the
company generates that traffic, so staging must be sized for it — not for the
handful of manual checks a release candidate otherwise gets.

This runbook records what staging runs, why, and how to change each piece.

---

## 1. What staging runs today

| Component | Value | Owned by |
|---|---|---|
| API task size | 1024 CPU / 2048 MiB | Terraform — `infra/terraform/environments/staging/main.tf` |
| API count | desired 2, min 2, max 4 | Terraform (min/max), autoscaling (live count) |
| API capacity | FARGATE_SPOT, **on-demand base 1** | Terraform — `fargate_base_on_demand` |
| Gateway task size | 512 CPU / 1024 MiB | Terraform |
| Gateway count | desired 2, min 2, max 3 | Terraform |
| Gateway capacity | FARGATE_SPOT, **on-demand base 1** | Terraform |
| Scaling policies | CPU 60%, memory 70%, 600 req/target | `infra/terraform/modules/ecs-api/main.tf` |
| Database | Supabase project `ujzsbwvurfyeuerxxeaz`, region eu-west-2, compute **Medium** | **Nothing in this repo — see §4** |
| Region | us-west-2 (ECS), eu-west-2 (Supabase) | — |

### Why these numbers

Before 2026-08-19 staging ran **1 task of 512 CPU / 1024 MiB on Spot with
`base = 0`**. Three properties made that indefensible:

1. **Staging was smaller than dev.** Dev runs desired/min 2 and carries no load;
   staging ran 1 and carries all of it.
2. **The autoscaling ceiling was 3 × 0.5 vCPU = 1.5 vCPU** for the entire API.
3. **One Spot reclaim was a total outage.** `base = 0` means no task is pinned to
   on-demand, and `deployment_minimum_healthy_percent = 100`
   (`modules/ecs-api/main.tf`) blocks the replacement until Spot capacity
   returns.

During the v0.13.0 release gate the suite's own traffic drove the single task
unhealthy, ECS replaced it mid-run, and the edge Worker reported the resulting
5xx as `MAINTENANCE_MODE`. Two `tests-release` attempts were lost. See the
`learnings` skill entry "`tests-release`'s own load can knock staging over".

### Cost

us-west-2, 730 h/mo, on-demand $0.04048/vCPU-hr + $0.004445/GiB-hr; Spot is
roughly 70% of on-demand.

| | API | Gateway | Total |
|---|---|---|---|
| Before (1 × 0.5 vCPU/1 GiB Spot; 1 × 0.25 vCPU/0.5 GiB Spot) | ~$14/mo | ~$7/mo | **~$21/mo** |
| After (2 × 1 vCPU/2 GiB, 1 on-demand; 2 × 0.5 vCPU/1 GiB, 1 on-demand) | ~$96/mo | ~$48/mo | **~$144/mo** |

Delta at the `min_capacity` floor: **~+$123/mo**. At full scale-out (API 4,
gateway 3) it is ~$255/mo. Against a release process that was costing 10+
engineer-hours per attempt, this is not a decision worth deliberating.

---

## 2. Changing ECS sizing — and the Terraform trap

**The trap:** `modules/ecs-api/main.tf` deliberately carries

```hcl
# on aws_ecs_task_definition
lifecycle { ignore_changes = [container_definitions] }
# on aws_ecs_service
lifecycle { ignore_changes = [task_definition, desired_count] }
```

so that CI image rolls do not fight Terraform. The consequence is that
**changing `task_cpu` / `task_memory` in Terraform is not, by itself, enough.**
Terraform registers a new task-definition revision with the new size, but the
service keeps rolling from the lineage `infra/scripts/ecs-deploy.sh` renders,
and that renderer rebuilds each revision from the service's **current** one.

**The fix (live since 2026-08-19):** `ecs-deploy.sh` takes **only `cpu` and
`memory`** from the family's latest ACTIVE revision, and everything else from
the service's current revision.

Terraform and `ecs-deploy.sh` register into the *same* family, and every
`register-task-definition` appends. So the family's latest revision is either
Terraform's (right after an apply that changed the size) or `ecs-deploy.sh`'s own
previous one (which already carries Terraform's size). The override therefore
propagates a resize on the very next deploy and is a no-op otherwise. It
soft-fails: if the family cannot be read, the running size is preserved and the
deploy proceeds as before.

This works because `deploy-staging.yml`'s `deploy-ecs` job `needs:` the
`terraform-staging` job — Terraform always applies before the ECS roll.

### To change task size or counts

1. Edit `infra/terraform/environments/staging/main.tf` (`module "api"` /
   `module "gateway"`).
2. Open a PR to `main`. `terraform-ci.yml` runs `fmt`, `validate`, `tflint` and
   `checkov`.
3. Merge to `main`, then promote `main` → `staging`. **The staging Terraform
   apply only runs on a push to `staging`** (`deploy-staging.yml` triggers on the
   `Build Staging Artifacts` workflow for branch `staging`). A merge to `main`
   changes nothing on staging.
4. Watch the `Apply staging Terraform` job, then `Deploy API + gateway to
   staging (ECS Fargate)`.
5. Verify the live task size — do **not** trust the apply alone:

```sh
aws ecs describe-services --region us-west-2 \
  --cluster kortix-staging --services kortix-staging \
  --query 'services[0].taskDefinition' --output text
# then
aws ecs describe-task-definition --region us-west-2 \
  --task-definition <that arn> --query 'taskDefinition.{cpu:cpu,memory:memory}'
```

`min_capacity` / `max_capacity` are different: they live on
`aws_appautoscaling_target`, which has no `ignore_changes`, so a Terraform apply
changes them directly. Raising `min_capacity` raises the running count on its
own.

### Fargate Spot and the on-demand base

`use_fargate_spot = true` alone means `base = 0` — every task is interruptible
and the service can reach zero. `fargate_base_on_demand = N` pins N tasks to
on-demand `FARGATE` while the rest stay Spot. The module defaults it to `0`, so
dev and prod behavior is unchanged; only environments that opt in move.

`fargate_base_on_demand` must be `<= min_capacity`. That is enforced as a
precondition on `aws_appautoscaling_target`, so a bad value fails the plan.

---

## 3. Emergency lever — `ecs-scale.yml`

`.github/workflows/ecs-scale.yml` (`workflow_dispatch`) sets `desired_count` on a
live service without Terraform. This is the intended ops mechanism, precisely
because the service ignores `desired_count`.

```
cluster:       kortix-staging          (or kortix-staging-gateway)
service:       kortix-staging          (or kortix-staging-gateway)
desired_count: <n>
region:        us-west-2
```

**Use it when:** staging is degrading during a run you cannot afford to lose, or
you need temporary headroom for a one-off load test.

**Do not use it as a fix.** It is not durable in either direction:

- Autoscaling will pull the count back inside `[min_capacity, max_capacity]`.
  Scaling *below* `min_capacity` is undone within minutes.
- Nothing records why the count changed. On 2026-08-18 staging was hand-scaled
  to API 3 / gateway 2 during the v0.13.0 incident; that change existed nowhere
  in code, which is what this runbook and the Terraform change now correct.

If you find yourself reaching for it twice for the same reason, raise
`min_capacity` in Terraform instead.

---

## 4. The database is NOT in Terraform

The staging database is a **hosted Supabase project**, injected into CI as
`STAGING_DATABASE_URL` (`.github/workflows/tests-release.yml`). A repo-wide grep
for `aws_db_instance` / `aws_rds_cluster` / `aws_elasticache_*` returns **zero
hits**. There is no Terraform knob, no state entry, and no plan that will ever
show it.

| | |
|---|---|
| Project ref | `ujzsbwvurfyeuerxxeaz` |
| Region | eu-west-2 |
| Compute add-on | **`ci_medium`** — resized from `ci_micro` on 2026-08-18 |
| Decision | **Keep at Medium permanently.** |

**Why Medium.** `kortix.audit_events` carries 14 indexes and takes a write on
every API request. Under the release gate's concurrency the `ci_micro` instance
was the binding constraint. Roughly $10/mo → $60/mo (Supabase list pricing,
external to this repo, verify before budgeting) against a gate that was costing
10+ engineer-hours per attempt.

**This also means the tier survives every `terraform apply`** — and that nothing
will restore it if someone changes it in the Supabase dashboard. This runbook is
the only record. Update it if the tier changes.

### Reading and changing the tier (Supabase Management API)

Requires a Supabase personal access token with access to the Kortix org.

```sh
# read the current compute add-on
curl -sS -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  https://api.supabase.com/v1/projects/ujzsbwvurfyeuerxxeaz/billing/addons | jq .

# change it (variants: ci_micro, ci_small, ci_medium, ci_large, ci_xlarge, …)
curl -sS -X POST \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  https://api.supabase.com/v1/projects/ujzsbwvurfyeuerxxeaz/billing/addons \
  -d '{"addon_type":"compute_instance","addon_variant":"ci_medium"}'
```

A compute change restarts the database. Do not run it during a release gate.
Confirm the applied variant with the `GET` above before declaring it done —
verify the endpoint shape against current Supabase Management API docs if the
call 404s, since that API is outside this repo's control.

---

## 5. Do not cancel a running release gate without sweeping its debris

`tests-release.yml` tears down its world in a `finally` block
(`tests/src/core/runner.ts`, `tests/src/fixtures/world.ts`). A cancelled GitHub
job is SIGKILLed and never reaches it. Every cancel therefore leaks that run's
entire world: accounts, PATs, projects, and live sandboxes. Nine cancels
compounded into 73 running sessions and 186 live PATs, whose background traffic
then loaded the same staging origin the next attempt had to run against.

**The rule: a cancel is not free.** If you cancel a `tests-release` run, sweep
its debris in the same sitting:

```sh
bun tests/bin/ke2e.ts gc --older-than 2h
```

`tests-release.yml` now sweeps automatically (added in #6545): a pre-run
`ke2e gc --older-than 2h` (`:65`) clears prior debris before load starts, and
each shard runs `ke2e gc --run-id "$KE2E_RUN_ID"` under `if: always()` (`:131-133`)
so a failed or passed shard reclaims exactly its own accounts. The manual
command above is the fallback for a job killed outside those hooks — a SIGKILLed
runner never reaches `always()` either.

Two known gaps in the sweep, both still open at the time of writing:

- GC filters on `%@ke2e.kortix.test`; the Playwright specs mint accounts under
  `@example.test` and are not reclaimed.
- Stripe test-mode customers and subscriptions leak on every run.

---

## 6. `MAINTENANCE_MODE` from staging is usually not maintenance

`infra/cloudflare/workers/api-router/worker.mjs` replaces any origin fetch
failure, or any origin 502/503/504, with a synthetic `MAINTENANCE_MODE` 503. A
real capacity problem reads as a scheduled maintenance window.

Since 2026-08-19 the Worker attaches `X-Origin-Status` to that synthetic
response (the true origin status, or `fetch-error` when the fetch threw) and
restores the origin's `x-request-id` when it sent one. **Read `X-Origin-Status`
first** — it separates "the origin returned 503" from "the origin was
unreachable".

A trusted CI run can also opt out of the laundering entirely by sending
`X-Kortix-CI-Passthrough: <secret>`, matched against the Worker's
`CI_PASSTHROUGH_SECRET` binding (deployed from the `CF_WORKER_CI_PASSTHROUGH_SECRET`
repository secret). With a valid marker the true origin status and body pass
through unmodified. Public behavior is unchanged.

---

## Related

- `.claude/skills/learnings/SKILL.md` — "`tests-release`'s own load can knock
  staging over, then the edge worker hides it as 'maintenance'".
- `docs/runbooks/enable-sandbox-provider.md`, `docs/runbooks/self-hosting.md`.
- `infra/terraform/modules/ecs-api/` — the shared module for every ECS service.

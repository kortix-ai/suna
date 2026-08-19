# Production API outage: OOM, stale secret selectors, and schema drift

Date: 2026-08-06

Service: `api.kortix.com`

Severity: production outage

## Impact

`GET https://api.kortix.com/health` returned `504` after both API tasks stopped.
Better Stack opened the incident at `2026-08-06T19:51:39Z`.

The public API recovered at `2026-08-06T19:59:24Z`.

## Root cause

Two independent failures combined into the outage.

1. Both `2 GiB` API tasks exhausted memory during the same marketplace catalog refresh.
   ECS recorded exit code `137` and `OutOfMemoryError: container killed due to memory usage` for both API containers.
   Both task logs stopped while loading external marketplace registries.
   The production catalog contained `7,248` items.
   `buildExternalCatalog()` started every external registry load through one unbounded `Promise.allSettled()` call.

2. ECS could not start replacement capacity.
   Task definition `kortix-prod:33` referenced individual JSON keys in `kortix-prod-env`.
   Six optional Mailtrap keys had been removed from the secret one day earlier.
   ECS rejected replacement task `e169687efae44e6e9c47f80f0f7ac8a5` before container startup because `MAILTRAP_ACCOUNT_ID` no longer existed.

The Mailtrap removal did not crash a running container.
The stale task-definition selector prevented ECS from replacing a failed container.

## Evidence

- Failed API tasks:
  - `6ca084bb125844d5b75306080f05c288`
  - `f0ab890ddb2c4e1c8443e21857e8917b`
- Both tasks used `kortix-prod:33`.
- Both API containers exited with code `137`.
- Both ECS container reasons were `OutOfMemoryError: container killed due to memory usage`.
- Replacement task `e169687efae44e6e9c47f80f0f7ac8a5` failed with `TaskFailedToStart`.
- Its ECS reason named the missing `MAILTRAP_ACCOUNT_ID` JSON key.
- CloudTrail event `f561aa00-1e1b-4002-be6e-617023662724` records `PutSecretValue` for `kortix-prod-env` at `2026-08-05T20:21:43Z` in `us-west-2`.
- The previous secret version had `137` keys.
- The current secret version had `131` keys.
- Removed keys:
  - `MAILTRAP_ACCOUNT_ID`
  - `MAILTRAP_API_TOKEN`
  - `MAILTRAP_BUSINESS_SIGNUPS_LIST_ID`
  - `MAILTRAP_SENDER_EMAIL`
  - `MAILTRAP_SENDER_NAME`
  - `MAILTRAP_SIGNUPS_LIST_ID`

## Timeline

All times use UTC.

- `2026-08-05T20:21:43Z`: The production secret update removes six Mailtrap keys.
- `2026-08-06T19:49:56Z`: ECS creates extra task `e169687efae44e6e9c47f80f0f7ac8a5`.
- `2026-08-06T19:50:20Z`: Both existing API log streams stop during external marketplace registry loading.
- `2026-08-06T19:50:52Z`: The extra ECS task stops before startup because `MAILTRAP_ACCOUNT_ID` is absent.
- `2026-08-06T19:51:39Z`: Better Stack reports `504` from the production health endpoint.
- `2026-08-06T19:56:17Z`: Task definition `kortix-prod:34` registers without the deleted Mailtrap selectors.
- `2026-08-06T19:59:24Z`: The public health endpoint returns `200` again.
- `2026-08-06T20:01:52Z`: ECS reports the recovery deployment complete.
- `2026-08-06T20:05:40Z`: Task definition `kortix-prod:35` registers with `4 GiB` memory.
- `2026-08-06T20:05:41Z`: Gateway task definition `kortix-prod-gateway:29` registers without the deleted selectors.
- `2026-08-06T20:09:07Z`: The gateway rollout completes with `2/2` tasks.
- `2026-08-06T20:09:59Z`: The API rollout completes with `3/3` tasks.
- `2026-08-06T20:17:06Z`: The API reaches steady state after the autoscaling floor changes to three tasks.
- `2026-08-06T20:44:06Z`: API revision `36` starts from merge commit `8f121bd61a60`.
- `2026-08-06T20:49:58Z`: Live traffic exposes `18` unapplied database migrations. Project and billing routes return `500` for missing columns.
- `2026-08-06T20:54:39Z`: All `18` migrations are applied to the primary and disaster-recovery databases. Public API traffic returns `200` again.

## Recovery

The incident response made these production changes:

- Registered API revision `34` without the six deleted Mailtrap selectors.
- Restored three healthy API tasks.
- Registered API revision `35` with `4096 MiB` task memory.
- Registered gateway revision `29` without the deleted Mailtrap selectors.
- Set the production API autoscaling floor to three tasks.
- Repaired the ALB metric dimensions and installed zero-healthy-host alarms for the API and gateway.

Post-recovery verification:

- API revision `36`: rollout `COMPLETED`, desired `3`, running `3`, pending `0`.
- Gateway revision `30`: rollout `COMPLETED`, desired `2`, running `2`, pending `0`.
- API target group: three healthy targets.
- Gateway target group: two healthy targets.
- Public API health: `20/20` requests returned `200`.
- Public gateway health: `20/20` requests returned `200`.
- Public marketplace: `10/10` requests returned `200`.
- Marketplace response: `7,250` items, `loading: false`, `pending: 0`.
- API health reached all three instances. Every instance reported commit `8f121bd61a60`.
- Both production databases reported `No migrations to run`.

## Recovery regression: schema drift

The emergency ECS rollout used `infra/scripts/ecs-deploy.sh` directly because the GitHub-hosted production workflow was queued.
That path registered the new image without running the workflow's `migrate-db` job.
The image required `18` migrations that production had not applied.

The migration runner then found two production-only schema differences:

- `credit_accounts` did not contain the legacy `kortix_credit_accounts_billing_model_check` constraint.
- The disaster-recovery logical publication still published `project_session_connector_bindings.profile_id`.

The billing migration now drops the old constraint with `IF EXISTS` before installing the canonical constraint.
The connector migration now detaches explicit logical publications, removes `profile_id`, and re-adds the table with its canonical column list in one transaction.
The primary publication now includes `connection_id` and excludes `profile_id`.
Live production ECS rolls now require `--database-migrated`.
Both production workflows pass this assertion only after their migration steps.
A direct emergency ECS roll without the migration assertion exits before it calls AWS.

## Permanent prevention

This change removes each failure class.

### Secret deletion safety

ECS now injects the full environment secret through one stable `KORTIX_ENV_JSON` selector.
The API and gateway expand the JSON before any configuration or observability module reads `process.env`.
Explicit task-definition environment variables override values from the secret.

Adding or removing an optional JSON key no longer invalidates an existing ECS task definition.

### Marketplace memory control

External marketplace registry loading now uses at most four concurrent loads per API task.
Completed refreshes receive up to one hour of random jitter beyond the 24-hour cache lifetime.
The jitter prevents replicas deployed together from refreshing together every day.

### Capacity and detection

Production and disaster-recovery API tasks use `4096 MiB` memory.
The active production API keeps a minimum of three tasks.
The ALB alarm reconciler now creates a `HealthyHostCount < 1` alarm for every target group.
Target health and response-time alarms now use the required target-group and load-balancer dimensions.

## Verification gates

- `bun test packages/shared/src/environment-secret.test.ts`
- `bun test apps/api/src/__tests__/unit-marketplace.test.ts --timeout 30000`
- `bun test infra/cloudflare/workers/api-router/worker.test.mjs`
- `python3 -m unittest test_alb_alarm_reconciler.py`
- `pnpm --filter kortix-api typecheck`
- `pnpm --filter @kortix/llm-gateway-server typecheck`
- `pnpm --filter @kortix/shared test`
- `terraform fmt -check` for all changed Terraform files
- `terraform validate` for the ECS module, production root, and disaster-recovery root
- `bash -n infra/scripts/ecs-deploy.sh`
- Production API and gateway `--dry-run` task-definition renders

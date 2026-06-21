# Observability — where the logs/traces/metrics are (and how to read them)

> TL;DR: **prod logs live in Better Stack, NOT CloudWatch.** CloudWatch is legacy
> (frozen 2026-04-07 when logging migrated; the old app log groups were deleted).
> The real prod logs table is **`kortix_api`**, *not* `kortix_api_2` (a stale
> metrics rollup — querying it and concluding "logs are dead" is a known trap).

## What ships where

The API ships structured logs via `@logtail/node` → **Better Stack Telemetry**
(`apps/api/src/lib/logger.ts`). Errors also go to Sentry, tunnelled to Better
Stack's Sentry-compatible endpoint. It's gated on `BETTERSTACK_API_LOG_TOKEN` +
`BETTERSTACK_API_LOG_HOST`, injected at runtime from **AWS Secrets Manager**
(`kortix-prod-env` in eu-west-2). They are NOT in the repo `.env.prod`, so that
file showing them blank tells you nothing about prod.

EKS container stdout also ships to Better Stack (source `kubernetes_prod_eks`).

## Reading the logs

1. **List the sources** (authoritative — find the right table, don't guess):
   ```sh
   curl -sS https://telemetry.betterstack.com/api/v1/sources \
     -H "Authorization: Bearer $BETTERSTACK_TELEMETRY_API_TOKEN" \
     | jq '.data[].attributes | {name, table_name, ingesting_paused, updated_at}'
   ```
   Sources (Better Stack team `t502678` "Kortix", ClickHouse DB `t502678`):
   | Source | ClickHouse table | what |
   | --- | --- | --- |
   | Kortix API (prod) | **`t502678.kortix_api_logs_local`** | prod app logs (live, ~4–5k/15min) |
   | Kortix API (prod) | `t502678.kortix_api_spans_local` | prod traces |
   | Kortix API (dev) | `t502678.kortix_api_dev_logs_local` | dev app logs |
   | ⚠️ `kortix_api_2*` | — | **STALE** web-analytics/Sentry metrics rollup. Ignore. |

2. **Query ClickHouse** over the HTTPS interface (creds `BETTERSTACK_CLICKHOUSE_*`
   in `apps/api/.env.prod`):
   ```sh
   ch() { curl -sS --user "$BETTERSTACK_CLICKHOUSE_USERNAME:$BETTERSTACK_CLICKHOUSE_PASSWORD" \
     "https://$BETTERSTACK_CLICKHOUSE_HOST/" --data-urlencode "query=$1 FORMAT PrettyCompact"; }
   ch "SELECT max(dt), countIf(dt>now()-INTERVAL 15 MINUTE) FROM t502678.kortix_api_logs_local"
   ```
   Gotchas: use `--data-urlencode "query=…"` (raw `--data-binary` → `Empty query`);
   the connect host load-balances across nodes with different local tables and the
   raw shard names rotate per connection, so **query the stable `_logs_local` view**
   and **retry** on `… does not exist` (you hit a node without it).

The `clickhouse` skill in the **company** repo (`.kortix/opencode/skills/clickhouse/`)
has the full cookbook + field notes; this file is the suna-side pointer.

## Current runtime topology (verified 2026-06-21)

- **prod** = **eu-west-2 (London)**, **EKS `kortix-prod-eks`** is the **active**
  backend (`api.kortix.com` → Cloudflare Worker → EKS ALB; pods `kortix-api-*`).
- **dev** = **us-west-2**, **EKS `kortix-dev-eks`** active.
- **ECS Fargate is the WARM STANDBY**, not legacy — the Cloudflare Worker
  (`ACTIVE_BACKEND`) flips `api.kortix.com` between EKS and ECS. ⚠️ **Do not delete
  the ECS clusters / `kortix-*-alb` ALBs** thinking they're old; they're the
  failover. Stacks: `infra/terraform/environments/{prod,dev}` (state
  `prod/ecs-api.tfstate`, `dev/ecs-api.tfstate`). The Worker reaches them via the
  stable hostnames `api-ecs-fargate.kortix.com` / `dev-api-ecs-fargate.kortix.com`.

### Restoring the ECS standby (if it ever gets torn down)
```sh
cd infra/terraform/environments/prod   # or dev
export TF_VAR_cloudflare_api_key=<global key>  TF_VAR_cloudflare_email=marko@kortix.ai
terraform init && terraform plan   # expect: recreate ecs cluster/service/ALB + update *-ecs-fargate CNAME
terraform apply
```
Gotcha: if a stale `*-ecs-fargate` CNAME or its ACM-validation CNAME already exists
in Cloudflare (pointing at a deleted ALB), the apply fails with *"DNS record
already exists"* — delete those two records in CF, then re-apply.

### Known fragility: Docker Hub pull rate limit
ECS task-defs pull `kortix/kortix-api:*` from Docker Hub **unauthenticated** →
fresh task placement can hit `CannotPullContainerError: 429 toomanyrequests`
(per-NAT-IP anon limit). It self-heals (ECS retries; limit resets; next CI deploy
fixes it), but the proper fix is registry creds on the task execution role
(`repositoryCredentials`) or mirroring the image to ECR.

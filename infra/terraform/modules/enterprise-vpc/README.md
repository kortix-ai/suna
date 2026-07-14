# Enterprise VPC runtime plane

This module is the single-tenant AWS substrate used for Kortix-owned
customer-zero and customer VPC installations. It runs the same ECS Fargate
pattern that Kortix Cloud runs in production (`modules/ecs-api`,
`infra/scripts/ecs-deploy.sh`) while changing ownership, release channel, data
boundary, and update control plane. The whole system is one sentence: **a signed
release manifest, three ECS services and a Supabase EC2 behind one ALB, deployed
by one CLI command.**

## Runtime topology

- Three-AZ VPC with one NAT gateway per AZ, private workload subnets, VPC flow
  logs, default-deny default security group, and private AWS service endpoints
  (including `bedrock-runtime`).
- One ECS Fargate cluster `kortix-<instance>` (container insights on) running
  three services behind a shared public ALB:
  - `kortix-<instance>-api` (port 8008, min 2 tasks, AZ spread)
  - `kortix-<instance>-gateway` (port 8090, min 2 tasks, AZ spread)
  - `kortix-<instance>-frontend` (port 3000, 2 tasks)
  and two one-off task-defs: `kortix-<instance>-migrate`
  (`bun scripts/migrate.ts bootstrap`) and `kortix-<instance>-deployer` (the
  slim signed deployer). Rolling deploys use the ECS deployment circuit breaker
  for automatic rollback; images are digest-pinned by the deployer, so services
  `ignore_changes` on `task_definition`/`desired_count`.
- One shared ALB routes host + path: `api.<domain>` `/v1/llm*` to the gateway
  and everything else to the api; `<domain>` routes the Supabase data-plane
  prefixes (`/rest/v1 /auth/v1 /storage/v1 /realtime/v1 /functions/v1
  /graphql/v1`) to the Supabase Kong target group (the EC2 private IP on :8000)
  and everything else to the frontend. Health checks and success codes mirror
  the retired `kortix-enterprise-edge` chart.
- One private, SSM-only EC2 host for the official Supabase Docker stack, with a
  separately attached encrypted EBS data volume and EC2 system recovery.
- The gateway task role invokes Bedrock (`bedrock:InvokeModel[WithResponseStream]`,
  model allowlist variable) so managed Claude models resolve to Bedrock with
  task-role credentials and no OpenRouter dependency.
- Customer KMS keys, Secrets Manager (`<instance>/runtime`), immutable ECR image
  repositories, ACM, CloudTrail, encrypted logs, alerting, hourly AWS Backup
  recovery points, and vault lock.
- An EventBridge Scheduler rule runs the deployer task daily; it exits 0 when the
  running digests already match the signed stable manifest. An SSM parameter
  `/kortix/<instance>/release` is the human-readable breadcrumb (never a lock).
- Customer Route 53 owns ACM validation (in the cluster stage) and the two
  application A/AAAA alias records to the ALB (in the platform stage).

## Durability

Encrypted EBS plus hourly AWS Backup recovery points (`backup.tf`, with vault
lock) is the v1 durability story. RPO tracks the EBS snapshot cadence (~60m),
stated explicitly. The former custom WAL/base-backup/PITR path and its S3 bucket
were removed (unsatisfiable on the hardened Supabase image and redundant).

## Deploy control plane

Deploys are operator-driven. `kortix self-host deploy` (and the daily scheduled
deployer task, sharing the same library) verify the pinned AWS account,
TUF-verify the `stable` manifest, no-op if the running digests already match,
mirror images into customer ECR, install the Supabase bundle over SSM when it
changed, register task-def revisions (env + secrets rendered from the runtime
secret keys, the `ecs-deploy.sh` pattern), run the migrate task, roll
api → gateway → frontend, and write the SSM release breadcrumb. The ECS circuit
breaker rolls back a bad task-def automatically. There is no Step Functions,
CodeBuild, DynamoDB, or EventBridge hint bus — live ECS state is the release
state, and ECS serializes deployments per service so no lease is needed.

## Safety contract

Every plan is classified by `infra/terraform/scripts/guard-enterprise-plan.ts`:

- any delete or replacement is blocked;
- IAM, KMS, ECS cluster, network, backup, audit, encryption, policy, versioning,
  and retention changes require manual customer review; and
- ordinary additive/runtime changes — including ECS services and task
  definitions — may auto-apply.

All runtime and deployer roles require `permissions_boundary_arn`, normally the
output of `modules/enterprise-state`. Kortix GitHub never receives customer AWS
credentials. Optional operator access is customer-approved, external-ID
protected, limited to one-hour sessions, read-only inspection, and SSM host
operations.

## Release prerequisites

Do not apply this module with placeholder release values. Deployment requires an
offline-reviewed TUF root digest, immutable enterprise artifacts signed with
KMS-backed Cosign, and a certified `stable` target using `<prod-version>-e<revision>`.

The CLI generates all internal database, Supabase, API, gateway, and signing
credentials directly into customer Secrets Manager after the cluster stage. It
never persists those values in the instance config. Operator-owned values (SMTP,
Daytona, and the initial model provider) are set with `kortix self-host env set`.
Terraform seeds a harmless long-lived placeholder image into every task-def so
the cluster/services exist before the first signed deploy; the deployer then owns
all real, digest-pinned revisions.

Reusable modules never retain `.terraform.lock.hcl`; generated environment roots
do, so provider selections are reviewable and reproducible.

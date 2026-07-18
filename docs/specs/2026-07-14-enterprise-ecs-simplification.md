# Enterprise VPC on ECS — simplification refactor + A-to-Z deployment plan

> **Superseded again (generic self-host refactor).** The single-EC2 appliance
> this spec was superseded by (below) has itself since been replaced: `kortix
> self-host` is now ONE generic Docker Compose system with no target flag, no
> Terraform, no TUF/signing, no SSM — identical on a laptop, any VPS, or a
> cloud VM. Read `docs/runbooks/self-hosting.md` and
> `apps/web/content/docs/reference/self-hosting-architecture.mdx` for the
> current design. Kept as design history.

> **SUPERSEDED (2026-07-14) by
> [`docs/specs/2026-07-14-enterprise-appliance.md`](2026-07-14-enterprise-appliance.md).**
> The ECS/ALB/deployer runtime described below was replaced by a single-EC2, 100%
> Docker appliance (Caddy + api×2 + gateway + frontend + official Supabase Docker,
> reconciled by an on-box systemd updater timer). Everything release-side here still
> stands unchanged — the TUF `stable` channel, `Promote Enterprise Stable`
> (copy+sign, never rebuild), compatibility contracts with enforced `rollback_from`,
> digest pinning, image mirroring, account pinning, secret generation, and the
> `kortix self-host` CLI surface. Read the appliance spec for the current runtime,
> `infra/terraform/modules/enterprise-vpc/README.md` for the module, and
> `docs/runbooks/enterprise-vpc-deployment.md` for operations (this runbook path
> itself is gone — see the generic self-host note above).

Date: 2026-07-14. Status: SUPERSEDED (runtime half). Supersedes the EKS-based
deployment in `docs/specs/2026-07-13-enterprise-vpc-single-tenant-deployment.md`
(architecture section only — the BYOC thesis, signed releases, and account model
stand).

## Decision

Replace the EKS + Helm + External Secrets + Step Functions + CodeBuild +
EventBridge + DynamoDB enterprise deployment with the ECS Fargate pattern that
prod itself now runs (PR #4676/#4682/#4683, `infra/terraform/modules/ecs-api`,
`infra/scripts/ecs-deploy.sh`). Goals: simplicity, operator-driven deploys, and
"the whole system explainable in one sentence": **a signed release manifest,
three ECS services and a Supabase EC2 behind one ALB, deployed by one CLI
command.**

Why each deleted piece is safe to delete:

- **DynamoDB (release state + lease)** existed to coordinate *unattended
  hourly* self-updates. Deploys become operator-driven (plus one simple daily
  scheduled check) — live ECS state (`describe-services` image digests) IS the
  release state; ECS serializes deployments per service, so no lease.
- **Step Functions + CodeBuild + EventBridge hints** — the unattended update
  robot. Replaced by: `kortix self-host deploy` (operator) and one EventBridge
  Scheduler rule → `ecs:RunTask` of the deployer task, daily, which exits 0 if
  the running digests already match the stable manifest.
- **Helm + External Secrets** — ECS injects secrets natively from Secrets
  Manager into task definitions; rolling deploys + automatic rollback come from
  the ECS deployment circuit breaker.
- **Custom WAL/base-backup/PITR** — unsatisfiable on the hardened Supabase
  image (the 0.9.108-e12 failure) and redundant: encrypted EBS + hourly AWS
  Backup (`backup.tf`, already live and healthy on customer-zero) is the v1
  durability story. RPO becomes ~1h (EBS snapshot cadence), stated explicitly.

What is KEPT unchanged: TUF-signed immutable release manifests + the
`Promote Enterprise Stable` workflow (copy-and-sign, never rebuild); digest
pinning end-to-end; ECR mirroring into the customer account; account pinning;
Secrets Manager as the single secret store; official Supabase Docker on one
private EC2 with encrypted EBS + AWS Backup; Route53/ACM; the
`kortix self-host` CLI surface; `guard-enterprise-plan.ts`.

## Target architecture (per customer account)

```
VPC (existing module: subnets, NAT, flow logs)
├── ALB  kortix-<instance>  (public subnets, TLS via ACM)
│     host api.<domain>:   /v1/llm* → TG gateway, /* → TG api
│     host <domain>:       /rest/v1* /auth/v1* /storage/v1* /realtime/v1*
│                          /functions/v1* /graphql/v1* → TG supabase (IP TG →
│                          EC2 private IP:8000 Kong), /* → TG frontend
├── ECS cluster kortix-<instance> (Fargate, container insights)
│     service kortix-<instance>-api       (ECR digest-pinned, port 8008)
│     service kortix-<instance>-gateway   (port 8090)
│     service kortix-<instance>-frontend  (standalone Next.js, port 3000)
│     task-def kortix-<instance>-migrate  (one-off: bun scripts/migrate.ts bootstrap)
│     task-def kortix-<instance>-deployer (one-off: slim updater binary)
│     circuit breaker ON (auto-rollback), AZ spread, min 2 tasks api/gateway
├── EventBridge Scheduler: daily → ecs:RunTask deployer (auto-update check)
├── EC2 Supabase (existing: official Docker, encrypted EBS, AWS Backup hourly,
│     SSM-managed, systemd units from the signed Supabase bundle — minus WAL)
├── Secrets Manager <instance>/runtime (existing contract incl. PR #4669 keys)
├── ECR mirror repos, KMS, Route53/ACM (existing)
└── DELETED: EKS cluster+addons, Helm releases, External Secrets, Step
    Functions, CodeBuild updater, DynamoDB, EventBridge hint bus wiring,
    WAL/base-backup IAM + S3 prefixes + systemd units
```

Naming contract (deployer + CLI discover everything from `<instance>`):
cluster `kortix-<instance>`; services/task-def families as above; secret
`<instance>/runtime`; ALB + TGs tagged `kortix:instance=<instance>`.

## Deploy flow (CLI and scheduled task run the SAME library code)

`kortix self-host deploy --instance <name>` (in `apps/cli`), and the deployer
binary (in `apps/enterprise-updater`, slimmed):

1. Verify pinned AWS account. Fetch + TUF-verify the `stable` channel manifest.
2. If running digests (all three services + Supabase bundle sha recorded in an
   SSM parameter `/kortix/<instance>/release`) already match → exit 0 (this is
   the whole "is there anything to do" check; SSM parameter replaces DynamoDB
   as a human-readable breadcrumb, never as a lock).
3. Mirror images into customer ECR by digest (existing code, keep).
4. If Supabase bundle changed: SSM RunCommand install/finalize on the EC2
   (existing scripts minus WAL), health-check Kong authenticated endpoint.
5. Register new task-def revisions (render env+secrets from the runtime secret
   keys, like `ecs-deploy.sh`), run migrate task, wait for exit 0.
6. `update-service` api → gateway → frontend; `aws ecs wait services-stable`;
   circuit breaker handles rollback of a bad task-def automatically.
7. Public health checks (existing curl retry logic), write SSM release param,
   print summary. On failure: report loudly, roll back only what the circuit
   breaker didn't (Supabase bundle rollback stays, existing script), NEVER
   tear down healthy services for a non-critical step.

`rollback --release <v>` = deploy of an older signed revision; contracts MUST
list predecessors in `rollback_from` (workflow now enforces non-empty).

## LLM upstream (certification-blocking gap, fix in this refactor)

Gateway task role gets `bedrock:InvokeModel` + `bedrock:InvokeModelWithResponseStream`
(region-scoped; model allowlist variable). Investigate the gateway's existing
Bedrock provider config (prod uses Claude→Bedrock) and set the enterprise
runtime-secret defaults so managed Claude models resolve to Bedrock with task-role
credentials and NO OpenRouter dependency. A deployment is not certifiable until
one real agent turn completes against Bedrock.

Sandboxes: v1 keeps `ALLOWED_SANDBOX_PROVIDERS=daytona` via NAT egress —
documented limitation in the runbook (single-tenant sandboxes = separate
project).

## Workstreams

- **WS-TF** `infra/terraform/**`: refactor `modules/enterprise-vpc` (drop
  eks/updater/wal resources; add ECS cluster/services/ALB/TGs/scheduler/IAM
  incl. Bedrock; keep vpc/supabase/backup/kms/secrets/dns; fix
  `backup_contract` output to RPO≈60m); update `environments/enterprise-vpc-template`.
- **WS-DEPLOY** `apps/enterprise-updater/**` + `apps/cli/src/self-host/**`:
  shared deploy library per flow above; delete stepfn/dynamo/lease/helm/ESO/WAL
  code; CLI keeps init/doctor/plan/deploy/update/rollback/status/version/env.
- **WS-RELEASE** `apps/enterprise-release/**` + promote workflow: strip
  WAL/base-backup/PITR from bundles + tests; keep signing untouched; add
  non-empty `rollback_from` + predecessor check to the workflow.
- **WS-INTEGRATION** (after the above): ci.yml path filters + chart-render step
  (enterprise-edge chart deleted; kortix-api/gateway charts stay — dev EKS uses
  them), full test suites, docs rewrite (module README, deployment runbook,
  spec supersession notes), typecheck across seams.
- **WS-LIVE**: stop the zombie Step Functions execution on customer-zero; tear
  down the EKS-era stack; fresh A-to-Z `init → doctor → plan → deploy`;
  certify (authenticated app flow + agent turn on Bedrock + backup recovery
  point); then the enterprise pilot customer's own account from the same
  signed revision.

## Certification checklist (per deployment)

- [ ] `terraform apply` clean from the generated env root
- [ ] all 3 ECS services stable on expected digests; migrate task exit 0
- [ ] Supabase authenticated health through Kong
- [ ] API /v1/health 200 with expected version; frontend 200
- [ ] sign-up/sign-in + one real project/session flow persists data
- [ ] one agent turn completes against Bedrock (no OpenRouter)
- [ ] AWS Backup recovery point exists; restore procedure documented
- [ ] deployer scheduled task ran once and no-oped cleanly
- [ ] rollback to previous revision exercised once (customer-zero only)

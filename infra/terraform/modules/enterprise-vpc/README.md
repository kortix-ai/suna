# Enterprise VPC runtime plane (single-EC2 appliance)

This module is the single-tenant AWS substrate used for Kortix-owned
customer-zero and customer VPC installations. The whole product runs as Docker
containers on ONE host, changing ownership, release channel, data boundary, and
update control plane from Kortix Cloud. The whole system is one sentence: **a
signed release manifest and one box running Caddy + the Kortix containers +
official Supabase Docker, updated by a systemd timer, deployed by one CLI
command.**

## Runtime topology

- Three-AZ VPC with one NAT gateway per AZ, public + private subnets, VPC flow
  logs, default-deny default security group, and private AWS service endpoints
  (including `bedrock-runtime`).
- One public EC2 appliance host `kortix-<instance>-appliance` (default
  `m7i.2xlarge`, sized for Supabase + api×2 + gateway + frontend + Caddy) in a
  public subnet with a stable Elastic IP. Inbound is 80/443 from `ingress_cidrs`
  only; there is no SSH (SSM is the only management path). It runs everything as
  Docker containers:
  - Caddy terminates TLS (ACME, DNS-01 through Route 53) and owns host/path
    routing: `api.<domain>` `/v1/llm*` → gateway:8090, else → api:8008;
    `<domain>` the Supabase data-plane prefixes (`/rest/v1 /auth/v1 /storage/v1
    /realtime/v1 /functions/v1 /graphql/v1`) → supabase-kong:8000, else →
    frontend:3000. api runs 2+ replicas; Caddy load-balances with upstream
    health checks.
  - The official Supabase Docker stack (systemd `kortix-supabase.service`, seeded
    by user-data) on a separately attached encrypted EBS data volume mounted at
    `/var/lib/kortix`.
  - The app bundle (docker-compose + Caddyfile + `.env`) installs its own systemd
    units from the signed release — they are NOT baked into user-data.
- One instance profile replaces every ECS task/exec role. The containers and the
  on-box updater all run under it: read the runtime + updater secrets and customer
  KMS keys; pull digest-pinned images from the customer ECR mirror (read only);
  read staged bundle tarballs from S3; invoke Bedrock
  (`bedrock:InvokeModel[WithResponseStream]`, model allowlist variable) so managed
  Claude resolves to Bedrock via SigV4 with no bearer key and no OpenRouter
  dependency; manage Route 53 records (ACME DNS-01 + the app A records, zone-scoped);
  read/write the release breadcrumb; and publish host metrics.
- Customer KMS keys, Secrets Manager (`<instance>/runtime`, `<instance>/updater`),
  immutable ECR mirror repositories, CloudTrail, encrypted logs, alerting, hourly
  AWS Backup recovery points, and vault lock. TLS is the box's job (Caddy/ACME),
  so there is no ACM certificate.
- A KMS-encrypted, versioned, TLS-only release-staging S3 bucket
  (`kortix-<instance>-…-artifacts`). The updater reads verified Supabase/app
  bundle tarballs from `updater-staging/` (lifecycle-expired) over the S3 gateway
  endpoint; it holds only transient deploy artifacts, never customer data.
- A systemd timer on the box runs the updater daily; it no-ops when running image
  digests already match the signed stable manifest. An SSM parameter
  `/kortix/<instance>/release` is the human-readable breadcrumb (never a lock).
- Customer Route 53 owns the two application A records → the appliance EIP,
  created directly in the cluster stage. EIPs are IPv4-only, so v1 publishes A
  records only (AAAA is deferred until the VPC/host carry IPv6).

## Self-healing

- EC2 auto-recovery alarm on `StatusCheckFailed_System` recovers the host on an
  underlying system failure.
- A visible `StatusCheckFailed_Instance` alarm surfaces a wedged guest OS/network.
- The CloudWatch agent publishes `disk_used_percent` for `/var/lib/kortix`
  (aggregated on `InstanceId`); an alarm fires as the data volume fills so images
  can be pruned or the volume grown before it wedges.
- user-data hardens dockerd itself: `live-restore: true` keeps containers running
  across a daemon restart/upgrade, plus a global log-size cap as a
  belt-and-suspenders to the bundle's per-service limits.
- The root volume defaults to 100 GiB for Docker image churn between prunes.

## Durability

Encrypted EBS plus hourly AWS Backup recovery points (`backup.tf`, with vault
lock) is the v1 durability story. The backup plan snapshots the Supabase data
volume hourly; recovery is a whole-volume restore to the most recent recovery
point, so the RPO tracks the snapshot cadence (~60m) and is stated explicitly.
No custom log-shipping or point-in-time database machinery runs on the host —
it was unsatisfiable on the hardened Supabase image and redundant given AWS
Backup.

## Deploy control plane

Deploys are operator-driven and reconciled ON the box. `kortix self-host deploy`
runs `terraform apply` (state + cluster stages) then triggers the on-box updater
over SSM; the daily systemd timer runs the same updater. The updater verifies the
pinned AWS account, TUF-verifies the `stable` manifest, no-ops if the running
container digests already match, pulls digest-pinned images from the customer ECR
mirror, installs the Supabase bundle when it changed, runs the one-off
`docker compose run --rm migrate`, then rolls each app service blue-green
(`compose up -d --no-deps` new containers → container healthchecks pass → Caddy
upstream health gates traffic → old containers stop), and writes the SSM release
breadcrumb. On a failed health check it keeps the old containers, reports loudly,
and exits nonzero — a failed optional step never takes down healthy containers. A
concurrent run is guarded by a lockfile + `flock`. Rollback is the same flow
pointed at an older signed release (`rollback_from` enforced by contract).

## Safety contract

Every plan is classified by `infra/terraform/scripts/guard-enterprise-plan.ts`:

- any delete or replacement is blocked;
- IAM, KMS, the appliance instance + EIP, security groups, network, backup,
  audit, encryption, policy, versioning, and retention changes require manual
  customer review; and
- ordinary additive/runtime changes — new ECR images, log groups, DNS records,
  alarms — may auto-apply.

The instance profile and every service role require `permissions_boundary_arn`,
normally the output of `modules/enterprise-state`. Kortix GitHub never receives
customer AWS credentials. Optional operator access is customer-approved,
external-ID protected, limited to one-hour sessions, read-only inspection, and
SSM host operations.

## Release prerequisites

Do not apply this module with placeholder release values. Deployment requires an
offline-reviewed TUF root digest, immutable enterprise artifacts signed with
KMS-backed Cosign, and a certified `stable` target using `<prod-version>-e<revision>`.

The CLI generates all internal database, Supabase, API, gateway, and signing
credentials directly into customer Secrets Manager after the cluster stage. It
never persists those values in the instance config. Operator-owned values (SMTP,
Daytona, and the initial model provider) are set with `kortix self-host env set`.
Terraform stands up the box and its data plane; the on-box updater then pulls the
first signed, digest-pinned release and installs the app + Supabase bundles.

Reusable modules never retain `.terraform.lock.hcl`; generated environment roots
do, so provider selections are reviewable and reproducible.

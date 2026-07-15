# Enterprise appliance deployment and update runbook

The enterprise installation is a single-EC2 Docker appliance (not ECS/EKS/Helm).
The whole system is one sentence: **a signed release manifest and one box running
Caddy + the Kortix containers + official Supabase Docker, updated by a systemd
timer, deployed by one CLI command.** See the architecture spec
`docs/specs/2026-07-14-enterprise-appliance.md` and the module README
`infra/terraform/modules/enterprise-vpc/README.md`.

## Release flow

`main -> staging -> prod -> customer-zero certification -> stable`

`stable` is a signed release channel, not a moving source branch deployed from
Git. An enterprise version is `<prod-version>-e<revision>`. Promotion (the
`Promote Enterprise Stable` workflow) copies the exact certified image and bundle
digests and signs the manifest; it never rebuilds them. Revisions after `e1` must
declare `rollback_from` in their compatibility contract (the workflow rejects an
empty list and requires the immediately preceding published revision). The
manifest's `images.*.source` point at the public `docker.io/kortix/kortix-*`
repositories by digest — the same repos the plain Docker self-host pulls — so the
box can pull them on any VPS with no credentials. The customer ECR mirror is an
AWS-only air-gap optimization, not a requirement.

## Release publisher (Kortix account)

The shared publisher is Terraform-owned in the Kortix AWS account: its CloudFront
hostname, us-east-1 ACM certificate, Cloudflare validation/CNAME records, WAF,
encrypted WAF logs, immutable request-log bucket, object-locked TUF bucket, KMS
signing keys, and GitHub OIDC roles are one deployment. The one-time
`enterprise-release-publisher-bootstrap` root creates the GitHub OIDC Terraform
role; store its `terraform_role_arn` as the repo variable
`ENTERPRISE_PUBLISHER_TERRAFORM_ROLE_ARN` and the Kortix Cloudflare zone as
`CLOUDFLARE_ZONE_ID`. The protected `enterprise-stable` environment then runs
`Deploy Enterprise Release Publisher`.

## Host layout (identical on AWS EC2 and any VPS)

```
/opt/kortix/
├── current/            symlink → the active signed Supabase bundle release
├── releases/           extracted, sha-verified bundles
├── app/                the signed app bundle (docker-compose.yml, Caddyfile,
│                       .env, acme.caddy, caddy/Dockerfile, bin/, systemd/)
└── bin/kortix-updater  the deployer binary
/etc/kortix/instance.env   the updater contract (0600)
/var/lib/kortix/*          encrypted data volume (Postgres + storage + Caddy)
systemd: kortix-supabase.service · kortix-app.service ·
         kortix-updater.{service,timer} · kortix-watchdog.{service,timer} ·
         kortix-prune.{service,timer}
```

Caddy owns TLS + routing (one table, all platforms): `api.<domain>` `/v1/llm*` →
gateway:8090, else → api:8008 (2+ replicas, load-balanced with health checks);
`<domain>` the six Supabase data-plane prefixes → the in-box Kong, else →
frontend:3000. The in-box Kong origin is the runtime secret's `SUPABASE_URL`
(`http://<host-private-ip>:8000`) — server-side, never the public URL.

## Caddy image (fixed appliance dependency)

Caddy is pinned by digest in the signed app bundle to the official public `caddy`
image (`docker.io/library/caddy:2.11.4@sha256:af5f…`), a single source of truth in
`apps/enterprise-updater/src/caddy.ts` that both the bundle (compose default) and
the updater use. A missing `KORTIX_CADDY_IMAGE` is never fatal. **v1 uses ACME
HTTP-01 on every platform** (port 80 is open). DNS-01 via Route 53 needs the
`caddy-dns/route53` plugin, which the stock image does not bundle; the app bundle
ships `caddy/Dockerfile` (xcaddy). To enable DNS-01: build that image, push it to
a registry the box can pull, set `KORTIX_CADDY_IMAGE=<ref>@sha256:<digest>` and
`KORTIX_ACME_PROVIDER=route53` in `/etc/kortix/instance.env`, then reconcile. The
instance role's zone-scoped Route 53 grant is already provisioned (latent).

## LLM upstream (Bedrock via bearer key — v1)

Managed Claude resolves to AWS Bedrock via the `AWS_BEDROCK_API_KEY` bearer key
(an operator-supplied required runtime key) and `AWS_BEDROCK_REGION` (defaulted by
the CLI); there is no OpenRouter dependency. The appliance instance role ALSO holds
`bedrock:InvokeModel[WithResponseStream]` (model-allowlist scoped), but it is
LATENT in v1. `TODO(bedrock-sigv4)` in
`packages/llm-gateway/src/transports/bedrock/request.ts`: adding a SigV4 signing
path (sign with the instance-role credentials instead of a Bearer header) would let
the appliance drop the bearer key entirely and rely on IAM alone — no shared
secret, no rotation. Until then the bearer key is required for the `aws-ec2` target.

## AWS bootstrap order

1. The CLI resolves the AWS target and prints the STS account/region/instance
   name; it refuses an account mismatch. The instance slug must NOT start with
   `kortix-`.
2. The `state` root plans locally (bootstrap IAM/KMS/S3/state-lock changes always
   require explicit review), applies, migrates local state to the encrypted S3
   backend, and verifies lineage/serial before local cleanup.
3. The `cluster` root plans against remote state (deletes/replacements blocked;
   the first plan is necessarily manual — it creates trust/network boundaries, the
   one EC2 appliance + EIP, KMS, ECR mirror, the release-staging bucket, the
   Bedrock grant, and the two application A records → the EIP directly in the
   customer zone).
4. `bootstrapRuntimeSecret` generates all internal DB/Supabase/API/gateway/signing
   credentials directly into `<instance>/runtime` in Secrets Manager (seeded from
   the appliance's own private IP for `SUPABASE_URL`/`DATABASE_URL`). Operator
   values (SMTP, Daytona, `AWS_BEDROCK_API_KEY`) are set with
   `kortix self-host env set`.
5. `deploy` triggers the on-box updater over SSM once the operator keys are present.
6. The `platform` root is a retained no-op (nothing to do post-cluster — DNS lives
   in the module now).

The permanent customer-zero target is AWS account `935064898258`, `us-west-2`,
CIDR `10.60.0.0/16`.

## CLI management plane (AWS)

```bash
kortix self-host init \
  --target aws-ec2 --instance vpc-demo \
  --aws-profile default --region us-west-2 --vpc-cidr 10.60.0.0/16 \
  --api-domain api.vpc-demo.kortix.com --frontend-domain vpc-demo.kortix.com \
  --route53-zone-id "$CUSTOMER_PUBLIC_ZONE_ID" \
  --release-repository-url https://releases.kortix.com \
  --tuf-root-sha256 "$REVIEWED_TUF_ROOT_SHA256" \
  --release-publisher-account-id 935064898258 \
  --maintenance-window Sun:02:00-05:00 --yes

kortix self-host doctor  --instance vpc-demo
kortix self-host plan    --instance vpc-demo
kortix self-host env set --instance vpc-demo DAYTONA_API_KEY=… AWS_BEDROCK_API_KEY=… SMTP_HOST=… …
kortix self-host deploy  --instance vpc-demo

kortix self-host status    --instance vpc-demo
kortix self-host version   --instance vpc-demo
kortix self-host logs app  --instance vpc-demo --follow   # or: supabase|watchdog|api|gateway|frontend|caddy|updater
kortix self-host reconcile --instance vpc-demo
kortix self-host update    --instance vpc-demo --release 0.9.84-e1 [--force]
kortix self-host rollback  --instance vpc-demo --release 0.9.83-e2
```

`deploy`/`update`/`reconcile`/`rollback` all run the SAME on-box updater via SSM
RunCommand (`AWS-RunShellScript` sources `/etc/kortix/instance.env`, layers the
`KORTIX_DEPLOY_*` intent, runs `/opt/kortix/bin/kortix-updater run`). No secret
ever crosses the wire — the box reads Secrets Manager itself. `status`/`version`
read the SSM release breadcrumb + `docker compose ps` over SSM.

## Deploy and update mechanics (the on-box updater)

The updater is the same brain as the old ECS deployer, with every step a Docker
Compose operation on the box:

1. Verify the pinned AWS account; TUF-verify the `stable` manifest (the launcher
   also fetches/re-execs the signed updater payload).
2. No-op if the release breadcrumb AND the live container image digests
   (`docker inspect`) already match. A run already in progress (lockfile + `flock`)
   exits 0.
3. Pull digest-pinned images — from the customer ECR mirror on AWS
   (`KORTIX_ECR_REPOSITORIES` set), or straight from the public `docker.io/kortix/*`
   source by digest on a VPS.
4. If the Supabase bundle sha changed, install/finalize it (staging extract,
   symlink swap, previous-release restore on failure). Its keys come from Secrets
   Manager (`--runtime-secret-arn`) or the local runtime-env file (`--runtime-env`).
5. Render `/opt/kortix/app/.env` + enforce the digest lock via the signed
   `bin/install` (nothing has touched a running container yet).
6. Migrate to completion FIRST: `docker compose run --rm migrate`
   (`bun /app/packages/db/scripts/migrate.ts bootstrap`); a nonzero exit aborts
   before any service moves.
7. Roll `api -> gateway -> frontend` start-first, one service at a time: scale up
   new containers on the new digest (`--no-recreate`), wait for their healthchecks,
   then stop the old ones. A failed health gate keeps the old containers serving,
   reports loudly, and exits nonzero — a failed step never takes down healthy
   containers. api never drops below 2 healthy replicas.
8. Reconcile the Caddy edge, run public health checks, write the breadcrumb
   (`/var/lib/kortix/release.json` + the SSM param on AWS).

The watchdog timer curls the local health endpoints and restarts `kortix-app`
after 3 consecutive failures (10-minute cooldown), and NEVER acts mid-deploy (it
takes the same `flock` the updater holds). The prune timer reclaims dangling
images/build cache weekly under the same lock.

## Zero-downtime guarantee and the backward-compatible contract

The start-first roll (step 7) briefly runs the OLD app containers against the NEW
schema while the new containers come up healthy. That is safe ONLY when every
migration in the release is backward-compatible — each release manifest carries a
per-migration `backward_compatible` boolean in its compatibility contract. Before
migrating an UPDATE (not a first install), the updater inspects those flags:

- **All backward-compatible** → the normal zero-downtime start-first roll.
- **Any NOT backward-compatible** → the release cannot be applied with zero
  downtime. The updater REFUSES it unless the operator opts in with
  `--allow-downtime` (CLI) / `KORTIX_ALLOW_DOWNTIME=1` (deployer env). Without the
  opt-in the deploy aborts BEFORE pulling images or migrating — nothing is touched.
  With it, the updater performs a brief, honest downtime window: drain the app tier
  (stop `api`/`gateway`/`frontend`; Supabase and Caddy stay up), migrate, then start
  the new containers.

A first install is always fine (no old containers). Run a non-backward-compatible
release only during a scheduled maintenance window:

```bash
kortix self-host update --instance vpc-demo --release 0.9.90-e1 --allow-downtime --yes
```

## VPS bootstrap (appliance minus Terraform — one self-host system)

A plain VPS runs the IDENTICAL bundles + updater; only provisioning differs. On a
fresh Ubuntu host with a public IP and the two app A records already pointing at it:

```bash
export KORTIX_INSTANCE=acme \
  KORTIX_API_DOMAIN=api.acme.example.com KORTIX_FRONTEND_DOMAIN=acme.example.com \
  KORTIX_RELEASE_REPOSITORY=https://releases.kortix.com \
  KORTIX_TUF_ROOT_SHA256=… \
  KORTIX_UPDATER_BOOTSTRAP_URL=https://releases.kortix.com/bootstrap/…/kortix-enterprise-updater-linux-amd64 \
  KORTIX_UPDATER_BOOTSTRAP_SHA256=… \
  KORTIX_ACME_EMAIL=ops@acme.example.com \
  DAYTONA_API_KEY=… AWS_BEDROCK_API_KEY=… AWS_BEDROCK_REGION=us-west-2 \
  SMTP_ADMIN_EMAIL=… SMTP_HOST=… SMTP_PORT=587 SMTP_USER=… SMTP_PASS=… SMTP_SENDER_NAME=Acme
sudo -E bash scripts/appliance-bootstrap.sh
```

The script installs Docker/compose/jq/openssl, generates the runtime keys into
`/etc/kortix/runtime.json` (0600) — the VPS analogue of the CLI's Secrets Manager
bootstrap, including the Supabase HS256 JWTs and all crypto keys — writes the VPS
variant of `instance.env` (`KORTIX_RUNTIME_ENV_FILE` instead of an ARN,
`KORTIX_ACME_PROVIDER=http`, no AWS coordinates), installs the bootstrap updater
binary (which self-updates to the signed channel binary via TUF on first run),
seeds `kortix-supabase.service`, and runs the first reconcile. The app bundle then
installs the updater/watchdog/prune timers, so subsequent updates are automatic and
identical to AWS. Provide exactly one LLM upstream (`AWS_BEDROCK_API_KEY` or
`OPENROUTER_API_KEY`).

## Rollback

`rollback --release <v>` is a deploy of an older signed revision, allowed only when
the target manifest lists the current revision in `rollback_from`. A database
rollback is safe only when the manifest declares a tested reverse/forward-compatible
migration path; otherwise a data restore is a reviewed recovery operation (below).
Exercise a rollback once on customer-zero.

## Backup and restore (whole-volume)

Durability is encrypted EBS + hourly AWS Backup recovery points (`backup.tf`,
vault-locked). Recovery is a **whole-volume restore** of the Supabase data volume
to the most recent recovery point, so the RPO tracks the ~60-minute snapshot cadence
(RTO ~60m). To recover:

1. Confirm a recent recovery point in the `<instance>-supabase` backup vault.
2. Stop the stack on the host (systemd-managed; `kortix self-host logs supabase`).
3. Restore the recovery point to a new encrypted EBS volume, detach the current
   data volume, attach the restored volume at `/dev/sdf`.
4. Start Supabase, verify the authenticated Kong health endpoint, then confirm
   application reads through the API.

Certification is not complete until a real marker row survives a restore, the
application reads it through the API, and the procedure is recorded. On a VPS the
equivalent is the provider's block-volume snapshots of `/var/lib/kortix`.

## Documented v1 limitations

- **Availability = one host.** The whole product runs on a single box; a host
  failure is downtime (EC2 auto-recovery + watchdog + the restore drill mitigate;
  multi-host HA is out of scope). This never changed the availability class —
  Supabase always ran on one EC2.
- **RPO ~60m / RTO ~60m** (whole-volume restore).
- **Bedrock via bearer key** (`AWS_BEDROCK_API_KEY`); SigV4 is the documented
  future (`TODO(bedrock-sigv4)`).
- **TLS = ACME HTTP-01** by default; DNS-01/wildcards are opt-in (self-built Caddy).
- **Sandboxes** run on Daytona via egress (`ALLOWED_SANDBOX_PROVIDERS=daytona`).
- **IPv4 only** (EIP; A records, no AAAA).

## Certification checklist (per deployment)

- [ ] `terraform apply` (AWS: state -> cluster) or `appliance-bootstrap.sh` (VPS)
      clean from scratch
- [ ] all containers healthy on the expected digests; migrate exit 0
- [ ] Supabase authenticated health through Kong
- [ ] API `/v1/health` 200 with the expected version; frontend 200; TLS valid
- [ ] sign-up/sign-in + one real project/session flow persists data
- [ ] one agent turn completes against Bedrock via the bearer key (no OpenRouter)
- [ ] the updater timer ran once and no-oped; a forced update exercised
- [ ] rollback to the previous revision exercised once (customer-zero)
- [ ] a backup recovery point exists; whole-volume restore documented

## Stop conditions

Do not auto-apply when the guard reports `manual_review`/`blocked`, any
signature/digest check fails, the installed account/region differs, a release is
not on `stable`, migrations are incompatible, or post-deploy health gates fail. Do
not replace a host or restore data until the current backup recovery point and
rollback target are recorded.

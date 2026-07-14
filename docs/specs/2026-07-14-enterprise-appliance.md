# Kortix Enterprise Appliance — single-EC2, 100% Docker

Date: 2026-07-14. Status: EXECUTING. Supersedes the ECS runtime half of
`docs/specs/2026-07-14-enterprise-ecs-simplification.md` (merged PR #4689,
dff20292d). Everything release-side from that spec stands unchanged: TUF
`stable` channel, Promote Enterprise Stable (copy+sign, never rebuild),
compatibility contracts with enforced `rollback_from`, digest pinning, image
mirroring, account pinning, secret generation, `kortix self-host` CLI surface.

## Decision

The whole product runs as Docker containers on ONE host. Rationale: Supabase
already runs on a single EC2, so a multi-AZ app tier never changed the
deployment's availability class — it only added an orchestration layer. The
heavy compute (sandboxes, LLM) is external by design; API/gateway/frontend are
light. One box, vertically sized, is the honest architecture — and the same
artifact deploys on ANY VPS or cloud, unifying enterprise AWS-VPC with plain
Docker self-hosting into ONE system.

Sentence: **a signed release manifest and one box running Caddy + the Kortix
containers + official Supabase Docker, updated by a systemd timer, deployed by
one CLI command.**

## Host layout (identical on AWS EC2 and any VPS)

```
/opt/kortix/
├── supabase/          official Supabase Docker Compose (EXISTS today — the
│                      signed supabase bundle, unchanged mechanism)
├── app/               NEW signed app bundle:
│   ├── docker-compose.yml   caddy, api (replicas: 2), gateway, frontend —
│   │                        every image digest-pinned from the manifest
│   ├── Caddyfile            TLS termination + routing (below)
│   └── .env                 rendered from the runtime secret (0600, root)
└── bin/kortix-updater       slim deployer binary (TUF verify → compare running
                             digests → compose pull/up → health → breadcrumb)
systemd: kortix-supabase.service (exists) · kortix-app.service ·
         kortix-updater.{service,timer} (daily; no-op when digests match)
Data:    /var/lib/kortix/* on the encrypted data volume (EBS on AWS)
```

Caddy owns what the ALB owned — one routing table, all platforms:
- `api.<domain>`: `/v1/llm*` → gateway:8090, everything else → api:8008
- `<domain>`: `/rest/v1* /auth/v1* /storage/v1* /realtime/v1* /functions/v1*
  /graphql/v1*` → supabase-kong:8000, everything else → frontend:3000
- api runs 2+ replicas (compose `deploy.replicas` or scaled service); Caddy
  load-balances; `reverse_proxy` health checks gate upstreams.
- TLS: ACME. On AWS, DNS-01 via Route53 (instance role gets zone-scoped
  `route53:ChangeResourceRecordSets`); on a VPS, HTTP-01 or provider DNS-01.

## Deploy flow (updater binary, same brain as the ECS deployer)

1. Verify pinned account (AWS) / instance identity. TUF-verify `stable`.
2. No-op check: running container image digests (`docker inspect`) + release
   breadcrumb (`/var/lib/kortix/release.json`, plus SSM param on AWS) vs
   manifest. A deploy already in progress (lockfile + `flock`) → exit 0.
3. Pull digest-pinned images (from customer ECR mirror on AWS; Docker Hub by
   digest elsewhere). Mirroring stays for AWS (air-gap-friendly); plain pulls
   are the VPS fallback.
4. Supabase bundle changed → existing install/finalize scripts (unchanged).
5. Migrate: one-off `docker compose run --rm migrate` (api image,
   `bun scripts/migrate.ts bootstrap`) — nonzero aborts before touching services.
6. App roll, blue-green per service: `compose up -d --no-deps` new containers →
   container healthchecks pass → Caddy upstream health gates traffic → old
   containers stop. On failed health: keep old containers, report loudly,
   exit nonzero. NEVER take down healthy containers for a failed optional step.
7. Public health checks (existing curl retry), write breadcrumb, print summary.
Rollback = same flow pointed at an older signed release (`rollback_from`
enforced by contract).

## AWS Terraform (module shrinks hard)

KEEP: VPC/network, the ONE EC2 (now sized for the whole product, public subnet
+ EIP, SG 80/443 from `alb_ingress_cidrs`-equivalent ingress list + SSM), the
encrypted data EBS + AWS Backup hourly, KMS, Secrets Manager, Route53 records
(A/AAAA → EIP), ECR mirror repos, operator/break-glass role, account guard,
guard-plan classifier, artifacts staging bucket (bundle delivery via SSM+S3).
ADD: instance-profile grants — Bedrock invoke (SigV4 with instance role — the
bearer-key workaround dies, `AWS_BEDROCK_API_KEY` no longer required on AWS),
zone-scoped Route53 for ACME DNS-01, artifacts GetObject, SSM param breadcrumb.
DELETE: ecs.tf, alb.tf, deployer.tf (cluster, services, task defs, ALB+TGs,
EventBridge Scheduler, all ECS IAM). Scheduling moves into the box (systemd
timer). ACM cert resources go (Caddy owns TLS).

## CLI unification (ONE self-host system)

`kortix self-host --target aws-vpc`: init/doctor/plan/deploy keep their shape;
`deploy` = terraform apply → SSM RunCommand "run kortix-updater now";
status/version read the SSM breadcrumb + `docker ps` via SSM.
`kortix self-host` (docker target): converges on the SAME app bundle + updater
binary — a VPS is "appliance minus Terraform" (operator runs a bootstrap
script; updater timer handles updates identically). One bundle format, one
updater, one runtime — two provisioning paths (Terraform vs bootstrap script).

## v1 limitations (documented, unchanged)

Sandboxes = Daytona via egress. Availability = one host; RTO = snapshot
restore, documented drill. RPO ~1h (hourly EBS snapshots / provider snapshots).

## Certification checklist (per deployment)

- [ ] terraform apply (AWS) or bootstrap script (VPS) clean from scratch
- [ ] all containers healthy on expected digests; migrate exit 0
- [ ] Supabase authenticated health through Kong
- [ ] API /v1/health 200 expected version; frontend 200; TLS valid
- [ ] sign-up/sign-in + one real project/session flow persists
- [ ] one agent turn completes against Bedrock via instance role (AWS)
- [ ] updater timer ran once and no-oped; forced update exercised
- [ ] rollback to previous revision exercised once (customer-zero)
- [ ] backup recovery point exists; whole-volume restore documented

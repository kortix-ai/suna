# Enterprise VPC (Single-Tenant, Kortix-Managed) Deployment

> **Superseded by the generic self-host refactor.** The whole enterprise-VPC
> lineage this spec started (EKS → ECS → single-EC2 appliance) has been
> replaced: `kortix self-host` is now ONE generic Docker Compose system with no
> target flag, no Terraform, no TUF/signing, no SSM — identical on a laptop,
> any VPS, or a cloud VM. The BYOC thesis and account model here are kept as
> history; read `docs/runbooks/self-hosting.md` and
> `apps/web/content/docs/reference/self-hosting-architecture.mdx` for the
> current design.

> **Superseded (architecture).** The runtime/deploy architecture below — EKS +
> Helm + External Secrets + Step Functions + CodeBuild + EventBridge + DynamoDB —
> is replaced by the ECS Fargate model in
> [`docs/specs/2026-07-14-enterprise-ecs-simplification.md`](./2026-07-14-enterprise-ecs-simplification.md)
> (three ECS services + a Supabase EC2 behind one ALB, an operator/scheduled
> deployer task, and encrypted-EBS + AWS-Backup durability). The BYOC thesis,
> signed TUF release channel, account model, and operator-access design here all
> stand; only the concrete infrastructure changed. Kept as history.

Date: 2026-07-13

## Goal

Ship the **full Kortix product** into an enterprise customer's own AWS account as
a dedicated single-tenant install ("bring-your-own-cloud" / BYOC), operated by
Kortix, and keep every such install continuously up to date with a curated
`stable` release channel — the same way we promote `staging → prod` today.

The customer owns the AWS account, the data, and the KMS keys. Kortix owns the
software plane and operates it through a scoped, audited, time-boxed cross-account
IAM role. This is the standard enterprise-VPC pattern (Databricks/Confluent/
Temporal Cloud BYOC): customer gets data residency + control, vendor gets to run
real upgrades/migrations/rollback instead of emailing a runbook.

**Decided parameters (2026-07-13):**

| Decision | Choice |
| --- | --- |
| Isolation tier | **Connected VPC** — private networking + Bedrock VPC endpoint; may pull images from Kortix registry and emit scrubbed health telemetry. (Not full air-gap.) |
| Ops model | **Kortix-managed** via cross-account break-glass role. Customer owns account/data/KMS. |
| Update channel | **`stable`** long-lived branch. `prod → stable` is a gated promotion (mirror of `staging → prod`). All managed VPCs auto-track `stable` only, and it may lag `prod` by more than one version by design. |

## The channel model: `stable` as a 4th environment

`stable` extends the existing [dev/staging/prod topology](./2026-06-25-dev-staging-prod-release-topology.md).
It is the **only** thing any managed VPC ever deploys.

| Environment | Git branch | Deploys to | Promotion into it |
| --- | --- | --- | --- |
| dev | `main` | `dev.kortix.com` | direct push |
| staging | `staging` | `staging.kortix.com` | PR `main`→`staging` |
| prod | `prod` | `kortix.com` (our cloud) | `promote.yml`: reviewed PR `staging`→`prod` |
| **stable** | **`stable`** | **all managed enterprise VPCs** | **`promote-stable.yml`: reviewed PR `prod`→`stable`** |

Branch flow:

```text
main → staging → prod → stable
                  │        │
          (our cloud)   (every managed VPC, auto-synced)
```

`stable` is protected exactly like `prod`. It moves **only** when `promote-stable.yml`
opens a reviewed release PR from `prod` into `stable` and it's merged. Because
`stable` lags `prod` deliberately, a version soaks on our own cloud before any
customer sees it — our prod is the soak environment for the enterprise fleet.

Key property: **you promote to `stable` once, and every VPC converges.** No
per-customer release choreography for the common case.

## Target topology (customer AWS account, one region, one tenant)

```text
Customer AWS Account (dedicated) ── Kortix assumes a scoped break-glass role
└─ VPC (private subnets; app ingress private unless customer opts to expose)
   ├─ EKS cluster
   │   ├─ ns kortix-app:       api · gateway · web   (Helm releases + Argo Rollouts)
   │   ├─ ns kortix-platinum:  Platinum control-plane + microVM workers (.metal nodes)
   │   ├─ ns platform:         Argo CD · Kyverno · external-secrets · Prom/Grafana/OTel
   │   └─ Karpenter/ASG:       sandbox worker capacity (bare-metal pool for Cloud Hypervisor)
   ├─ RDS Postgres (Multi-AZ, customer KMS)     ← Supabase schema / GoTrue
   ├─ ElastiCache Redis                          ← queues / cache
   ├─ ECR                                        ← Kortix images mirrored from our registry
   ├─ S3 (+ KMS)                                 ← artifacts · git-cache · backups
   ├─ Secrets Manager                            ← tenant env; external-secrets syncs in
   └─ VPC endpoints: Bedrock · S3 · ECR · STS · Secrets Manager
```

Only required outbound is Bedrock (VPC endpoint, stays on Amazon's backbone).
Optional controlled egress: pull from Kortix registry (or mirror to their ECR →
zero-egress capable) and scrubbed telemetry home.

`.metal` note: Cloud Hypervisor microVMs need nested virt / bare metal, so the
Platinum worker pool is a distinct, pricier node group — a cost line for the
contract.

## The four external dependencies to internalize

Everything else is "run the same Helm charts in their account." These are the work:

| Dependency | Kortix Cloud today | In customer VPC |
| --- | --- | --- |
| **Agent sandboxes** | Daytona SaaS (`apps/api/src/platform/providers/daytona.ts`) | **Platinum** (`platform/providers/platinum.ts`) — our Cloud Hypervisor microVM provider, mirrors Daytona's contract 1:1 — deployed *inside* the VPC. **Tentpole workstream.** |
| **LLM inference** | Gateway → Bedrock (Claude) + OpenRouter (rest) | **Bedrock-only** default (Claude in-region via VPC endpoint). OpenRouter opt-in / disabled. BYOK allowed. |
| **App deployments** | Freestyle SaaS (`deployments/providers/freestyle.ts`) | Disable the deploy feature for the tenant, or point `FREESTYLE_API_URL` at a self-hosted endpoint. |
| **Auth / DB** | Supabase managed | RDS Postgres (Multi-AZ, customer KMS) + GoTrue. |

**Tentpole:** Platinum must be a first-class *single-tenant deployable* product, not
just the Kortix-Cloud backend. Phase 0 is proving Platinum stands up cleanly in a
throwaway customer-shaped account. If it currently assumes a shared control plane,
"make Platinum single-tenant" gates the whole schedule — verify before committing dates.

## Terraform structure — extend, don't fork

Reuse the existing `cluster` / `platform` split
(`infra/terraform/environments/prod-eks/{cluster,platform}`). Each customer is a
**tfvars + backend config**, never a code fork.

```text
infra/terraform/
  modules/
    eks/ · network/ · ...            # existing, shared
    tenant/                          # NEW: extract common EKS+platform wiring from prod-eks
    platinum/                        # NEW: in-VPC sandbox runtime
    rds-postgres/                    # NEW: Supabase schema host
    tenant-secrets/                  # NEW: Secrets Manager + external-secrets wiring
  environments/
    prod-eks/                        # our cloud (existing) — should also consume modules/tenant
    tenants/
      _template/                     # the reusable single-tenant blueprint
      <customer>/
        cluster/                     # backend.tf (their S3 state) + terraform.tfvars
        platform/
```

Extracting `modules/tenant/` and having **our own prod consume it too** is what
prevents drift — a fix can't land in our cloud but miss the fleet. Tenant TF state
lives in the customer's S3 (data residency) with an assumed role; whose account
holds state is a contract decision, not a technical one.

## CI/CD — how a VPC tracks `stable`

Model: **releases are a product with a channel; tenants pull, we don't
continuously push into their account.**

1. **Release artifact = immutable, signed bundle.** On every `stable` promotion,
   publish a tenant release manifest pinned by **digest** (Kyverno already forbids
   `:latest`):
   ```text
   kortix-enterprise:<version> → { image digests: api/gateway/web/sandbox/platinum,
                                    helm chart versions, DB migration set,
                                    min modules/tenant version, signature }
   ```
   One version number for the whole bundle → "what's deployed" is a single answer.

2. **Distribution = per-tenant Argo CD (already in the stack)** pointed at the
   `stable` channel overlay. Auto-sync on. Argo Rollouts does the canary using the
   existing `analysistemplate.yaml`. Rollback = Argo image-digest swap (same
   mechanics as `rollback-prod.yml`).

3. **Image delivery = mirror on promote.** `promote-stable.yml` fans out: for each
   managed tenant, `skopeo`/`crane` copy the bundle's digests from our registry into
   **that tenant's ECR**, then bump the tenant's channel pointer. Connected tenants
   may instead pull directly via a read-only cross-account pull role; the ECR mirror
   is what also makes a future air-gap tenant possible with no new design.

4. **Migrations = pre-sync hook, gated.** The bundle carries the `node-pg-migrate`
   set. A pre-sync Argo Job runs it against the tenant RDS **before** the app
   rollout, gated on a `verify-live-schema` check.
   ⚠️ **Never let a tenant skip a `stable` release across a migration boundary** —
   schema lineage must move strictly forward, or we reproduce the migration-ordering
   / enum-drift incidents at customer scale. The channel-bump tooling enforces
   no-version-skipping across migration-bearing releases.

5. **Secrets stay tenant-owned.** external-secrets reads *their* Secrets Manager;
   the bundle never contains customer secrets. Tenants get a documented env contract
   (the keys `kortix self-host configure` collects, plus the VPC-specific ones).

End-to-end promotion:

```text
cut prod release → soak on our cloud → promote-stable.yml (prod→stable, reviewed)
   → build signed bundle → fan out: mirror digests to each tenant ECR + bump pointer
   → each tenant Argo syncs → migration pre-sync Job → Argo Rollout canary → done
```

## Operations

- **Break-glass:** scoped, time-boxed cross-account `AssumeRole` with customer
  approval; CloudTrail visible to the customer. No standing admin. This is how
  Kortix runs migrations, debugs, and rolls back without holding their keys.
- **Observability:** the `platform/` Prom/Grafana/OTel stack runs in-tenant.
  Connected tier optionally emits a **scrubbed** health stream home (version,
  error rate, sandbox health — never customer data) so we can proactively page on a
  customer's install.
- **Rollback:** Argo image-digest swap per surface; the DB-drift safety check is the
  real gate (rolling back across a migration is the thing that bites).
- **Version SLA:** contractually bound how far `stable` may lag and the
  security-fix SLA. Security hotfixes cut a bundle that jumps the channel regardless
  of the normal soak lag.

## Phased plan

0. **Prove Platinum-in-VPC.** Stand up Platinum single-tenant in a throwaway AWS
   account; run `self-host-e2e` with `ALLOWED_SANDBOX_PROVIDERS=platinum`. If not yet
   single-tenant deployable, this phase absorbs that build and the schedule pivots here.
1. **Extract `modules/tenant/`** from `prod-eks`; add `modules/{platinum,rds-postgres,tenant-secrets}`; stand up `environments/tenants/_template`.
2. **Bedrock-only gateway profile** + disable/replace Daytona/Freestyle/OpenRouter behind an enterprise config profile.
3. **`stable` branch + `promote-stable.yml` + signed bundle + ECR-mirror fan-out** wired off `promote.yml`.
4. **Per-tenant Argo app-of-apps + migration pre-sync hook;** dry-run the full "promote `stable` → tenant converges" loop on the throwaway account.
5. **Break-glass role + observability + runbook,** then onboard the real customer.

## Open questions / risks

- **Platinum single-tenant readiness** — the schedule-defining unknown. Verify first.
- **`.metal` capacity & cost** — bare-metal node pool for Cloud Hypervisor; price into contract, confirm regional availability.
- **Bedrock model coverage** — confirm every model the product defaults to (see `default-model-resolution`) is available on Bedrock in the customer's region; anything Claude-family is fine, non-Claude defaults need a Bedrock equivalent or must be gated off.
- **Telemetry-home boundary** — exact scrubbed schema needs security sign-off before any connected tenant emits it.
- **State ownership** — customer S3 vs Kortix S3 for tenant TF state; contract, not code.
- **License gate** — enterprise-VPC entitlements vs `docs/ENTERPRISE_EDITION.md`; the ELv2 license-key mechanism must function in a customer-run cluster.
```

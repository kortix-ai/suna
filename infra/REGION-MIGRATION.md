# Region migration: us-west-2 (Oregon) → eu-west-2 (London)

## Why

Prod compute (EKS + ECS) runs in `us-west-2` but the prod Postgres (Supabase
`supa.kortix.com` → project `jbriwassebxdwoieikga`) lives in `eu-west-2`. Every
DB round-trip crosses the Atlantic (~130ms+ RTT), which inflates p95 latency and,
under load or a transient cross-region blip, stacks up request handlers until
they time out — while the shallow `/health` probe (no DB) stays green, so EKS and
Better Stack never register the incident.

**Decision: colocate everything in `eu-west-2`** (move the compute to the DB —
the DB is the harder thing to move). This brings DB latency to single-digit ms.

## What this PR changes (code)

A pure region-literal flip across the infra-as-code so a *fresh* `terraform
apply` + GitOps reconcile stands the whole stack up in `eu-west-2`:

- **Terraform** — every `aws_region` default, every S3 backend `region`, the
  `terraform_remote_state` region, every provider `region`, and the
  region-bound ARNs (DynamoDB lock table, Secrets Manager examples) →
  `eu-west-2`. The CloudTrail KMS `use1` (`us-east-1`) provider alias is
  deliberately left as-is (multi-region trail homed in us-east-1).
- **k8s GitOps values** (`infra/k8s/envs/*`) — `externalSecrets.region` →
  `eu-west-2`. ACM `certificateArn`s are **placeholdered**
  (`REPLACE_WITH_EU_WEST_2_CERT`) because an ACM cert is region-bound: the old
  us-west-2 cert UUIDs cannot front an eu-west-2 ALB. They must be set to the new
  cert ARNs that apply emits (step 4).
- **Deploy workflows** (`deploy-dev.yml`, `deploy-prod.yml`) — `AWS_REGION` →
  `eu-west-2`.
- **Docs** (`CICD.md`, `EKS.md`, terraform READMEs, security-baseline README).

> ⚠️ **The code change alone does NOT move the live stack.** Terraform state,
> S3/DynamoDB state backend, ACM certs, Secrets Manager, ECR images and the
> running clusters are all region-scoped. Merging this PR is step 1 of the
> runbook below — the cutover is a deliberate, ordered, operator-run migration.

## Runbook (ordered, operator-run)

Pre-req: AWS creds for account `935064898258`; a maintenance window; the prod
Supabase project already lives in eu-west-2 (it does), so the DB does **not**
move — only compute + state + supporting AWS resources.

1. **State backend in eu-west-2.** The S3 state bucket + DynamoDB lock table are
   region-bound. Either (a) create new ones in eu-west-2 and migrate state, or
   (b) keep the existing bucket if it's acceptable cross-region for *state only*
   (state access is infrequent and not latency-sensitive). Recommended (a):
   ```sh
   AWS_REGION=eu-west-2 TF_STATE_BUCKET=kortix-terraform-state-euw2 \
     infra/terraform/scripts/bootstrap-state.sh
   # then per stack: terraform init -migrate-state -backend-config=...
   ```
   Update each `backend.tf` bucket name if you use a new bucket.
2. **ECR / image registry.** Confirm the API image is pullable from eu-west-2
   (Docker Hub `kortix/*` is region-agnostic — no change; if any ECR is used,
   replicate the repo to eu-west-2 first).
3. **Apply the foundational stacks in eu-west-2** (new VPCs, subnets, NAT, EKS
   cluster, node groups):
   ```sh
   cd infra/terraform/environments/prod-eks/cluster && terraform init -reconfigure && terraform apply
   cd ../platform && terraform init -reconfigure && terraform apply
   # (dev-eks the same; ECS prod/dev stacks if still in use)
   ```
4. **New ACM certs.** The acm-cloudflare module requests fresh certs in
   eu-west-2 and emits their ARNs. Copy each into the matching
   `infra/k8s/envs/*/values.yaml` `certificateArn` (replacing
   `REPLACE_WITH_EU_WEST_2_CERT`) and commit — that commit is what lets Argo CD
   bring up the eu-west-2 ingress with a valid cert.
5. **Secrets Manager.** Recreate the `kortix-{prod,dev}-env` secret bundle in
   eu-west-2 (Secrets Manager is regional). External Secrets in the new cluster
   reads it via the IRSA role (already region-flipped in values).
6. **Bring up the app on eu-west-2, verify against the prod DB** (now in-region —
   confirm p95 DB latency drops to single-digit ms) while `api.kortix.com` still
   points at the old stack. `manage_dns=false` keeps the live record untouched.
7. **Cutover.** Repoint `api.kortix.com` (and `dev-api`) Cloudflare CNAME → the
   new eu-west-2 ALB. Instantly reversible (flip the CNAME back).
8. **Decommission us-west-2** once stable: destroy the old stacks, delete old
   certs/secrets, remove the old state objects.

## Rollback

Every step is reversible until step 8. The DNS cutover (step 7) is the only
user-visible flip and is a single Cloudflare record change back to the old ALB.
Do not run step 8 until the eu-west-2 stack has been stable through a full
business-day peak.

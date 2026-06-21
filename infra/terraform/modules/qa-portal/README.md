# qa-portal (Terraform module)

The durable AWS half of the internal QA report portal (`qa.kortix.com`):

- **S3 bucket** (`kortix-qa-reports` by default) — **versioning ON**, **all public
  access blocked**, SSE (AES256), and a lifecycle policy that
  - expires per-run reports under `reports/runs/` after `per_run_retention_days`,
  - expires overwritten object versions after `noncurrent_version_retention_days`,
  - aborts stale multipart uploads.
  The currently-served report lives under `reports/latest/` and is **never**
  expired (different prefix).
- **IRSA role** the portal pod's ServiceAccount assumes — **read-only** on
  `reports/*`. Same trust shape as `modules/eks/irsa`
  (`system:serviceaccount:<namespace>:<service_account>`).
- **CI write policy** (optional) attached to an existing CI role (`ci_writer_role_arn`)
  so the Allure-upload job can `PutObject`/`DeleteObject` under `reports/*`.
- **DNS** (optional, single record) — off by default; the chart's external-dns
  annotation owns `qa.kortix.com`. Set `manage_dns_record = true` to have
  Terraform create the proxied Cloudflare CNAME to the ALB instead.

## Bucket layout

```
s3://<bucket>/
  reports/
    latest/            # generated static Allure report — what the pod serves
    runs/<run-id>/     # per-run results + report (history; lifecycle-expired)
```

## Usage

```hcl
module "qa_portal" {
  source = "../../../modules/qa-portal"

  name              = "kortix-qa-portal"
  bucket_name       = "kortix-qa-reports"
  region            = var.aws_region
  oidc_provider_arn = module.eks.oidc_provider_arn   # from modules/eks/cluster
  oidc_provider_url = module.eks.oidc_provider_url
  namespace         = "kortix-qa"
  service_account   = "qa-portal"

  # optional: grant the CI uploader write
  ci_writer_role_arn = aws_iam_role.ci_deploy.arn

  # optional: let TF own the DNS record instead of external-dns
  # manage_dns_record = true
  # dns_zone_id       = var.cloudflare_zone_id
  # alb_hostname      = "<ALB DNS from kubectl get ingress>"

  tags = local.tags
}
```

## Outputs

| Output | Use |
| ------ | --- |
| `bucket_name` | `bucket` in `infra/k8s/envs/qa/values.yaml` |
| `role_arn` | `serviceAccount.roleArn` in `infra/k8s/envs/qa/values.yaml` |

## Cluster-specific values to confirm

- `oidc_provider_arn` / `oidc_provider_url` — from the cluster layer's outputs
  (the QA portal usually rides the **prod-eks** cluster; confirm which cluster).
- `region` — must match the cluster region (`us-west-2` today).
- `bucket_name` — globally unique; confirm it isn't taken.
- `ci_writer_role_arn` — the existing CI role that uploads reports (e.g. the
  `kortix-gha-eks-deploy` role, or a dedicated QA CI role).

## Cloudflare Access gate (qa.kortix.com)

`enable_access = true` (default) puts the portal behind **Cloudflare Access (Zero Trust)**
on `qa.kortix.com` (which is already proxied through Cloudflare). Access denies by default;
the one allow policy admits the configured emails / email domains. Every report — including
the per-PR Allure links `qa-pr` posts — requires authentication.

```hcl
module "qa_portal" {
  # ...
  enable_access                = true
  cloudflare_account_id        = var.cloudflare_account_id   # TF_VAR_cloudflare_account_id
  access_allowed_email_domains = ["kortix.com"]
  access_allowed_emails        = []                          # add contractors/on-call here
  access_session_duration      = "24h"
}
```

**Prerequisites**
- An identity provider (Google / GitHub / one-time-PIN) configured in the Cloudflare
  Zero Trust account. This module uses the existing IdPs; it does not create one.
- `cloudflare_account_id` supplied (the module fails the plan with a clear message otherwise).
- The Cloudflare API token must include **Account · Access: Apps and Policies · Edit**.

Set `enable_access = false` to serve the portal without the gate (not recommended — reports
can include internal hostnames, tokens-in-URLs, and failure traces).

| Output | Use |
| ------ | --- |
| `access_application_id` | the Access app guarding `qa.kortix.com` |
| `access_enabled` | whether the gate is on |

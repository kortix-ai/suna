# qa-portal RUNBOOK

Bring up the internal QA report portal at **qa.kortix.com**. GitOps: Terraform
provisions S3 + IRSA (+ optionally DNS); Argo CD deploys the chart. Nothing here
is applied automatically — follow the order.

## Architecture (one line)

CI uploads Allure results + the generated static report to **versioned S3**
(`s3://kortix-qa-reports/reports/latest/`); a stateless nginx pod on EKS
re-`aws s3 sync`s that prefix (IRSA, no keys) and serves it via an ALB Ingress;
external-dns + Cloudflare publish proxied `qa.kortix.com`.

## Apply order

1. **Wire the Terraform module** into the cluster environment that hosts the QA
   portal (recommended: the **prod-eks** cluster layer, alongside `module.app_irsa`):

   ```hcl
   module "qa_portal" {
     source             = "../../../modules/qa-portal"
     name               = "kortix-qa-portal"
     bucket_name        = "kortix-qa-reports"
     region             = var.aws_region
     oidc_provider_arn  = module.eks.oidc_provider_arn
     oidc_provider_url  = module.eks.oidc_provider_url
     namespace          = "kortix-qa"
     service_account    = "qa-portal"
     ci_writer_role_arn = aws_iam_role.ci_deploy.arn   # CI uploader gets write
     tags               = local.tags
   }
   ```

   > NOTE: per the brief I did **not** edit the existing cluster `main.tf`. Add the
   > block above (and an `output` for `module.qa_portal.role_arn` /
   > `bucket_name`) in a separate change, OR run the module standalone.

2. **Create the ACM cert for `qa.kortix.com`** (reuse `modules/acm-cloudflare`,
   like `module.acm` for api-eks):

   ```hcl
   module "acm_qa" {
     source      = "../../../modules/acm-cloudflare"
     domain_name = "qa.kortix.com"
     zone_id     = var.cloudflare_zone_id
     tags        = local.tags
     providers = { aws = aws, cloudflare = cloudflare }
   }
   ```

3. **`terraform apply`** (S3 + IRSA + cert). Grab the outputs:
   - `bucket_name`  → `kortix-qa-reports`
   - `role_arn`     → `arn:aws:iam::<acct>:role/kortix-qa-portal`
   - the ACM cert ARN for `qa.kortix.com`

4. **Fill `infra/k8s/envs/qa/values.yaml`:**
   - `bucket` ← `bucket_name`
   - `serviceAccount.roleArn` ← `role_arn`  (confirm the account id)
   - `ingress.certificateArn` ← the qa cert ARN

5. **DNS for `qa.kortix.com`** — two options:
   - **external-dns (default):** the Ingress carries the
     `external-dns.alpha.kubernetes.io/hostname` annotation; if external-dns runs
     on the cluster with Cloudflare access, the proxied record is created
     automatically once the ALB is up. Nothing else to do.
   - **Terraform-managed:** set `manage_dns_record = true`, `dns_zone_id`, and
     `alb_hostname` (`kubectl -n kortix-qa get ingress qa-portal`) on the module,
     then `terraform apply`.

6. **Merge so Argo syncs.** `infra/k8s/argocd/applications/qa.yaml` is picked up
   by the app-of-apps (it recurses `applications/`). Argo creates the `kortix-qa`
   namespace (`CreateNamespace=true`) and the workload.

   > BOOTSTRAP: until these manifests are on `kortix-ai/suna`, create the app with
   > the same `--repo/--revision` override the other apps use (see GITOPS.md).

7. **Verify:**

   ```bash
   argocd app get kortix-qa                      # Synced / Healthy
   kubectl -n kortix-qa get deploy,po,svc,ingress
   kubectl -n kortix-qa logs deploy/qa-portal -c report-sync   # sync ran
   curl -I https://qa.kortix.com                 # 200
   ```

## CI upload (write side)

The Allure-publishing job assumes the role given as `ci_writer_role_arn` and:

```bash
# results/report history (lifecycle-expired after N days)
aws s3 sync ./allure-report "s3://kortix-qa-reports/reports/runs/${RUN_ID}/" --region us-west-2
# the served pointer (the pod syncs this)
aws s3 sync ./allure-report "s3://kortix-qa-reports/reports/latest/" --delete --region us-west-2
```

## Cluster-specific values to CONFIRM (don't assume)

| Value | Why / where |
| ----- | ----------- |
| **Cluster OIDC ARN + URL** | `oidc_provider_arn` / `oidc_provider_url` from the cluster the portal runs on (prod-eks: `terraform -chdir=environments/prod-eks/cluster output`). The IRSA trust is wrong if these don't match. |
| **AWS account id** | `935064898258` is used in the env-values placeholder (copied from prod); confirm it's the same account, else fix the `roleArn`. |
| **Region** | `us-west-2` assumed (matches api-eks). Bucket + sync must use the cluster's region. |
| **Bucket name** | `kortix-qa-reports` must be globally unique — confirm it's free. |
| **ACM cert ARN** | Must be a **validated** cert for `qa.kortix.com` in the cluster region. |
| **Cloudflare hosted zone id** | For the qa record (external-dns config or the module's `dns_zone_id`). |
| **Ingress class / ALB controller** | Assumes `ingressClassName: alb` + AWS Load Balancer Controller + external-dns are installed (they are, for kortix-api). |
| **Argo project** | `qa.yaml` uses `project: default` because the `kortix` AppProject whitelist excludes `kortix-qa` (project.yaml intentionally untouched). Switch to `kortix` only after adding a `kortix-qa` destination there. |
| **`inboundCidrs`** | Empty during bring-up; set to Cloudflare IP ranges to lock the ALB once verified. |
| **CI writer role** | `ci_writer_role_arn` — the existing CI identity that should get bucket write (e.g. `kortix-gha-eks-deploy`). |

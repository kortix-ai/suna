# environments/dev-eks

Dev EKS stack for `dev-api-eks.kortix.com`, run in parallel with ECS dev. A
faithful clone of `prod-eks` (same modules), **fully isolated** — its own VPC
(`10.40.0.0/16`), cluster (`kortix-dev-eks`), and Argo CD — trimmed for dev:
a single NAT gateway, a 2-node floor, and Argo CD running **headless** (UI +
GitHub SSO off; access via port-forward).

Two Terraform states, applied in order (identical flow to prod-eks):

1. **`cluster/`** — AWS-only: the isolated VPC, EKS control plane + managed node
   group, ACM certs, the app's secret-read IRSA role (reads `kortix-dev-env`),
   and the GitHub Actions deploy role (`kortix-gha-eks-deploy-dev`, trusts
   `main`) + EKS access entries.
2. **`platform/`** — configures the kubernetes/helm providers from `cluster/`'s
   remote state, then installs the in-cluster controllers (AWS Load Balancer
   Controller, External Secrets, external-dns, metrics-server, cluster-autoscaler,
   Argo CD, Argo Rollouts) and the `kortix-dev` namespace.

The app workload is the Helm chart at `infra/k8s/charts/kortix-api`, rendered
with `infra/k8s/envs/dev/values.yaml` and deployed by Argo CD (app:
`infra/k8s/argocd/applications/dev.yaml`, tracks `main`). CI
(`.github/workflows/deploy-dev-eks.yml`) bumps the image tag on every push to
`main` — Terraform owns infra, GitOps owns the app.

## Apply

```bash
export TF_VAR_cloudflare_api_token=...   # scoped token, DNS:Edit on kortix.com
export TF_VAR_cloudflare_zone_id=...     # kortix.com zone id

cd cluster     && terraform init && terraform apply
cd ../platform && terraform init && terraform apply
```

## Post-apply wiring (one-time)

1. **Fill the cert ARN** in `infra/k8s/envs/dev/values.yaml`
   (`ingress.certificateArn`, currently a placeholder):
   ```bash
   terraform -chdir=cluster output -raw acm_certificate_arn
   ```
   Also sanity-check the IRSA role ARN already in that file matches:
   ```bash
   terraform -chdir=cluster output -raw app_irsa_role_arn   # expect .../kortix-dev-eks-app
   ```
   Commit the values change to `main`.

2. **Confirm the dev secret bundle** has the keys the app needs (External
   Secrets syncs `kortix-dev-env` → the `kortix-api-env` k8s Secret):
   ```bash
   aws secretsmanager get-secret-value --secret-id kortix-dev-env \
     --query SecretString --output text | jq 'keys | length'
   ```

3. **Bootstrap the dev Argo CD app** (one-time; thereafter GitOps owns it):
   ```bash
   aws eks update-kubeconfig --region us-west-2 --name kortix-dev-eks
   kubectl apply -f ../../../k8s/argocd/applications/dev.yaml
   # watch it: kubectl -n argocd port-forward svc/argocd-server 8080:443
   ```

4. **DNS** — add a Cloudflare **proxied** CNAME `dev-api-eks` → the dev ALB
   hostname (external-dns is wedged cluster-wide, so this is manual, same as
   prod-eks):
   ```bash
   kubectl -n kortix-dev get ingress kortix-api \
     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
   ```

5. **Verify**: `curl https://dev-api-eks.kortix.com/v1/health` → `environment: dev`.

## Cutover (later)

Flip `dev-api.kortix.com` → dev-eks (Cloudflare), set `workers.enabled: true` in
`envs/dev/values.yaml`, and disable the ECS dev service. Until then EKS dev runs
**API-only** so ECS keeps the dev-tier singleton workers (shared Postgres leader
lease). Full architecture + coexistence notes: **`infra/EKS.md`**.

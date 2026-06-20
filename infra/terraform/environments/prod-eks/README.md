# environments/prod-eks

Production EKS stack for `api-eks.kortix.com`, run in parallel with ECS prod.
Two Terraform states, applied in order:

1. **`cluster/`** — AWS-only: the isolated VPC, EKS control plane + managed node
   group, ACM cert, the app's secret-read IRSA role, and the GitHub Actions
   deploy role + EKS access entries. Plans/applies before any cluster exists.
2. **`platform/`** — configures the kubernetes/helm providers from `cluster/`'s
   remote state, then installs the in-cluster controllers (AWS Load Balancer
   Controller, External Secrets, external-dns, metrics-server, cluster-autoscaler)
   and the app namespace.

The app workload itself is the Helm chart at `infra/k8s/charts/kortix-api`,
deployed by `.github/workflows/deploy-prod-eks.yml` (Terraform owns infra, CI
owns the app — same split as ECS).

Full runbook, architecture, and switch-back/coexistence notes: **`infra/EKS.md`**.

```bash
# cluster first, then platform
cd cluster   && terraform init && terraform apply
cd ../platform && terraform init && terraform apply
```

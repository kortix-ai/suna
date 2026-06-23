# environments/prod-eks

Production EKS stack for `api-eks.kortix.com`, the active prod API origin behind
the Cloudflare Worker. ECS Fargate remains the warm standby origin.
Two Terraform states, applied in order:

1. **`cluster/`** — AWS-only: the isolated VPC, EKS control plane + managed node
   group, ACM cert, the app's secret-read IRSA role, and the GitHub Actions
   deploy role + EKS access entries. Plans/applies before any cluster exists.
2. **`platform/`** — configures the kubernetes/helm providers from `cluster/`'s
   remote state, then installs the in-cluster controllers (AWS Load Balancer
   Controller, External Secrets, external-dns, metrics-server, cluster-autoscaler)
   and the app namespace.

The app workload itself is the Helm chart at `infra/k8s/charts/kortix-api`,
reconciled by Argo CD from `infra/k8s/argocd/applications/prod.yaml`. The reviewed
promote PR bumps prod values, and `.github/workflows/deploy-prod.yml` applies
database migrations and watches the EKS rollout.

Full runbook, architecture, and switch-back/coexistence notes: **`infra/EKS.md`**.

```bash
# cluster first, then platform
cd cluster   && terraform init && terraform apply
cd ../platform && terraform init && terraform apply
```
